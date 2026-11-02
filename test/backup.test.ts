import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { install, run } from "../src/cli.ts";
import { OPS } from "../src/core/perform.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";
import { afterWrite, BACKUP_RULE } from "../src/durability.ts";
import { dbPath, dumpFile, fileHash, ROOT, tempDir } from "./support/books.ts";
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

test("ISC-183: the guide tells an agent with no shell to give the person the exact backup set or move command, and neither is a tool", () => {
  const guide = readFileSync(join(ROOT, "skills/solobooks/references/backups.md"), "utf8");
  const skill = readFileSync(join(ROOT, "skills/solobooks/SKILL.md"), "utf8");
  const said = guide.split("\n").find((l) => l.includes("no shell"))!;
  expect(said).toContain("`backup set` and `move`");
  expect(said).toContain("give the person the exact command");
  expect(said).toContain("paste into a terminal");
  for (const row of ["solobooks backup set --folder", "solobooks move --to"]) {
    const line = skill.split("\n").find((l) => l.includes(row))!;
    expect(line).toContain("CLI only");
    expect(line).toContain("with no shell, give the person the exact command");
  }
  const names = OPS.map((o) => o.name);
  expect(names).not.toContain("backup_set");
  expect(names).not.toContain("move");
});

/** A machine with its folder picked, so it holds a real copy for DAY1 that old copies can be cloned from. */
async function machineWithBackups() {
  const m = await machine();
  expect((await install("backup", ["set", "--folder", "~/backups"], m.env)).code).toBe(0);
  return m;
}

/** Real, restorable copies under the given names. */
function seed(m: { backups: string }, names: string[]) {
  for (const name of names) copyFileSync(join(m.backups, "solobooks-2026-10-22.sqlite"), join(m.backups, name));
}

/** The names of `count` daily copies on consecutive days from `from`. */
function daily(from: string, count: number) {
  return Array.from({ length: count }, (_, i) => `solobooks-${new Date(Date.parse(from) + i * 86_400_000).toISOString().slice(0, 10)}.sqlite`);
}

/** With DAY1's copy, fills the newest 30 places with recent copies, so age alone decides anything older. */
const RECENT = daily("2026-09-23", 29);

const stillThere = (folder: string, names: string[]) => names.filter((n) => existsSync(join(folder, n)));

test("ISC-187: after a write, copies over 30 days old thin to the earliest of each month, and newer ones all stay", async () => {
  const m = await machineWithBackups();
  const old = ["solobooks-2025-12-01.sqlite", "solobooks-2026-01-05.sqlite", "solobooks-2026-03-17.sqlite", "solobooks-2026-09-10.sqlite"];
  const aged = [
    "solobooks-2025-12-31.sqlite",
    "solobooks-2026-01-06.sqlite",
    "solobooks-2026-01-20.sqlite",
    "solobooks-2026-09-11.sqlite",
    "solobooks-2026-09-21.sqlite", // 31 days old
  ];
  const recent = daily("2026-09-22", 30); // the first is 30 days old exactly, and beyond the newest 30
  seed(m, [...old, ...aged, ...recent]);
  const hash = fileHash(join(m.backups, "solobooks-2026-10-22.sqlite"));

  const r = await sb(m.env, ["client", "add", "--name", "Acme", "--source", "person"]);
  expect(r.code).toBe(0);
  expect(backupsIn(m.backups)).toEqual([...old, ...recent, "solobooks-2026-10-22.sqlite"].sort());
  for (const name of backupsIn(m.backups)) expect(fileHash(join(m.backups, name))).toBe(hash);

  // MCP writes thin the same way once the clock has moved. Past the 30 days, the newest 30 still hold from 09-24 on.
  const later = { ...m.env, SOLOBOOKS_NOW: "2026-11-05T12:00:00.000Z" };
  const mcp = await inProcessMcp(m.dir, later);
  expect((await mcp.call("client_add", { name: "Beta", source: "agent:test" })).isError).toBe(false);
  await mcp.close();
  const gone = ["solobooks-2026-09-22.sqlite", "solobooks-2026-09-23.sqlite"];
  expect(stillThere(m.backups, gone)).toEqual([]);
  expect(stillThere(m.backups, old)).toEqual(old);
  expect(stillThere(m.backups, daily("2026-09-24", 28))).toHaveLength(28);
  expect(existsSync(join(m.backups, "solobooks-2026-11-05.sqlite"))).toBe(true);
}, 30_000);

