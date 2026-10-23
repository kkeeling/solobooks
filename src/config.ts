import { join } from "node:path";
import { DEFAULT_PORT } from "./core/gate.ts";
import { Refusal } from "./core/refusal.ts";

export type Env = Record<string, string | undefined>;

export const DB_FILE = "solobooks.sqlite";

/** The books folder: `--books <dir>` wins, then SOLOBOOKS_DIR. There is no default location. */
export function booksDir(flag: string | undefined, env: Env): string {
  const dir = flag ?? env.SOLOBOOKS_DIR;
  if (!dir || !dir.trim()) {
    throw new Refusal("Say which folder holds the books with --books <dir> or the SOLOBOOKS_DIR variable.", "books");
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
