import { Database } from "bun:sqlite";
import { existsSync, linkSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "../db/migrations.ts";

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
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  } finally {
    unlinkSync(tmp);
  }
}

/**
 * Opens a books file (or ":memory:"), applying any pending migrations.
 * The default rollback journal is kept on purpose: a rolled-back dry run then leaves the file byte-identical,
 * with no -wal or -shm files beside it.
 */
export function openBooks(path: string): Books {
  let db: Database;
  if (path === ":memory:") {
    db = Database.deserialize(freshImage(), { strict: true });
  } else {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) placeFresh(path);
    db = new Database(path, { create: true, strict: true });
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

/** A dry run against books that don't exist yet runs on an empty in-memory copy, so no file appears. */
export function openForRun(path: string, dryRun: boolean): Books {
  return dryRun && !existsSync(path) ? openBooks(":memory:") : openBooks(path);
}
