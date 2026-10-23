import { expect, test } from "bun:test";
import fc from "fast-check";
import { cashEvents } from "../src/core/cash.ts";
import { memBooks, acct } from "./support/books.ts";
import { must, write } from "./support/gen.ts";
import { letAgentDecide } from "./support/person.ts";

// ISC-51: for any run of taxed invoices, payments, partial refunds, credit notes, voids and payments to the state, the
// sales tax report's three figures, for every period and tax label, match the books: charged matches the ledger's
// postings to Sales tax payable, collected matches the money that settled invoices, and paid to the state matches the
// payments recorded. And the report never presents any figure as the amount due.

const LABELS = ["AA sales tax", "BB sales tax"];
const CLIENT_LABEL: Record<number, string | null> = { 1: LABELS[0]!, 2: LABELS[1]!, 3: null };
const day = (d: number) => new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
const dayOf = (s: string) => Math.round((Date.parse(s) - Date.UTC(2026, 0, 1)) / 86_400_000);
const date = fc.integer({ min: 0, max: 364 }).map(day);
const monthEnd = (m: number) => new Date(Date.UTC(2026, m, 0)).toISOString().slice(0, 10);

const step = fc.oneof(
  fc.record({ do: fc.constant("issue"), client: fc.constantFrom(1, 2, 3), cents: fc.integer({ min: 1, max: 2_000_000 }), lines: fc.integer({ min: 1, max: 3 }) }),
  fc.record({ do: fc.constant("pay"), pick: fc.nat(), part: fc.constantFrom(0.1, 0.33, 0.5, 1, 1.2), date }),
  fc.record({ do: fc.constant("pay"), pick: fc.nat(), part: fc.constant(1), date }),
  fc.record({ do: fc.constant("refund"), pick: fc.nat(), after: fc.integer({ min: 0, max: 30 }), part: fc.option(fc.constantFrom(0.1, 0.5, 0.9)) }),
  fc.record({ do: fc.constant("credit"), pick: fc.nat(), cents: fc.option(fc.integer({ min: 1, max: 500_000 })) }),
  fc.record({ do: fc.constant("void"), pick: fc.nat() }),
  fc.record({ do: fc.constant("state"), label: fc.constantFrom(...LABELS), cents: fc.integer({ min: 1, max: 300_000 }), month: fc.integer({ min: 1, max: 12 }), months: fc.constantFrom(1, 3), date }),
);

/** Every key anywhere in a value. */
const keys = (v: unknown): string[] =>
  Array.isArray(v) ? v.flatMap(keys) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : [];

