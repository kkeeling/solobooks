import type { Op } from "./op.ts";
import { Refusal } from "./refusal.ts";

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

export const reportOps: Op[] = [reportPnl, historyList];
