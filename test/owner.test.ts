import { expect, test } from "bun:test";
import type { Books } from "../src/core/db.ts";
import { cli, ok, tempDir } from "./support/books.ts";
import { json, S } from "./support/billing.ts";
import { inProcessMcp } from "./support/mcp-client.ts";
import { memBooks } from "./support/books.ts";
import { must, write } from "./support/gen.ts";

// Owner money: the person's own money moving around is never income or expense.

/** Books with a business checking account, a business card, some income and a cost already on the card. */
function ownBooks() {
  const db = memBooks();
  for (const [name, type] of [["Checking", "asset"], ["Card", "liability"], ["Consulting", "income"], ["Software", "expense"], ["Meals", "expense"]]) {
    must(db, "account_add", { name, type });
  }
  must(db, "entry_post", { date: "2026-10-01", memo: "Client paid", lines: [{ account_id: 1, debit_cents: 500000 }, { account_id: 3, credit_cents: 500000 }] });
  must(db, "expense_add", { date: "2026-10-02", amount_cents: 12000, vendor: "Editor", account_id: 4, paid_from_account_id: 2 });
  return db;
}

/** An account's balance as debits less credits. */
const balance = (db: Books, id: number) =>
  (db.query("SELECT COALESCE(SUM(debit_cents) - SUM(credit_cents), 0) AS n FROM lines WHERE account_id = ?").get(id) as { n: number }).n;
