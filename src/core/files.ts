import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Books } from "./db.ts";
import type { PendingFile } from "./op.ts";
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
