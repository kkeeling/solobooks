import type { Books } from "./db.ts";
import type { Fields } from "./validate.ts";

export interface Ctx {
  source: string;
  now: string;
}

/** One thing solobooks can do. The CLI and the MCP server are both generated from these. */
export interface Op {
  /** snake_case; the CLI spells it as two words ("client_add" is `solobooks client add`). */
  name: string;
  kind: "read" | "write";
  /** A write that removes a record. */
  destructive?: boolean;
  description: string;
  fields: Fields;
  run(db: Books, input: any, ctx: Ctx): Record<string, unknown>;
}
