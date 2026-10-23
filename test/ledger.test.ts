import { expect, test } from "bun:test";
import { memBooks } from "./support/books.ts";
import { must, seedAccounts } from "./support/gen.ts";

test("ISC-7 posted immutable: UPDATE and DELETE on a posted entry are refused by the database", () => {
  const db = memBooks();
  seedAccounts(db);
  must(db, "entry_post", { date: "2026-10-01", memo: "fee", lines: [{ account_id: 1, debit_cents: 500 }, { account_id: 4, credit_cents: 500 }] });

  const attempts = [
    "UPDATE entries SET memo = 'changed' WHERE id = 1",
    "DELETE FROM entries WHERE id = 1",
    "UPDATE lines SET debit_cents = 1 WHERE entry_id = 1",
    "DELETE FROM lines WHERE entry_id = 1",
  ];
  for (const sql of attempts) expect(() => db.exec(sql)).toThrow(/posted entries are immutable/);

  expect(db.query("SELECT memo FROM entries WHERE id = 1").get()).toEqual({ memo: "fee" });
  expect(db.query("SELECT SUM(debit_cents) d, COUNT(*) n FROM lines WHERE entry_id = 1").get()).toEqual({ d: 500, n: 2 });
});
