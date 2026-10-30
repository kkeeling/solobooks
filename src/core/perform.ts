import { bankOps } from "./bank.ts";
import { chargeOps } from "./charges.ts";
import { clientOps } from "./clients.ts";
import type { Books } from "./db.ts";
import { documentOps } from "./documents.ts";
import { expenseOps } from "./expenses.ts";
import { DEFAULT_PAGE, gateOps, park, refuseIfHeld, requiredLevel } from "./gate.ts";
import { saveFiles, sha256 } from "./files.ts";
import { invoiceOps } from "./invoices.ts";
import { assertBalanced, ledgerOps } from "./ledger.ts";
import type { Ctx, Op } from "./op.ts";
import { ownerOps } from "./owner.ts";
import { paymentOps } from "./payments.ts";
import { profileOps } from "./profile.ts";
import { Refusal } from "./refusal.ts";
import { reportOps } from "./reports.ts";
import { salesTaxOps } from "./salestax.ts";
import { yearEndOps } from "./yearend.ts";
import { exportOps } from "./export.ts";
import { timeOps } from "./time.ts";
import { validate } from "./validate.ts";

export const OPS: readonly Op[] = [
  ...profileOps,
  ...clientOps,
  ...timeOps,
  ...expenseOps,
  ...chargeOps,
  ...invoiceOps,
  ...paymentOps,
  ...documentOps,
  ...ledgerOps,
  ...ownerOps,
  ...bankOps,
  ...reportOps,
  ...salesTaxOps,
  ...yearEndOps,
  ...exportOps,
  ...gateOps,
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
  /** The local approval page's address; pending actions point to it. */
  page?: string;
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
  const page = env.page ?? DEFAULT_PAGE;
  if (op.kind === "read") {
    const ctx: Ctx = { source: "", now: env.now, files: [], page };
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
  if (env.idempotency_key !== undefined && (typeof env.idempotency_key !== "string" || !env.idempotency_key.trim())) {
    throw new Refusal("idempotency_key must be non-empty text.", "idempotency_key");
  }
  const key = env.idempotency_key as string | undefined;
  const write: Write = { name: op.name, input, source: env.source.trim(), key, dryRun: env.dry_run === true, now: env.now, page };
  // The gate: a gated action the person hasn't left to the agent is parked as a pending action instead of run.
  const action = typeof op.gate === "function" ? op.gate(input, db) : (op.gate ?? null);
  const level = action === null ? "agent_decides" : requiredLevel(db, action, input);
  if (action !== null && level !== "agent_decides") {
    return runWrite(db, write, (ctx) => park(db, op, input, ctx, action, level, key));
  }
  return runWrite(db, write, (ctx) => {
    refuseIfHeld(db, op.name, input);
    const result = op.run(db, input, ctx);
    if (result instanceof Promise) throw new Error(`${op.name} is a write, so it must finish inside its transaction`);
    return result;
  });
}

/** One write as asked for: what it is, who asked, and how. */
export interface Write {
  name: string;
  input: unknown;
  source: string;
  key?: string;
  dryRun: boolean;
  now: string;
  page: string;
}

/**
 * The one way anything changes the books: the change, the balance check and exactly one history row commit together,
 * or nothing does. A repeated idempotency key returns the first result; a dry run takes the same path and rolls back.
 */
export function runWrite(db: Books, w: Write, change: (ctx: Ctx) => Record<string, unknown>): Record<string, unknown> {
  const payload = canonical({ op: w.name, input: w.input, source: w.source });
  const hash = sha256(payload);

  if (w.key !== undefined) {
    const prior = db.query("SELECT payload_hash, result FROM history WHERE idempotency_key = ?").get(w.key) as
      | { payload_hash: string; result: string }
      | null;
    if (prior) {
      if (prior.payload_hash !== hash) {
        throw new Refusal("This idempotency_key was already used for a different write, so use a new key.", "idempotency_key");
      }
      const result = JSON.parse(prior.result);
      return w.dryRun ? { dry_run: true, result } : result;
    }
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const ctx: Ctx = { source: w.source, now: w.now, files: [], page: w.page };
    const result = change(ctx);
    assertBalanced(db);
    db.query(
      "INSERT INTO history (at, op, source, idempotency_key, payload_hash, payload, result) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(w.now, w.name, w.source, w.key ?? null, hash, payload, JSON.stringify(result));
    if (w.dryRun) {
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
