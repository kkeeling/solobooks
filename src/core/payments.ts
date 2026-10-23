import { linkLine, requireUnmatchedLine } from "./bank.ts";
import type { Books } from "./db.ts";
import { displayNumber, invoiceAccount, openBalance, requireInvoice } from "./invoices.ts";
import { getEntry, namedAccount, postEntry, requireOwnAccount } from "./ledger.ts";
import type { Ctx, Op } from "./op.ts";
import { Refusal } from "./refusal.ts";
import { currency, MAX_CENTS } from "./validate.ts";

// Payments on issued invoices, recorded gross plus fee: a $1,000 invoice paid through a processor that kept $30 is
// $1,000 settled on the invoice, a $30 fee expense and a $970 deposit, which matches the 1099-K. A payment beyond
// what the invoice still owed leaves the rest as a client credit. A refund reverses its payment with a reversing entry.

export const FEE_ACCOUNT = { name: "Payment processing fees", type: "expense" } as const;

type PaymentRow = {
  id: number;
  invoice_id: number;
  date: string;
  amount_cents: number;
  fee_cents: number;
  deposit_account_id: number;
  applied_cents: number;
  credit_cents: number;
  memo: string | null;
  entry_id: number;
  source: string;
};

export function getPayment(db: Books, id: number): PaymentRow | null {
  return db.query("SELECT * FROM payments WHERE id = ?").get(id) as PaymentRow | null;
}

function requirePayment(db: Books, id: number, field = "payment_id"): PaymentRow {
  const p = getPayment(db, id);
  if (!p) throw new Refusal(`There is no payment with id ${id}.`, field);
  return p;
}

/** A client's credit balance: overpayments held for them, less any refunded since. */
export function creditBalance(db: Books, clientId: number): number {
  return (db.query("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM client_credits WHERE client_id = ?").get(clientId) as { n: number }).n;
}

export function paymentView(db: Books, id: number) {
  const p = requirePayment(db, id);
  const inv = requireInvoice(db, p.invoice_id);
  const refund = db.query("SELECT id, date, reason, entry_id, source FROM refunds WHERE payment_id = ?").get(p.id) as Record<string, unknown> | null;
  const credit = db.query("SELECT id, amount_cents FROM client_credits WHERE payment_id = ? AND refund_id IS NULL").get(p.id) as
    | { id: number; amount_cents: number }
    | null;
  return {
    id: p.id,
    invoice_id: p.invoice_id,
    invoice_number: inv.number === null ? null : String(inv.number),
    client_id: inv.client_id,
    date: p.date,
    // Gross, the fee the processor kept, and what reached the account: gross less fee.
    amount_cents: p.amount_cents,
    fee_cents: p.fee_cents,
    deposit_cents: p.amount_cents - p.fee_cents,
    deposit_account_id: p.deposit_account_id,
    applied_cents: p.applied_cents,
    credit_cents: p.credit_cents,
    client_credit: credit ? { id: credit.id, amount_cents: credit.amount_cents, client_balance_cents: creditBalance(db, inv.client_id) } : null,
    invoice_open_cents: openBalance(db, inv),
    // The imported bank line the deposit matched, if any: given when it was recorded, or matched on a later import.
    bank_line_id: (db.query("SELECT line_id FROM bank_matches WHERE entry_id = ? AND account_id = ?").get(p.entry_id, p.deposit_account_id) as { line_id: number } | null)?.line_id ?? null,
    memo: p.memo,
    entry: getEntry(db, p.entry_id),
    refund,
    source: p.source,
  };
}

/**
 * Records a payment on an issued invoice and posts it: the deposit and the fee against what the invoice still owed,
 * with anything beyond that held as a client credit. One function, so the approval gate can wrap it.
 */
