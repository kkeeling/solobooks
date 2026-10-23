import { existsSync, linkSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Books } from "./db.ts";

// Backups are consistent copies made by SQLite itself (VACUUM INTO), never a raw copy of a live file, and a backup
// never replaces one already there: each lands under its own dated name, and all of them are kept.

/**
 * Writes a consistent copy of the books into `folder` as `name`. Returns its path, or null when a file of that name
 * is already there, which is left as it was. The copy is made under a temporary name and only then given `name`, so
 * a copy cut short never passes for a finished one.
 */
export function backupInto(db: Books, folder: string, name: string): string | null {
  mkdirSync(folder, { recursive: true });
  const file = join(folder, name);
  if (existsSync(file)) return null;
  const tmp = join(folder, `.${name}.${process.pid}-${crypto.randomUUID()}.tmp`);
  try {
    db.query("VACUUM INTO ?").run(tmp);
    try {
      linkSync(tmp, file); // fails, leaving the other file alone, if one appeared under that name meanwhile
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
      // A drive with no hard links, such as exFAT: fall back to a rename, still never over an existing file.
      if (existsSync(file)) return null;
      renameSync(tmp, file);
    }
    return file;
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

/** Writes a backup under `stem`.sqlite, or `stem`-2.sqlite and so on when that name is taken. Returns its path. */
export function backupAs(db: Books, folder: string, stem: string): string {
  for (let n = 1; ; n++) {
    const file = backupInto(db, folder, n === 1 ? `${stem}.sqlite` : `${stem}-${n}.sqlite`);
    if (file) return file;
  }
}
