import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DEFAULT_PORT } from "./core/gate.ts";
import { Refusal } from "./core/refusal.ts";

export type Env = Record<string, string | undefined>;

export const DB_FILE = "solobooks.sqlite";

/** The person's home folder, from the environment only, so a run can be pointed at a scratch home. */
export function homeDir(env: Env): string | null {
  return env.HOME || env.USERPROFILE || null;
}

/** Where `solobooks setup` records the books folder: $XDG_CONFIG_HOME/solobooks, else ~/.config/solobooks. */
export function configFile(env: Env): string | null {
  const home = homeDir(env);
  const base = env.XDG_CONFIG_HOME || (home ? join(home, ".config") : null);
  return base ? join(base, "solobooks", "config.json") : null;
}

/** What setup and the durability commands record: the books folder, and the folder daily backups go to. */
export type Config = { books?: string; backups?: string };

/** The recorded settings, or none when setup hasn't run. */
export function readConfig(env: Env): Config {
  const file = configFile(env);
  if (!file || !existsSync(file)) return {};
  let c: unknown;
  try {
    c = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Refusal(`The settings file ${file} isn't valid JSON, so run solobooks setup to write it again.`, "config");
  }
  if (typeof c !== "object" || c === null || Array.isArray(c)) {
    throw new Refusal(`The settings file ${file} must hold a JSON object, so run solobooks setup to write it again.`, "config");
  }
  return c as Config;
}

/** The books folder: `--books <dir>` wins, then SOLOBOOKS_DIR, then the folder setup recorded. Otherwise it refuses. */
export function booksDir(flag: string | undefined, env: Env): string {
  const dir = flag ?? env.SOLOBOOKS_DIR ?? readConfig(env).books;
  if (!dir || !dir.trim()) {
    throw new Refusal("Say which folder holds the books with --books <dir> or SOLOBOOKS_DIR, or run solobooks setup to pick one.", "books");
  }
  return dir;
}

/** Records settings, keeping the ones not given. Returns the settings file, or null when there is no home folder. */
export function saveConfig(env: Env, patch: Config): string | null {
  const file = configFile(env);
  if (!file) return null;
  writeIfChanged(file, JSON.stringify({ ...readConfig(env), ...patch }, null, 2) + "\n");
  return file;
}

export function booksFile(dir: string): string {
  return join(dir, DB_FILE);
}

/** The clock. SOLOBOOKS_NOW pins it (ISO 8601) so runs can be compared exactly. */
export function now(env: Env): string {
  return env.SOLOBOOKS_NOW ?? new Date().toISOString();
}

/** The approval page's port: SOLOBOOKS_PORT, or 7317. */
export function pagePort(env: Env): number {
  const raw = env.SOLOBOOKS_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Refusal("SOLOBOOKS_PORT must be a whole number from 1 to 65535.", "port");
  return n;
}

/** The approval page's address, which pending actions point the person to. */
export function pageUrl(env: Env, port = pagePort(env)): string {
  return `http://localhost:${port}/`;
}

/** Expands a leading ~ and makes the path absolute. */
export function absolute(p: string, home: string): string {
  return resolve(p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);
}

/** Folders that sync files while solobooks writes them, which can corrupt a live SQLite file. */
export function syncedFolder(dir: string, home: string): string | null {
  const real = (p: string) => {
    let at = p;
    while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
    try {
      return join(realpathSync(at), p.slice(at.length));
    } catch {
      return p;
    }
  };
  const under = (p: string, base: string) => p === base || p.startsWith(base + sep);
  const h = (...parts: string[]) => join(home, ...parts);
  const named: [string, string][] = [
    [h("Library", "Mobile Documents"), "iCloud Drive"],
    [h("Library", "CloudStorage"), "a cloud drive (Dropbox, OneDrive or Google Drive)"],
    [h("Dropbox"), "Dropbox"],
    [h("Google Drive"), "Google Drive"],
    [h("My Drive"), "Google Drive"],
    [h("iCloudDrive"), "iCloud Drive"],
  ];
  // iCloud's Desktop & Documents option on a Mac, and OneDrive's folder backup on Windows, sync these two.
  if (process.platform !== "linux") named.push([h("Documents"), "Documents, which iCloud or OneDrive may sync"], [h("Desktop"), "Desktop, which iCloud or OneDrive may sync"]);
  for (const p of new Set([dir, real(dir)])) {
    for (const [base, what] of named) if (under(p, base)) return what;
    const rel = p.startsWith(home + sep) ? p.slice(home.length + 1) : "";
    if (/^OneDrive( |-|$)/.test(rel.split(sep)[0] ?? "")) return "OneDrive";
  }
  return null;
}

/** Writes a file whole (a temporary file, then a rename), only when its text changes. Returns whether it did. */
export function writeIfChanged(file: string, text: string): boolean {
  if (existsSync(file) && readFileSync(file, "utf8") === text) return false;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.solobooks-${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
  return true;
}