const accountId = (db: Books, name: string) => (db.query("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
const pnl = (db: Books) => must(db, "report_pnl", {});

test("ISC-21 card payoff: paying the business card off from checking leaves the P&L unchanged", async () => {
  const db = ownBooks();
  const before = pnl(db);
  expect(balance(db, 2)).toBe(-12000); // the card owes the editor charge

  const r = must(db, "transfer_add", { date: "2026-10-25", memo: "Pay off October card", legs: [{ account_id: 1, amount_cents: -12000 }, { account_id: 2, amount_cents: 12000 }] });
  expect(r.transfer).toMatchObject({ kind: "transfer", amount_cents: 12000, memo: "Pay off October card" });
  expect(r.transfer.entry.lines).toEqual([
    { account_id: 1, debit_cents: 0, credit_cents: 12000 },
    { account_id: 2, debit_cents: 12000, credit_cents: 0 },
  ]);
  expect(pnl(db)).toEqual(before);
  expect(balance(db, 2)).toBe(0);
  expect(balance(db, 1)).toBe(500000 - 12000);

  // The same through the CLI and MCP, on books in a folder.
  const dir = tempDir();
  await ok(dir, ["account", "add", "--name", "Checking", "--type", "asset", ...S]);
  await ok(dir, ["account", "add", "--name", "Card", "--type", "liability", ...S]);
  const legs = [{ account_id: 1, amount_cents: -5000 }, { account_id: 2, amount_cents: 5000 }];
  await ok(dir, json(["transfer", "add"], { date: "2026-10-25", legs }));
  const mcp = await inProcessMcp(dir);
  expect((await mcp.call("transfer_add", { date: "2026-10-26", legs, source: "agent:mcp" })).isError).toBe(false);
  await mcp.close();
  const p = await ok(dir, ["report", "pnl"]);
  expect([p.income_total_cents, p.expense_total_cents]).toEqual([0, 0]);
  expect((await ok(dir, ["owner", "list"])).owner_money.map((m: any) => [m.kind, m.amount_cents])).toEqual([["transfer", 5000], ["transfer", 5000]]);
});

test("ISC-22 personal card: a business cost paid personally records the expense and an owner contribution", () => {
  const db = ownBooks();
  const checking = balance(db, 1);
  const card = balance(db, 2);
  const before = pnl(db);

  const r = must(db, "expense_add", { date: "2026-10-12", amount_cents: 4500, vendor: "Cafe", memo: "Client lunch", account_id: 5, paid_personally: true });
  const owner = accountId(db, "Owner contributions");
  // The expense, against the person's contribution rather than any business account.
  expect(r.expense).toMatchObject({ amount_cents: 4500, account_id: 5, paid_from_account_id: owner });
  expect(r.owner_contribution).toMatchObject({ kind: "contribution", date: "2026-10-12", amount_cents: 4500, expense_id: r.expense.id, memo: "Paid personally: Cafe: Client lunch" });
  expect(r.owner_contribution.entry.id).toBe(r.expense.entry_id);
  expect(r.owner_contribution.entry.lines).toEqual([
    { account_id: 5, debit_cents: 4500, credit_cents: 0 },
    { account_id: owner, debit_cents: 0, credit_cents: 4500 },
  ]);
  // It is a business expense on the P&L, the person's equity went up by it, and no business account moved.
  expect(pnl(db).expense_total_cents).toBe(before.expense_total_cents + 4500);
  expect(-balance(db, owner)).toBe(4500);
  expect([balance(db, 1), balance(db, 2)]).toEqual([checking, card]);
  expect(must(db, "owner_list", { kind: "contribution" }).owner_money).toHaveLength(1);

  // It is one or the other: paid from a business account, or paid personally.
  expect(write(db, "expense_add", { date: "2026-10-12", amount_cents: 1, vendor: "V", account_id: 5, paid_personally: true, paid_from_account_id: 1 })).toMatchObject({
    ok: false, refusal: { field: "paid_from_account_id" },
  });
  expect(write(db, "expense_add", { date: "2026-10-12", amount_cents: 1, vendor: "V", account_id: 5 })).toMatchObject({ ok: false, refusal: { field: "paid_from_account_id" } });
  expect(write(db, "expense_add", { date: "2026-10-12", amount_cents: 1, vendor: "V", account_id: 5, paid_personally: "yes" })).toMatchObject({
    ok: false, refusal: { field: "paid_personally", reason: "paid_personally must be true or false." },
  });
});

test("ISC-23 unbalanced: a transfer whose legs don't net to zero is refused, and nothing is written", async () => {
  const db = ownBooks();
  const history = () => (db.query("SELECT COUNT(*) n FROM history").get() as { n: number }).n;
  const entries = () => (db.query("SELECT COUNT(*) n FROM entries").get() as { n: number }).n;
  const [h, e] = [history(), entries()];
  for (const legs of [
    [{ account_id: 1, amount_cents: -12000 }, { account_id: 2, amount_cents: 11000 }],
    [{ account_id: 1, amount_cents: 100 }, { account_id: 2, amount_cents: 100 }],
    [{ account_id: 1, amount_cents: -300 }, { account_id: 2, amount_cents: 100 }, { account_id: 2, amount_cents: 200 }],
  ]) {
    const r = write(db, "transfer_add", { date: "2026-10-25", legs });
    expect(r.ok).toBe(false);
  }
  expect(write(db, "transfer_add", { date: "2026-10-25", legs: [{ account_id: 1, amount_cents: -12000 }, { account_id: 2, amount_cents: 11000 }] })).toEqual({
    ok: false, refusal: { reason: "The legs add up to -1000 cents, but a transfer between your own accounts must net to zero.", field: "legs" },
  });
  // Money in from an income account is not a transfer between the person's own accounts.
  expect(write(db, "transfer_add", { date: "2026-10-25", legs: [{ account_id: 3, amount_cents: -100 }, { account_id: 1, amount_cents: 100 }] })).toMatchObject({
    ok: false, refusal: { field: "legs[0].account_id" },
  });
  expect(write(db, "transfer_add", { date: "2026-10-25", legs: [{ account_id: 1, amount_cents: 0 }, { account_id: 2, amount_cents: 0 }] })).toMatchObject({
    ok: false, refusal: { field: "legs[0].amount_cents" },
  });
  expect([history(), entries()]).toEqual([h, e]);

  // The CLI and MCP refuse it the same way.
  const dir = tempDir();
  await ok(dir, ["account", "add", "--name", "Checking", "--type", "asset", ...S]);
  await ok(dir, ["account", "add", "--name", "Savings", "--type", "asset", ...S]);
  const legs = [{ account_id: 1, amount_cents: -5000 }, { account_id: 2, amount_cents: 4999 }];
  const c = await cli(dir, json(["transfer", "add"], { date: "2026-10-25", legs }));
  const mcp = await inProcessMcp(dir);
  const m = await mcp.call("transfer_add", { date: "2026-10-25", legs, source: "agent:mcp" });
  await mcp.close();
  expect(c).toEqual({ code: 2, out: { reason: "The legs add up to -1 cents, but a transfer between your own accounts must net to zero.", field: "legs" } });
  expect(m).toMatchObject({ isError: true, structuredContent: c.out });
  expect((await ok(dir, ["entry", "list"])).entries).toEqual([]);
});
