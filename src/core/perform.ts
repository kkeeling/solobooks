import { clientOps } from "./clients.ts";
import type { Books } from "./db.ts";
import { documentOps } from "./documents.ts";
import { expenseOps } from "./expenses.ts";
import { saveFiles, sha256 } from "./files.ts";
import { invoiceOps } from "./invoices.ts";
import { assertBalanced, ledgerOps } from "./ledger.ts";
import type { Ctx, Op } from "./op.ts";
import { profileOps } from "./profile.ts";
import { Refusal } from "./refusal.ts";
import { reportOps } from "./reports.ts";
import { timeOps } from "./time.ts";
import { validate } from "./validate.ts";

export const OPS: readonly Op[] = [
  ...profileOps,
  ...clientOps,
  ...timeOps,
  ...expenseOps,
  ...invoiceOps,
  ...documentOps,
  ...ledgerOps,
  ...reportOps,
];

export function findOp(name: string): Op | undefined {
  return OPS.find((o) => o.name === name);
}

/** How a write is asked for. These ride alongside the operation's own fields. */
export interface Envelope {
  source?: unknown;
  idempotency_key?: unknown;
  dry_run?: unknown;
  now: string;
}

export type Outcome = { ok: true; result: Record<string, unknown> } | { ok: false; refusal: { reason: string; field: string } };

/** Stable JSON with sorted keys, so equal payloads hash equal. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * Runs one operation. A write is one transaction: the change, the balance check and exactly one history row
 * commit together, or nothing does. A dry run takes the same path and rolls back.
 */
export function perform(db: Books, opName: string, input: unknown, env: Envelope): Outcome {
  try {
    const result = execute(db, opName, input ?? {}, env);
    if (result instanceof Promise) throw new Error(`${opName} finishes asynchronously, so call performAsync`);
    return { ok: true, result };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, refusal: e.toJSON() };
    throw e;
  }
}

/** perform() for callers that can wait, which is what the CLI and MCP use: it also runs the reads that render files. */
export async function performAsync(db: Books, opName: string, input: unknown, env: Envelope): Promise<Outcome> {
  try {
    return { ok: true, result: await execute(db, opName, input ?? {}, env) };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, refusal: e.toJSON() };
    throw e;
  }
}

function execute(
  db: Books,
  opName: string,
  rawInput: unknown,
  env: Envelope,
): Record<string, unknown> | Promise<Record<string, unknown>> {
  const op = findOp(opName);
  if (!op) throw new Refusal("There is no such operation.", "command");
  const input = validate(rawInput, op.fields);
  if (op.kind === "read") {
    const ctx: Ctx = { source: "", now: env.now, files: [] };
    const result = op.run(db, input, ctx);
    if (result instanceof Promise) {
      return result.then((r) => {
        saveFiles(db, ctx.files);
        return r;
      });
    }
    saveFiles(db, ctx.files);
    return result;
  }

  if (typeof env.source !== "string" || !env.source.trim()) {
    throw new Refusal("Every write needs a source saying where it came from, such as agent:claude-code or person.", "source");
  }
  const source = env.source.trim();
  const key = env.idempotency_key;
  if (key !== undefined && (typeof key !== "string" || !key.trim())) {
    throw new Refusal("idempotency_key must be non-empty text.", "idempotency_key");
  }
  const dryRun = env.dry_run === true;
  const payload = canonical({ op: op.name, input, source });
  const hash = sha256(payload);

  if (key !== undefined) {
    const prior = db.query("SELECT payload_hash, result FROM history WHERE idempotency_key = ?").get(key) as
      | { payload_hash: string; result: string }
      | null;
    if (prior) {
      if (prior.payload_hash !== hash) {
        throw new Refusal("This idempotency_key was already used for a different write, so use a new key.", "idempotency_key");
      }
      const result = JSON.parse(prior.result);
      return dryRun ? { dry_run: true, result } : result;
    }
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const ctx: Ctx = { source, now: env.now, files: [] };
    const result = op.run(db, input, ctx);
    if (result instanceof Promise) throw new Error(`${op.name} is a write, so it must finish inside its transaction`);
    assertBalanced(db);
    db.query(
      "INSERT INTO history (at, op, source, idempotency_key, payload_hash, payload, result) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(env.now, op.name, source, key ?? null, hash, payload, JSON.stringify(result));
    if (dryRun) {
      db.exec("ROLLBACK");
      return { dry_run: true, result };
    }
    // Files land before the commit: if saving fails the write rolls back, and an orphan file is the worst case.
    saveFiles(db, ctx.files);
    db.exec("COMMIT");
    return result;
  } catch (e) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw e;
  }
}
