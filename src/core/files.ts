import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import type { Books } from "./db.ts";
import type { Ctx, PendingFile } from "./op.ts";
import { Refusal } from "./refusal.ts";

/** The folder that holds these books, or null for books held in memory. */
export function booksFolder(db: Books): string | null {
  return db.filename === ":memory:" || db.filename === "" ? null : dirname(db.filename);
}

export function saveFiles(db: Books, files: PendingFile[]): void {
  if (files.length === 0) return;
  const dir = booksFolder(db);
  if (!dir) throw new Refusal("These books are held in memory, so there is no folder to save files in.", files[0]!.field);
  for (const f of files) {
    const abs = join(dir, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.bytes);
  }
}

export function sha256(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

const MAX_KEPT_BYTES = 25 * 1024 * 1024;

/**
 * Reads a file the person named (a receipt, a usage export) and queues a copy under `folder` in the books folder,
 * named by its sha256 so the same file is kept once. Returns where it will live, relative to the books folder.
 */
export function keepFile(ctx: Ctx, inputPath: string, folder: string, field: string, what: string) {
  const path = resolve(inputPath);
  let bytes: Uint8Array;
  try {
    if (!statSync(path).isFile()) throw new Error("not a file");
    if (statSync(path).size > MAX_KEPT_BYTES) throw new Refusal(`The ${what} is larger than 25 MB, so shrink it first.`, field);
    bytes = readFileSync(path);
  } catch (e) {
    if (e instanceof Refusal) throw e;
    throw new Refusal(`There is no readable file at ${field}.`, field);
  }
  const sha = sha256(bytes);
  const ext = extname(path).toLowerCase();
  const file = `${folder}/${sha}${/^\.[a-z0-9]{1,5}$/.test(ext) ? ext : ""}`;
  ctx.files.push({ path: file, bytes, field });
  return { file, sha, size: bytes.length };
}
