import { expect, test } from "bun:test";
import { acmeBooks, cli, json, ok, S } from "./support/billing.ts";
import { acct } from "./support/books.ts";

// The year-end report: everything an accountant asks for, with figures only. acmeBooks: 1 Checking, 2 Printing.

test("ISC-54 home office: the year's home office figures appear in the year-end export", async () => {
  const dir = await acmeBooks();
  const set = (body: Record<string, unknown>) => ok(dir, json(["home", "office", "set"], { year: 2026, ...body }));
  await set({ office_square_feet: 200, home_square_feet: 1000, expenses: [{ description: "Rent", amount_cents: 100 }] });
  // Setting the year again replaces it.
  const h = (await set({
    office_square_feet: 150, home_square_feet: 1200, note: "Second bedroom, all year",
    expenses: [{ description: "Rent", amount_cents: 2_400_000 }, { description: "Electricity", amount_cents: 96_000 }],
  })).home_office;
  expect(h).toMatchObject({ year: 2026, office_square_feet: 150, home_square_feet: 1200, office_share_ppm: 125_000, office_share: "12.50%", expenses_total_cents: 2_496_000 });

  const y = await ok(dir, ["report", "yearend", "--year", "2026"]);
  expect(y.home_office).toEqual({ ...h, expenses: [{ description: "Rent", amount_cents: 2_400_000 }, { description: "Electricity", amount_cents: 96_000 }] });
  // It is a figure for the accountant, never posted: the P&L doesn't move, and another year has none.
  expect(y.pnl.expense_total_cents).toBe(4200 + 999);
  expect((await ok(dir, ["report", "yearend", "--year", "2025"])).home_office).toBeNull();
  expect((await cli(dir, json(["home", "office", "set"], { year: 2026, office_square_feet: 2000, home_square_feet: 1000 }))).out.field).toBe("office_square_feet");
}, 30_000); // many CLI runs: allow for a busy machine

test("ISC-55 owner items: estimated taxes, health insurance and retirement are totalled apart, and never in the P&L", async () => {
  const dir = await acmeBooks();
  const before = await ok(dir, ["report", "pnl"]);
  const item = (body: Record<string, unknown>) => ok(dir, json(["owner", "item", "add"], body));
  await item({ kind: "estimated_tax", date: "2026-04-15", amount_cents: 400_000, paid_from_account_id: acct(1), jurisdiction: "federal", confirmation: "EFT-1" });
  await item({ kind: "estimated_tax", date: "2026-04-15", amount_cents: 90_000, paid_from_account_id: acct(1), jurisdiction: "Illinois" });
  await item({ kind: "estimated_tax", date: "2026-06-15", amount_cents: 400_000, paid_personally: true, jurisdiction: "federal", memo: "Q2" });
  const health = (await item({ kind: "health_insurance", date: "2026-05-01", amount_cents: 61_234, paid_from_account_id: acct(1) })).owner_item;
  await item({ kind: "retirement", date: "2026-12-30", amount_cents: 1_000_000, paid_personally: true, memo: "Solo 401(k)" });
  await item({ kind: "retirement", date: "2025-12-30", amount_cents: 5, paid_personally: true }); // last year

  // Paid from checking it is an owner draw: money left the business, and no expense was booked.
  expect(health).toMatchObject({ paid_personally: false, entry: { lines: [{ debit_cents: 61_234 }, { account_id: acct(1), credit_cents: 61_234 }] } });
  expect((await ok(dir, ["owner", "list", "--kind", "draw"])).owner_money.map((m: any) => m.amount_cents)).toEqual([400_000, 90_000, 61_234]);
  expect(await ok(dir, ["report", "pnl"])).toEqual(before);

  const y = await ok(dir, ["report", "yearend", "--year", "2026"]);
  expect(y.owner_items.estimated_tax.total_cents).toBe(890_000);
  expect(y.owner_items.estimated_tax.by_jurisdiction).toEqual([{ jurisdiction: "Illinois", total_cents: 90_000 }, { jurisdiction: "federal", total_cents: 800_000 }]);
  expect(y.owner_items.health_insurance.total_cents).toBe(61_234);
  expect(y.owner_items.retirement.total_cents).toBe(1_000_000);
  expect(y.owner_items.estimated_tax.items.map((i: any) => i.confirmation)).toEqual(["EFT-1", null, null]);
  // None of it is in the year's P&L or its profit.
  expect(y.pnl).toMatchObject({ income_total_cents: 0, expense_total_cents: 4200 + 999 });
  expect(y.profit_cents).toBe(-(4200 + 999));

  // An estimated tax payment says who it went to; nothing else does; and it is paid one way.
  expect((await cli(dir, json(["owner", "item", "add"], { kind: "estimated_tax", date: "2026-09-15", amount_cents: 1, paid_personally: true }))).out.field).toBe("jurisdiction");
  expect((await cli(dir, json(["owner", "item", "add"], { kind: "retirement", date: "2026-09-15", amount_cents: 1, paid_personally: true, jurisdiction: "federal" }))).out.field).toBe("jurisdiction");
  expect((await cli(dir, json(["owner", "item", "add"], { kind: "retirement", date: "2026-09-15", amount_cents: 1, paid_personally: true, paid_from_account_id: acct(1) }))).out.field).toBe("paid_from_account_id");
  expect((await cli(dir, json(["owner", "item", "add"], { kind: "retirement", date: "2026-09-15", amount_cents: 1, paid_from_account_id: acct(2) }))).out.field).toBe("paid_from_account_id");
}, 30_000); // many CLI runs: allow for a busy machine

test("year-end: one report carries the P&L by Schedule C line, profit, sales tax, mileage and contractors, stated as figures", async () => {
  const dir = await acmeBooks();
  const y = await ok(dir, ["report", "yearend", "--year", "2026", ...S]);
  expect(Object.keys(y)).toEqual(["year", "from", "to", "basis", "basis_note", "note", "profit_cents", "pnl", "sales_tax", "mileage", "home_office", "owner_items", "contractors"]);
  expect(y.note).toContain("computes no tax");
  expect(y.pnl.schedule_c).toBeArray();
  expect(y.profit_cents).toBe(y.pnl.net_cents);
}, 30_000); // many CLI runs: allow for a busy machine
