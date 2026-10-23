import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { install, run } from "../src/cli.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";
import { dbPath, dumpFile, fileHash, tempDir } from "./support/books.ts";
import { inProcessMcp } from "./support/mcp-client.ts";

const DAY1 = "2026-10-22T12:00:00.000Z";
const DAY2 = "2026-10-23T12:00:00.000Z";

/** A person's machine: a home with settings, books set up in it, and a backup folder picked. */
async function machine(books = "books") {
  const home = tempDir();
  const env = { HOME: home, SOLOBOOKS_NOW: DAY1 };
  const dir = join(home, books);
  expect((await install("setup", ["--books", dir], env)).code).toBe(0);
  const backups = join(home, "backups");
  return { home, dir, backups, env };
}

async function sb(env: Record<string, string>, args: string[]) {
  const r = await run(args, env);
  return { code: r.code, out: JSON.parse(r.stdout) };
}

const backupsIn = (folder: string) => (existsSync(folder) ? readdirSync(folder).sort() : []);

test("ISC-91 daily: the first write of each day writes that day's dated backup to the folder the person picked, once", async () => {
  const m = await machine();
  const set = JSON.parse((await install("backup", ["set", "--folder", "~/backups"], m.env)).stdout);
  expect(set.backups).toBe(m.backups);
  expect(backupsIn(m.backups)).toEqual(["solobooks-2026-10-22.sqlite"]); // picking the folder writes today's at once

  // Day 1: writes add nothing more, and reads and dry runs never write one.
  expect((await sb(m.env, ["client", "add", "--name", "Acme", "--source", "person"])).code).toBe(0);
  expect((await sb(m.env, ["client", "add", "--name", "Beta", "--source", "person"])).code).toBe(0);
  const day1 = fileHash(join(m.backups, "solobooks-2026-10-22.sqlite"));
  const day2 = { ...m.env, SOLOBOOKS_NOW: DAY2 };
  expect((await sb(day2, ["client", "list"])).code).toBe(0);
  expect((await sb(day2, ["client", "add", "--name", "Gamma", "--source", "person", "--dry-run"])).code).toBe(0);
  expect(backupsIn(m.backups)).toEqual(["solobooks-2026-10-22.sqlite"]);

  // The clock moves to day 2: the first write backs up the books as they stood, Acme and Beta, before it runs.
  const before = dumpFile(dbPath(m.dir));
  expect((await sb(day2, ["client", "add", "--name", "Gamma", "--source", "person"])).code).toBe(0);
  expect((await sb(day2, ["client", "add", "--name", "Delta", "--source", "person"])).code).toBe(0);
  expect(backupsIn(m.backups)).toEqual(["solobooks-2026-10-22.sqlite", "solobooks-2026-10-23.sqlite"]);
  const copy = join(m.backups, "solobooks-2026-10-23.sqlite");
  expect(dumpFile(copy)).toEqual(before);
  const db = new Database(copy, { readonly: true });
  expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
  db.close();
  // An earlier day's backup is never written over.
  expect(fileHash(join(m.backups, "solobooks-2026-10-22.sqlite"))).toBe(day1);

  // Writes through MCP count the same way: day 3's first write backs up once.
  const day3 = { ...m.env, SOLOBOOKS_NOW: "2026-10-24T12:00:00.000Z" };
  const mcp = await inProcessMcp(m.dir, day3);
  expect((await mcp.call("client_add", { name: "Epsilon", source: "agent:test" })).isError).toBe(false);
  expect((await mcp.call("client_add", { name: "Zeta", source: "agent:test" })).isError).toBe(false);
  await mcp.close();
  expect(backupsIn(m.backups)).toEqual(["solobooks-2026-10-22.sqlite", "solobooks-2026-10-23.sqlite", "solobooks-2026-10-24.sqlite"]);
}, 30_000);