test("ISC-188: only regular files named exactly for a real day are ever removed", async () => {
  const m = await machineWithBackups();
  const others = [
    "solobooks-2025-01-02-before-upgrade-from-v3.sqlite",
    "solobooks-2025-01-02-before-upgrade-from-v3-2.sqlite",
    "solobooks-2025-01-03-2.sqlite",
    "solobooks-2025-01-04.sqlite.bak",
    "solobooks-2025-01-05 (conflicted copy).sqlite",
    "solobooks-2025-01-06-keep.sqlite",
    "Solobooks-2025-01-07.sqlite",
    "solobooks-2025-13-01.sqlite", // no such month, twice, so neither could be the earliest of it
    "solobooks-2025-13-45.sqlite",
    "solobooks-2025-02-30.sqlite", // no such day, after a real copy from that month
    ".solobooks-2025-01-08.sqlite.123.tmp",
    "notes.txt",
  ];
  seed(m, [...others, ...RECENT, "solobooks-2025-01-01.sqlite", "solobooks-2025-01-09.sqlite", "solobooks-2025-02-03.sqlite"]);
  seed(m, ["solobooks-2025-03-02.sqlite", "solobooks-2025-03-03.sqlite"]);
  const elsewhere = join(m.home, "elsewhere.sqlite");
  writeFileSync(elsewhere, "not a backup");
  symlinkSync(elsewhere, join(m.backups, "solobooks-2025-01-10.sqlite"));
  mkdirSync(join(m.backups, "solobooks-2025-01-11.sqlite"));
  mkdirSync(join(m.backups, "solobooks-2025-03-01.sqlite")); // can't stand in as March's earliest copy

  const r = await sb(m.env, ["client", "add", "--name", "Acme", "--source", "person"]);
  expect(r.code).toBe(0);
  expect(r.out.warnings).toEqual([expect.stringContaining("removed 2 old daily backups")]);
  expect(stillThere(m.backups, ["solobooks-2025-01-09.sqlite", "solobooks-2025-03-03.sqlite"])).toEqual([]);
  expect(stillThere(m.backups, others)).toEqual(others);
  expect(stillThere(m.backups, ["solobooks-2025-01-01.sqlite", "solobooks-2025-02-03.sqlite", "solobooks-2025-03-02.sqlite"])).toHaveLength(3);
  expect(lstatSync(join(m.backups, "solobooks-2025-01-10.sqlite")).isSymbolicLink()).toBe(true);
  expect(statSync(join(m.backups, "solobooks-2025-01-11.sqlite")).isDirectory()).toBe(true);
  expect(statSync(join(m.backups, "solobooks-2025-03-01.sqlite")).isDirectory()).toBe(true);
  expect(readFileSync(elsewhere, "utf8")).toBe("not a backup");
}, 30_000);

