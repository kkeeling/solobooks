import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { absolute, booksDir, booksFile, type Env, homeDir, now, readConfig, saveConfig, syncedFolder } from "./config.ts";
import { backupInto, thinDailyBackups, type Thinned } from "./core/backup.ts";
import { type Books, hasBooks, openBooks, type OpenOptions } from "./core/db.ts";
import { today } from "./core/format.ts";
import { Refusal } from "./core/refusal.ts";

// Durability: a dated backup each day the books change, thinned as it ages, and a warning while the live books sit in a synced folder.
// solobooks only ever writes copies on this machine; getting them off it is the person's or their agent's job.

/** What stays in the backup folder, as every message and guide states it. */
export const BACKUP_RULE = "every copy for 30 days, and always your newest 30, then the earliest copy of each month, and every copy made before an upgrade";

/** How the adapters open books: with the person's backup folder and the clock, for a backup before an upgrade. */
export function openOptions(env: Env): OpenOptions {
  return { backups: backupFolder(env), now: now(env) };
}

/** The folder the person picked for backups, or null when they haven't picked one. */
export function backupFolder(env: Env): string | null {
  return readConfig(env).backups ?? null;
}

/** The warning for live books inside a synced folder, or null when they aren't in one. */
export function syncedWarning(dir: string, env: Env): string | null {
  const home = homeDir(env);
  const synced = home ? syncedFolder(absolute(dir, home), home) : null;
  if (!synced || !home) return null;
  return `The books folder ${absolute(dir, home)} is inside ${synced}, and syncing a live books file can corrupt it, so move the books out with solobooks move --to <dir>, such as ${join(home, "solobooks")}.`;
}

/** Today's backup file name. The clock (SOLOBOOKS_NOW when set) decides what today is. */
export const dailyName = (env: Env) => `solobooks-${today(now(env))}.sqlite`;

/**
 * The day's backup: the first time the books are about to change on a given day, a copy of them as they stand goes
 * to the backup folder under that day's date. Later writes that day find it there and write nothing. Returns a
 * warning when the backup couldn't be written; the write itself still goes ahead.
 */
export function dailyBackup(db: Books, env: Env): string | null {
  const folder = backupFolder(env);
  if (!folder) return null;
  try {
    // A folder that went missing, such as an unplugged drive, is never quietly made again somewhere else.
    if (!existsSync(folder)) throw new Error("the folder isn't there");
    backupInto(db, folder, dailyName(env));
    return null;
  } catch (e) {
    return `Today's backup couldn't be written to ${folder} (${e instanceof Error ? e.message : e}), so check that folder or pick another with solobooks backup set --folder <dir>.`;
  }
}

/**
 * What runs before every write through the CLI or MCP: the day's backup (never on a dry run, which changes nothing),
 * and the warnings the write's result carries.
 */
export function beforeWrite(db: Books, dir: string, env: Env, dryRun: boolean): string[] {
  const warnings: string[] = [];
  const backup = dryRun ? null : dailyBackup(db, env);
  if (backup) warnings.push(backup);
  const synced = syncedWarning(dir, env);
  if (synced) warnings.push(synced);
  return warnings;
}

/**
 * What runs once a write has gone through: thins old daily copies, so a refused write or a dry run removes nothing and
 * the result can say what went. One copy ageing out is the everyday case and goes unsaid; more than that gets told.
 */
export function afterWrite(env: Env, dryRun: boolean): string[] {
  const folder = backupFolder(env);
  if (dryRun || !folder || !existsSync(folder)) return [];
  let thinned: Thinned;
  try {
    thinned = thinDailyBackups(folder, today(now(env)));
  } catch (e) {
    return [`solobooks couldn't check the old backups in ${folder} (${e instanceof Error ? e.message : e}), so none were removed. Check that folder's permissions.`];
  }
  const warnings: string[] = [];
  if (thinned.todayUnusable) warnings.push(`The file under today's name in ${folder} isn't a backup that could be restored, so today has no good copy and no old backups were removed. Move that file away, and the next write makes a new copy.`);
  if (thinned.removed > 1) warnings.push(`solobooks removed ${thinned.removed} old daily backups from ${folder}. It keeps ${BACKUP_RULE}.`);
  if (thinned.stuck > 0) {
    warnings.push(`Some old backups in ${folder} couldn't be removed (${thinned.reason}), so they stay, which only means the folder holds more copies than it needs. Check that folder's permissions.`);
  }
  return warnings;
}

