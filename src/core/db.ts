import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "../db/migrations.ts";

export type Books = Database;

/**
 * Opens a books file (or ":memory:"), applying any pending migrations.
 * The default rollback journal is kept on purpose: a rolled-back dry run then leaves the file byte-identical,
 * with no -wal or -shm files beside it.
 */
export function openBooks(path: string): Books {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

/** A dry run against books that don't exist yet runs on an empty in-memory copy, so no file appears. */
export function openForRun(path: string, dryRun: boolean): Books {
  return dryRun && !existsSync(path) ? openBooks(":memory:") : openBooks(path);
}
