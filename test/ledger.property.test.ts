import { expect, test } from "bun:test";
import fc from "fast-check";
import { memBooks } from "./support/books.ts";
import { seedAccounts, write, writeCmd } from "./support/gen.ts";

test("ISC-4 balances: debits equal credits after every write, across any sequence of writes", () => {
  let posted = 0;
  let refused = 0;
  fc.assert(
    fc.property(fc.array(writeCmd, { maxLength: 15 }), (cmds) => {
      const db = memBooks();
      seedAccounts(db);
      for (const c of cmds) {
        const r = write(db, c.op, c.input);
        if (c.op === "entry_post") r.ok ? posted++ : refused++;
        const total = db.query("SELECT COALESCE(SUM(debit_cents),0) d, COALESCE(SUM(credit_cents),0) c FROM lines").get() as any;
        expect(total.d).toBe(total.c);
        const unbalanced = db
          .query("SELECT entry_id FROM lines GROUP BY entry_id HAVING SUM(debit_cents) <> SUM(credit_cents)")
          .all();
        expect(unbalanced).toEqual([]);
      }
      db.close();
    }),
    { numRuns: 1000 },
  );
  // The property only means something if both balanced posts and unbalanced attempts were exercised.
  expect(posted).toBeGreaterThan(100);
  expect(refused).toBeGreaterThan(100);
}, 60_000); // 1000 runs: allow for a busy machine
