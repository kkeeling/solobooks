import type { Books } from "./db.ts";
import { hasPasskey, levelToApprove, pendingView, promptFor, requirePending, stillAsShown } from "./gate.ts";
import { type NewPasskey, spendPasskey, type VerifiedPasskey } from "./passkey.ts";
import { findOp, type Outcome, runWrite } from "./perform.ts";
import { Refusal } from "./refusal.ts";

// The person's side of the gate. Nothing here is an operation, so no CLI command or MCP tool reaches it: only the
// local approval page and the agent app's own approval prompt (MCP elicitation) call it.

export type Via = "page" | "elicitation";

export interface Approval {
  via: Via;
  /** Draft invoices the person pulled out of a batch before approving; they stay drafts. */
  exclude?: number[];
  /** Required when the action is at passkey level; only the page can make one. */
  passkey?: VerifiedPasskey;
}

export interface When {
  now: string;
  page: string;
}

function outcome(f: () => Record<string, unknown>): Outcome {
  try {
    return { ok: true, result: f() };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, refusal: e.toJSON() };
    throw e;
  }
}

function requireOpen(db: Books, id: number) {
  const p = requirePending(db, id);
  if (p.status !== "pending") throw new Refusal(`Pending action ${id} was already ${p.status}.`, "pending_id");
  return p;
}

/** Runs exactly what was parked, less any drafts pulled from a batch, as one write with one history row. */
export function approvePending(db: Books, id: number, a: Approval, when: When): Outcome {
  const exclude = a.exclude ?? [];
  const input = { pending_id: id, via: a.via, exclude };
  return outcome(() =>
    runWrite(db, { name: "pending_approve", input, source: `person:${a.via}`, dryRun: false, ...when }, (ctx) => {
      const p = requireOpen(db, id);
      if (levelToApprove(db, p) === "passkey") {
        if (a.via !== "page" || !spendPasskey(a.passkey, id)) {
          throw new Refusal("This action is set to passkey, so approve it with your passkey on the approval page.", "passkey");
        }
        db.query("UPDATE passkeys SET counter = ? WHERE credential_id = ?").run(a.passkey!.new_counter, a.passkey!.credential_id);
      }
      let run = p.input;
      if (exclude.length > 0) {
        const ids: number[] | undefined = p.input.ids;
        if (p.op !== "invoice_issue" || !ids) throw new Refusal("Only a batch of invoices can have drafts pulled out of it.", "exclude");
        const stray = exclude.find((x) => !ids.includes(x));
        if (stray !== undefined) throw new Refusal(`Draft invoice ${stray} isn't in this batch.`, "exclude");
        const kept = ids.filter((x) => !exclude.includes(x));
        if (kept.length === 0) throw new Refusal("Pulling every invoice leaves nothing to issue, so reject the batch instead.", "exclude");
        run = { ...p.input, ids: kept };
      }
      // Records the action makes carry the source that asked for it; the history row shows who approved it.
      const op = findOp(p.op)!;
      const asked = { ...ctx, source: p.source };
      // A draft edited, a client changed or a level moved since the person was asked would make this a different action.
      const shown = exclude.length ? p.items.filter((it) => !exclude.includes(it.invoice_id as number)) : p.items;
      if (!stillAsShown(shown, promptFor(db, op, run, asked, p.action).items)) {
        throw new Refusal("What this would do has changed since the person was asked, so reject it and ask again.", "pending_id");
      }
      const result = op.run(db, run, asked) as Record<string, unknown>;
      db.query("UPDATE pending_actions SET status = 'approved', decided_at = ?, decided_via = ?, excluded = ?, result = ? WHERE id = ?").run(
        ctx.now,
        a.via,
        JSON.stringify(exclude),
        JSON.stringify(result),
        id,
      );
      return { status: "approved", pending: pendingView(db, id, ctx.page), result };
    }),
  );
}

/** Closes a pending action with no effect. */
export function rejectPending(db: Books, id: number, via: Via, when: When): Outcome {
  return outcome(() =>
    runWrite(db, { name: "pending_reject", input: { pending_id: id, via }, source: `person:${via}`, dryRun: false, ...when }, (ctx) => {
      requireOpen(db, id);
      db.query("UPDATE pending_actions SET status = 'rejected', decided_at = ?, decided_via = ? WHERE id = ?").run(ctx.now, via, id);
      return { status: "rejected", pending: pendingView(db, id, ctx.page) };
    }),
  );
}

/** Stores the passkey the person registered on the page. The first one is trusted on first use; there is only one. */
export function registerPasskey(db: Books, k: NewPasskey, when: When): Outcome {
  const input = { credential_id: k.credential_id, aaguid: k.aaguid };
  return outcome(() =>
    runWrite(db, { name: "passkey_register", input, source: "person:page", dryRun: false, ...when }, (ctx) => {
      if (hasPasskey(db)) throw new Refusal("These books already have a passkey, so use that one.", "passkey");
      db.query(
        "INSERT INTO passkeys (credential_id, public_key, counter, transports, aaguid, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(k.credential_id, k.public_key, k.counter, k.transports, k.aaguid, ctx.now, ctx.source);
      return { passkey: { credential_id: k.credential_id, aaguid: k.aaguid, created_at: ctx.now } };
    }),
  );
}
