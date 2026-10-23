import { linkLine, requireUnmatchedLine } from "./bank.ts";
import type { Books } from "./db.ts";
import { displayNumber, invoiceAccount, openBalance, requireInvoice } from "./invoices.ts";
import { getEntry, namedAccount, postEntry, requireOwnAccount } from "./ledger.ts";
import type { Ctx, Op } from "./op.ts";
import { Refusal } from "./refusal.ts";
import { currency, MAX_CENTS } from "./validate.ts";

// Payments on issued invoices, recorded gross plus fee: a $1,000 invoice paid through a processor that kept $30 is
// $1,000 settled on the invoice, a $30 fee expense and a $970 deposit, which matches the 1099-K. A payment beyond
// what the invoice still owed leaves the rest as a client credit, which can pay down a later invoice of that client.
// A refund is a new entry that gives back gross: the invoice is owed again, and the processor's fee stays an expense
// unless the refund says the processor returned it, which Stripe, for one, doesn't.

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

/** What refunds of a payment have given back so far, and how each part of it was split. */
function refundedOf(db: Books, paymentId: number) {
  return db
    .query(
      `SELECT COALESCE(SUM(amount_cents), 0) AS amount, COALESCE(SUM(fee_returned_cents), 0) AS fee,
              COALESCE(SUM(applied_cents), 0) AS applied, COALESCE(SUM(credit_cents), 0) AS credit
       FROM refunds WHERE payment_id = ?`,
    )
    .get(paymentId) as { amount: number; fee: number; applied: number; credit: number };
}

/**
 * How a refund of a payment splits, given what it already gave back: client credit the payment made comes back first,
 * as far as the client still holds it, then what it settled on the invoice. A credit already applied to another
 * invoice can't be refunded from here, so it caps what is left.
 */
function refundable(db: Books, p: PaymentRow, clientId: number) {
  const done = refundedOf(db, p.id);
  const credit = Math.max(0, Math.min(p.credit_cents - done.credit, creditBalance(db, clientId)));
  const applied = p.applied_cents - done.applied;
  return { credit, applied, total: credit + applied, fee: p.fee_cents - done.fee, refunded: done.amount };
}

/** A client's credit balance: overpayments held for them, less what was refunded or applied to invoices since. */
export function creditBalance(db: Books, clientId: number): number {
  return (db.query("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM client_credits WHERE client_id = ?").get(clientId) as { n: number }).n;
}

