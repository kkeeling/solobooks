import { join } from "node:path";
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
