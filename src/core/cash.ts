import type { Books } from "./db.ts";
import { today } from "./format.ts";
import { amounts, type InvoiceRow } from "./invoices.ts";

// Cash basis. The ledger posts what an invoice is owed on the day it is issued; the reports count it when the money
// arrives. By the end of any day, the money that has settled an invoice so far (payments less refunds) is split in
// proportion across what the invoice then holds, net of credit notes: work, costs billed on at cost, and sales tax.
// Work and costs are income; the tax is collected for the state. Each day counts what that split grew by, so money
// counts on the day it moved, an invoice settled in full has counted every part exactly, and a credit note or void,
// which moves no money, counts nothing but can shift a rounding cent between the parts on its day. The split on a day
// depends only on records dated up to that day, and nothing is stored: every report works it out from the records.

/** What an invoice's money is made of: work, costs billed on at cost, and sales tax. */
type Parts = { services: number; reimbursed: number; tax: number };

/** One day's money on one invoice, split into its parts. Negative for a refund. */
export type CashEvent = Parts & { date: string; invoice_id: number; client_id: number; tax_label: string | null };

/** Tax charged on an invoice or taken off by a credit note, dated when it was, as the ledger posts it. */
export type ChargeEvent = { date: string; invoice_id: number; tax_label: string | null; tax: number };

const partsOf = (db: Books, r: InvoiceRow): Parts => {
  const a = amounts(db, r);
  return { services: a.subtotal - a.passThrough, reimbursed: a.passThrough, tax: a.tax?.amount_cents ?? 0 };
};

/** a / b of n, rounded half-up, exactly. */
function share(n: number, a: number, b: number): number {
  const num = BigInt(n) * BigInt(a) * 2n + BigInt(b);
  const den = BigInt(b) * 2n;
  const q = num / den;
  return Number(num % den < 0n ? q - 1n : q);
}

/** Money settled so far, split in proportion across what the invoice holds. All of it takes every part exactly. */
function split(settled: number, holds: Parts): Parts {
  const total = holds.services + holds.reimbursed + holds.tax;
  if (total <= 0) return { services: settled, reimbursed: 0, tax: 0 };
  const tax = share(settled, holds.tax, total);
  const reimbursed = share(settled, holds.reimbursed, total);
  return { services: settled - tax - reimbursed, reimbursed, tax };
}

/**
 * Money that settled an invoice, each dated, positive in and negative back out: payments, refunds, and a past invoice
 * brought in as paid. Applying a client's credit to an invoice belongs here too, on the day it is applied.
 */
function money(db: Books, r: InvoiceRow): { date: string; cents: number }[] {
  const pays = db.query("SELECT date, applied_cents AS cents FROM payments WHERE invoice_id = ?").all(r.id) as { date: string; cents: number }[];
  // A refund takes back what it took off the invoice: here every refund is the whole payment.
  const refunds = db
    .query("SELECT f.date, -p.applied_cents AS cents FROM refunds f JOIN payments p ON p.id = f.payment_id WHERE p.invoice_id = ?")
    .all(r.id) as { date: string; cents: number }[];
  const past = r.paid_on === null ? [] : [{ date: r.paid_on, cents: amounts(db, r).total }];
  return [...pays, ...refunds, ...past].filter((m) => m.cents !== 0);
}

/** Credit notes against an invoice, each taking its parts off on the day it was issued and back on the day it was voided. */
function creditChanges(db: Books, r: InvoiceRow): { date: string; sign: 1 | -1; parts: Parts }[] {
  const credits = db.query("SELECT * FROM invoices WHERE kind = 'credit' AND credits_invoice_id = ? AND status <> 'draft'").all(r.id) as InvoiceRow[];
  return credits.flatMap((c) => {
    const parts = partsOf(db, c);
    const off = { date: c.invoice_date!, sign: -1 as const, parts };
    return c.status === "void" ? [off, { date: today(c.voided_at!), sign: 1 as const, parts }] : [off];
  });
}

const KEYS = ["services", "reimbursed", "tax"] as const;

/** One invoice's money, day by day. */
function replay(db: Books, r: InvoiceRow): CashEvent[] {
  const original = partsOf(db, r);
  const moves = money(db, r);
  const credits = creditChanges(db, r);
  const days = [...new Set([...moves.map((m) => m.date), ...credits.map((c) => c.date)])].sort();
  const base = { invoice_id: r.id, client_id: r.client_id, tax_label: r.tax_label };
  const out: CashEvent[] = [];
  let before: Parts = { services: 0, reimbursed: 0, tax: 0 };
  for (const day of days) {
    const settled = moves.filter((m) => m.date <= day).reduce((s, m) => s + m.cents, 0);
    const holds = { ...original };
    for (const c of credits.filter((c) => c.date <= day)) for (const k of KEYS) holds[k] += c.sign * c.parts[k];
    const now = split(settled, holds);
    const counted = { services: now.services - before.services, reimbursed: now.reimbursed - before.reimbursed, tax: now.tax - before.tax };
    if (KEYS.some((k) => counted[k] !== 0)) out.push({ ...base, date: day, ...counted });
    before = now;
  }
  return out;
}

const issued = (db: Books) =>
  db.query("SELECT * FROM invoices WHERE kind = 'invoice' AND status <> 'draft' ORDER BY id").all() as InvoiceRow[];

/** Every day's money on every invoice, in the order it happened, optionally only between two days. */
export function cashEvents(db: Books, from = "0000-01-01", to = "9999-12-31"): CashEvent[] {
  return issued(db)
    .flatMap((r) => replay(db, r))
    .filter((e) => e.date >= from && e.date <= to)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.invoice_id - b.invoice_id));
}

/** Sales tax charged on invoices when issued, less what credit notes took off, with voids undoing either. */
export function chargeEvents(db: Books, from = "0000-01-01", to = "9999-12-31"): ChargeEvent[] {
  const out: ChargeEvent[] = [];
  const docs = db.query("SELECT * FROM invoices WHERE status <> 'draft' ORDER BY id").all() as InvoiceRow[];
  for (const d of docs) {
    const tax = partsOf(db, d).tax;
    if (tax === 0) continue;
    const sign = d.kind === "invoice" ? 1 : -1;
    // A credit note carries the tax label of the invoice it credits.
    out.push({ date: d.invoice_date!, invoice_id: d.id, tax_label: d.tax_label, tax: sign * tax });
    if (d.status === "void") out.push({ date: today(d.voided_at!), invoice_id: d.id, tax_label: d.tax_label, tax: -sign * tax });
  }
  return out.filter((e) => e.date >= from && e.date <= to);
}