export function recordPayment(db: Books, input: Record<string, any>, ctx: Ctx) {
  const inv = requireInvoice(db, input.invoice_id, "invoice_id");
  if (inv.kind !== "invoice") throw new Refusal(`Credit note ${displayNumber(inv)} is owed to the client, so it can't be paid.`, "invoice_id");
  if (inv.status === "draft") throw new Refusal(`Draft invoice ${inv.id} hasn't been issued, so it can't be paid yet.`, "invoice_id");
  if (inv.status === "void") throw new Refusal(`Invoice ${inv.number} is void, so nothing on it can be paid.`, "invoice_id");
  const deposit = requireOwnAccount(db, input.deposit_account_id, "deposit_account_id");
  if (deposit.type !== "asset") {
    throw new Refusal(`Account ${deposit.id} is a liability, and a payment lands in an asset account such as checking or a processor balance.`, "deposit_account_id");
  }
  const fee = input.fee_cents ?? 0;
  if (fee >= input.amount_cents) throw new Refusal("fee_cents must be less than amount_cents, the gross the client paid.", "fee_cents");

  const owed = Math.max(openBalance(db, inv), 0);
  const applied = Math.min(input.amount_cents, owed);
  const credit = input.amount_cents - applied;
  const legs: [number, number][] = [
    [deposit.id, input.amount_cents - fee],
    [namedAccount(db, FEE_ACCOUNT, ctx.source, "fee_cents"), fee],
    [invoiceAccount(db, "receivable", ctx), -applied],
    [invoiceAccount(db, "clientCredits", ctx), -credit],
  ];
  const memo = input.memo ?? null;
  const entry = postEntry(db, input.date, `Payment on invoice ${inv.number} from ${inv.client_name}${memo ? `: ${memo}` : ""}`, legs, ctx.source);
  const { id } = db
    .query(
      `INSERT INTO payments (invoice_id, date, amount_cents, fee_cents, deposit_account_id, applied_cents, credit_cents, memo, entry_id, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(inv.id, input.date, input.amount_cents, fee, deposit.id, applied, credit, memo, entry, ctx.source) as { id: number };
  if (credit > 0) {
    db.query("INSERT INTO client_credits (client_id, date, amount_cents, payment_id, source) VALUES (?, ?, ?, ?, ?)").run(inv.client_id, input.date, credit, id, ctx.source);
  }
  return { payment: paymentView(db, id), entry_id: entry };
}

const paymentAdd: Op = {
  name: "payment_add",
  kind: "write",
  description:
    "Record a client's payment on an issued invoice, gross plus fee: amount_cents is what the client paid, fee_cents what the processor kept, and the rest is the deposit into deposit_account_id. A partial payment leaves the rest still owed; anything beyond what was owed becomes a client credit. Give bank_line_id, the imported bank line the deposit is, to back it with the bank. Gated without one: unless the person lets the agent decide, a payment with no bank line behind it returns a pending action for them to approve.",
  fields: {
    invoice_id: { type: "int", required: true, min: 1, description: "The issued invoice being paid." },
    date: { type: "date", required: true, description: "Day of the payment, YYYY-MM-DD." },
    amount_cents: { type: "int", required: true, min: 1, max: MAX_CENTS, unit: "cents", description: "Gross: what the client paid, before any processor fee." },
    fee_cents: { type: "int", min: 0, max: MAX_CENTS, unit: "cents", description: "What the payment processor kept, such as Stripe's fee. Default 0." },
    deposit_account_id: {
      type: "int", required: true, min: 1,
      description: "The asset account the money landed in, gross less fee: checking, or a processor balance such as Stripe.",
    },
    memo: { type: "text", description: "Anything worth keeping, such as the check number." },
    bank_line_id: {
      type: "int", min: 1,
      description: "The unmatched imported bank line this deposit is: on deposit_account_id, for amount_cents less fee_cents. Without one the payment waits for the person.",
    },
    currency,
  },
  // A receipt or CSV the agent reads could tell it to mark everything paid, so a payment the bank doesn't show is gated.
  gate: (input) => (input.bank_line_id === undefined ? "payment_unmatched" : null),
  run(db, input, ctx) {
    if (input.bank_line_id === undefined) return { payment: recordPayment(db, input, ctx).payment };
    const line = requireUnmatchedLine(db, input.bank_line_id, "bank_line_id");
    if (line.account_id !== input.deposit_account_id) {
      throw new Refusal(`Bank line ${line.id} is on account ${line.account_id}, so the deposit_account_id must be ${line.account_id}.`, "deposit_account_id");
    }
    const deposit = input.amount_cents - (input.fee_cents ?? 0);
    if (line.amount_cents !== deposit) {
      throw new Refusal(`Bank line ${line.id} is ${line.amount_cents} cents, but amount_cents less fee_cents is ${deposit} cents.`, "bank_line_id");
    }
    const r = recordPayment(db, input, ctx);
    linkLine(db, line, r.entry_id, "payment", ctx, "bank_line_id");
    return { payment: paymentView(db, r.payment.id) };
  },
};

const paymentRefund: Op = {
  name: "payment_refund",
  kind: "write",
  description:
    "Refund a payment in full: a reversing entry undoes its deposit, fee and what it settled, so the invoice is owed again, and any client credit it made is taken back. The payment itself is kept, never edited.",
  fields: {
    payment_id: { type: "int", required: true, min: 1, description: "The payment being refunded." },
    date: { type: "date", required: true, description: "Day of the refund, YYYY-MM-DD." },
    reason: { type: "text", required: true, description: "Why it was refunded." },
  },
  run(db, input, ctx) {
    const p = requirePayment(db, input.payment_id);
    if (db.query("SELECT 1 FROM refunds WHERE payment_id = ?").get(p.id)) throw new Refusal(`Payment ${p.id} was already refunded.`, "payment_id");
    if (input.date < p.date) throw new Refusal(`The refund can't be dated before the payment it refunds, on ${p.date}.`, "date");
    const inv = requireInvoice(db, p.invoice_id);
    // The reversing entry: every line of the payment's entry, debit and credit swapped.
    const lines = db.query("SELECT account_id, debit_cents, credit_cents FROM lines WHERE entry_id = ? ORDER BY id").all(p.entry_id) as {
      account_id: number;
      debit_cents: number;
      credit_cents: number;
    }[];
    const legs: [number, number][] = lines.map((l) => [l.account_id, l.credit_cents - l.debit_cents]);
    const entry = postEntry(db, input.date, `Refund of payment ${p.id} on invoice ${inv.number}: ${input.reason}`, legs, ctx.source);
    const { id } = db
      .query("INSERT INTO refunds (payment_id, date, reason, entry_id, source) VALUES (?, ?, ?, ?, ?) RETURNING id")
      .get(p.id, input.date, input.reason, entry, ctx.source) as { id: number };
    if (p.credit_cents > 0) {
      db.query("INSERT INTO client_credits (client_id, date, amount_cents, payment_id, refund_id, source) VALUES (?, ?, ?, ?, ?, ?)").run(
        inv.client_id, input.date, -p.credit_cents, p.id, id, ctx.source,
      );
    }
    return { payment: paymentView(db, p.id) };
  },
};

