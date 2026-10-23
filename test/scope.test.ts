import { expect, test } from "bun:test";
import { memBooks, acct } from "./support/books.ts";
import { must, seedAccounts, write } from "./support/gen.ts";

const USD_ONLY = { reason: "solobooks keeps books in US dollars only, so currency must be USD.", field: "" };

test("ISC-15 usd only: any currency other than USD is refused", () => {
  const db = memBooks();
  seedAccounts(db);
  must(db, "client_add", { name: "Acme" });
  const line = (currency?: string) => ({
    date: "2026-10-01",
    memo: "m",
    lines: [{ account_id: acct(1), debit_cents: 100, currency }, { account_id: acct(4), credit_cents: 100 }],
  });

  for (const currency of ["EUR", "usd", "CAD", "GBP", ""]) {
    expect(write(db, "entry_post", line(currency))).toEqual({ ok: false, refusal: { ...USD_ONLY, field: "lines[0].currency" } });
    expect(write(db, "engagement_add", { client_id: 1, name: "E", rate_cents_per_hour: 100, currency })).toEqual({
      ok: false,
      refusal: { ...USD_ONLY, field: "currency" },
    });
    expect(
      write(db, "engagement_add", { client_id: 1, name: "M", milestones: [{ name: "a", amount_cents: 1, currency }] }),
    ).toEqual({ ok: false, refusal: { ...USD_ONLY, field: "milestones[0].currency" } });
  }
  expect(db.query("SELECT COUNT(*) n FROM lines").get()).toEqual({ n: 0 });

  // USD, stated or left out, is accepted.
  expect(write(db, "entry_post", line("USD")).ok).toBe(true);
  expect(write(db, "entry_post", line()).ok).toBe(true);

  // The database refuses a non-USD row even if a code path forgot to check.
  expect(() =>
    db.exec("INSERT INTO lines (entry_id, account_id, debit_cents, currency, source) VALUES (1, 1, 5, 'EUR', 'x')"),
  ).toThrow(/CHECK/);
  expect(() => db.exec("UPDATE engagements SET currency = 'EUR'")).not.toThrow(); // no engagements yet
  must(db, "engagement_add", { client_id: 1, name: "E", rate_cents_per_hour: 100 });
  expect(() => db.exec("UPDATE engagements SET currency = 'EUR'")).toThrow(/CHECK/);
});