test("ISC-189: nothing is removed on a read, a dry run or a refused write, through the CLI or MCP, or without a good copy today", async () => {
  const m = await machineWithBackups();
  const old = ["solobooks-2025-01-01.sqlite", "solobooks-2025-01-02.sqlite", "solobooks-2025-01-03.sqlite"];
  seed(m, [...old, ...RECENT]);
  const untouched = () => expect(stillThere(m.backups, old)).toEqual(old);

  expect((await sb(m.env, ["client", "list"])).code).toBe(0);
  untouched();
  expect((await sb(m.env, ["client", "add", "--name", "Acme", "--source", "person", "--dry-run"])).code).toBe(0);
  untouched();
  expect((await sb(m.env, ["client", "add", "--source", "person"])).code).toBe(2); // no name: refused
  untouched();
  const mcp = await inProcessMcp(m.dir, m.env);
  expect((await mcp.call("client_list", {})).isError).toBe(false);
  untouched();
  expect((await mcp.call("client_add", { name: "Acme", source: "agent:test", dry_run: true })).isError).toBe(false);
  untouched();
  expect((await mcp.call("client_add", { source: "agent:test" })).isError).toBe(true);
  untouched();
  // A write parked for the person hasn't happened yet, so it removes nothing and says nothing about backups.
  const instructions = { payment_instructions: "ACH to First Bank" };
  const parkedMcp = (await mcp.call("profile_payment_instructions_set", { ...instructions, source: "agent:test" })).structuredContent;
  expect(parkedMcp).toMatchObject({ status: "pending" });
  expect(parkedMcp.warnings).toBeUndefined();
  untouched();
  await mcp.close();
  const parked = await sb(m.env, ["profile", "payment", "instructions", "set", "--json", JSON.stringify({ payment_instructions: "ACH to Second Bank" }), "--source", "agent:test"]);
  expect(parked.out).toMatchObject({ status: "pending" });
  expect(parked.out.warnings).toBeUndefined();
  untouched();

  // The next day has no copy yet, so nothing goes.
  expect(afterWrite({ ...m.env, SOLOBOOKS_NOW: DAY2 }, false)).toEqual([]);
  untouched();
  // Today's name taken by something that isn't a backup: an empty file, then a folder.
  writeFileSync(join(m.backups, "solobooks-2026-10-23.sqlite"), "");
  const tellsThePerson = [expect.stringContaining("isn't a backup that could be restored")];
  const beta = await sb({ ...m.env, SOLOBOOKS_NOW: DAY2 }, ["client", "add", "--name", "Beta", "--source", "person"]);
  expect(beta.code).toBe(0);
  expect(beta.out.warnings).toEqual(tellsThePerson);
  untouched();
  mkdirSync(join(m.backups, "solobooks-2026-10-24.sqlite"));
  const gamma = await sb({ ...m.env, SOLOBOOKS_NOW: "2026-10-24T12:00:00.000Z" }, ["client", "add", "--name", "Gamma", "--source", "person"]);
  expect(gamma.code).toBe(0);
  expect(gamma.out.warnings).toEqual(tellsThePerson);
  untouched();
  symlinkSync(join(m.backups, "solobooks-2026-10-22.sqlite"), join(m.backups, "solobooks-2026-10-25.sqlite"));
  const delta = await sb({ ...m.env, SOLOBOOKS_NOW: "2026-10-25T12:00:00.000Z" }, ["client", "add", "--name", "Delta", "--source", "person"]);
  expect(delta.code).toBe(0);
  expect(delta.out.warnings).toEqual(tellsThePerson);
  untouched();
}, 30_000);

test("ISC-190: an old copy that can't be removed warns, naming the folder, and the write still happens; one locked on purpose stays quietly while the rest go", async () => {
  const m = await machineWithBackups();
  seed(m, [...RECENT, "solobooks-2025-01-01.sqlite", "solobooks-2025-01-02.sqlite"]);
  chmodSync(m.backups, 0o555);
  try {
    const r = await sb(m.env, ["client", "add", "--name", "Acme", "--source", "person"]);
    expect(r.code).toBe(0);
    expect(r.out.warnings).toEqual([expect.stringContaining(`Some old backups in ${m.backups} couldn't be removed`)]);
    expect(existsSync(join(m.backups, "solobooks-2025-01-02.sqlite"))).toBe(true);
  } finally {
    chmodSync(m.backups, 0o755);
  }
  expect(JSON.stringify((await sb(m.env, ["client", "list"])).out)).toContain("Acme");
  // A folder that can't even be read says that instead, and the write still lands.
  chmodSync(m.backups, 0o000);
  try {
    const r = await sb(m.env, ["client", "add", "--name", "Unread", "--source", "person"]);
    expect(r.code).toBe(0);
    expect(r.out.warnings).toContainEqual(expect.stringContaining(`solobooks couldn't check the old backups in ${m.backups}`));
  } finally {
    chmodSync(m.backups, 0o755);
  }
  expect(JSON.stringify((await sb(m.env, ["client", "list"])).out)).toContain("Unread");
  // A file the system won't delete, such as one locked in Finder, doesn't stop the others and isn't worth a warning.
  if (process.platform === "darwin") {
    seed(m, ["solobooks-2025-02-01.sqlite", "solobooks-2025-02-02.sqlite", "solobooks-2025-02-03.sqlite"]);
    Bun.spawnSync(["chflags", "uchg", join(m.backups, "solobooks-2025-01-02.sqlite")]);
    try {
      const r = await sb(m.env, ["client", "add", "--name", "Beta", "--source", "person"]);
      expect(r.code).toBe(0);
      expect(r.out.warnings).toEqual([expect.stringContaining("removed 2 old daily backups")]);
      expect(existsSync(join(m.backups, "solobooks-2025-01-02.sqlite"))).toBe(true);
      expect(stillThere(m.backups, ["solobooks-2025-02-02.sqlite", "solobooks-2025-02-03.sqlite"])).toEqual([]);
    } finally {
      Bun.spawnSync(["chflags", "nouchg", join(m.backups, "solobooks-2025-01-02.sqlite")]);
    }
  }
}, 30_000);

