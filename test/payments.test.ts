import { expect, test } from "bun:test";
import { acmeBooks, cli, json, ok, S } from "./support/billing.ts";
import { asPerson } from "./support/person.ts";

// Payments on issued invoices, through the CLI on books where the person lets the agent decide everything.
// Accounts from acmeBooks: 1 Checking, 2 Printing.

/** acmeBooks() plus a second client, Beta, with one issued $1,000.00 invoice and nothing else on it. */
async function thousandDollarInvoice() {
  const dir = await acmeBooks();
  await ok(dir, json(["client", "add"], { name: "Beta LLC", address: "9 Elm Rd\nAustin, TX 78701" }));
  const d = (await ok(dir, json(["invoice", "draft"], { client_id: 2, period_start: "2026-10-01", period_end: "2026-10-31", lines: [{ description: "October work", amount_cents: 100000 }] }))).invoice;
  const inv = (await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S])).invoice;
  expect(inv).toMatchObject({ status: "issued", total_cents: 100000, open_cents: 100000 });
  return { dir, inv };
}

const pay = async (dir: string, body: Record<string, unknown>) => (await ok(dir, json(["payment", "add"], { deposit_account_id: 1, date: "2026-10-25", ...body }))).payment;
const open = async (dir: string, id: number) => (await ok(dir, ["invoice", "get", "--id", String(id)])).invoice.open_cents;

/** An account's balance, debits less credits, by name. */
const balance = (dir: string, name: string) =>
  asPerson(dir, (db) => (db.query("SELECT COALESCE(SUM(l.debit_cents) - SUM(l.credit_cents), 0) AS n FROM lines l JOIN accounts a ON a.id = l.account_id WHERE a.name = ?").get(name) as { n: number }).n);
const pnlLine = async (dir: string, name: string) => {
  const p = await ok(dir, ["report", "pnl"]);
  return [...p.income, ...p.expense].find((x: any) => x.name === name)?.total_cents ?? 0;
};

test("ISC-39 gross plus fee: a $1,000 invoice paid with a $30 fee records $1,000 settled, a $30 fee and a $970 deposit", async () => {
  const { dir, inv } = await thousandDollarInvoice();
  const checking = balance(dir, "Checking");
  const income = await pnlLine(dir, "Consulting income");

  const p = await pay(dir, { invoice_id: inv.id, amount_cents: 100000, fee_cents: 3000, memo: "Stripe ch_123" });
  expect(p).toMatchObject({ invoice_id: inv.id, invoice_number: inv.number, amount_cents: 100000, fee_cents: 3000, deposit_cents: 97000, applied_cents: 100000, credit_cents: 0, client_credit: null, invoice_open_cents: 0 });
  const fees = asPerson(dir, (db) => (db.query("SELECT id FROM accounts WHERE name = 'Payment processing fees'").get() as { id: number }).id);
  const ar = asPerson(dir, (db) => (db.query("SELECT id FROM accounts WHERE name = 'Accounts receivable'").get() as { id: number }).id);
  expect(p.entry.lines).toEqual([
    { account_id: 1, debit_cents: 97000, credit_cents: 0 },
    { account_id: fees, debit_cents: 3000, credit_cents: 0 },
    { account_id: ar, debit_cents: 0, credit_cents: 100000 },
  ]);

  // The deposit is what reached checking; the fee is an expense; the income stays the full $1,000 the client paid.
  expect(balance(dir, "Checking") - checking).toBe(97000);
  expect(await pnlLine(dir, "Payment processing fees")).toBe(3000);
  expect(await pnlLine(dir, "Consulting income")).toBe(income);
  expect(await open(dir, inv.id)).toBe(0);
  // What the 1099-K reports is the gross: payments total $1,000, not the $970 deposit.
  const payments = (await ok(dir, ["payment", "list", "--invoice-id", String(inv.id)])).payments;
  expect(payments.reduce((s: number, x: any) => s + x.amount_cents, 0)).toBe(100000);

  // A fee can't swallow the whole payment, and only an issued invoice can be paid into an asset account.
  for (const [body, field] of [
    [{ invoice_id: inv.id, amount_cents: 100, fee_cents: 100 }, "fee_cents"],
    [{ invoice_id: inv.id, amount_cents: 100, deposit_account_id: 2 }, "deposit_account_id"],
    [{ invoice_id: inv.id, amount_cents: 100, deposit_account_id: ar }, "deposit_account_id"],
    [{ invoice_id: 999, amount_cents: 100 }, "invoice_id"],
  ] as const) {
    const r = await cli(dir, json(["payment", "add"], { deposit_account_id: 1, date: "2026-10-25", ...body }));
    expect(r).toMatchObject({ code: 2, out: { field } });
  }
  const draft = (await ok(dir, json(["invoice", "draft"], { client_id: 2, period_start: "2026-11-01", period_end: "2026-11-30", lines: [{ description: "Nov", amount_cents: 500 }] }))).invoice;
  expect(await cli(dir, json(["payment", "add"], { invoice_id: draft.id, amount_cents: 500, deposit_account_id: 1, date: "2026-10-25" }))).toMatchObject({ code: 2, out: { field: "invoice_id" } });
});