const paymentList: Op = {
  name: "payment_list",
  kind: "read",
  description: "List payments with their gross, fee, deposit, what each settled and any refund, optionally for one invoice or client.",
  fields: {
    invoice_id: { type: "int", min: 1, description: "Only payments on this invoice." },
    client_id: { type: "int", min: 1, description: "Only this client's payments." },
  },
  run(db, input) {
    const rows = db
      .query(
        `SELECT p.id FROM payments p JOIN invoices i ON i.id = p.invoice_id
         WHERE (?1 IS NULL OR p.invoice_id = ?1) AND (?2 IS NULL OR i.client_id = ?2) ORDER BY p.date, p.id`,
      )
      .all(input.invoice_id ?? null, input.client_id ?? null) as { id: number }[];
    return { payments: rows.map((r) => paymentView(db, r.id)) };
  },
};

const clientCredits: Op = {
  name: "client_credits",
  kind: "read",
  description: "Show money held for clients from overpayments: each credit row, and each client's balance.",
  fields: { client_id: { type: "int", min: 1, description: "Only this client." } },
  run(db, input) {
    const credits = db
      .query("SELECT id, client_id, date, amount_cents, payment_id, refund_id, source FROM client_credits WHERE ?1 IS NULL OR client_id = ?1 ORDER BY id")
      .all(input.client_id ?? null);
    const balances = db
      .query(
        `SELECT c.id AS client_id, c.name AS client, SUM(x.amount_cents) AS balance_cents FROM client_credits x JOIN clients c ON c.id = x.client_id
         WHERE ?1 IS NULL OR x.client_id = ?1 GROUP BY c.id ORDER BY c.id`,
      )
      .all(input.client_id ?? null);
    return { credits, balances };
  },
};

export const paymentOps: Op[] = [paymentAdd, paymentRefund, paymentList, clientCredits];
