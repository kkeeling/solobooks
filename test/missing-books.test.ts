import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import { OPS } from "../src/core/perform.ts";
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
        expect(JSON.parse(r.stdout).reason).toContain(`There are no books in ${books}`);
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

test("ISC-138: every MCP tool refuses when the books file is missing, and creates nothing", async () => {
  const { env, books } = await person();
  renameSync(dbPath(books), join(books, "away"));
  const mcp = await inProcessMcp(books, env);
  try {
    for (const o of OPS) {
      const r = await mcp.call(o.name, { source: "s" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain(`There are no books in ${books}`);
    }
  } finally {
    await mcp.close();
  }
  expect(existsSync(dbPath(books))).toBe(false);
});

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
  expect(() => setup([], env)).toThrow(`Your books were in ${books} and aren't there now`);
  expect(existsSync(dbPath(books))).toBe(false);
  expect(setup(["--books", books], env).books).toBe(books);
  expect(existsSync(dbPath(books))).toBe(true);
});

test("ISC-140: doctor's fix for missing books is one that works", async () => {
  const { env, books } = await person();
  rmSync(dbPath(books));
  const r = await run(["client", "list"], env);
  expect(JSON.parse(r.stdout).reason).toContain(`solobooks setup --books ${books}`);
  const { doctor } = await import("../src/doctor.ts");
  const d = await doctor([], { ...env, PATH: process.env.PATH });
  const check = d.checks.find((c: { check: string }) => c.check === "books")!;
  expect(check.ok).toBe(false);
  expect(check.fix).toContain(`solobooks setup --books ${books}`);
  expect(existsSync(dbPath(books))).toBe(false); // doctor looks; it doesn't make books
});

test("ISC-140: a first setup still starts books in the default folder", () => {
  const home = tempDir();
  mkdirSync(join(home, ".claude"));
  const r = setup([], { HOME: home, XDG_CONFIG_HOME: join(home, ".config") });
  expect(existsSync(dbPath(r.books))).toBe(true);
});
