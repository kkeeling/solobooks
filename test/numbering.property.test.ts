import { expect, test } from "bun:test";
import fc from "fast-check";
import { memBooks } from "./support/books.ts";
import { must, write } from "./support/gen.ts";
import { letAgentDecide } from "./support/person.ts";

const step = fc.oneof(
  fc.record({ do: fc.constant("draft"), client: fc.constantFrom(1, 2), cents: fc.integer({ min: 1, max: 5_000_000 }) }),
  fc.record({ do: fc.constant("issue"), pick: fc.nat() }),
  fc.record({ do: fc.constant("void"), pick: fc.nat() }),
  fc.record({ do: fc.constant("credit"), pick: fc.nat(), cents: fc.option(fc.integer({ min: 1, max: 5_000_000 })) }),
  fc.record({ do: fc.constant("delete"), pick: fc.nat() }),
);

const count = (db: any, sql: string) => (db.query(sql).get() as { n: number }).n;

test("ISC-32: invoice numbers continue from the configured next number with no gaps, across random issue, void and credit", () => {
  const seen = { issue: 0, void: 0, credit: 0, delete: 0 };
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 999_000_000 }), fc.array(step, { minLength: 1, maxLength: 30, size: "max" }), (start, steps) => {
      const db = memBooks();
      letAgentDecide(db);
      must(db, "profile_set", { legal_name: "Jane Doe LLC", address: "1 Main St", ein: "12-3456789", next_invoice_number: start });
      must(db, "client_add", { name: "Acme", address: "500 Market St" });
      must(db, "client_add", { name: "Beta", address: "9 Elm Rd", tax_rate_ppm: 82500, tax_applies_to: ["manual"] }); // tax is owed, not income
      const ids = { draft: [] as number[], issued: [] as number[], credits: [] as number[] };
      let history = count(db, "SELECT COUNT(*) n FROM history");
      let income = 0; // independent tally: subtotals of standing invoices less standing credits

      for (const s of steps) {
        const pick = (xs: number[]) => xs[(s as any).pick % xs.length];
        let r: ReturnType<typeof write> | null = null;
        if (s.do === "draft") {
          r = write(db, "invoice_draft", {
            client_id: s.client, period_start: "2026-10-01", period_end: "2026-10-31",
            lines: [{ description: "Work", amount_cents: s.cents }],
          });
          if (r.ok) ids.draft.push((r.result as any).invoice.id);
        } else if (s.do === "issue" && ids.draft.length) {
          const id = pick(ids.draft)!;
          r = write(db, "invoice_issue", { id });
          if (r.ok) {
            ids.draft = ids.draft.filter((x) => x !== id);
            ids.issued.push(id);
            income += (r.result as any).invoice.subtotal_cents;
            seen.issue++;
          }
        } else if (s.do === "void" && ids.issued.length + ids.credits.length) {
          const id = pick([...ids.issued, ...ids.credits])!;
          r = write(db, "invoice_void", { id, reason: "test" });
          if (r.ok) {
            const v = (r.result as any).invoice;
            income += v.kind === "credit" ? v.subtotal_cents : -v.subtotal_cents;
            seen.void++;
          }
        } else if (s.do === "credit" && ids.issued.length) {
          r = write(db, "invoice_credit", { invoice_id: pick(ids.issued), reason: "test", line_kind: "manual", ...(s.cents ? { amount_cents: s.cents } : {}) });
          if (r.ok) {
            ids.credits.push((r.result as any).credit_note.id);
            income -= (r.result as any).credit_note.subtotal_cents;
            seen.credit++;
          }
        } else if (s.do === "delete" && ids.draft.length) {
          const id = pick(ids.draft)!;
          r = write(db, "invoice_delete", { id });
          if (r.ok) {
            ids.draft = ids.draft.filter((x) => x !== id);
            seen.delete++;
          }
        }
        // F0 holds after every step: one history row per accepted write, balanced books, a P&L that matches the tally.
        if (r?.ok) history++;
        expect(count(db, "SELECT COUNT(*) n FROM history")).toBe(history);
        expect(db.query("SELECT COALESCE(SUM(debit_cents),0) d, COALESCE(SUM(credit_cents),0) c FROM lines").get()).toMatchObject({
          d: count(db, "SELECT COALESCE(SUM(credit_cents),0) n FROM lines"),
        });
        expect(must(db, "report_pnl", {}).income_total_cents).toBe(income);
      }

      // Every invoice that was ever issued, voided ones included, holds one number from an unbroken run.
      const nums = (db.query("SELECT number FROM invoices WHERE kind = 'invoice' AND number IS NOT NULL ORDER BY number").all() as any[]).map((x) => x.number);
      expect(nums).toEqual(nums.map((_, i) => start + i));
      expect(nums.length).toBe(ids.issued.length);
      const cns = (db.query("SELECT number FROM invoices WHERE kind = 'credit' ORDER BY number").all() as any[]).map((x) => x.number);
      expect(cns).toEqual(cns.map((_, i) => 1 + i));
      // Drafts never hold or reserve a number.
      expect(count(db, "SELECT COUNT(*) n FROM invoices WHERE status = 'draft' AND number IS NOT NULL")).toBe(0);
      const next = must(db, "profile_get", {}).next_invoice_number;
      expect(next).toBe(start + nums.length);
      db.close();
    }),
    { numRuns: 1000 },
  );
  // The property only means something if every kind of step really happened.
  expect(seen.issue).toBeGreaterThan(800);
  expect(seen.void).toBeGreaterThan(300);
  expect(seen.credit).toBeGreaterThan(200);
  expect(seen.delete).toBeGreaterThan(300);
}, 60_000); // 1000 runs: allow for a busy machine

test("ISC-32: the configured next number is fixed once an invoice is issued", () => {
  const db = memBooks();
  letAgentDecide(db);
  must(db, "profile_set", { legal_name: "Jane Doe LLC", address: "1 Main St", ein: "123456789", next_invoice_number: 500 });
  must(db, "profile_set", { next_invoice_number: 1043 }); // free to change before the first issue
  must(db, "client_add", { name: "Acme", address: "500 Market St" });
  const d = must(db, "invoice_draft", { client_id: 1, period_start: "2026-10-01", period_end: "2026-10-31", lines: [{ description: "x", amount_cents: 100 }] });
  expect(must(db, "invoice_issue", { id: d.invoice.id }).invoice.number).toBe("1043");
  const r = write(db, "profile_set", { next_invoice_number: 2000 });
  expect(r).toEqual({
    ok: false,
    refusal: {
      reason: "Invoices have already been issued, so numbers continue from the last one and next_invoice_number can't change.",
      field: "next_invoice_number",
    },
  });
  expect(must(db, "profile_get", {}).next_invoice_number).toBe(1044);
});
