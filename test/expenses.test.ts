import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { acmeBooks, cli, issueOctober, json, ok, S } from "./support/billing.ts";
import { tempDir } from "./support/books.ts";
import { RECEIPT } from "./support/scenario.ts";

test("ISC-44 receipt: an expense carries its receipt file, stored in the books folder, linked and readable back", async () => {
  const dir = tempDir();
  await ok(dir, ["account", "add", "--name", "Checking", "--type", "asset", ...S]);
  await ok(dir, ["account", "add", "--name", "Software", "--type", "expense", ...S]);
  const add = (extra: Record<string, unknown>) =>
    cli(dir, json(["expense", "add"], { date: "2026-10-02", amount_cents: 1999, vendor: "Editor Inc", account_id: 2, paid_from_account_id: 1, ...extra }));

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

test("ISC-45 pass-through: a pass-through cost links to the invoice that recovers it", async () => {
  const dir = await acmeBooks();
  const before = (await ok(dir, ["expense", "list", "--pass-through-client-id", "1"])).expenses;
  expect(before.map((e: any) => [e.id, e.recovered_by_invoice])).toEqual([[1, null], [2, null]]);

  const inv = await issueOctober(dir);
  const line = inv.lines.find((l: any) => l.kind === "pass_through");
  expect(line).toMatchObject({ expense_id: 1, amount_cents: 4200 });

  const after = (await ok(dir, ["expense", "list", "--pass-through-client-id", "1"])).expenses;
  expect(after[0].recovered_by_invoice).toEqual({ invoice_id: inv.id, number: "7001", status: "issued" });
  expect(after[1].recovered_by_invoice).toBeNull(); // November's cost isn't on October's invoice

  // Recovered at cost into its own income account, so the expense stays an expense.
  const pnl = await ok(dir, ["report", "pnl"]);
  expect(pnl.income.find((i: any) => i.name === "Reimbursed expense income").total_cents).toBe(4200);
  expect(pnl.expense.find((e: any) => e.name === "Printing").total_cents).toBe(4200 + 999);

  // Voiding the invoice unlinks it, so the cost can be billed again.
  await ok(dir, ["invoice", "void", "--id", String(inv.id), "--reason", "redo", ...S]);
  expect((await ok(dir, ["expense", "list"])).expenses[0].recovered_by_invoice).toBeNull();
});
