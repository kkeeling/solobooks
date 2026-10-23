import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { absolute, booksDir, booksFile, DB_FILE, type Env, saveConfig } from "./config.ts";
import { openBooks } from "./core/db.ts";
import { sha256 } from "./core/files.ts";
import { Refusal } from "./core/refusal.ts";
import { flag, needHome, openOptions, syncedWarning } from "./durability.ts";

// `solobooks move`: carries the books to a new folder on this machine, or packs them for the agent to carry to another.

/** Every file under `dir`, as paths relative to it, skipping the folders in `skip`. */
function walk(dir: string, skip: Set<string>, at = dir): string[] {
  return readdirSync(at).flatMap((name) => {
    const abs = join(at, name);
    if (skip.has(abs)) return [];
    return statSync(abs).isDirectory() ? walk(dir, skip, abs) : [relative(dir, abs)];
  });
}

/** Rows per table: what a copy of the books must match. */
function counts(db: Database): Record<string, number> {
  const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, (db.query(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n]));
}

/**
 * `solobooks move --to <empty folder>`: copies the books to a new folder and points the settings at it. The books
 * file is copied by SQLite itself (VACUUM INTO) while a write lock keeps every other writer out, so the copy is
 * consistent and nothing lands in the old books halfway through. Every other file in the books folder (receipts,
 * invoice PDFs, statements) is copied and checked byte for byte. The old folder is left as it was.
 */
export function move(argv: string[], env: Env) {
  const home = needHome(env);
  const from = absolute(booksDir(flag(argv, "books"), env), home);
  const given = flag(argv, "to");
  if (!given || !given.trim()) throw new Refusal("Say which empty folder the books move to with --to <dir>.", "to");
  const to = absolute(given, home);
  if (!existsSync(booksFile(from))) throw new Refusal(`There are no books in ${from} to move.`, "books");
  if (to === from || to.startsWith(from + sep)) throw new Refusal(`The new folder ${to} is inside the books folder ${from}, so choose one outside it.`, "to");
  if (from.startsWith(to + sep)) throw new Refusal(`The books folder ${from} is inside the new folder ${to}, so choose an empty folder elsewhere.`, "to");
  if (existsSync(to) && (!statSync(to).isDirectory() || readdirSync(to).length > 0)) {
    throw new Refusal(`The folder ${to} isn't empty, so choose an empty or new folder for the books.`, "to");
  }

  const db = openBooks(booksFile(from), openOptions(env)); // books from an older solobooks are backed up and upgraded first
  const lock = new Database(booksFile(from), { strict: true });
  const existed = existsSync(to);
  let files: string[] = [];
  try {
    lock.exec("PRAGMA busy_timeout = 5000");
    lock.exec("BEGIN IMMEDIATE"); // other writers wait (and give up) until the move is done; reads still work
    mkdirSync(to, { recursive: true });
    db.query("VACUUM INTO ?").run(booksFile(to));

    const live = new Set([DB_FILE, `${DB_FILE}-journal`, `${DB_FILE}-wal`, `${DB_FILE}-shm`].map((f) => join(from, f)));
    files = walk(from, live);
    for (const rel of files) {
      const dest = join(to, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(from, rel), dest);
      if (sha256(readFileSync(dest)) !== sha256(readFileSync(join(from, rel)))) {
        throw new Refusal(`${rel} didn't copy to ${to} intact, so the books stay where they are; check the new folder's drive and try again.`, "to");
      }
    }
    const copy = new Database(booksFile(to), { readonly: true });
    try {
      const check = (copy.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
      if (check !== "ok" || JSON.stringify(counts(copy)) !== JSON.stringify(counts(db))) {
        throw new Refusal(`The copy of the books in ${to} doesn't match the books in ${from}, so the books stay where they are.`, "to");
      }
    } finally {
      copy.close();
    }
  } catch (e) {
    // A move cut short leaves the new folder as it was found, so it can simply be run again.
    rmSync(to, { recursive: true, force: true });
    if (existed) mkdirSync(to);
    throw e;
  } finally {
    if (lock.inTransaction) lock.exec("ROLLBACK");
    lock.close();
    db.close();
  }
  const settings = saveConfig(env, { books: to });
  const warnings = [syncedWarning(to, env)].filter((w): w is string => w !== null);
  if (env.SOLOBOOKS_DIR) warnings.push(`SOLOBOOKS_DIR still says ${env.SOLOBOOKS_DIR}, which wins over the settings, so point it at ${to} or unset it.`);
  return {
    from,
    to,
    books: booksFile(to),
    files: files.length,
    settings,
    warnings,
    next: `solobooks now uses the books in ${to}. The old folder ${from} is left as it was; once the reports from the new folder look right, the person can delete it. To carry the books to another machine, copy the new folder there and run solobooks setup --books <that folder>.`,
  };
}
