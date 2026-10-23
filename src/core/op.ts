import type { Books } from "./db.ts";
import type { Fields } from "./validate.ts";

/** A file an operation wants saved in the books folder. perform() writes it; operations never touch the folder. */
export interface PendingFile {
  /** Relative to the books folder, such as "receipts/<sha256>.pdf". */
  path: string;
  bytes: Uint8Array;
  /** The input field to name if the file can't be saved. */
  field: string;
}

export interface Ctx {
  source: string;
  now: string;
  /** Files to save. For a write they are saved just before commit, and never on a dry run. */
  files: PendingFile[];
  /** The local approval page's address, which a pending action points the person to. */
  page: string;
}

/** What the approval gate guards. The first five have a level the person sets; gate settings always need approval. */
export type GateAction = "invoice_issue" | "invoice_void" | "invoice_credit" | "payment_instructions" | "payment_unmatched" | "gate_settings";

/** One thing solobooks can do. The CLI and the MCP server are both generated from these. */
export interface Op {
  /** snake_case; the CLI spells it as two words ("client_add" is `solobooks client add`). */
  name: string;
  kind: "read" | "write";
  /** A write that removes a record. */
  destructive?: boolean;
  /** A read that saves a file into the books folder (an invoice PDF), so it isn't read-only to MCP. */
  savesFile?: boolean;
  description: string;
  fields: Fields;
  /** For a gated write: which gated action this input is, or null when it touches nothing gated. */
  gate?(input: any): GateAction | null;
  /** Writes are synchronous so they run inside one transaction; only reads may return a promise. */
  run(db: Books, input: any, ctx: Ctx): Record<string, unknown> | Promise<Record<string, unknown>>;
}
