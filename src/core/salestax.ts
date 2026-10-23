import { cashEvents, chargeEvents } from "./cash.ts";
import type { Books } from "./db.ts";
import { invoiceAccount } from "./invoices.ts";
import { getEntry, postEntry, requireOwnAccount } from "./ledger.ts";
import type { Op } from "./op.ts";
import { Refusal } from "./refusal.ts";
import { range } from "./reports.ts";
import { currency, MAX_CENTS } from "./validate.ts";

// Sales tax is money collected for a state. It is owed from the day the client pays it (cash basis, like income) until
// the person pays it to the state. solobooks never decides what is taxable or files anything; it reports what was
// collected and paid, so the person or their accountant can file.

const DEFAULT_LABEL = "Sales tax";

function paymentView(db: Books, id: number) {
  const p = db.query("SELECT * FROM sales_tax_payments WHERE id = ?").get(id) as Record<string, any>;
  return {
    id: p.id,
    date: p.date,
    amount_cents: p.amount_cents,
    tax_label: p.tax_label,
    period_start: p.period_start,
    period_end: p.period_end,
    paid_from_account_id: p.account_id,
    confirmation: p.confirmation,
    memo: p.memo,
    entry: getEntry(db, p.entry_id),
    source: p.source,
  };
}

/** Every tax label an issued invoice has carried, which is what a payment to the state can be for. */
function labels(db: Books): string[] {
  const rows = db.query("SELECT DISTINCT COALESCE(tax_label, ?) AS l FROM invoices WHERE status <> 'draft' AND tax_rate_ppm IS NOT NULL ORDER BY l").all(DEFAULT_LABEL) as { l: string }[];
  return rows.map((r) => r.l);
}

const salesTaxPaymentAdd: Op = {
  name: "sales_tax_payment_add",
  kind: "write",
  description:
    "Record a payment of collected sales tax to a state: the day paid, the amount, the account it came from, the tax label it pays (as printed on invoices), and the return period it covers. It lowers Sales tax payable and never touches the P&L. solobooks files nothing; this records what the person paid.",
  fields: {
    date: { type: "date", required: true, description: "Day it was paid, YYYY-MM-DD." },
    amount_cents: { type: "int", required: true, min: 1, max: MAX_CENTS, unit: "cents", description: "What was paid to the state, in cents." },
    paid_from_account_id: { type: "int", required: true, min: 1, description: "The business bank or card account it was paid from." },
    tax_label: { type: "text", required: true, description: "The tax it pays, as labelled on the invoices that charged it, such as IL sales tax." },
    period_start: { type: "date", required: true, description: "First day of the return period it pays for, YYYY-MM-DD." },
    period_end: { type: "date", required: true, description: "Last day of the return period it pays for, YYYY-MM-DD." },
    confirmation: { type: "text", description: "The state's confirmation number, if any." },
    memo: { type: "text", description: "Anything worth keeping." },
    currency,
  },
  run(db, input, ctx) {
    if (input.period_start > input.period_end) throw new Refusal("period_start must be on or before period_end.", "period_start");
    requireOwnAccount(db, input.paid_from_account_id, "paid_from_account_id");
    if (!labels(db).includes(input.tax_label)) {
      throw new Refusal("No issued invoice carries that tax label, so use a label exactly as report sales tax lists it.", "tax_label");
    }
    const payable = invoiceAccount(db, "salesTax", ctx);
    const memo = `Sales tax paid: ${input.tax_label}, ${input.period_start} to ${input.period_end}${input.memo ? `: ${input.memo}` : ""}`;
    const entry = postEntry(db, input.date, memo, [[payable, input.amount_cents], [input.paid_from_account_id, -input.amount_cents]], ctx.source);
    const { id } = db
      .query(
        `INSERT INTO sales_tax_payments (date, amount_cents, tax_label, period_start, period_end, account_id, entry_id, confirmation, memo, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(input.date, input.amount_cents, input.tax_label, input.period_start, input.period_end, input.paid_from_account_id, entry, input.confirmation ?? null, input.memo ?? null, ctx.source) as { id: number };
    return { sales_tax_payment: paymentView(db, id) };
  },
};

/**
 * Sales tax for a period, per tax label: what clients paid in it (collected), what was paid to the state for return
 * periods inside it, and owed, which is collected less paid. Payments for a return period only partly inside the range
 * aren't counted, and are listed so the person can see why.
 */
export function salesTax(db: Books, from: string, to: string) {
  const collected = cashEvents(db, from, to);
  const charged = chargeEvents(db, from, to);
  const pays = db.query("SELECT id FROM sales_tax_payments ORDER BY date, id").all() as { id: number }[];
  const all = pays.map((p) => paymentView(db, p.id));
  const inside = all.filter((p) => p.period_start >= from && p.period_end <= to);
  const partly = all.filter((p) => !inside.includes(p) && p.period_start <= to && p.period_end >= from);
  const names = [...new Set([...collected.filter((e) => e.tax !== 0).map((e) => e.tax_label ?? DEFAULT_LABEL), ...charged.map((e) => e.tax_label ?? DEFAULT_LABEL), ...inside.map((p) => p.tax_label)])].sort();
  const taxes = names.map((label) => {
    const mine = (l: string | null) => (l ?? DEFAULT_LABEL) === label;
    const collected_cents = collected.filter((e) => mine(e.tax_label)).reduce((s, e) => s + e.tax, 0);
    const payments = inside.filter((p) => p.tax_label === label);
    const paid_cents = payments.reduce((s, p) => s + p.amount_cents, 0);
    return {
      tax_label: label,
      collected_cents,
      paid_cents,
      owed_cents: collected_cents - paid_cents,
      // For states where tax is due when invoiced rather than when paid: what invoices charged, less credit notes.
      invoiced_cents: charged.filter((e) => mine(e.tax_label)).reduce((s, e) => s + e.tax, 0),
      payments,
    };
  });
  const sum = (k: "collected_cents" | "paid_cents" | "owed_cents" | "invoiced_cents") => taxes.reduce((s, t) => s + t[k], 0);
  return {
    basis: "cash",
    basis_note: "Collected is sales tax inside what clients paid in the period, counted on the day they paid; owed is collected less what was paid to the state for return periods inside the range. invoiced is the tax charged on invoices issued in the period, less credit notes, for states that want tax when invoiced.",
    taxes,
    collected_cents: sum("collected_cents"),
    paid_cents: sum("paid_cents"),
    owed_cents: sum("owed_cents"),
    invoiced_cents: sum("invoiced_cents"),
    payments_partly_in_range: partly,
  };
}

const reportSalesTax: Op = {
  name: "report_sales_tax",
  kind: "read",
  description:
    "Sales tax owed for a period, per tax label: collected (the tax inside what clients paid in the period), paid (payments to the state for return periods inside it) and owed (collected less paid), plus invoiced, the tax charged on invoices issued in the period. Figures only: solobooks never decides what is taxable and files nothing.",
  fields: {
    from: { type: "date", description: "First day of the period, YYYY-MM-DD. Default: the beginning." },
    to: { type: "date", description: "Last day of the period, YYYY-MM-DD. Default: the end." },
  },
  run(db, input) {
    const { from, to } = range(input);
    return { from: input.from ?? null, to: input.to ?? null, ...salesTax(db, from, to) };
  },
};

export const salesTaxOps: Op[] = [salesTaxPaymentAdd, reportSalesTax];
