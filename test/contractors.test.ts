import { expect, test } from "bun:test";
import { acmeBooks, cli, json, ok, S } from "./support/billing.ts";
import { acct } from "./support/books.ts";

// Contractors and what they were paid. acmeBooks: 1 Checking, 2 Printing; here 3 Card and 4 Contract labor.

async function books() {
  const dir = await acmeBooks();
  await ok(dir, ["account", "add", "--name", "Card", "--type", "liability", ...S]);
  await ok(dir, ["account", "add", "--name", "Subcontractors", "--type", "expense", "--schedule-c", "11", ...S]);
  const sam = (await ok(dir, json(["contractor", "add"], { name: "Sam Rivera", w9_status: "not_on_file" }))).contractor;
  const lee = (await ok(dir, json(["contractor", "add"], { name: "Lee Design LLC", w9_status: "on_file", w9_received_on: "2026-02-01" }))).contractor;
  const pay = (c: number, date: string, cents: number, payment_method: string, from = acct(1)) =>
    ok(dir, json(["expense", "add"], { date, amount_cents: cents, vendor: "Contractor", account_id: acct(4), paid_from_account_id: from, contractor_id: c, payment_method }));
  return { dir, sam, lee, pay };
}

test("ISC-56 fields: a contractor payment carries the contractor's W-9 status and the payment method", async () => {
  const { dir, sam, lee, pay } = await books();
  const e = (await pay(sam.id, "2026-03-01", 150_000, "ach")).expense;
  expect(e).toMatchObject({ contractor_id: sam.id, payment_method: "ach", account_id: acct(4) });
  await pay(lee.id, "2026-04-01", 80_000, "check");

  const listed = (await ok(dir, ["contractor", "list", "--year", "2026"])).contractors;
  expect(listed.map((c: any) => [c.name, c.w9_status, c.w9_received_on])).toEqual([["Lee Design LLC", "on_file", "2026-02-01"], ["Sam Rivera", "not_on_file", null]]);
  expect(listed[1].payments).toEqual([
    { expense_id: e.id, date: "2026-03-01", amount_cents: 150_000, payment_method: "ach", w9_status: "not_on_file", outside_1099_nec: false, outside_1099_nec_reason: null, memo: null },
  ]);
  // When the W-9 arrives, every payment shows it.
  await ok(dir, json(["contractor", "edit"], { id: sam.id, w9_status: "on_file", w9_received_on: "2026-05-02" }));
  const after = (await ok(dir, ["report", "yearend", "--year", "2026"])).contractors.find((c: any) => c.id === sam.id);
  expect(after).toMatchObject({ w9_status: "on_file", w9_received_on: "2026-05-02", paid_cents: 150_000 });
  expect(after.payments[0].w9_status).toBe("on_file");

  // A payment to a contractor must say how it was paid, and name a real contractor.
  const base = { date: "2026-03-01", amount_cents: 1, vendor: "x", account_id: acct(4), paid_from_account_id: acct(1) };
  expect((await cli(dir, json(["expense", "add"], { ...base, contractor_id: sam.id }))).out).toEqual({
    reason: "A payment to a contractor needs payment_method, since card and PayPal payments are reported on 1099-K instead of 1099-NEC.",
    field: "payment_method",
  });
  expect((await cli(dir, json(["expense", "add"], { ...base, contractor_id: 99, payment_method: "ach" }))).out.field).toBe("contractor_id");
  expect((await cli(dir, json(["expense", "add"], { ...base, contractor_id: sam.id, payment_method: "bitcoin" }))).out.field).toBe("payment_method");
  expect((await cli(dir, json(["contractor", "add"], { name: "sam rivera", w9_status: "on_file" }))).out.field).toBe("name");
  expect((await cli(dir, json(["contractor", "add"], { name: "New", w9_status: "not_on_file", w9_received_on: "2026-01-01" }))).out.field).toBe("w9_received_on");
}, 30_000); // many CLI runs: allow for a busy machine

test("ISC-57 1099-k: card and PayPal payments to a contractor are flagged as outside the 1099-NEC list", async () => {
  const { dir, sam, pay } = await books();
  await pay(sam.id, "2026-03-01", 100_000, "ach");
  await pay(sam.id, "2026-04-01", 30_000, "card", acct(3));
  await pay(sam.id, "2026-05-01", 20_000, "paypal");
  await pay(sam.id, "2026-06-01", 5_000, "zelle");
  await pay(sam.id, "2025-12-01", 9_999, "check"); // last year

  const c = (await ok(dir, ["contractor", "list", "--year", "2026"])).contractors.find((x: any) => x.id === sam.id);
  expect(c.payments.map((p: any) => [p.payment_method, p.outside_1099_nec])).toEqual([["ach", false], ["card", true], ["paypal", true], ["zelle", false]]);
  for (const p of c.payments.filter((p: any) => p.outside_1099_nec)) expect(p.outside_1099_nec_reason).toContain("1099-K");
  expect(c).toMatchObject({ paid_cents: 155_000, nec_method_cents: 105_000, outside_1099_nec_cents: 50_000 });
  // Every year, when no year is asked for.
  expect((await ok(dir, ["contractor", "list"])).contractors.find((x: any) => x.id === sam.id).nec_method_cents).toBe(105_000 + 9_999);
}, 30_000); // many CLI runs: allow for a busy machine