test("ISC-191: backup set, its help and the guide state the rule and how to keep a copy, and nothing says every copy is kept", async () => {
  const m = await machine();
  const set = JSON.parse((await install("backup", ["set", "--folder", "~/backups"], m.env)).stdout);
  const help = (await run(["help"], m.env)).stdout;
  const guide = readFileSync(join(ROOT, "skills/solobooks/references/backups.md"), "utf8");
  expect(BACKUP_RULE).toContain("earliest copy of each month");
  for (const text of [set.next as string, help, guide]) {
    expect(text).toContain(BACKUP_RULE);
    expect(text).toContain("rename it");
    expect(text).not.toContain("keeps every one");
  }
}, 30_000);

test("ISC-192: under a clock that jumps a year ahead, one write leaves the newest 30 copies", async () => {
  const m = await machineWithBackups();
  seed(m, RECENT);
  const ahead = { ...m.env, SOLOBOOKS_NOW: "2027-10-22T12:00:00.000Z" };
  expect((await sb(ahead, ["client", "add", "--name", "Acme", "--source", "person"])).code).toBe(0);
  // The new copy takes one of the 30 places, so the oldest of them, September's earliest, stays as September's.
  expect(stillThere(m.backups, RECENT)).toEqual(RECENT);
  expect(existsSync(join(m.backups, "solobooks-2026-10-22.sqlite"))).toBe(true);
  expect(existsSync(join(m.backups, "solobooks-2027-10-22.sqlite"))).toBe(true);
}, 30_000);

test("ISC-193: a damaged copy never stands in as a month's earliest, and a month with no good copy loses nothing", async () => {
  const m = await machineWithBackups();
  seed(m, [...RECENT, "solobooks-2025-03-05.sqlite", "solobooks-2025-03-09.sqlite", "solobooks-2025-04-05.sqlite", "solobooks-2025-04-06.sqlite"]);
  const good = readFileSync(join(m.backups, "solobooks-2026-10-22.sqlite"));
  writeFileSync(join(m.backups, "solobooks-2025-03-01.sqlite"), ""); // empty
  writeFileSync(join(m.backups, "solobooks-2025-04-01.sqlite"), good.subarray(0, 4096)); // cut off
  writeFileSync(join(m.backups, "solobooks-2025-05-01.sqlite"), "not a database");
  writeFileSync(join(m.backups, "solobooks-2025-05-02.sqlite"), "");
  // Damaged inside, with a first page that still reads as books.
  const hollow = Buffer.from(good);
  hollow.fill(0, 4096);
  writeFileSync(join(m.backups, "solobooks-2025-06-01.sqlite"), hollow);
  seed(m, ["solobooks-2025-06-02.sqlite", "solobooks-2025-06-03.sqlite"]);

  expect((await sb(m.env, ["client", "add", "--name", "Acme", "--source", "person"])).code).toBe(0);
  expect(stillThere(m.backups, ["solobooks-2025-03-05.sqlite", "solobooks-2025-04-05.sqlite", "solobooks-2025-06-02.sqlite"])).toHaveLength(3);
  expect(stillThere(m.backups, ["solobooks-2025-03-09.sqlite", "solobooks-2025-04-06.sqlite", "solobooks-2025-06-03.sqlite"])).toEqual([]);
  // The damaged ones stay too: removing them is no part of the rule.
  expect(stillThere(m.backups, ["solobooks-2025-03-01.sqlite", "solobooks-2025-04-01.sqlite", "solobooks-2025-06-01.sqlite"])).toHaveLength(3);
  expect(stillThere(m.backups, ["solobooks-2025-05-01.sqlite", "solobooks-2025-05-02.sqlite"])).toHaveLength(2);
}, 30_000);

test("ISC-194: thinning more than one copy says so on the write, and one copy ageing out goes unsaid", async () => {
  const m = await machineWithBackups();
  seed(m, [...RECENT, ...daily("2025-01-01", 4)]);
  const many = await sb(m.env, ["client", "add", "--name", "Acme", "--source", "person"]);
  expect(many.out.warnings).toEqual([`solobooks removed 3 old daily backups from ${m.backups}. It keeps ${BACKUP_RULE}.`]);
  seed(m, ["solobooks-2025-02-01.sqlite", "solobooks-2025-02-02.sqlite"]);
  expect((await sb(m.env, ["client", "add", "--name", "Beta", "--source", "person"])).out.warnings).toBeUndefined();
  expect(existsSync(join(m.backups, "solobooks-2025-02-02.sqlite"))).toBe(false);
}, 30_000);
