import { requireClient } from "./clients.ts";
import type { Books } from "./db.ts";
import { keepFile } from "./files.ts";
import type { Ctx, Op } from "./op.ts";
import { Refusal } from "./refusal.ts";
import { currency, MAX_CENTS } from "./validate.ts";

// Billable charges: amounts billed back to a client at cost, each waiting for that client's next invoice. A charge may
// name the expense it came out of, or none. Charges are free to change until the invoice billing them is issued.

type ChargeRow = {
  id: number;
  client_id: number;
  date: string;
  amount_cents: number;
  line_text: string;
  reference: string | null;
  expense_id: number | null;
  evidence_file: string | null;
  evidence_sha256: string | null;
  evidence_bytes: number | null;
  source: string;
  deleted_at: string | null;
};

/** A charge that wasn't deleted. */
function chargeRow(db: Books, id: number) {
  return db.query("SELECT * FROM charges WHERE id = ? AND deleted_at IS NULL").get(id) as ChargeRow | null;
}

/** The invoice billing a charge, unless that invoice was voided. */
function billedOn(db: Books, chargeId: number) {
  return db
    .query(
      `SELECT i.id, i.status, i.number, l.id AS line_id FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
       WHERE l.charge_id = ? AND i.status <> 'void'`,
    )
    .get(chargeId) as { id: number; status: string; number: number | null; line_id: number } | null;
}

export function chargeView(db: Books, id: number) {
  const c = chargeRow(db, id)!;
  const inv = billedOn(db, id);
  return {
    id: c.id,
    client_id: c.client_id,
    date: c.date,
    amount_cents: c.amount_cents,
    line_text: c.line_text,
    reference: c.reference,
    expense_id: c.expense_id,
    evidence: c.evidence_file ? { file: c.evidence_file, sha256: c.evidence_sha256, bytes: c.evidence_bytes } : null,
    // waiting: on no invoice yet; on_draft: on a draft; billed: on an issued invoice.
    status: !inv ? "waiting" : inv.status === "draft" ? "on_draft" : "billed",
    invoice: inv ? { invoice_id: inv.id, number: inv.number === null ? null : String(inv.number), status: inv.status } : null,
    source: c.source,
  };
}

/** What is left of an expense to charge, leaving out one charge (the one being edited). */
export function unchargedCents(db: Books, expenseId: number, except: number | null = null): number {
  const e = db.query("SELECT amount_cents FROM expenses WHERE id = ?").get(expenseId) as { amount_cents: number };
  const { n } = db.query("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM charges WHERE expense_id = ? AND id IS NOT ? AND deleted_at IS NULL").get(expenseId, except) as {
    n: number;
  };
  return e.amount_cents - n;
}

function checkExpense(db: Books, expenseId: number, amount: number, except: number | null) {
  if (!db.query("SELECT 1 FROM expenses WHERE id = ?").get(expenseId)) throw new Refusal(`There is no expense with id ${expenseId}.`, "expense_id");
  const left = unchargedCents(db, expenseId, except);
  if (amount > left) {
    throw new Refusal(`Expense ${expenseId} has only ${left} cents left to charge, so this charge of ${amount} cents would bill more than was spent.`, "amount_cents");
  }
}

function checkReference(db: Books, clientId: number, reference: string | null, except: number | null) {
  if (reference === null) return;
  const dup = db.query("SELECT id FROM charges WHERE client_id = ? AND reference = ? AND id IS NOT ? AND deleted_at IS NULL").get(clientId, reference, except) as {
    id: number;
  } | null;
  if (dup) throw new Refusal(`Charge ${dup.id} already bills reference "${reference}" to this client, so this would bill it twice.`, "reference");
}