export function paymentView(db: Books, id: number) {
  const p = requirePayment(db, id);
  const inv = requireInvoice(db, p.invoice_id);
  const refunds = db
    .query("SELECT id, date, reason, amount_cents, fee_returned_cents, applied_cents, credit_cents, entry_id, source FROM refunds WHERE payment_id = ? ORDER BY id")
    .all(p.id);
  const left = refundable(db, p, inv.client_id);
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
    bank_line_id: (db.query("SELECT line_id FROM live_bank_matches WHERE entry_id = ? AND account_id = ?").get(p.entry_id, p.deposit_account_id) as { line_id: number } | null)?.line_id ?? null,
    memo: p.memo,
    entry: getEntry(db, p.entry_id),
    // Each refund of it, what they gave back in all, and what could still be refunded.
    refunds,
    refunded_cents: left.refunded,
    refundable_cents: left.total,
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
    "Refund a payment, in full or in part, as a new entry; the payment itself is never edited. amount_cents is the gross given back to the client, by default all that is still refundable. It comes out of any client credit the payment made first, then off the invoice, which is owed again by that much. The processor's fee stays an expense unless fee_returned_cents says the processor gave some back; Stripe, for one, keeps it. What leaves deposit_account_id is amount_cents less fee_returned_cents. A payment can be refunded more than once, up to what was paid.",
  fields: {
    payment_id: { type: "int", required: true, min: 1, description: "The payment being refunded." },
    date: { type: "date", required: true, description: "Day of the refund, YYYY-MM-DD." },
    reason: { type: "text", required: true, description: "Why it was refunded." },
    amount_cents: {
      type: "int", min: 1, max: MAX_CENTS, unit: "cents",
      description: "Gross given back to the client. Default: all of the payment still refundable.",
    },
    fee_returned_cents: {
      type: "int", min: 0, max: MAX_CENTS, unit: "cents",
      description: "Processor fee the processor gave back with this refund. Default 0, which is what Stripe does.",
    },
  },
  run(db, input, ctx) {
    const p = requirePayment(db, input.payment_id);
    if (input.date < p.date) throw new Refusal(`The refund can't be dated before the payment it refunds, on ${p.date}.`, "date");
    const inv = requireInvoice(db, p.invoice_id);
    const left = refundable(db, p, inv.client_id);
    if (left.total === 0) {
      const why = left.refunded === p.amount_cents ? "was already refunded in full" : "has nothing left to refund, because its client credit was applied to an invoice";
      throw new Refusal(`Payment ${p.id} ${why}.`, "payment_id");
    }
    const amount: number = input.amount_cents ?? left.total;
    if (amount > left.total) {
      throw new Refusal(`amount_cents can be at most ${left.total}, what is still refundable on payment ${p.id}.`, "amount_cents");
    }
    const fee: number = input.fee_returned_cents ?? 0;
    if (fee > left.fee) throw new Refusal(`fee_returned_cents can be at most ${left.fee}, the fee on payment ${p.id} not yet returned.`, "fee_returned_cents");
    if (fee > 0 && fee >= amount) throw new Refusal("fee_returned_cents must be less than amount_cents, the gross given back.", "fee_returned_cents");
    const credit = Math.min(amount, left.credit);
    const applied = amount - credit;

    // The client gets gross back: the invoice is owed again and their credit shrinks, and the deposit account pays
    // all of it except any fee the processor returned.
    const legs: [number, number][] = [
      [invoiceAccount(db, "receivable", ctx), applied],
      [invoiceAccount(db, "clientCredits", ctx), credit],
      [p.deposit_account_id, -(amount - fee)],
      [namedAccount(db, FEE_ACCOUNT, ctx.source, "fee_returned_cents"), -fee],
    ];
    const entry = postEntry(db, input.date, `Refund of payment ${p.id} on invoice ${inv.number}: ${input.reason}`, legs, ctx.source);
    const { id } = db
      .query(
        `INSERT INTO refunds (payment_id, date, reason, amount_cents, fee_returned_cents, applied_cents, credit_cents, entry_id, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(p.id, input.date, input.reason, amount, fee, applied, credit, entry, ctx.source) as { id: number };
    if (credit > 0) {
      db.query("INSERT INTO client_credits (client_id, date, amount_cents, payment_id, refund_id, source) VALUES (?, ?, ?, ?, ?, ?)").run(
        inv.client_id, input.date, -credit, p.id, id, ctx.source,
      );
    }
    return { payment: paymentView(db, p.id), refund_id: id };
  },
};

const clientCreditApply: Op = {
  name: "client_credit_apply",
  kind: "write",
  description:
    "Apply a client's credit, held from an overpayment, to one of that client's issued invoices. The invoice's open balance and the client's credit balance both drop by the amount, posted as one entry; the money never leaves the books, so this isn't gated. amount_cents defaults to as much as the credit and the invoice allow.",
  fields: {
    client_id: { type: "int", required: true, min: 1, description: "The client whose credit is used." },
    invoice_id: { type: "int", required: true, min: 1, description: "That client's issued invoice the credit pays down." },
    date: { type: "date", required: true, description: "Day the credit is applied, YYYY-MM-DD." },
    amount_cents: {
      type: "int", min: 1, max: MAX_CENTS, unit: "cents",
      description: "How much credit to apply. Default: the smaller of the client's credit and what the invoice still owes.",
    },
  },
  run(db, input, ctx) {
    const client = db.query("SELECT id, name FROM clients WHERE id = ?").get(input.client_id) as { id: number; name: string } | null;
    if (!client) throw new Refusal(`There is no client with id ${input.client_id}.`, "client_id");
    const inv = requireInvoice(db, input.invoice_id, "invoice_id");
    if (inv.kind !== "invoice") throw new Refusal(`Credit note ${displayNumber(inv)} is owed to the client, so credit can't be applied to it.`, "invoice_id");
    if (inv.status === "draft") throw new Refusal(`Draft invoice ${inv.id} hasn't been issued, so credit can't be applied to it yet.`, "invoice_id");
    if (inv.status === "void") throw new Refusal(`Invoice ${inv.number} is void, so nothing on it can be paid.`, "invoice_id");
    if (inv.client_id !== client.id) {
      throw new Refusal(`Invoice ${inv.number} belongs to another client, and a client's credit only pays their own invoices.`, "invoice_id");
    }
    const balance = creditBalance(db, client.id);
    if (balance <= 0) throw new Refusal(`${client.name} has no client credit to apply.`, "client_id");
    const open = openBalance(db, inv);
    if (open <= 0) throw new Refusal(`Invoice ${inv.number} has nothing left owing, so there is nothing to apply credit to.`, "invoice_id");
    const amount: number = input.amount_cents ?? Math.min(balance, open);
    if (amount > balance) throw new Refusal(`amount_cents can be at most ${balance}, the credit ${client.name} holds.`, "amount_cents");
    if (amount > open) throw new Refusal(`amount_cents can be at most ${open}, what invoice ${inv.number} still owes.`, "amount_cents");

    // What was held for the client settles what they owe.
    const legs: [number, number][] = [
      [invoiceAccount(db, "clientCredits", ctx), amount],
      [invoiceAccount(db, "receivable", ctx), -amount],
    ];
    const entry = postEntry(db, input.date, `Client credit applied to invoice ${inv.number} for ${client.name}`, legs, ctx.source);
    const { id } = db
      .query("INSERT INTO credit_applications (client_id, invoice_id, date, amount_cents, entry_id, source) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
      .get(client.id, inv.id, input.date, amount, entry, ctx.source) as { id: number };
    db.query("INSERT INTO client_credits (client_id, date, amount_cents, application_id, source) VALUES (?, ?, ?, ?, ?)").run(
      client.id, input.date, -amount, id, ctx.source,
    );
    return {
      applied: { id, client_id: client.id, invoice_id: inv.id, invoice_number: String(inv.number), date: input.date, amount_cents: amount, entry_id: entry },
      invoice_open_cents: openBalance(db, inv),
      client_balance_cents: creditBalance(db, client.id),
    };
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
  description:
    "Show money held for clients from overpayments: each credit row (an overpayment adds, a refund of it or applying it to an invoice takes away), and each client's balance.",
  fields: { client_id: { type: "int", min: 1, description: "Only this client." } },
  run(db, input) {
    const credits = db
      .query(
        `SELECT x.id, x.client_id, x.date, x.amount_cents, x.payment_id, x.refund_id, x.application_id, a.invoice_id AS applied_to_invoice_id, x.source
         FROM client_credits x LEFT JOIN credit_applications a ON a.id = x.application_id WHERE ?1 IS NULL OR x.client_id = ?1 ORDER BY x.id`,
      )
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

export const paymentOps: Op[] = [paymentAdd, paymentRefund, paymentList, clientCredits, clientCreditApply];
