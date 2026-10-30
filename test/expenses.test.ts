import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { acmeBooks, cli, issueOctober, json, ok, S } from "./support/billing.ts";
import { tempDir, acct } from "./support/books.ts";
import { RECEIPT } from "./support/scenario.ts";

test("ISC-44 receipt: an expense carries its receipt file, stored in the books folder, linked and readable back", async () => {
  const dir = tempDir();
  await ok(dir, ["account", "add", "--name", "Checking", "--type", "asset", ...S]);
  await ok(dir, ["account", "add", "--name", "Software", "--type", "expense", ...S]);
  const add = (extra: Record<string, unknown>) =>
    cli(dir, json(["expense", "add"], { date: "2026-10-02", amount_cents: 1999, vendor: "Editor Inc", account_id: acct(2), paid_from_account_id: acct(1), ...extra }));

  const original = readFileSync(RECEIPT);
  const { expense } = (await add({ receipt_path: RECEIPT })).out;
  expect(expense.receipt).toEqual({
    file: `receipts/${new Bun.CryptoHasher("sha256").update(original).digest("hex")}.png`,
    sha256: new Bun.CryptoHasher("sha256").update(original).digest("hex"),
    bytes: original.length,
  });
  // It lives inside the books folder, and reads back byte for byte.
  expect(readFileSync(join(dir, expense.receipt.file)).equals(original)).toBe(true);
  expect((await ok(dir, ["expense", "list"])).expenses[0].receipt).toEqual(expense.receipt);
  // The expense is posted to the books.
  expect((await ok(dir, ["report", "pnl"])).expense_total_cents).toBe(1999);

  // A missing file is refused and records nothing; an expense without a receipt is fine.
  const missing = await add({ receipt_path: join(dir, "nope.pdf") });
  expect(missing.out).toEqual({ reason: "There is no readable file at receipt_path.", field: "receipt_path" });
  expect((await add({})).out.expense.receipt).toBeNull();
  expect((await ok(dir, ["expense", "list"])).expenses.length).toBe(2);
});

test("ISC-45 links: a charge links to the invoice that bills it, and an expense lists its charges and what is left", async () => {
  const dir = await acmeBooks();
  const before = (await ok(dir, ["expense", "list", "--client-id", "1"])).expenses;
  expect(before.map((e: any) => [e.id, e.charges.map((c: any) => c.invoice), e.not_yet_charged_cents])).toEqual([[1, [null], 0], [2, [null], 0]]);

  const inv = await issueOctober(dir);
  const line = inv.lines.find((l: any) => l.kind === "pass_through");
  expect(line).toMatchObject({ expense_id: 1, amount_cents: 4200 });

  const after = (await ok(dir, ["expense", "list", "--client-id", "1"])).expenses;
  expect(after[0].charges[0].invoice).toEqual({ invoice_id: inv.id, number: "7001", status: "issued" });
  expect(after[0].charges[0].status).toBe("billed");
  expect(after[1].charges[0].invoice).toBeNull(); // November's cost isn't on October's invoice
  expect((await ok(dir, ["charge", "list", "--expense-id", "1"])).charges[0].invoice).toEqual(after[0].charges[0].invoice);

  // Recovered at cost into its own income account, so the expense stays an expense.
  const reimbursed = (await ok(dir, ["account", "list"])).accounts.find((a: any) => a.name === "Reimbursed expense income").id;
  const posted = (await ok(dir, ["entry", "list"])).entries.at(-1);
  expect(posted.lines).toContainEqual({ account_id: reimbursed, debit_cents: 0, credit_cents: 4200 });
  const pnl = await ok(dir, ["report", "pnl"]);
  expect(pnl.expense.find((e: any) => e.name === "Printing").total_cents).toBe(4200 + 999);

  // Part of an expense charged leaves the rest showing.
  const { expense } = await ok(dir, json(["expense", "add"], { date: "2026-10-09", amount_cents: 10000, vendor: "OpenAI", account_id: acct(2), paid_from_account_id: acct(1) }));
  await ok(dir, json(["charge", "add"], { client_id: 1, date: "2026-10-31", amount_cents: 2500, line_text: "API usage", expense_id: expense.id }));
  expect((await ok(dir, ["expense", "list", "--vendor", "OpenAI"])).expenses[0].not_yet_charged_cents).toBe(7500);

  // Voiding the invoice unlinks it, so the cost can be billed again.
  await ok(dir, ["invoice", "void", "--id", String(inv.id), "--reason", "redo", ...S]);
  expect((await ok(dir, ["expense", "list"])).expenses[0].charges[0].invoice).toBeNull();
});

test("ISC-131 filters: the expense list narrows by vendor, dates and whether any amount is not yet charged", async () => {
  const dir = await acmeBooks(); // expense 1 Print shop Oct 5 and 2 Courier Nov 5, each charged in full
  const add = (body: Record<string, unknown>) =>
    ok(dir, json(["expense", "add"], { amount_cents: 10000, account_id: acct(2), paid_from_account_id: acct(1), ...body }));
  await add({ date: "2026-10-09", vendor: "OpenAI" }); // 3
  await add({ date: "2026-11-09", vendor: "OpenAI LLC" }); // 4
  await ok(dir, json(["charge", "add"], { client_id: 1, date: "2026-11-30", amount_cents: 10000, line_text: "API usage", expense_id: 4 }));
  const ids = async (...flags: string[]) => (await ok(dir, ["expense", "list", ...flags])).expenses.map((e: any) => e.id);
  expect(await ids()).toEqual([1, 3, 2, 4]);
  expect(await ids("--vendor", "openai")).toEqual([3, 4]);
  expect(await ids("--from", "2026-10-06", "--to", "2026-11-08")).toEqual([3, 2]);
  expect(await ids("--uncharged", "true")).toEqual([3]);
  expect(await ids("--vendor", "openai", "--from", "2026-11-01", "--uncharged", "true")).toEqual([]);
});