/** A write's result with the warnings added, when there are any. */
export function withWarnings(result: Record<string, unknown>, warnings: string[]): Record<string, unknown> {
  return warnings.length === 0 ? result : { ...result, warnings: [...((result.warnings as string[] | undefined) ?? []), ...warnings] };
}

/** One flag's value, written as `--name value` or `--name=value`. */
export function flag(argv: string[], name: string): string | undefined {
  const joined = argv.find((a) => a.startsWith(`--${name}=`));
  if (joined !== undefined) {
    const v = joined.slice(name.length + 3);
    if (!v.trim()) throw new Refusal("That flag needs a value after it.", name);
    return v;
  }
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  // An empty value is what an unset shell variable leaves, and it must not mean the current folder.
  if (v === undefined || v.startsWith("--") || !v.trim()) throw new Refusal("That flag needs a value after it.", name);
  return v;
}

/** Refuses anything this command doesn't read, so a typo or an unquoted folder can't quietly put the books somewhere else. */
export function onlyFlags(argv: string[], ...names: string[]): void {
  const takes = names.map((n) => `--${n}`).join(" and ");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      throw new Refusal(`This command doesn't take "${a}"; it takes ${takes}, and a folder with a space in its name needs quotes.`, a.replace(/^-+/, ""));
    }
    const name = a.slice(2).split("=")[0]!;
    if (!names.includes(name)) throw new Refusal(`This command has no --${name} flag; it takes ${takes}.`, name);
    if (!a.includes("=")) i++; // its value
  }
}

export function needHome(env: Env): string {
  const home = homeDir(env);
  if (!home) throw new Refusal("solobooks can't tell where your home folder is, because HOME isn't set.", "HOME");
  return home;
}

/** `solobooks backup set --folder <dir>`: records the backup folder, then writes today's backup there at once. */
export function backupSet(argv: string[], env: Env) {
  const home = needHome(env);
  onlyFlags(argv, "folder", "books");
  const given = flag(argv, "folder");
  if (!given || !given.trim()) throw new Refusal("Say which folder backups go to with --folder <dir>.", "folder");
  const books = flag(argv, "books"); // read now: a bad value has to stop this before anything is created
  const folder = absolute(given, home);
  try {
    mkdirSync(folder, { recursive: true });
    if (!statSync(folder).isDirectory()) throw new Error("it isn't a folder");
  } catch (e) {
    throw new Refusal(`solobooks can't use ${folder} for backups (${e instanceof Error ? e.message : e}), so choose another folder.`, "folder");
  }
  const settings = saveConfig(env, { backups: folder })!;

  // Prove the folder works now, with today's backup, if there are books to back up.
  let dir: string | null = null;
  try {
    dir = booksDir(books, env);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
  }
  let latest: string | null = null;
  if (dir && hasBooks(booksFile(dir))) {
    const db = openBooks(booksFile(dir), openOptions(env));
    try {
      const warning = dailyBackup(db, env);
      if (warning) throw new Refusal(warning, "folder");
      latest = join(folder, dailyName(env));
    } finally {
      db.close();
    }
  }
  return {
    backups: folder,
    settings,
    latest,
    ...(dir && !latest && { warnings: [`There are no books in "${dir}" to back up yet, so no copy was written.`] }),
    next: `solobooks now writes a dated copy of the books here once a day, the first time they change that day. It keeps ${BACKUP_RULE}. To keep any other copy for good, rename it. Getting copies off this machine, such as to another drive or a cloud folder, is up to you or your agent.`,
  };
}