test("ISC-91 daily: with no backup folder picked nothing is written, and a folder gone missing warns on the write instead of stopping it", async () => {
  const m = await machine();
  expect((await sb(m.env, ["client", "add", "--name", "Acme", "--source", "person"])).out.warnings).toBeUndefined();
  expect(readdirSync(m.dir)).toEqual(["solobooks.sqlite"]);
  const doctor = JSON.parse((await install("doctor", [], m.env)).stdout);
  expect(doctor.warnings).toContainEqual(expect.stringContaining("No backup folder is chosen"));

  const drive = join(m.home, "drive");
  await install("backup", ["set", "--folder", drive], m.env);
  const unplugged = join(m.home, "unplugged");
  writeFileSync(join(m.home, ".config", "solobooks", "config.json"), JSON.stringify({ books: m.dir, backups: unplugged }));
  const r = await sb({ ...m.env, SOLOBOOKS_NOW: DAY2 }, ["client", "add", "--name", "Beta", "--source", "person"]);
  expect(r.code).toBe(0);
  expect(r.out.client.name).toBe("Beta");
  expect(r.out.warnings).toEqual([expect.stringContaining(`Today's backup couldn't be written to ${unplugged}`)]);
  expect(existsSync(unplugged)).toBe(false); // never quietly made again somewhere else
  expect(JSON.parse((await install("doctor", [], m.env)).stdout).warnings).toContainEqual(expect.stringContaining(`The backup folder ${unplugged} isn't there`));
}, 30_000);

/** Books an older solobooks saved, at schema `version`, with a client and a posted entry in them. */
function oldBooks(dir: string, version: number): string {
  const path = dbPath(dir);
  mkdirSync(dir, { recursive: true });
  const old = new Database(path, { create: true, strict: true });
  for (const [v, sql] of MIGRATIONS.slice(0, version).entries()) {
    old.exec(sql);
    old.exec(`PRAGMA user_version = ${v + 1}`);
  }
  old.exec(`
    INSERT INTO clients (id, name, source) VALUES (1, 'Acme', 'agent:old');
    INSERT INTO accounts (id, name, type, source) VALUES (1, 'Checking', 'asset', 'agent:old'), (2, 'Owner', 'equity', 'agent:old');
    INSERT INTO entries (id, date, memo, source) VALUES (1, '2026-01-02', 'Opening balance', 'agent:old');
    INSERT INTO lines (entry_id, account_id, debit_cents, credit_cents, source) VALUES (1, 1, 500000, 0, 'agent:old'), (1, 2, 0, 500000, 'agent:old');
  `);
  old.close();
  return path;
}

test("ISC-92 pre-migration: books from an older solobooks are backed up, exactly as they were, before any migration runs", async () => {
  const m = await machine();
  await install("backup", ["set", "--folder", m.backups], m.env);
  const old = join(m.home, "old-books");
  const path = oldBooks(old, MIGRATIONS.length - 1);
  const asSaved = { rows: dumpFile(path), hash: fileHash(path) };

  // A dry run upgrades nothing and backs up nothing: the file stays byte-identical.
  expect((await sb(m.env, ["client", "add", "--name", "Beta", "--source", "person", "--dry-run", "--books", old])).code).toBe(0);
  expect(fileHash(path)).toBe(asSaved.hash);

  const r = await sb(m.env, ["client", "list", "--books", old]);
  expect(r.code).toBe(0);
  const name = `solobooks-2026-10-22-before-upgrade-from-v${MIGRATIONS.length - 1}.sqlite`;
  expect(backupsIn(m.backups)).toContain(name);
  const copy = new Database(join(m.backups, name), { readonly: true });
  expect(copy.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length - 1 });
  copy.close();
  expect(dumpFile(join(m.backups, name))).toEqual(asSaved.rows);
  expect(new Database(path, { readonly: true }).query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });

  // Opening the upgraded books again backs up nothing more.
  const count = backupsIn(m.backups).length;
  expect((await sb(m.env, ["client", "list", "--books", old])).code).toBe(0);
  expect(backupsIn(m.backups).length).toBe(count);

  // With no backup folder picked, the copy goes in the books folder's backups/.
  const bare = join(tempDir(), "books");
  oldBooks(bare, 3);
  expect((await sb({ SOLOBOOKS_NOW: DAY1 }, ["client", "list", "--books", bare])).code).toBe(0);
  expect(readdirSync(join(bare, "backups"))).toEqual(["solobooks-2026-10-22-before-upgrade-from-v3.sqlite"]);
}, 30_000);

