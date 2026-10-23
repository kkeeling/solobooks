import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

export type Config = { books?: string };

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