/** Records a charge. expense_add uses it too, for a cost billed on in full. */
export function addCharge(
  db: Books,
  input: { client_id: number; date: string; amount_cents: number; line_text: string; reference?: string; expense_id?: number; evidence_path?: string },
  ctx: Ctx,
) {
  requireClient(db, input.client_id, "client_id");
  if (input.expense_id !== undefined) checkExpense(db, input.expense_id, input.amount_cents, null);
  checkReference(db, input.client_id, input.reference ?? null, null);
  const evidence = input.evidence_path === undefined ? null : keepFile(ctx, input.evidence_path, "evidence", "evidence_path", "evidence file");
  const { id } = db
    .query(
      `INSERT INTO charges (client_id, date, amount_cents, line_text, reference, expense_id, evidence_file, evidence_sha256, evidence_bytes, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      input.client_id,
      input.date,
      input.amount_cents,
      input.line_text,
      input.reference ?? null,
      input.expense_id ?? null,
      evidence?.file ?? null,
      evidence?.sha ?? null,
      evidence?.size ?? null,
      ctx.source,
    ) as { id: number };
  return chargeView(db, id);
}

function requireCharge(db: Books, id: number) {
  const c = chargeRow(db, id);
  if (!c) throw new Refusal(`There is no charge with id ${id}.`, "id");
  return c;
}

/** A charge on an issued invoice is locked; one on a draft is free, and the draft follows the change. */
function refuseIfIssued(db: Books, id: number) {
  const inv = billedOn(db, id);
  if (inv && inv.status !== "draft") {
    throw new Refusal(`Charge ${id} is billed on issued invoice ${inv.number}, so it can't change; void or credit that invoice instead.`, "id");
  }
}

const fields = {
  client_id: { type: "int", required: true, min: 1, description: "Client the charge is billed to." },
  date: { type: "date", required: true, description: "Day the charge belongs to, YYYY-MM-DD, such as the last day of the usage it bills; the client's next draft whose period ends on or after it picks it up." },
  amount_cents: { type: "int", required: true, min: 1, max: MAX_CENTS, unit: "cents", description: "Amount billed, in cents, at cost: solobooks adds no markup." },
  line_text: { type: "text", required: true, description: "The invoice line the client reads, such as \"OpenAI API usage, Oct 2026\"." },
  reference: {
    type: "text",
    description: "Your own name for what this bills, such as \"openai:etr-key:2026-10\". A second charge with the same reference for the same client is refused, so a rerun can't bill it twice.",
  },
  expense_id: { type: "int", min: 1, description: "The expense this cost came out of, if any. The charges on one expense can't add up to more than it." },
  evidence_path: { type: "text", description: "Path to what the amount came from, such as a usage export; it is copied into the books folder." },
} as const;

const chargeAdd: Op = {
  name: "charge_add",
  kind: "write",
  description:
    "Bill an amount back to a client at cost, such as API usage spent on their app or part of a subscription bought for them. It waits for that client's next draft invoice, which picks up every waiting charge dated on or before its period end and bills it as a pass-through line. A charge needs no expense; name one with expense_id when the cost came out of a recorded expense. Add charges any time after the fact.",
  fields: { ...fields, currency },
  run(db, input, ctx) {
    return { charge: addCharge(db, input, ctx) };
  },
};

const chargeEdit: Op = {
  name: "charge_edit",
  kind: "write",
  description:
    "Change a charge that isn't on an issued invoice; a draft holding it follows the change, or drops it when the client changes or the date moves past the draft's period. unlink_expense and clear_reference remove those.",
  fields: {
    id: { type: "int", required: true, min: 1, description: "Charge id." },
    client_id: { ...fields.client_id, required: false },
    date: { ...fields.date, required: false },
    amount_cents: { ...fields.amount_cents, required: false },
    line_text: { ...fields.line_text, required: false },
    reference: fields.reference,
    expense_id: fields.expense_id,
    evidence_path: fields.evidence_path,
    unlink_expense: { type: "bool", description: "true to drop the charge's link to its expense, freeing that amount of the expense." },
    clear_reference: { type: "bool", description: "true to drop the charge's reference." },
    currency,
  },
  run(db, input, ctx) {
    const old = requireCharge(db, input.id);
    if (input.unlink_expense === true && input.expense_id !== undefined) throw new Refusal("Give expense_id or unlink_expense, not both.", "unlink_expense");
    if (input.clear_reference === true && input.reference !== undefined) throw new Refusal("Give reference or clear_reference, not both.", "clear_reference");
    refuseIfIssued(db, old.id);
    const next = {
      client_id: input.client_id ?? old.client_id,
      date: input.date ?? old.date,
      amount_cents: input.amount_cents ?? old.amount_cents,
      line_text: input.line_text ?? old.line_text,
      reference: input.clear_reference === true ? null : (input.reference ?? old.reference),
      expense_id: input.unlink_expense === true ? null : (input.expense_id ?? old.expense_id),
    };
    requireClient(db, next.client_id, "client_id");
    if (next.expense_id !== null) checkExpense(db, next.expense_id, next.amount_cents, old.id);
    checkReference(db, next.client_id, next.reference, old.id);
    const evidence =
      input.evidence_path === undefined
        ? { file: old.evidence_file, sha: old.evidence_sha256, size: old.evidence_bytes }
        : keepFile(ctx, input.evidence_path, "evidence", "evidence_path", "evidence file");
    db.query(
      `UPDATE charges SET client_id = ?, date = ?, amount_cents = ?, line_text = ?, reference = ?, expense_id = ?,
         evidence_file = ?, evidence_sha256 = ?, evidence_bytes = ?, source = ? WHERE id = ?`,
    ).run(next.client_id, next.date, next.amount_cents, next.line_text, next.reference, next.expense_id, evidence.file, evidence.sha, evidence.size, ctx.source, old.id);
    const draft = billedOn(db, old.id);
    if (draft) {
      const on = db.query("SELECT client_id, period_end FROM invoices WHERE id = ?").get(draft.id) as { client_id: number; period_end: string };
      if (on.client_id !== next.client_id || next.date > on.period_end) {
        db.query("DELETE FROM invoice_lines WHERE id = ?").run(draft.line_id);
      } else {
        db.query("UPDATE invoice_lines SET description = ?, amount_cents = ?, expense_id = ?, item_date = ?, source = ? WHERE id = ?").run(
          next.line_text,
          next.amount_cents,
          next.expense_id,
          next.date,
          ctx.source,
          draft.line_id,
        );
      }
    }
    return { charge: chargeView(db, old.id) };
  },
};