test("ISC-92 pre-migration: when the backup can't be written, the migration doesn't run and the books stay exactly as they were", async () => {
  const m = await machine();
  const blocked = join(m.home, "not-a-folder");
  writeFileSync(blocked, "a file where the backup folder should be");
  writeFileSync(join(m.home, ".config", "solobooks", "config.json"), JSON.stringify({ books: m.dir, backups: blocked }));
  const old = join(m.home, "old-books");
  const path = oldBooks(old, 5);
  const hash = fileHash(path);

  for (const args of [["client", "list"], ["client", "add", "--name", "Beta", "--source", "person"]]) {
    const r = await sb(m.env, [...args, "--books", old]);
    expect(r.code).toBe(2);
    expect(r.out.field).toBe("backups");
    expect(r.out.reason).toMatch(/^solobooks couldn't back up these books into .* so it left them as they were; choose a backup folder it can write to with solobooks backup set --folder <dir>\.$/);
    expect(fileHash(path)).toBe(hash);
  }
  // A read-only folder refuses the same way, through MCP too.
  const ro = join(m.home, "read-only");
  mkdirSync(ro);
  chmodSync(ro, 0o500);
  writeFileSync(join(m.home, ".config", "solobooks", "config.json"), JSON.stringify({ books: old, backups: ro }));
  const mcp = await inProcessMcp(old, m.env);
  const r = await mcp.call("client_list", {});
  await mcp.close();
  chmodSync(ro, 0o700);
  expect(r.isError).toBe(true);
  expect(r.structuredContent.field).toBe("backups");
  expect(fileHash(path)).toBe(hash);
  expect(new Database(path, { readonly: true }).query("PRAGMA user_version").get()).toEqual({ user_version: 5 });
}, 30_000);

test("ISC-93 synced folder: live books in iCloud, Dropbox, OneDrive or Google Drive get a warning on every write and in doctor", async () => {
  const cases: [string, RegExp][] = [
    ["Library/Mobile Documents/com~apple~CloudDocs/books", /inside iCloud Drive/],
    ["Library/CloudStorage/OneDrive-Personal/books", /inside a cloud drive \(Dropbox, OneDrive or Google Drive\)/],
    ["Dropbox/books", /inside Dropbox/],
    ["OneDrive/books", /inside OneDrive/],
    ["Google Drive/books", /inside Google Drive/],
  ];
  for (const [where, says] of cases) {
    const m = await machine(where);
    const warning = expect.stringMatching(new RegExp(`^The books folder ${m.dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is inside .*, and syncing a live books file can corrupt it, so move the books out with solobooks move --to <dir>, such as ${join(m.home, "solobooks")}\\.$`));
    for (const n of ["Acme", "Beta"]) {
      const r = await sb(m.env, ["client", "add", "--name", n, "--source", "person"]);
      expect(r.code).toBe(0);
      expect(r.out.warnings).toEqual([warning]);
      expect(r.out.warnings[0]).toMatch(says);
    }
    expect((await sb(m.env, ["client", "add", "--name", "Gamma", "--source", "person", "--dry-run"])).out.warnings).toEqual([warning]);
    const mcp = await inProcessMcp(m.dir, m.env);
    expect((await mcp.call("client_add", { name: "Delta", source: "agent:test" })).structuredContent.warnings).toEqual([warning]);
    await mcp.close();
    const doctor = JSON.parse((await install("doctor", [], m.env)).stdout);
    expect(doctor.warnings).toContainEqual(warning);
  }
  // Outside a synced folder, no warning.
  const m = await machine();
  expect((await sb(m.env, ["client", "add", "--name", "Acme", "--source", "person"])).out.warnings).toBeUndefined();
}, 60_000);