test("ISC-40 partial: a partial payment leaves the exact remaining balance due", async () => {
  const { dir, inv } = await thousandDollarInvoice();
  await pay(dir, { invoice_id: inv.id, amount_cents: 40000 });
  expect(await open(dir, inv.id)).toBe(60000);
  const second = await pay(dir, { invoice_id: inv.id, amount_cents: 25001, fee_cents: 755 });
  expect(second).toMatchObject({ applied_cents: 25001, credit_cents: 0, invoice_open_cents: 34999 });
  expect(await open(dir, inv.id)).toBe(34999);
  expect(balance(dir, "Accounts receivable")).toBe(34999); // the only issued invoice in these books

  // The overdue reminder asks for exactly what is left.
  const reminder = await ok(dir, ["invoice", "reminder", "--id", String(inv.id), "--as-of", "2026-12-31"]);
  expect(reminder).toMatchObject({ balance_cents: 34999 });
  expect(reminder.body).toContain("$349.99");

  // Paying the rest settles it.
  expect(await pay(dir, { invoice_id: inv.id, amount_cents: 34999 })).toMatchObject({ applied_cents: 34999, credit_cents: 0, invoice_open_cents: 0 });
  expect(await open(dir, inv.id)).toBe(0);
});

test("ISC-41 overpay: a payment beyond what is owed becomes a client credit row with a visible balance", async () => {
  const { dir, inv } = await thousandDollarInvoice();
  const income = await pnlLine(dir, "Consulting income");
  const p = await pay(dir, { invoice_id: inv.id, amount_cents: 120000 });
  expect(p).toMatchObject({ amount_cents: 120000, applied_cents: 100000, credit_cents: 20000, invoice_open_cents: 0 });
  expect(p.client_credit).toMatchObject({ amount_cents: 20000, client_balance_cents: 20000 });

  const credits = await ok(dir, ["client", "credits"]);
  expect(credits.credits).toEqual([{ id: p.client_credit.id, client_id: 2, date: "2026-10-25", amount_cents: 20000, payment_id: p.id, refund_id: null, source: "agent:test" }]);
  expect(credits.balances).toEqual([{ client_id: 2, client: "Beta LLC", balance_cents: 20000 }]);
  // Held for the client, owed back to them: a liability, not income.
  expect(balance(dir, "Client credits")).toBe(-20000);
  expect(await pnlLine(dir, "Consulting income")).toBe(income);
  expect(balance(dir, "Checking")).toBe(-4200 - 999 + 120000);

  // Paying an invoice that is already settled adds the whole amount to the credit.
  expect(await pay(dir, { invoice_id: inv.id, amount_cents: 500 })).toMatchObject({ applied_cents: 0, credit_cents: 500, client_credit: { client_balance_cents: 20500 } });
  expect((await ok(dir, ["client", "credits", "--client-id", "2"])).balances).toEqual([{ client_id: 2, client: "Beta LLC", balance_cents: 20500 }]);
});

