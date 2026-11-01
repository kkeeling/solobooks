import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import { OPS } from "../src/core/perform.ts";
import { startPage } from "../src/page.ts";
import { setup } from "../src/setup.ts";
import { dbPath, tempDir } from "./support/books.ts";
import { inProcessMcp } from "./support/mcp-client.ts";

const NOW = "2026-10-22T12:00:00.000Z";

/** A scratch person whose setup already ran, with one client in their books. */
async function person() {
  const home = tempDir();
  mkdirSync(join(home, ".claude"));
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), SOLOBOOKS_NOW: NOW };
  const books = join(home, "solobooks");
  setup([], env);
  expect((await run(["client", "add", "--name", "Acme", "--source", "s"], env)).code).toBe(0);
  return { home, env, books };
}

/** One call per operation, with no input: refused before anything looks at the input. */
const everyOp = OPS.map((o) => o.name.split("_"));

for (const state of ["missing", "empty"] as const) {
  test(`ISC-138: every CLI command refuses when the books file is ${state}, and creates nothing`, async () => {
    const { env, books } = await person();
    renameSync(dbPath(books), join(books, "away"));
    if (state === "empty") writeFileSync(dbPath(books), "");
    const before = readdirSync(books).sort();
    for (const words of everyOp) {
      for (const extra of [[], ["--dry-run"]]) {
        const r = await run([...words, "--source", "s", ...extra], env);
        expect(r.code).toBe(2);
        expect(JSON.parse(r.stdout)).toMatchObject({ field: "books" });
        expect(JSON.parse(r.stdout).reason).toContain(`There are no books in "${books}"`);
      }
    }
    expect(readdirSync(books).sort()).toEqual(before);
  });
}

test("ISC-138: a command in a folder with no books doesn't make the folder", async () => {
  const { env, home } = await person();
  const elsewhere = join(home, "elsewhere");
  expect((await run(["client", "list", "--books", elsewhere], env)).code).toBe(2);
  expect(existsSync(elsewhere)).toBe(false);
});

for (const state of ["missing", "empty"] as const) test(`ISC-138: every MCP tool refuses when the books file is ${state}, and creates nothing`, async () => {
  const { env, books } = await person();
  renameSync(dbPath(books), join(books, "away"));
  if (state === "empty") writeFileSync(dbPath(books), "");
  const mcp = await inProcessMcp(books, env);
  try {
    for (const o of OPS) {
      const r = await mcp.call(o.name, { source: "s" });
      expect(r.isError).toBe(true);
      expect(r.structuredContent.reason).toContain(`There are no books in "${books}"`);
    }
  } finally {
    await mcp.close();
  }
  expect(existsSync(dbPath(books))).toBe(state === "empty");
  if (state === "empty") expect(statSync(dbPath(books)).size).toBe(0);
});

test("ISC-138: doctor fails on an empty books file, and neither it nor a bare setup fills it", async () => {
  const { env, books } = await person();
  writeFileSync(dbPath(books), "");
  const { doctor } = await import("../src/doctor.ts");
  const d = await doctor([], { ...env, PATH: process.env.PATH });
  expect(d.checks.find((c: { check: string }) => c.check === "books")!.ok).toBe(false);
  expect(() => setup([], env)).toThrow("There are no books");
  expect(statSync(dbPath(books)).size).toBe(0);
});

test("ISC-140: with SOLOBOOKS_DIR set, a bare setup won't start books; --books will", async () => {
  const { env, home } = await person();
  const elsewhere = join(home, "elsewhere");
  expect(() => setup([], { ...env, SOLOBOOKS_DIR: elsewhere })).toThrow("There are no books");
  expect(existsSync(elsewhere)).toBe(false);
  expect(setup(["--books", elsewhere], { ...env, SOLOBOOKS_DIR: elsewhere }).started_new_books).toBe(true);
});

