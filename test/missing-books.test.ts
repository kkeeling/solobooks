import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import { OPS } from "../src/core/perform.ts";
import { startPage } from "../src/page.ts";
import { setup } from "../src/setup.ts";
import { dbPath, tempDir } from "./support/books.ts";
import { inProcessMcp } from "./support/mcp-client.ts";
import { browserMarkers } from "./support/person.ts";

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
      const click = () => fetch(new URL("/approve", page.url), { method: "POST", headers: { "content-type": "application/json", ...browserMarkers(page.url) }, body: JSON.stringify({ pending_id: asked.pending_id, code }) });
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

/** A person with one card waiting and the page open: `click(path)` is the button, with the page's code for it. */
async function clickable() {
  const { env, books } = await person();
  const asked = JSON.parse((await run(["gate", "set", "--invoice-issue", "agent_decides", "--source", "s"], env)).stdout);
  const page = startPage({ books, port: 0, env });
  const html = await (await fetch(page.url)).text();
  const data = JSON.parse(html.match(/<script type="application\/json" id="data">(.*?)<\/script>/s)![1]!);
  const code = data.pending[0].code as string;
  const click = (path = "/approve") =>
    fetch(new URL(path, page.url), { method: "POST", headers: { "content-type": "application/json", ...browserMarkers(page.url) }, body: JSON.stringify({ pending_id: asked.pending_id, code }) });
  return { env, books, page, data, click, id: asked.pending_id as number };
}

for (const path of ["/approve", "/reject"]) {
  test(`ISC-161: ${path} with a books file that isn't books shows the can't-read message, spends no code, and the same button works once it's back`, async () => {
    const { books, page, click } = await clickable();
    try {
      renameSync(dbPath(books), join(books, "away"));
      writeFileSync(dbPath(books), "this is not a books file, it is a shopping list");
      const r = await click(path);
      expect(r.status).toBe(503);
      const { refusal } = (await r.json()) as any;
      expect(refusal.field).toBe("books");
      expect(refusal.reason).toStartWith(`solobooks can't read the books file at ${dbPath(books)} (`);
      expect(refusal.reason).toEndWith("then reload this page.");
      expect(refusal.reason).toContain("file is not a database");
      expect(readFileSync(dbPath(books), "utf8")).toStartWith("this is not a books file"); // nothing wrote over it
      rmSync(dbPath(books));
      renameSync(join(books, "away"), dbPath(books));
      expect((await click(path)).status).toBe(200);
    } finally {
      page.stop();
    }
  });
}

test("ISC-161: a books file cut short gets the can't-read message and spends no code", async () => {
  const { books, page, click } = await clickable();
  try {
    const whole = readFileSync(dbPath(books));
    writeFileSync(dbPath(books), whole.subarray(0, 4096));
    const r = await click();
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).refusal.reason).toStartWith(`solobooks can't read the books file at ${dbPath(books)} (`);
    writeFileSync(dbPath(books), whole);
    expect((await click()).status).toBe(200);
  } finally {
    page.stop();
  }
});

test("ISC-161: registering a passkey with a books file that isn't books spends no code either", async () => {
  const { books, page, data } = await clickable();
  try {
    const post = () => fetch(new URL("/passkey/register", page.url), { method: "POST", headers: { "content-type": "application/json", ...browserMarkers(page.url) }, body: JSON.stringify({ code: data.register.code, response: {} }) });
    renameSync(dbPath(books), join(books, "away"));
    writeFileSync(dbPath(books), "not books");
    expect((await post()).status).toBe(503);
    rmSync(dbPath(books));
    renameSync(join(books, "away"), dbPath(books));
    const r = await post();
    expect(r.status).not.toBe(403); // the code still works; this made-up response is what is refused
    expect(((await r.json()) as any).refusal.field).not.toBe("code");
  } finally {
    page.stop();
  }
});

test("ISC-162: with a zero-byte books file, the page, its panels and a click all say the file is empty, not that it isn't there", async () => {
  const { books, page, click } = await clickable();
  try {
    renameSync(dbPath(books), join(books, "away"));
    writeFileSync(dbPath(books), "");
    const html = await (await fetch(page.url)).text();
    expect(html).toContain("(the file is empty)");
    expect(html).not.toContain("the file is not there");
    const data = (await (await fetch(new URL("/data", page.url))).json()) as any;
    expect(data.refusal.reason).toContain("(the file is empty)");
    const r = (await (await click()).json()) as any;
    expect(r.refusal.reason).toContain("(the file is empty)");

    rmSync(dbPath(books)); // really gone: it says that instead
    expect(await (await fetch(page.url)).text()).toContain("(the file is not there)");
    renameSync(join(books, "away"), dbPath(books));
    expect((await click()).status).toBe(200);
  } finally {
    page.stop();
  }
});

/** Books with one page of the pending table's overwritten: they open, then fail at the first read of that table. */
function damagedPage(file: string): Buffer {
  const db = new Database(file, { readonly: true });
  const { rootpage } = db.query("SELECT rootpage FROM sqlite_master WHERE name = 'pending_actions'").get() as { rootpage: number };
  const { page_size } = db.query("PRAGMA page_size").get() as { page_size: number };
  db.close();
  const bytes = readFileSync(file);
  return Buffer.from(bytes).fill(0xff, (rootpage - 1) * page_size, rootpage * page_size);
}

for (const path of ["/approve", "/reject"]) {
  test(`ISC-169: ${path} with a damaged page in the file shows the can't-read message with its reason, and the same button works once it's repaired`, async () => {
    const { books, page, click } = await clickable();
    try {
      const whole = readFileSync(dbPath(books));
      writeFileSync(dbPath(books), damagedPage(dbPath(books)));
      const r = await click(path);
      expect(r.status).toBe(503);
      const { refusal } = (await r.json()) as any;
      expect(refusal.field).toBe("books");
      expect(refusal.reason).toStartWith(`solobooks can't read the books file at ${dbPath(books)} (`);
      expect(refusal.reason).not.toContain("Something went wrong");
      writeFileSync(dbPath(books), whole);
      expect((await click(path)).status).toBe(200);
    } finally {
      page.stop();
    }
  });

  test(`ISC-169: ${path} with a read-only books file shows the can't-read message with its reason, and the same button works once it's writable`, async () => {
    if (process.getuid?.() === 0) return; // root can write anything
    const { books, page, click } = await clickable();
    try {
      chmodSync(dbPath(books), 0o444);
      const r = await click(path);
      expect(r.status).toBe(503);
      const { refusal } = (await r.json()) as any;
      expect(refusal.field).toBe("books");
      expect(refusal.reason).toContain("readonly");
      expect(refusal.reason).not.toContain("Something went wrong");
      chmodSync(dbPath(books), 0o644);
      expect((await click(path)).status).toBe(200);
    } finally {
      chmodSync(dbPath(books), 0o644);
      page.stop();
    }
  });
}