test("ISC-42 refund: a refund reverses its payment through a reversing entry, never an edit", async () => {
  const { dir, inv } = await thousandDollarInvoice();
  const p = await pay(dir, { invoice_id: inv.id, amount_cents: 100000, fee_cents: 3000 });
  const before = asPerson(dir, (db) => ({
    entries: db.query("SELECT * FROM entries ORDER BY id").all(),
    lines: db.query("SELECT * FROM lines ORDER BY id").all(),
    payments: db.query("SELECT * FROM payments").all(),
  }));
  expect(await cli(dir, json(["invoice", "void"], { id: inv.id, reason: "Wrong client" }))).toMatchObject({ code: 2, out: { field: "id" } }); // paid: refund first

  const r = (await ok(dir, json(["payment", "refund"], { payment_id: p.id, date: "2026-10-28", reason: "Project cancelled" }))).payment;
  expect(r.refund).toMatchObject({ date: "2026-10-28", reason: "Project cancelled" });
  const refundEntry = (await ok(dir, ["entry", "list"])).entries.find((e: any) => e.id === r.refund.entry_id);
  // Every line of the payment's entry, debit and credit swapped.
  expect(refundEntry.lines).toEqual(p.entry.lines.map((l: any) => ({ account_id: l.account_id, debit_cents: l.credit_cents, credit_cents: l.debit_cents })));
  expect(refundEntry).toMatchObject({ date: "2026-10-28", memo: `Refund of payment ${p.id} on invoice ${inv.number}: Project cancelled` });

  // Nothing was edited: the payment and every earlier entry and line are exactly as they were; one entry was added.
  const after = asPerson(dir, (db) => ({
    entries: db.query("SELECT * FROM entries ORDER BY id").all(),
    lines: db.query("SELECT * FROM lines ORDER BY id").all(),
    payments: db.query("SELECT * FROM payments").all(),
  }));
  expect(after.payments).toEqual(before.payments);
  expect(after.entries.slice(0, before.entries.length)).toEqual(before.entries);
  expect(after.lines.slice(0, before.lines.length)).toEqual(before.lines);
  expect(after.entries.length).toBe(before.entries.length + 1);
  asPerson(dir, (db) => {
    expect(() => db.exec("UPDATE payments SET amount_cents = 1")).toThrow(/never change/);
    expect(() => db.exec("DELETE FROM payments")).toThrow(/never change/);
  });

  // The invoice is owed again in full, the deposit and fee are undone, and it can't be refunded twice.
  expect(await open(dir, inv.id)).toBe(100000);
  expect(r.invoice_open_cents).toBe(100000);
  expect(balance(dir, "Checking")).toBe(-4200 - 999);
  expect(await pnlLine(dir, "Payment processing fees")).toBe(0);
  expect(await cli(dir, json(["payment", "refund"], { payment_id: p.id, date: "2026-10-29", reason: "Again" }))).toMatchObject({ code: 2, out: { field: "payment_id" } });
  expect(await cli(dir, json(["payment", "refund"], { payment_id: 999, date: "2026-10-29", reason: "x" }))).toMatchObject({ code: 2, out: { field: "payment_id" } });

  // Refunding an overpayment takes its client credit back out too.
  const over = await pay(dir, { invoice_id: inv.id, amount_cents: 150000 });
  expect(over.client_credit.client_balance_cents).toBe(50000);
  await ok(dir, json(["payment", "refund"], { payment_id: over.id, date: "2026-10-30", reason: "Overpaid by mistake" }));
  expect((await ok(dir, ["client", "credits"])).balances).toEqual([{ client_id: 2, client: "Beta LLC", balance_cents: 0 }]);
  expect(balance(dir, "Client credits")).toBe(0);

  // With every payment refunded, the invoice can be voided again.
  expect((await ok(dir, json(["invoice", "void"], { id: inv.id, reason: "Cancelled" }))).invoice.status).toBe("void");
});
