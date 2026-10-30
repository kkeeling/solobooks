import { expect, test } from "bun:test";
import fc from "fast-check";
import { acct, memBooks } from "./support/books.ts";
import { must, write } from "./support/gen.ts";

// Random charges and edits against one expense, from two clients. Whatever the sequence, the charges on the expense
// never add up to more than it, and the write that would have pushed them past it is the one refused.

const step = fc.oneof(
  fc.record({ kind: fc.constant("add" as const), client: fc.integer({ min: 1, max: 2 }), amount: fc.integer({ min: 1, max: 6000 }) }),
  fc.record({ kind: fc.constant("edit" as const), pick: fc.nat(), amount: fc.integer({ min: 1, max: 6000 }) }),
);

test("ISC-120 over-charge: charges on one expense never total more than it, and the write past it is refused", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 10_000 }), fc.array(step, { maxLength: 12 }), (spent, steps) => {
      const db = memBooks();
      must(db, "account_add", { name: "Checking", type: "asset" });
      must(db, "account_add", { name: "API usage", type: "expense" });
      must(db, "client_add", { name: "Acme" });
      must(db, "client_add", { name: "ETR" });
      const e = must(db, "expense_add", { date: "2026-10-01", amount_cents: spent, vendor: "OpenAI", account_id: acct(2), paid_from_account_id: acct(1) }).expense;
      const amounts = new Map<number, number>();
      const total = () => [...amounts.values()].reduce((a, b) => a + b, 0);
      for (const s of steps) {
        const ids = [...amounts.keys()];
        if (s.kind === "edit" && ids.length === 0) continue;
        const id = s.kind === "edit" ? ids[s.pick % ids.length]! : null;
        const after = total() - (id === null ? 0 : amounts.get(id)!) + s.amount;
        const r =
          s.kind === "add"
            ? write(db, "charge_add", { client_id: s.client, date: "2026-10-31", amount_cents: s.amount, line_text: "API usage", expense_id: e.id })
            : write(db, "charge_edit", { id: id!, amount_cents: s.amount });
        if (after > spent) {
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.refusal.field).toBe("amount_cents");
        } else {
          expect(r.ok).toBe(true);
          if (r.ok) amounts.set((r.result as any).charge.id, s.amount);
        }
        const sum = (db.query("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM charges WHERE expense_id = ?").get(e.id) as { n: number }).n;
        expect(sum).toBe(total());
        expect(sum).toBeLessThanOrEqual(spent);
        expect(must(db, "expense_list", {}).expenses[0].not_yet_charged_cents).toBe(spent - sum);
      }
      db.close();
    }),
    { numRuns: 1000 },
  );
});
