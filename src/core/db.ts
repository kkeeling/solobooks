import { Database } from "bun:sqlite";
import { existsSync, linkSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { migrate, MIGRATIONS } from "../db/migrations.ts";
import { backupAs } from "./backup.ts";
import { today } from "./format.ts";
import { Refusal } from "./refusal.ts";

export type Books = Database;

let fresh: Uint8Array | undefined;

/**
 * New books: every migration applied to nothing, run once per process and then copied. Opening new books is then a
 * copy of this image, not thirteen migrations, which is what made a test suite that opens thousands of books slow.
 */
function freshImage(): Uint8Array {
  if (!fresh) {
    const db = new Database(":memory:", { strict: true });
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    fresh = db.serialize();
    db.close();
  }
  return fresh;
}

/** Writes new, fully migrated books at `path`, unless a file appeared there first. Never overwrites one. */
function placeFresh(path: string): void {
  const tmp = `${path}.solobooks-${process.pid}-${crypto.randomUUID()}.tmp`;
  writeFileSync(tmp, freshImage());
  try {
    linkSync(tmp, path); // fails, leaving the other file alone, if one appeared at path meanwhile
  } catch (e) {
    // A drive with no hard links, such as exFAT: fall back to a rename, still never over an existing file.
    if ((e as NodeJS.ErrnoException).code !== "EEXIST" && !existsSync(path)) renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

export interface OpenOptions {
  /** Start new books when none are there. Only `solobooks setup` asks for this; everything else refuses. */
  create?: boolean;
  /** The folder the person picked for backups. Without one, a backup before an upgrade goes in the books folder's backups/. */
  backups?: string | null;
  /** The clock, which dates a backup's file name. */
  now?: string;
}

const version = (db: Database) => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;

/**
 * Before books saved by an older solobooks are upgraded, a dated copy of them as they were is written. If that copy
 * can't be written, the books are left exactly as they were and nothing is upgraded.
 */
function backUpBeforeUpgrade(db: Database, path: string, o: OpenOptions): void {
  const from = version(db);
  if (from === 0 || from >= MIGRATIONS.length) return;
  const folder = o.backups || join(dirname(path), "backups");
  try {
    backupAs(db, folder, `solobooks-${today(o.now ?? new Date().toISOString())}-before-upgrade-from-v${from}`);
  } catch (e) {
    db.close();
    const why = e instanceof Error ? e.message : String(e);
    throw new Refusal(
      `solobooks couldn't back up these books into ${folder} before upgrading them (${why}), so it left them as they were; choose a backup folder it can write to with solobooks backup set --folder <dir>.`,
      "backups",
    );
  }
}

/** Whether books are really at this path: an empty file, as a failed restore leaves, isn't books. */
export function hasBooks(path: string): boolean {
  return existsSync(path) && statSync(path).size > 0;
}

/** Refuses when the books aren't there, so a moved file or an unplugged drive can never read as new, empty books. */
function refuseMissing(path: string): void {
  if (hasBooks(path)) return;
  const dir = dirname(path);
  throw new Refusal(
    `There are no books in "${dir}", so nothing was done; if they moved or their drive is unplugged, put them back, and to start new books there run solobooks setup --books "${dir}".`,
    "books",
  );
}

/**
 * Opens a books file (or ":memory:"), applying any pending migrations, after backing up books from an older solobooks.
 * The default rollback journal is kept on purpose: a rolled-back dry run then leaves the file byte-identical,
 * with no -wal or -shm files beside it.
 */
export function openBooks(path: string, o: OpenOptions = {}): Books {
  if (path !== ":memory:" && !o.create) refuseMissing(path);
  let db: Database;
  if (path === ":memory:") {
    db = Database.deserialize(freshImage(), { strict: true });
  } else {
    if (o.create) {
      mkdirSync(dirname(path), { recursive: true });
      if (!existsSync(path)) placeFresh(path);
    }
    db = new Database(path, { readwrite: true, create: false, strict: true });
  }
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") backUpBeforeUpgrade(db, path, o);
    migrate(db);
  } catch (e) {
    db.close(); // a file that isn't books, or can't be read, isn't left open
    throw e;
  }
  return db;
}

/**
 * Opens the books for one command. A dry run never changes the folder: against books an older solobooks saved it
 * upgrades a copy in memory, so the file stays byte-identical and no backup is written.
 */
export function openForRun(path: string, dryRun: boolean, o: OpenOptions = {}): Books {
  if (!dryRun) return openBooks(path, o);
  refuseMissing(path);
  const file = new Database(path, { readonly: true, strict: true });
  let old: Uint8Array | null;
  try {
    old = version(file) < MIGRATIONS.length ? file.serialize() : null; // SQLite's own consistent read of the file
  } finally {
    file.close();
  }
  if (!old) return openBooks(path, o);
  const db = Database.deserialize(old, { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}