const chargeDelete: Op = {
  name: "charge_delete",
  kind: "write",
  destructive: true,
  description:
    "Delete a charge that isn't on an issued invoice; a draft holding it drops the line. A charge billed only on voided invoices is deleted too, and those voided invoices keep their record of it.",
  fields: { id: { type: "int", required: true, min: 1, description: "Charge id." } },
  run(db, input, ctx) {
    const old = requireCharge(db, input.id);
    refuseIfIssued(db, old.id);
    const voided = db
      .query(
        `SELECT i.number FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
         WHERE l.charge_id = ? AND i.status = 'void' LIMIT 1`,
      )
      .get(old.id) as { number: number } | null;
    const view = chargeView(db, old.id);
    db.query("DELETE FROM invoice_lines WHERE charge_id = ? AND invoice_id IN (SELECT id FROM invoices WHERE status = 'draft')").run(old.id);
    // A voided invoice's line still names the charge, so the row stays as its record, marked deleted; otherwise it goes.
    if (voided) db.query("UPDATE charges SET deleted_at = ?, source = ? WHERE id = ?").run(ctx.now, ctx.source, old.id);
    else db.query("DELETE FROM charges WHERE id = ?").run(old.id);
    return { deleted: { charge: view } };
  },
};

const chargeList: Op = {
  name: "charge_list",
  kind: "read",
  description:
    "List charges with where each stands: waiting (on no invoice yet), on_draft or billed. unbilled_by_client totals what each client has not been billed yet, waiting or on a draft.",
  fields: {
    client_id: { type: "int", min: 1, description: "Only this client's charges." },
    expense_id: { type: "int", min: 1, description: "Only the charges on this expense." },
    unbilled: { type: "bool", description: "true for only the charges not yet on an issued invoice." },
  },
  run(db, input) {
    const ids = db
      .query("SELECT id FROM charges WHERE deleted_at IS NULL AND (?1 IS NULL OR client_id = ?1) AND (?2 IS NULL OR expense_id = ?2) ORDER BY date, id")
      .all(input.client_id ?? null, input.expense_id ?? null) as { id: number }[];
    const all = ids.map((r) => chargeView(db, r.id));
    const charges = input.unbilled === true ? all.filter((c) => c.status !== "billed") : all;
    const totals = new Map<number, { client_id: number; count: number; total_cents: number }>();
    for (const c of all) {
      if (c.status === "billed") continue;
      const t = totals.get(c.client_id) ?? { client_id: c.client_id, count: 0, total_cents: 0 };
      t.count += 1;
      t.total_cents += c.amount_cents;
      totals.set(c.client_id, t);
    }
    return { charges, unbilled_by_client: [...totals.values()].sort((a, b) => a.client_id - b.client_id) };
  },
};

export const chargeOps: Op[] = [chargeAdd, chargeEdit, chargeDelete, chargeList];
