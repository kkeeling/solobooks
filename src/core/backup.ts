import { Database } from "bun:sqlite";
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Books } from "./db.ts";

// Backups are consistent copies made by SQLite itself (VACUUM INTO), never a raw copy of a live file, and a backup
// never replaces one already there: each lands under its own dated name. Only daily copies ever go, as they age.

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

/** The day a daily copy's name stands for, counted in days, or null for any other name, including a date that doesn't exist. */
function dailyCopyDay(name: string): number | null {
  const m = /^solobooks-(\d{4})-(\d{2})-(\d{2})\.sqlite$/.exec(name);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d.getTime() / 86_400_000 : null;
}

/** Whether a file really is a backup that could be restored: an empty or cut-off file is not. */
function restorable(file: string): boolean {
  if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) return false;
  try {
    const db = new Database(file, { readonly: true });
    try {
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
      return version > 0 && db.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check === "ok";
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

export interface Thinned {
  removed: number;
  stuck: number;
  reason?: string;
  /** Something sits under today's name that couldn't be restored, so nothing was removed. */
  todayUnusable?: boolean;
}

/**
 * Removes daily copies over 30 days old, keeping the earliest restorable copy of each calendar month and the newest
 * 30 copies whatever their dates, so a clock that is wrong for one write can't take recent copies with it. Removes
 * nothing unless today's copy is restorable. Only ever removes a regular file named exactly for a real day. A copy
 * the system won't delete, such as one locked in Finder, was kept on purpose, so it stays and goes unreported.
 */
export function thinDailyBackups(folder: string, today: string): Thinned {
  const copies = readdirSync(folder)
    .sort()
    .flatMap((name) => {
      const day = dailyCopyDay(name);
      // Another write running at the same moment may have removed it already, which is no failure.
      return day !== null && lstatSync(join(folder, name), { throwIfNoEntry: false })?.isFile() ? [{ name, day }] : [];
    });
  const keepFrom = dailyCopyDay(`solobooks-${today}.sqlite`)! - 30;
  const newest = new Set(copies.slice(-30));
  const months = new Map<string, typeof copies>();
  for (const copy of copies) {
    const month = copy.name.slice("solobooks-".length, "solobooks-YYYY-MM".length);
    months.set(month, [...(months.get(month) ?? []), copy]);
  }
  const old = (copy: (typeof copies)[number]) => copy.day < keepFrom && !newest.has(copy);
  // A month down to its one old copy has nothing to decide, so a settled folder opens no files on a write.
  const due = [...months.values()].filter((month) => month.slice(1).some(old));
  const done: Thinned = { removed: 0, stuck: 0 };
  if (due.length === 0) return done;
  const todayCopy = join(folder, `solobooks-${today}.sqlite`);
  if (!restorable(todayCopy)) return { ...done, todayUnusable: lstatSync(todayCopy, { throwIfNoEntry: false }) !== undefined };
  for (const month of due) {
    const keeper = month.find((copy) => restorable(join(folder, copy.name)));
    if (!keeper) continue;
    for (const copy of month.filter((c) => c.day > keeper.day && old(c))) {
      try {
        unlinkSync(join(folder, copy.name));
        done.removed++;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        // ENOENT: another write running at the same moment got there first.
        if (code === "ENOENT" || code === "EPERM") continue;
        done.stuck++;
        done.reason ??= e instanceof Error ? e.message : String(e);
      }
    }
  }
  return done;
}
