import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { run } from "../../src/cli.ts";
import { openBooks, type Books } from "../../src/core/db.ts";

export const ROOT = join(import.meta.dir, "..", "..");

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "solobooks-test-"));
}

/** How many accounts every new books file starts with: the Schedule C chart. */
export const CHART_ACCOUNTS = (() => {
  const db = openBooks(":memory:");
  try {
    return (db.query("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n;
  } finally {
    db.close();
  }
})();

/** The id of the nth account a test adds to new books itself, after the chart. */
export const acct = (n: number) => CHART_ACCOUNTS + n;

/** In-memory books with every migration applied. */
export function memBooks(): Books {
  return openBooks(":memory:");
}

/** Runs the CLI in-process against a books folder and parses its JSON output. */
export async function cli(dir: string, args: string[]): Promise<{ code: number; out: any }> {
  const r = await run([...args, "--books", dir], { SOLOBOOKS_NOW: "2026-10-22T12:00:00.000Z" });
  // An export prints its file as it is; everything else is JSON.
  return { code: r.code, out: r.text ? r.stdout : JSON.parse(r.stdout) };
}

/** Like cli(), but throws unless the command succeeded. */
export async function ok(dir: string, args: string[]): Promise<any> {
  const r = await cli(dir, args);
  if (r.code !== 0) throw new Error(`expected success for ${args.join(" ")}: ${JSON.stringify(r.out)}`);
  return r.out;
}

export function dbPath(dir: string): string {
  return join(dir, "solobooks.sqlite");
}

export function fileHash(path: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}

/** Every row of every user table, keyed by table, for whole-database comparison. */
export function dumpFile(path: string): Record<string, unknown[]> {
  const db = new Database(path, { readonly: true });
  try {
    return dumpDb(db);
  } finally {
    db.close();
  }
}

export function dumpDb(db: Database): Record<string, unknown[]> {
  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables) out[name] = db.query(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  return out;
}
