import { cashEvents } from "./cash.ts";
import type { Books } from "./db.ts";
import { daysBetween, today } from "./format.ts";
import { amounts, openBalance, paidCents, type InvoiceRow } from "./invoices.ts";
import { INVOICE_ACCOUNTS } from "./ledger.ts";
import type { Op } from "./op.ts";
import { Refusal } from "./refusal.ts";
import { lineOf, lineOrder, SCHEDULE_C, type ScheduleCLine } from "./schedule-c.ts";

/**
 * Every issued invoice with money still owed on it, overdue ones first with how many days late they are, measured
 * against the solobooks clock. Past invoices brought in still owed are on it, marked historical: they get no reminder.
 */
const reportUnpaid: Op = {
  name: "report_unpaid",
  kind: "read",
  description:
    "List every issued invoice with money still owed on it, most days late first: its total, what payments and credit notes took off, what is still open, its due date and how many days late it is today. Past invoices brought in still owed are listed too, marked historical: true, and get no reminder.",
  fields: { client_id: { type: "int", min: 1, description: "Only this client's." } },
  run(db, input, ctx) {
    const day = today(ctx.now);
    const rows = db
      .query("SELECT * FROM invoices WHERE kind = 'invoice' AND status IN ('issued', 'sent') AND (?1 IS NULL OR client_id = ?1) ORDER BY id")
      .all(input.client_id ?? null) as InvoiceRow[];
    const unpaid = rows
      .map((r) => ({ r, open: openBalance(db, r) }))
      .filter((x) => x.open > 0)
      .map(({ r, open }) => {
        const late = Math.max(daysBetween(r.due_date!, day), 0);
        return {
          invoice_id: r.id,
          number: String(r.number),
          client_id: r.client_id,
          client: r.client_name,
          invoice_date: r.invoice_date,
          due_date: r.due_date,
          total_cents: amounts(db, r).total,
          paid_cents: paidCents(db, r.id),
          open_cents: open,
          overdue: late > 0,
          days_late: late,
          historical: r.historical === 1,
        };
      })
      .sort((a, b) => b.days_late - a.days_late || a.invoice_id - b.invoice_id);
    const sum = (xs: { open_cents: number }[]) => xs.reduce((s, x) => s + x.open_cents, 0);
    return { as_of: day, invoices: unpaid, open_total_cents: sum(unpaid), overdue_total_cents: sum(unpaid.filter((u) => u.overdue)) };
  },
};

export const BASIS_NOTE =
  "Cash basis: what clients pay on invoices counts as income on the day it is paid, not the day it is invoiced, and sales tax collected is owed to the state, never income; expenses count on the day they are recorded.";

const range = (input: { from?: string; to?: string }) => {
  const from = input.from ?? "0000-01-01";
  const to = input.to ?? "9999-12-31";
  if (from > to) throw new Refusal("The from date must be on or before the to date.", "from");
  return { from, to };
};

/**
 * Profit and loss on the cash basis, recomputed from the records on every call; nothing is cached. Every income and
 * expense account is summed from its posted lines, except the two invoices post to: those count what clients paid
 * in the range, split from the tax it carried. Each account is also grouped under its Schedule C line.
 */
