import { cashEvents, chargeEvents } from "./cash.ts";
import type { Books } from "./db.ts";
import { invoiceAccount } from "./invoices.ts";
import { getEntry, postEntry, requireOwnAccount } from "./ledger.ts";
import type { Op } from "./op.ts";
import { Refusal } from "./refusal.ts";
import { range } from "./reports.ts";
import { currency, MAX_CENTS } from "./validate.ts";

// Sales tax is money collected for a state. States differ on when it is due: most when the sale is invoiced, some when
// the client pays. solobooks never decides which rule applies, what is taxable, or what is due, and files nothing. It
// reports three figures side by side (charged on invoices, collected in payments, paid to the state) for the person
// or their accountant to file from.

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
    "Record a payment of sales tax to a state: the day paid, the amount, the account it came from, the tax label it pays (as printed on invoices), and the return period it covers. It lowers Sales tax payable and never touches the P&L. solobooks files nothing; this records what the person paid.",
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

export const SALES_TAX_NOTE = "Your state's rules decide which of these figures, if any, is due for a period; solobooks doesn't decide that.";

const PERIODS = { month: 1, quarter: 3, year: 12 } as const;
type Period = keyof typeof PERIODS;

/** The calendar months, quarters or years that overlap a range, each clipped to it; or the range itself. */
function splitRange(from: string, to: string, by: Period | undefined): [string, string][] {
  if (by === undefined) return [[from, to]];
  const step = PERIODS[by];
  const out: [string, string][] = [];
  let [y, m] = from.split("-").map(Number) as [number, number];
  m = Math.floor((m - 1) / step) * step + 1;
  for (;;) {
    const start = `${y}-${String(m).padStart(2, "0")}-01`;
    if (start > to) return out;
    const end = new Date(Date.UTC(y, m - 1 + step, 0)).toISOString().slice(0, 10);
    out.push([start > from ? start : from, end < to ? end : to]);
    m += step;
    if (m > 12) {
      m -= 12;
      y++;
    }
  }
}

/**
 * Sales tax per tax label for a range, and for each month, quarter or year in it when asked: charged (on invoices
 * issued, less credit notes, with voids undoing either), collected (the tax inside what clients paid, on the day they
 * paid), and paid to the state (payments for a return period inside the period). No figure is presented as due.
 */
export function salesTax(db: Books, from: string, to: string, by?: Period) {
  const collected = cashEvents(db, from, to);
  const charged = chargeEvents(db, from, to);
  const pays = (db.query("SELECT id FROM sales_tax_payments ORDER BY date, id").all() as { id: number }[]).map((p) => paymentView(db, p.id));
  const within = (a: string, b: string) => pays.filter((p) => p.period_start >= a && p.period_end <= b);
  const label = (l: string | null) => l ?? DEFAULT_LABEL;
  const names = [...new Set([...collected.filter((e) => e.tax !== 0).map((e) => label(e.tax_label)), ...charged.map((e) => label(e.tax_label)), ...within(from, to).map((p) => p.tax_label)])].sort();

  const figures = (a: string, b: string) =>
    names.map((name) => {
      const payments = within(a, b).filter((p) => p.tax_label === name);
      return {
        tax_label: name,
        charged_cents: charged.filter((e) => label(e.tax_label) === name && e.date >= a && e.date <= b).reduce((s, e) => s + e.tax, 0),
        collected_cents: collected.filter((e) => label(e.tax_label) === name && e.date >= a && e.date <= b).reduce((s, e) => s + e.tax, 0),
        paid_to_state_cents: payments.reduce((s, p) => s + p.amount_cents, 0),
        payments_to_state: payments,
      };
    });
  const totals = figures(from, to);
  const periods = splitRange(from, to, by).map(([a, b]) => ({ period_start: a, period_end: b, taxes: figures(a, b) }));
  const inRows = new Set(periods.flatMap((p) => p.taxes.flatMap((t) => t.payments_to_state.map((x) => x.id))));
  const sum = (k: "charged_cents" | "collected_cents" | "paid_to_state_cents") => totals.reduce((s, t) => s + t[k], 0);
  return {
    note: SALES_TAX_NOTE,
    figures_note:
      "charged is the tax on invoices issued in the period, less credit notes; collected is the tax inside what clients paid in the period, counted on the day they paid; paid to the state counts payments whose return period lies inside the period.",
    period: by ?? null,
    taxes: totals,
    periods,
    charged_cents: sum("charged_cents"),
    collected_cents: sum("collected_cents"),
    paid_to_state_cents: sum("paid_to_state_cents"),
    // Payments to the state the rows above don't count: their return period runs past the range, or across two rows.
    payments_to_state_not_in_one_period: pays.filter((p) => p.period_start <= to && p.period_end >= from && !inRows.has(p.id)),
  };
}

const reportSalesTax: Op = {
  name: "report_sales_tax",
  kind: "read",
  description:
    "Sales tax per tax label for a range, and for each month, quarter or year in it when period is given: the tax charged on invoices issued (less credit notes), the tax collected in what clients paid, and payments to the state. It presents no figure as due, because the state's rules decide which applies; solobooks never decides what is taxable or due, and files nothing.",
  fields: {
    from: { type: "date", description: "First day, YYYY-MM-DD. Default: the beginning; required with period." },
    to: { type: "date", description: "Last day, YYYY-MM-DD. Default: the end; required with period." },
    period: { type: "enum", values: Object.keys(PERIODS), description: "Also break the range into calendar month, quarter or year rows." },
  },
  run(db, input) {
    if (input.period !== undefined && (input.from === undefined || input.to === undefined)) {
      throw new Refusal("Give from and to along with period, so solobooks knows which periods to list.", input.from === undefined ? "from" : "to");
    }
    const { from, to } = range(input);
    return { from: input.from ?? null, to: input.to ?? null, ...salesTax(db, from, to, input.period) };
  },
};

export const salesTaxOps: Op[] = [salesTaxPaymentAdd, reportSalesTax];

