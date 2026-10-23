import { daysBetween, today } from "./format.ts";
import { amounts, openBalance, paidCents, type InvoiceRow } from "./invoices.ts";
import type { Op } from "./op.ts";
import { Refusal } from "./refusal.ts";

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

/** Profit and loss, summed from journal lines on every call. Nothing is cached. */
const reportPnl: Op = {
  name: "report_pnl",
  kind: "read",
  description: "Profit and loss by account for a date range, recomputed from posted entries.",
  fields: {
    from: { type: "date", description: "First day included, YYYY-MM-DD. Default: the beginning." },
    to: { type: "date", description: "Last day included, YYYY-MM-DD. Default: the end." },
  },
  run(db, input) {
    const from = input.from ?? "0000-01-01";
    const to = input.to ?? "9999-12-31";
    if (from > to) throw new Refusal("The from date must be on or before the to date.", "from");
    const rows = db
      .query(
        `SELECT a.id AS account_id, a.name, a.type,
                COALESCE(SUM(l.debit_cents), 0) AS d, COALESCE(SUM(l.credit_cents), 0) AS c
         FROM accounts a
         LEFT JOIN (SELECT l.* FROM lines l JOIN entries e ON e.id = l.entry_id WHERE e.date BETWEEN ? AND ?) l
           ON l.account_id = a.id
         WHERE a.type IN ('income', 'expense')
         GROUP BY a.id ORDER BY a.id`,
      )
      .all(from, to) as { account_id: number; name: string; type: string; d: number; c: number }[];
    const line = (r: (typeof rows)[number], total_cents: number) => ({ account_id: r.account_id, name: r.name, total_cents });
    const income = rows.filter((r) => r.type === "income").map((r) => line(r, r.c - r.d));
    const expense = rows.filter((r) => r.type === "expense").map((r) => line(r, r.d - r.c));
    const sum = (xs: { total_cents: number }[]) => xs.reduce((s, x) => s + x.total_cents, 0);
    const income_total_cents = sum(income);
    const expense_total_cents = sum(expense);
    return {
      from: input.from ?? null,
      to: input.to ?? null,
      income,
      expense,
      income_total_cents,
      expense_total_cents,
      net_cents: income_total_cents - expense_total_cents,
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

export const reportOps: Op[] = [reportPnl, reportUnpaid, historyList];