test("ISC-51 sales tax by period: charged, collected and paid to the state each match the books, and none is presented as due", () => {
  fc.assert(
    fc.property(fc.array(step, { minLength: 1, maxLength: 25 }), date, date, fc.constantFrom(undefined, "month", "quarter", "year"), (steps, a, b, by) => {
      const db = memBooks();
      letAgentDecide(db);
      must(db, "profile_set", { legal_name: "Jane Doe LLC", address: "1 Main St", ein: "12-3456789" });
      must(db, "account_add", { name: "Checking", type: "asset" });
      must(db, "client_add", { name: "Aa", address: "1 A St", tax_rate_ppm: 100_000, tax_label: LABELS[0], tax_applies_to: ["manual"] });
      must(db, "client_add", { name: "Bb", address: "2 B St", tax_rate_ppm: 62_500, tax_label: LABELS[1], tax_applies_to: ["manual"] });
      must(db, "client_add", { name: "Cc", address: "3 C St" }); // no rate: never taxed
      const invoices: number[] = [];
      const credits: number[] = [];
      const payments: { id: number; date: string }[] = [];
      const pick = <T>(xs: T[], n: number) => xs[n % xs.length];

      for (const s of steps) {
        if (s.do === "issue") {
          const lines = Array.from({ length: s.lines }, (_, i) => ({ description: `Line ${i}`, amount_cents: s.cents + i * 137 }));
          const d = must(db, "invoice_draft", { client_id: s.client, period_start: "2026-01-01", period_end: "2026-12-31", lines }).invoice;
          invoices.push(must(db, "invoice_issue", { id: d.id }).invoice.id);
        } else if (s.do === "pay" && invoices.length) {
          const inv = must(db, "invoice_get", { id: pick(invoices, s.pick) }).invoice;
          const amount = Math.max(1, Math.round((inv.open_cents ?? 0) * s.part));
          const r = write(db, "payment_add", { invoice_id: inv.id, date: s.date, amount_cents: amount, deposit_account_id: acct(1) });
          if (r.ok) payments.push({ id: (r.result as any).payment.id, date: s.date });
        } else if (s.do === "refund" && payments.length) {
          const p = pick(payments, s.pick)!;
          const left = must(db, "payment_list", {}).payments.find((x: any) => x.id === p.id).refundable_cents as number;
          const amount = s.part === null ? undefined : Math.max(1, Math.round(left * s.part));
          write(db, "payment_refund", { payment_id: p.id, date: day(Math.min(364, dayOf(p.date) + s.after)), reason: "test", ...(amount ? { amount_cents: amount } : {}) });
        } else if (s.do === "credit" && invoices.length) {
          const r = write(db, "invoice_credit", { invoice_id: pick(invoices, s.pick), reason: "test", line_kind: "manual", ...(s.cents ? { amount_cents: s.cents } : {}) });
          if (r.ok) credits.push((r.result as any).credit_note.id);
        } else if (s.do === "void" && invoices.length + credits.length) {
          write(db, "invoice_void", { id: pick([...invoices, ...credits], s.pick), reason: "test" });
        } else if (s.do === "state") {
          const m = Math.min(s.month, 13 - s.months);
          const start = `2026-${String(m).padStart(2, "0")}-01`;
          write(db, "sales_tax_payment_add", { date: s.date, amount_cents: s.cents, paid_from_account_id: acct(1), tax_label: s.label, period_start: start, period_end: monthEnd(m + s.months - 1) });
        }
      }

      const [from, to] = a <= b ? [a, b] : [b, a];
      const r = must(db, "report_sales_tax", { from, to, ...(by ? { period: by } : {}) });

      // Never a figure presented as due: no field says owed, due, payable or balance, and the note says who decides.
      expect(keys(r).filter((k) => /owed|due|payable|balance/i.test(k))).toEqual([]);
      expect(r.note).toBe("Your state's rules decide which of these figures, if any, is due for a period; solobooks doesn't decide that.");

      // The periods tile the range.
      expect(r.periods[0].period_start).toBe(from);
      expect(r.periods.at(-1).period_end).toBe(to);
      for (let i = 1; i < r.periods.length; i++) expect(dayOf(r.periods[i].period_start)).toBe(dayOf(r.periods[i - 1].period_end) + 1);

      const ledger = (sql: string, ...args: unknown[]) => (db.query(sql).get(...(args as any[])) as { n: number }).n;
      for (const p of r.periods) {
        const [ps, pe] = [p.period_start, p.period_end];
        const sum = (k: string) => p.taxes.reduce((s: number, t: any) => s + t[k], 0);
        // Charged is what the ledger posted to Sales tax payable in the period, apart from payments to the state.
        expect(sum("charged_cents")).toBe(ledger(
          `SELECT COALESCE(SUM(l.credit_cents) - SUM(l.debit_cents), 0) AS n FROM lines l JOIN entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
           WHERE a.name = 'Sales tax payable' AND e.date BETWEEN ? AND ? AND e.id NOT IN (SELECT entry_id FROM sales_tax_payments)`, ps, pe,
        ));
        for (const t of p.taxes) {
          // Per label, charged is each invoice's and credit note's tax on the day it was issued, undone on the day voided.
          const docs = [...invoices, ...credits].map((id) => must(db, "invoice_get", { id }).invoice);
          const byLabel = docs.filter((d) => CLIENT_LABEL[d.client_id] === t.tax_label && d.tax);
          const tally = byLabel.reduce((s, d) => {
            const sign = d.kind === "invoice" ? 1 : -1;
            const on = (x: string | null) => x !== null && x.slice(0, 10) >= ps && x.slice(0, 10) <= pe;
            return s + (on(d.invoice_date) ? sign * d.tax.amount_cents : 0) - (d.status === "void" && on(d.voided_at) ? sign * d.tax.amount_cents : 0);
          }, 0);
          expect(t.charged_cents).toBe(tally);
          // Paid to the state is the payments recorded for a return period inside this one, as the ledger moved them.
          expect(t.paid_to_state_cents).toBe(ledger(
            `SELECT COALESCE(SUM(l.debit_cents), 0) AS n FROM lines l JOIN accounts a ON a.id = l.account_id WHERE a.name = 'Sales tax payable'
             AND l.entry_id IN (SELECT entry_id FROM sales_tax_payments WHERE tax_label = ? AND period_start >= ? AND period_end <= ?)`, t.tax_label, ps, pe,
          ));
          expect(t.payments_to_state.reduce((s: number, x: any) => s + x.amount_cents, 0)).toBe(t.paid_to_state_cents);
        }
        // Collected is part of the money that settled invoices in the period: with the income beside it, it is exactly
        // what payments settled less what refunds took back, plus credit applied.
        const settled = ledger(
          `SELECT (SELECT COALESCE(SUM(applied_cents), 0) FROM payments WHERE date BETWEEN ?1 AND ?2)
                - (SELECT COALESCE(SUM(applied_cents), 0) FROM refunds WHERE date BETWEEN ?1 AND ?2)
                + (SELECT COALESCE(SUM(amount_cents), 0) FROM credit_applications WHERE date BETWEEN ?1 AND ?2) AS n`, ps, pe,
        );
        const events = cashEvents(db, ps, pe);
        expect(events.reduce((s, e) => s + e.services + e.reimbursed + e.tax, 0)).toBe(settled);
        expect(sum("collected_cents")).toBe(events.reduce((s, e) => s + e.tax, 0));
      }
      // Rows add up to the range's figures.
      for (const k of ["charged_cents", "collected_cents"]) {
        for (const l of LABELS) {
          const total = r.taxes.find((t: any) => t.tax_label === l)?.[k] ?? 0;
          const rows = r.periods.reduce((s: number, p: any) => s + (p.taxes.find((t: any) => t.tax_label === l)?.[k] ?? 0), 0);
          expect(rows).toBe(total);
        }
      }

      // Collected follows the money exactly: an invoice settled in full has collected its tax less its credit notes'.
      const all = cashEvents(db);
      for (const id of invoices) {
        const inv = must(db, "invoice_get", { id }).invoice;
        const credited = credits
          .map((c) => must(db, "invoice_get", { id: c }).invoice)
          .filter((c) => c.credits_invoice.id === id && c.status !== "void")
          .reduce((s, c) => s + (c.tax?.amount_cents ?? 0), 0);
        const due = inv.status === "void" ? 0 : (inv.tax?.amount_cents ?? 0) - credited;
        const got = all.filter((e) => e.invoice_id === id).reduce((s, e) => s + e.tax, 0);
        if (inv.status !== "void" && inv.open_cents === 0) expect(got).toBe(due);
        else expect(got).toBeLessThanOrEqual(Math.max(due, 0));
      }
      db.close();
    }),
    { numRuns: 1000 },
  );
}, 300_000); // 1000 runs: allow for a busy machine
