import { expect, test } from "bun:test";
import fc from "fast-check";
import { cashEvents } from "../src/core/cash.ts";
import { memBooks } from "./support/books.ts";
import { must, write } from "./support/gen.ts";
import { letAgentDecide } from "./support/person.ts";

// ISC-51: for any run of taxed invoices, payments, refunds, credit notes, voids and payments to the state, the sales tax
// report's owed for a period is exactly what was collected in it less what was paid to the state for it.

const LABELS = ["AA sales tax", "BB sales tax"];
const day = (d: number) => new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
const date = fc.integer({ min: 0, max: 364 }).map(day);

const step = fc.oneof(
  fc.record({ do: fc.constant("issue"), client: fc.constantFrom(1, 2, 3), cents: fc.integer({ min: 1, max: 2_000_000 }), lines: fc.integer({ min: 1, max: 3 }) }),
  fc.record({ do: fc.constant("pay"), pick: fc.nat(), part: fc.constantFrom(0.1, 0.33, 0.5, 1, 1.2), date }),
  fc.record({ do: fc.constant("pay"), pick: fc.nat(), part: fc.constant(1), date }),
  fc.record({ do: fc.constant("refund"), pick: fc.nat(), after: fc.integer({ min: 0, max: 30 }) }),
  fc.record({ do: fc.constant("credit"), pick: fc.nat(), cents: fc.option(fc.integer({ min: 1, max: 500_000 })) }),
  fc.record({ do: fc.constant("void"), pick: fc.nat() }),
  fc.record({ do: fc.constant("state"), label: fc.constantFrom(...LABELS), cents: fc.integer({ min: 1, max: 300_000 }), month: fc.integer({ min: 1, max: 12 }), date }),
);

const monthEnd = (m: number) => new Date(Date.UTC(2026, m, 0)).toISOString().slice(0, 10);

test("ISC-51 owed by period: owed is exactly tax collected less payments to the state, for any period", () => {
  fc.assert(
    fc.property(fc.array(step, { minLength: 1, maxLength: 25 }), date, date, date, (steps, a, b, m) => {
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
      const statePaid: { label: string; cents: number; start: string; end: string }[] = [];
      const pick = <T>(xs: T[], n: number) => xs[n % xs.length];

      for (const s of steps) {
        if (s.do === "issue") {
          const lines = Array.from({ length: s.lines }, (_, i) => ({ description: `Line ${i}`, amount_cents: s.cents + i * 137 }));
          const d = must(db, "invoice_draft", { client_id: s.client, period_start: "2026-01-01", period_end: "2026-12-31", lines }).invoice;
          invoices.push(must(db, "invoice_issue", { id: d.id }).invoice.id);
        } else if (s.do === "pay" && invoices.length) {
          const inv = must(db, "invoice_get", { id: pick(invoices, s.pick) }).invoice;
          const amount = Math.max(1, Math.round((inv.open_cents ?? 0) * s.part));
          const r = write(db, "payment_add", { invoice_id: inv.id, date: s.date, amount_cents: amount, deposit_account_id: 1 });
          if (r.ok) payments.push({ id: (r.result as any).payment.id, date: s.date });
        } else if (s.do === "refund" && payments.length) {
          const p = pick(payments, s.pick)!;
          const on = day(Math.min(364, Math.round((Date.parse(p.date) - Date.UTC(2026, 0, 1)) / 86_400_000) + s.after));
          write(db, "payment_refund", { payment_id: p.id, date: on, reason: "test" });
        } else if (s.do === "credit" && invoices.length) {
          const r = write(db, "invoice_credit", { invoice_id: pick(invoices, s.pick), reason: "test", line_kind: "manual", ...(s.cents ? { amount_cents: s.cents } : {}) });
          if (r.ok) credits.push((r.result as any).credit_note.id);
        } else if (s.do === "void" && invoices.length + credits.length) {
          write(db, "invoice_void", { id: pick([...invoices, ...credits], s.pick), reason: "test" });
        } else if (s.do === "state") {
          const start = `2026-${String(s.month).padStart(2, "0")}-01`;
          const end = monthEnd(s.month);
          const r = write(db, "sales_tax_payment_add", { date: s.date, amount_cents: s.cents, paid_from_account_id: 1, tax_label: s.label, period_start: start, period_end: end });
          if (r.ok) statePaid.push({ label: s.label, cents: s.cents, start, end });
        }
      }

      const report = (from: string, to: string) => must(db, "report_sales_tax", { from, to });
      const label = (r: any, l: string) => r.taxes.find((t: any) => t.tax_label === l) ?? { collected_cents: 0, paid_cents: 0, owed_cents: 0, invoiced_cents: 0 };
      const [from, to] = a <= b ? [a, b] : [b, a];
      for (const [f, t] of [[from, to], ["2026-01-01", "2026-12-31"]] as const) {
        const r = report(f, t);
        for (const l of LABELS) {
          const x = label(r, l);
          // The claim: owed is collected less paid.
          expect(x.owed_cents).toBe(x.collected_cents - x.paid_cents);
          // Paid is every payment to the state for a return period inside the range, tallied here independently.
          expect(x.paid_cents).toBe(statePaid.filter((p) => p.label === l && p.start >= f && p.end <= t).reduce((s, p) => s + p.cents, 0));
        }
        expect(r.owed_cents).toBe(r.collected_cents - r.paid_cents);
        expect(r.taxes.map((x: any) => x.tax_label)).not.toContain("Sales tax"); // the untaxed client collects nothing
      }

      // Periods add up: splitting a range anywhere splits what was collected, to the cent.
      if (m >= from && m < to) {
        const next = day(Math.round((Date.parse(m) - Date.UTC(2026, 0, 1)) / 86_400_000) + 1);
        const whole = report(from, to);
        const left = report(from, m);
        const right = report(next, to);
        for (const l of LABELS) expect(label(left, l).collected_cents + label(right, l).collected_cents).toBe(label(whole, l).collected_cents);
      }

      // Collected follows the money: an invoice settled in full has collected exactly its tax less its credit notes';
      // one that isn't has collected no more than that; one never paid, nothing.
      const events = cashEvents(db);
      for (const id of invoices) {
        const inv = must(db, "invoice_get", { id }).invoice;
        const credited = credits
          .map((c) => must(db, "invoice_get", { id: c }).invoice)
          .filter((c) => c.credits_invoice.id === id && c.status !== "void")
          .reduce((s, c) => s + (c.tax?.amount_cents ?? 0), 0);
        const due = inv.status === "void" ? 0 : (inv.tax?.amount_cents ?? 0) - credited;
        const got = events.filter((e) => e.invoice_id === id).reduce((s, e) => s + e.tax, 0);
        if (inv.status !== "void" && inv.open_cents === 0) expect(got).toBe(due);
        else {
          expect(got).toBeGreaterThanOrEqual(0);
          expect(got).toBeLessThanOrEqual(Math.max(due, 0));
        }
      }

      // And across all time, what invoices charged less what was paid to the state is what the ledger still owes it.
      const all = report("0000-01-01", "9999-12-31");
      const payable = db.query("SELECT COALESCE(SUM(l.credit_cents) - SUM(l.debit_cents), 0) AS n FROM lines l JOIN accounts a ON a.id = l.account_id WHERE a.name = 'Sales tax payable'").get() as { n: number };
      expect(all.invoiced_cents - all.paid_cents).toBe(payable.n);
      db.close();
    }),
    { numRuns: 1000 },
  );
}, 180_000); // 1000 runs: allow for a busy machine
