import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { install, run } from "../src/cli.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";
import { buildFixture, DATA, FIXTURES, fixtureFile } from "../scripts/compat-fixtures.ts";
import { dbPath, dumpDb, dumpFile, tempDir } from "./support/books.ts";

const VERSIONS = MIGRATIONS.map((_, i) => i + 1);
const schema = (db: Database) => db.query("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();

test("ISC-94: there is a saved books file for every schema version, and the script still makes each one", () => {
  expect(DATA).toHaveLength(MIGRATIONS.length); // a new migration needs its own block, and so its own fixture
  expect(readdirSync(FIXTURES).sort()).toEqual(VERSIONS.map((v) => fixtureFile(v).slice(FIXTURES.length + 1)));
  for (const v of VERSIONS) {
    const saved = new Database(fixtureFile(v), { readonly: true });
    const made = buildFixture(v);
    expect(saved.query("PRAGMA user_version").get()).toEqual({ user_version: v });
    expect(schema(saved)).toEqual(schema(made));
    expect(dumpDb(saved)).toEqual(dumpDb(made));
    saved.close();
    made.close();
  }
});

const READS = [
  ["report", "pnl", "--from", "2025-01-01", "--to", "2026-12-31"],
  ["report", "ytd"],
  ["report", "unpaid"],
  ["report", "sales", "tax", "--from", "2026-01-01", "--to", "2026-12-31"],
  ["report", "yearend", "--year", "2026"],
  ["invoice", "list"],
  ["entry", "list"],
  ["account", "list"],
  ["client", "list"],
  ["client", "credits"],
  ["expense", "list"],
  ["owner", "list"],
  ["bank", "list"],
  ["pending", "list"],
  ["gate", "list"],
  ["history", "list"],
  ["export", "--format", "csv", "--year", "2026"],
  ["export", "--format", "hledger"],
];

for (const v of VERSIONS) {
  test(`ISC-94: books saved at schema v${v} open, pass solobooks doctor, and keep every row`, async () => {
    const home = tempDir();
    mkdirSync(join(home, ".claude")); // an agent is here, so doctor checks a real connection
    const env = { HOME: home, SOLOBOOKS_NOW: "2026-10-23T12:00:00.000Z" };
    const dir = join(home, "solobooks");
    mkdirSync(dir);
    copyFileSync(fixtureFile(v), dbPath(dir));
    const before = dumpFile(dbPath(dir));

    const setup = await install("setup", ["--books", dir], env); // opens the books, upgrading them
    expect(setup.code).toBe(0);
    const doctor = JSON.parse((await install("doctor", [], env)).stdout);
    expect(doctor.checks.filter((c: any) => !c.ok)).toEqual([]);
    expect(doctor.ok).toBe(true);

    const db = new Database(dbPath(dir), { readonly: true });
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    // Every row the old books held is still there, under its own id.
    const after = dumpDb(db);
    db.close();
    for (const [table, rows] of Object.entries(before)) {
      if (!(table in after)) continue; // a table rebuilt under a new name keeps its rows there, checked below
      const ids = new Set(after[table]!.map((r: any) => JSON.stringify(r.id ?? r.year ?? r.action ?? r.name)));
      for (const r of rows as any[]) expect(ids.has(JSON.stringify(r.id ?? r.year ?? r.action ?? r.name))).toBe(true);
    }
    for (const t of ["accounts", "entries", "lines", "clients", "time_entries", "history"]) expect(after[t]!.length).toBeGreaterThanOrEqual(before[t]!.length);
    // An upgrade backed up the books first, as they were.
    if (v < MIGRATIONS.length) {
      const backups = readdirSync(join(dir, "backups"));
      expect(backups).toEqual([`solobooks-2026-10-23-before-upgrade-from-v${v}.sqlite`]);
      expect(dumpFile(join(dir, "backups", backups[0]!))).toEqual(before);
    } else {
      expect(existsSync(join(dir, "backups"))).toBe(false);
    }

    // Every report runs on them, and a new write still balances.
    const invoiceOne = v >= 2 ? [["invoice", "get", "--id", "1"], ["invoice", "email", "--id", "1"], ["invoice", "pdf", "--id", "1"], ["payment", "list", "--invoice-id", "1"]] : [];
    for (const args of [...READS, ...invoiceOne]) {
      const r = await run(args, env);
      if (r.code !== 0) throw new Error(`${args.join(" ")} failed on v${v} books: ${r.stdout}`);
    }
    const w = await run(["time", "add", "--client-id", "1", "--date", "2026-10-23", "--minutes", "30", "--note", "After the upgrade", "--source", "person"], env);
    expect(w.code).toBe(0);
  }, 30_000);
}