test("ISC-140: an empty SOLOBOOKS_DIR doesn't mean the current folder", async () => {
  const { env, books } = await person();
  expect(setup([], { ...env, SOLOBOOKS_DIR: "" }).books).toBe(books);
});

test("ISC-140: pointing setup at a new folder says where the real books still are", async () => {
  const { env, books, home } = await person();
  const r = setup(["--books", join(home, "safe")], env);
  expect(r.started_new_books).toBe(true);
  expect(r.warnings.join(" ")).toContain(`your books are still in "${books}"`);
  expect(setup(["--books", books], env).started_new_books).toBeUndefined();
});

test("ISC-138: backup set with no books says no copy was written", async () => {
  const { env, books, home } = await person();
  rmSync(dbPath(books));
  const { backupSet } = await import("../src/durability.ts");
  const r = backupSet(["--folder", join(home, "bk")], env);
  expect(r.latest).toBeNull();
  expect(r.warnings!.join(" ")).toContain("no copy was written");
});

for (const state of ["missing", "empty"] as const) {
  test(`ISC-139: a page click with the books file ${state} creates nothing, and the same code works once it's back`, async () => {
    const { env, books } = await person();
    const asked = JSON.parse((await run(["gate", "set", "--invoice-issue", "agent_decides", "--source", "s"], env)).stdout);
    const page = startPage({ books, port: 0, env });
    try {
      const html = await (await fetch(page.url)).text();
      const code = html.match(/"pending":\[\{"id":\d+,"code":"([^"]+)"/)![1]!;
      const click = () => fetch(new URL("/approve", page.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pending_id: asked.pending_id, code }) });
      renameSync(dbPath(books), join(books, "away"));
      if (state === "empty") writeFileSync(dbPath(books), "");
      const r = await click();
      expect(r.status).toBe(503);
      expect(((await r.json()) as any).refusal.reason).toContain("can't read the books file");
      expect(existsSync(dbPath(books))).toBe(state === "empty");
      renameSync(join(books, "away"), dbPath(books));
      expect((await click()).status).toBe(200);
    } finally {
      page.stop();
    }
  });
}

test("ISC-138: the books come back whole once the file is back", async () => {
  const { env, books } = await person();
  renameSync(dbPath(books), join(books, "away"));
  expect((await run(["client", "add", "--name", "Ghost", "--source", "s"], env)).code).toBe(2);
  renameSync(join(books, "away"), dbPath(books));
  const r = await run(["client", "list"], env);
  expect(JSON.parse(r.stdout).clients.map((c: { name: string }) => c.name)).toEqual(["Acme"]);
});

test("ISC-140: setup with a recorded folder whose books are gone refuses, then --books starts new ones", async () => {
  const { env, books } = await person();
  rmSync(dbPath(books));
  expect(() => setup([], env)).toThrow(`There are no books in "${books}", so setup changed nothing`);
  expect(existsSync(dbPath(books))).toBe(false);
  expect(setup(["--books", books], env).books).toBe(books);
  expect(existsSync(dbPath(books))).toBe(true);
});

test("ISC-140: doctor's fix for missing books is one that works", async () => {
  const { env, books } = await person();
  rmSync(dbPath(books));
  const r = await run(["client", "list"], env);
  expect(JSON.parse(r.stdout).reason).toContain(`solobooks setup --books "${books}"`);
  const { doctor } = await import("../src/doctor.ts");
  const d = await doctor([], { ...env, PATH: process.env.PATH });
  const check = d.checks.find((c: { check: string }) => c.check === "books")!;
  expect(check.ok).toBe(false);
  expect(check.fix).toContain(`solobooks setup --books "${books}"`);
  expect(existsSync(dbPath(books))).toBe(false); // doctor looks; it doesn't make books
});

test("ISC-140: a first setup still starts books in the default folder", () => {
  const home = tempDir();
  mkdirSync(join(home, ".claude"));
  const r = setup([], { HOME: home, XDG_CONFIG_HOME: join(home, ".config") });
  expect(existsSync(dbPath(r.books))).toBe(true);
});