export function pnl(db: Books, from: string, to: string) {
  const rows = db
    .query(
      `SELECT a.id AS account_id, a.name, a.type, a.schedule_c,
              COALESCE(SUM(l.debit_cents), 0) AS d, COALESCE(SUM(l.credit_cents), 0) AS c
       FROM accounts a
       LEFT JOIN (SELECT l.* FROM lines l JOIN entries e ON e.id = l.entry_id WHERE e.date BETWEEN ? AND ?) l
         ON l.account_id = a.id
       WHERE a.type IN ('income', 'expense')
       GROUP BY a.id ORDER BY a.id`,
    )
    .all(from, to) as { account_id: number; name: string; type: string; schedule_c: string | null; d: number; c: number }[];
  const events = cashEvents(db, from, to);
  const paid = {
    [INVOICE_ACCOUNTS.services.name.toLowerCase()]: events.reduce((s, e) => s + e.services, 0),
    [INVOICE_ACCOUNTS.reimbursed.name.toLowerCase()]: events.reduce((s, e) => s + e.reimbursed, 0),
  };
  const line = (r: (typeof rows)[number], total_cents: number) => ({ account_id: r.account_id, name: r.name, schedule_c: lineOf(r), total_cents });
  const income = rows.filter((r) => r.type === "income").map((r) => line(r, paid[r.name.toLowerCase()] ?? r.c - r.d));
  const expense = rows.filter((r) => r.type === "expense").map((r) => line(r, r.d - r.c));
  const sum = (xs: { total_cents: number }[]) => xs.reduce((s, x) => s + x.total_cents, 0);
  const income_total_cents = sum(income);
  const expense_total_cents = sum(expense);

  // Schedule C, line by line in the form's order. An account with no line is listed for the person to place.
  const all = [...income, ...expense];
  const lines = [...new Set(all.map((a) => a.schedule_c).filter((l): l is ScheduleCLine => l !== null))].sort((a, b) => lineOrder(a) - lineOrder(b));
  const schedule_c = lines.map((l) => {
    const accounts = all.filter((a) => a.schedule_c === l);
    return { line: l, name: SCHEDULE_C[l], total_cents: sum(accounts), account_ids: accounts.map((a) => a.account_id) };
  });
  const not_on_schedule_c = all.filter((a) => a.schedule_c === null).map(({ account_id, name, total_cents }) => ({ account_id, name, total_cents }));
  return {
    basis: "cash",
    basis_note: BASIS_NOTE,
    income,
    expense,
    income_total_cents,
    expense_total_cents,
    net_cents: income_total_cents - expense_total_cents,
    schedule_c,
    not_on_schedule_c,
  };
}

const reportPnl: Op = {
  name: "report_pnl",
  kind: "read",
  description:
    "Profit and loss for a date range on the cash basis: invoice income counts on the day the client paid, not the day it was invoiced, and sales tax is never income. Lists each income and expense account, and the same totals grouped by Schedule C line; accounts with no line yet are listed in not_on_schedule_c for the person to place with account edit.",
  fields: {
    from: { type: "date", description: "First day included, YYYY-MM-DD. Default: the beginning." },
    to: { type: "date", description: "Last day included, YYYY-MM-DD. Default: the end." },
  },
  run(db, input) {
    const { from, to } = range(input);
    return { from: input.from ?? null, to: input.to ?? null, ...pnl(db, from, to) };
  },
};

/** Profit for the calendar year so far, as one number: the P&L's net from January 1 through the day asked about. */
const reportYtd: Op = {
  name: "report_ytd",
  kind: "read",
  description:
    "Year-to-date profit as one number, on the cash basis: income less expenses from January 1 through as_of (default today). A figure to size estimated tax payments with, not a tax calculation.",
  fields: { as_of: { type: "date", description: "Last day counted, YYYY-MM-DD. Default: today." } },
  run(db, input, ctx) {
    const to = input.as_of ?? today(ctx.now);
    const from = `${to.slice(0, 4)}-01-01`;
    const p = pnl(db, from, to);
    return {
      year: Number(to.slice(0, 4)),
      from,
      to,
      profit_cents: p.net_cents,
      income_cents: p.income_total_cents,
      expense_cents: p.expense_total_cents,
      basis: p.basis,
      basis_note: p.basis_note,
    };
  },
};

const historyList: Op = {
  name: "history_list",
  kind: "read",
  description: "List the write history, oldest first: one row per write, with its source and result.",
  fields: {},
  run(db) {
    const rows = db.query("SELECT id, at, op, source, idempotency_key, payload, result FROM history ORDER BY id").all() as any[];
    return { history: rows.map((r) => ({ ...r, payload: JSON.parse(r.payload), result: JSON.parse(r.result) })) };
  },
};

export const reportOps: Op[] = [reportPnl, reportYtd, reportUnpaid, historyList];
export { range };
