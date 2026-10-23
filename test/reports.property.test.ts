import { expect, test } from "bun:test";
import fc from "fast-check";
import { memBooks } from "./support/books.ts";
import { must, seedAccounts, write, writeCmd } from "./support/gen.ts";

// Account ids from seedAccounts: 4 is income; 5 and 6 are expenses.
const INCOME = new Set([4]);
const EXPENSE = new Set([5, 6]);

test("ISC-6 recompute: every P&L total equals the sum of its entries, with no cached totals", () => {
  fc.assert(
    fc.property(
      fc.array(writeCmd, { maxLength: 15 }),
      fc.integer({ min: 0, max: 364 }),
      fc.integer({ min: 0, max: 364 }),
      (cmds, a, b) => {
        const db = memBooks();
        seedAccounts(db);
        const day = (d: number) => new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
        const [from, to] = [day(Math.min(a, b)), day(Math.max(a, b))];

        // Independent tally, kept by the test from the writes that were accepted.
        let income = 0;
        let expense = 0;
        for (const c of cmds) {
          const r = write(db, c.op, c.input);
          if (!r.ok || c.op !== "entry_post") continue;
          const e = c.input as any;
          if (e.date < from || e.date > to) continue;
          for (const l of e.lines) {
            const net = (l.debit_cents ?? 0) - (l.credit_cents ?? 0);
            if (INCOME.has(l.account_id)) income -= net;
            if (EXPENSE.has(l.account_id)) expense += net;
          }
          // The report is asked for after every write, so a stale cached total would show up here.
          const p = must(db, "report_pnl", { from, to });
          expect(p.income_total_cents).toBe(income);
          expect(p.expense_total_cents).toBe(expense);
          expect(p.net_cents).toBe(income - expense);
          expect(p.income.reduce((s: number, x: any) => s + x.total_cents, 0)).toBe(p.income_total_cents);
          expect(p.expense.reduce((s: number, x: any) => s + x.total_cents, 0)).toBe(p.expense_total_cents);
        }
        db.close();
      },
    ),
    { numRuns: 1000 },
  );
});

test("ISC-6 recompute: the schema holds no table or column for stored totals", () => {
  const db = memBooks();
  const cols = db
    .query("SELECT m.name t, p.name c FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table'")
    .all() as { t: string; c: string }[];
  expect(cols.filter((x) => /total|balance|summary/i.test(x.t + " " + x.c))).toEqual([]);
});
