import { expect, test } from "bun:test";
import fc from "fast-check";
import type { Books } from "../src/core/db.ts";
import { memBooks } from "./support/books.ts";
import { must, write } from "./support/gen.ts";

// Owner money, thrown at the books at random. Accounts: 1 Checking, 2 Savings, 3 Card, 4 Stripe balance (the
// person's own), 5 Owner equity, 6 Speaking income, 7 Software expense. Random legs and accounts include ones that
// aren't the person's own, so a write that would reach the P&L has to be refused, not just never generated.

function books(): Books {
  const db = memBooks();
  for (const [name, type] of [
    ["Checking", "asset"], ["Savings", "asset"], ["Card", "liability"], ["Stripe balance", "asset"],
    ["Owner equity", "equity"], ["Speaking income", "income"], ["Software", "expense"],
  ]) must(db, "account_add", { name, type });
  // Some real income and expense first, so an unchanged P&L isn't just an empty one.
  must(db, "entry_post", { date: "2026-03-01", memo: "Client paid", lines: [{ account_id: 1, debit_cents: 900000 }, { account_id: 6, credit_cents: 900000 }] });
  must(db, "expense_add", { date: "2026-03-02", amount_cents: 4999, vendor: "Editor", account_id: 7, paid_from_account_id: 3 });
  return db;
}

const OWN = [1, 2, 3, 4];
const ANY = [1, 2, 3, 4, 5, 6, 7];
const date = fc.integer({ min: 0, max: 364 }).map((d) => new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10));
const amount = fc.integer({ min: 1, max: 50_000_000 });

/** Legs that net to zero across distinct own accounts: random amounts out of some, one leg taking the rest in. */
const balancedLegs = fc
  .shuffledSubarray(OWN, { minLength: 2, maxLength: 4 })
  .chain((ids) =>
    fc.array(fc.tuple(amount, fc.boolean()), { minLength: ids.length - 1, maxLength: ids.length - 1 }).map((xs) => {
      const legs = xs.map(([a, out], i) => ({ account_id: ids[i]!, amount_cents: out ? -a : a }));
      const net = legs.reduce((s, l) => s + l.amount_cents, 0);
      legs.push({ account_id: ids.at(-1)!, amount_cents: net === 0 ? 0 : -net });
      return legs;
    }),
  );

/** Legs that may not net to zero, or that reach accounts that aren't the person's own. */
const strayLegs = fc.array(fc.record({ account_id: fc.constantFrom(...ANY), amount_cents: fc.integer({ min: -50_000_000, max: 50_000_000 }) }), {
  minLength: 2,
  maxLength: 4,
});

const pnl = (db: Books) => must(db, "report_pnl", {});
/** What the person's own accounts hold in all, debits less credits: moving money among them never changes it. */
const own = (db: Books) =>
  (db.query("SELECT COALESCE(SUM(debit_cents) - SUM(credit_cents), 0) n FROM lines WHERE account_id IN (1, 2, 3, 4)").get() as { n: number }).n;

test("ISC-20 transfers: random transfers between the person's own accounts leave the P&L unchanged", () => {
  let posted = 0;
  let refused = 0;
  fc.assert(
    fc.property(fc.array(fc.tuple(date, fc.oneof(balancedLegs, strayLegs)), { maxLength: 12 }), (transfers) => {
      const db = books();
      const before = pnl(db);
      const held = own(db);
      for (const [d, legs] of transfers) {
        const r = write(db, "transfer_add", { date: d, legs });
        r.ok ? posted++ : refused++;
        expect(pnl(db)).toEqual(before);
        expect(own(db)).toBe(held);
      }
      // Every transfer that posted is on file as owner money, and only those.
      expect(must(db, "owner_list", { kind: "transfer" }).owner_money.length).toBe(
        (db.query("SELECT COUNT(*) n FROM history WHERE op = 'transfer_add'").get() as { n: number }).n,
      );
      db.close();
    }),
    { numRuns: 1000 },
  );
  // Both sides were exercised: transfers that posted, and ones refused for not netting or for reaching the P&L.
  expect(posted).toBeGreaterThan(500);
  expect(refused).toBeGreaterThan(500);
}, 60_000); // 1000 runs: allow for a busy machine

const move = fc.record({
  op: fc.constantFrom("owner_draw", "owner_contribute"),
  input: fc.record({ date, amount_cents: amount, account_id: fc.constantFrom(...ANY) }),
});

test("ISC-24 draws: random owner draws and contributions never touch the P&L", () => {
  let posted = 0;
  fc.assert(
    fc.property(fc.array(move, { maxLength: 12 }), (moves) => {
      const db = books();
      const before = pnl(db);
      let equity = 0; // what the person put in less what they took out, by the test's own tally
      for (const m of moves) {
        const r = write(db, m.op, m.input);
        if (r.ok) {
          posted++;
          equity += m.op === "owner_contribute" ? m.input.amount_cents : -m.input.amount_cents;
        }
        expect(pnl(db)).toEqual(before);
      }
      // The money went to equity instead: contributions less draws, exactly.
      const net = db
        .query("SELECT COALESCE(SUM(l.credit_cents) - SUM(l.debit_cents), 0) n FROM lines l JOIN accounts a ON a.id = l.account_id WHERE a.name IN ('Owner draws', 'Owner contributions')")
        .get() as { n: number };
      expect(net.n).toBe(equity);
      db.close();
    }),
    { numRuns: 1000 },
  );
  expect(posted).toBeGreaterThan(1000);
}, 60_000); // 1000 runs: allow for a busy machine
