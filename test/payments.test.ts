import { expect, test } from "bun:test";
import { acmeBooks, cli, json, ok, S } from "./support/billing.ts";
import { asPerson } from "./support/person.ts";
import { acct } from "./support/books.ts";

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

const pay = async (dir: string, body: Record<string, unknown>) => (await ok(dir, json(["payment", "add"], { deposit_account_id: acct(1), date: "2026-10-25", ...body }))).payment;
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
    { account_id: acct(1), debit_cents: 97000, credit_cents: 0 },
    { account_id: fees, debit_cents: 3000, credit_cents: 0 },
    { account_id: ar, debit_cents: 0, credit_cents: 100000 },
  ]);

  // The deposit is what reached checking; the fee is an expense; the income stays the full $1,000 the client paid.
  expect(balance(dir, "Checking") - checking).toBe(97000);
  expect(await pnlLine(dir, "Payment processing fees")).toBe(3000);
  expect(await pnlLine(dir, "Consulting income")).toBe(income + 100000); // cash basis: the full $1,000 the client paid counts the day it was paid
  expect(await open(dir, inv.id)).toBe(0);
  // What the 1099-K reports is the gross: payments total $1,000, not the $970 deposit.
  const payments = (await ok(dir, ["payment", "list", "--invoice-id", String(inv.id)])).payments;
  expect(payments.reduce((s: number, x: any) => s + x.amount_cents, 0)).toBe(100000);

  // A fee can't swallow the whole payment, and only an issued invoice can be paid into an asset account.
  for (const [body, field] of [
    [{ invoice_id: inv.id, amount_cents: 100, fee_cents: 100 }, "fee_cents"],
    [{ invoice_id: inv.id, amount_cents: 100, deposit_account_id: acct(2) }, "deposit_account_id"],
    [{ invoice_id: inv.id, amount_cents: 100, deposit_account_id: ar }, "deposit_account_id"],
    [{ invoice_id: 999, amount_cents: 100 }, "invoice_id"],
  ] as const) {
    const r = await cli(dir, json(["payment", "add"], { deposit_account_id: acct(1), date: "2026-10-25", ...body }));
    expect(r).toMatchObject({ code: 2, out: { field } });
  }
  const draft = (await ok(dir, json(["invoice", "draft"], { client_id: 2, period_start: "2026-11-01", period_end: "2026-11-30", lines: [{ description: "Nov", amount_cents: 500 }] }))).invoice;
  expect(await cli(dir, json(["payment", "add"], { invoice_id: draft.id, amount_cents: 500, deposit_account_id: acct(1), date: "2026-10-25" }))).toMatchObject({ code: 2, out: { field: "invoice_id" } });
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
  expect(credits.credits).toEqual([{ id: p.client_credit.id, client_id: 2, date: "2026-10-25", amount_cents: 20000, payment_id: p.id, refund_id: null, application_id: null, applied_to_invoice_id: null, source: "agent:test" }]);
  expect(credits.balances).toEqual([{ client_id: 2, client: "Beta LLC", balance_cents: 20000 }]);
  // Held for the client, owed back to them: a liability, not income.
  expect(balance(dir, "Client credits")).toBe(-20000);
  expect(await pnlLine(dir, "Consulting income")).toBe(income + 100000); // only what settled the invoice is income; the credit is not
  expect(balance(dir, "Checking")).toBe(-4200 - 999 + 120000);

  // Paying an invoice that is already settled adds the whole amount to the credit.
  expect(await pay(dir, { invoice_id: inv.id, amount_cents: 500 })).toMatchObject({ applied_cents: 0, credit_cents: 500, client_credit: { client_balance_cents: 20500 } });
  expect((await ok(dir, ["client", "credits", "--client-id", "2"])).balances).toEqual([{ client_id: 2, client: "Beta LLC", balance_cents: 20500 }]);
});

test("ISC-42 refund: a refund reverses the payment's income at gross as a new entry, and the processor keeps its fee unless the refund says otherwise", async () => {
  const { dir, inv } = await thousandDollarInvoice();
  const p = await pay(dir, { invoice_id: inv.id, amount_cents: 100000, fee_cents: 3000 });
  const ar = asPerson(dir, (db) => (db.query("SELECT id FROM accounts WHERE name = 'Accounts receivable'").get() as { id: number }).id);
  const fees = asPerson(dir, (db) => (db.query("SELECT id FROM accounts WHERE name = 'Payment processing fees'").get() as { id: number }).id);
  const snapshot = () =>
    asPerson(dir, (db) => ({
      entries: db.query("SELECT * FROM entries ORDER BY id").all(),
      lines: db.query("SELECT * FROM lines ORDER BY id").all(),
      payments: db.query("SELECT * FROM payments").all(),
    }));
  const before = snapshot();
  const checking = balance(dir, "Checking");
  expect(await cli(dir, json(["invoice", "void"], { id: inv.id, reason: "Wrong client" }))).toMatchObject({ code: 2, out: { field: "id" } }); // paid: refund first

  // Stripe's way, the default: the client gets the full $1,000 back, all of it leaves checking, and the $30 fee stays spent.
  const r = (await ok(dir, json(["payment", "refund"], { payment_id: p.id, date: "2026-10-28", reason: "Project cancelled" }))).payment;
  expect(r.refunds).toEqual([expect.objectContaining({ date: "2026-10-28", reason: "Project cancelled", amount_cents: 100000, fee_returned_cents: 0, applied_cents: 100000, credit_cents: 0 })]);
  expect(r).toMatchObject({ refunded_cents: 100000, refundable_cents: 0, invoice_open_cents: 100000 });
  const refundEntry = (await ok(dir, ["entry", "list"])).entries.find((e: any) => e.id === r.refunds[0].entry_id);
  expect(refundEntry).toMatchObject({ date: "2026-10-28", memo: `Refund of payment ${p.id} on invoice ${inv.number}: Project cancelled` });
  expect(refundEntry.lines).toEqual([
    { account_id: ar, debit_cents: 100000, credit_cents: 0 },
    { account_id: acct(1), debit_cents: 0, credit_cents: 100000 },
  ]);
  expect(balance(dir, "Checking") - checking).toBe(-100000);
  expect(await pnlLine(dir, "Payment processing fees")).toBe(3000);
  expect(await open(dir, inv.id)).toBe(100000);
  expect((await ok(dir, ["report", "unpaid"])).invoices).toContainEqual(expect.objectContaining({ invoice_id: inv.id, paid_cents: 0, open_cents: 100000 }));

  // Nothing was edited: the payment and every earlier entry and line are exactly as they were; one entry was added.
  const after = snapshot();
  expect(after.payments).toEqual(before.payments);
  expect(after.entries.slice(0, before.entries.length)).toEqual(before.entries);
  expect(after.lines.slice(0, before.lines.length)).toEqual(before.lines);
  expect(after.entries.length).toBe(before.entries.length + 1);
  asPerson(dir, (db) => {
    for (const t of ["payments", "refunds"]) {
      expect(() => db.exec(`UPDATE ${t} SET amount_cents = 1`)).toThrow(/never change/);
      expect(() => db.exec(`DELETE FROM ${t}`)).toThrow(/never change/);
    }
  });
  for (const [body, field] of [
    [{ payment_id: p.id }, "payment_id"], // already refunded in full
    [{ payment_id: 999 }, "payment_id"],
  ] as const) {
    expect(await cli(dir, json(["payment", "refund"], { date: "2026-10-29", reason: "Again", ...body }))).toMatchObject({ code: 2, out: { field } });
  }

  // A processor that gave its fee back: the deposit account pays gross less that fee, and the fee expense is undone.
  const q = await pay(dir, { invoice_id: inv.id, amount_cents: 100000, fee_cents: 3000 });
  for (const [body, field] of [
    [{ fee_returned_cents: 3001 }, "fee_returned_cents"], // more than the fee
    [{ amount_cents: 2000, fee_returned_cents: 2000 }, "fee_returned_cents"], // the whole refund
    [{ amount_cents: 100001 }, "amount_cents"], // more than was paid
  ] as const) {
    expect(await cli(dir, json(["payment", "refund"], { payment_id: q.id, date: "2026-10-29", reason: "x", ...body }))).toMatchObject({ code: 2, out: { field } });
  }
  const c2 = balance(dir, "Checking");
  // Partial: $400 back now, $90 of the fee returned with it. The invoice owes $400 again.
  const part = (await ok(dir, json(["payment", "refund"], { payment_id: q.id, date: "2026-10-29", reason: "Scope cut", amount_cents: 40000, fee_returned_cents: 90 }))).payment;
  expect(part).toMatchObject({ refunded_cents: 40000, refundable_cents: 60000, invoice_open_cents: 40000 });
  const partEntry = (await ok(dir, ["entry", "list"])).entries.find((e: any) => e.id === part.refunds[0].entry_id);
  expect(partEntry.lines).toEqual([
    { account_id: ar, debit_cents: 40000, credit_cents: 0 },
    { account_id: acct(1), debit_cents: 0, credit_cents: 39910 },
    { account_id: fees, debit_cents: 0, credit_cents: 90 },
  ]);
  expect(balance(dir, "Checking") - c2).toBe(-39910);
  expect(await pnlLine(dir, "Payment processing fees")).toBe(3000 + 3000 - 90);
  expect((await ok(dir, ["invoice", "get", "--id", String(inv.id)])).invoice).toMatchObject({ status: "issued", open_cents: 40000 });
  // Up to what was paid, and no more: $600.01 is a cent too far, $600 refunds the rest and the invoice owes it all again.
  expect(await cli(dir, json(["payment", "refund"], { payment_id: q.id, date: "2026-10-30", reason: "x", amount_cents: 60001 }))).toMatchObject({ code: 2, out: { field: "amount_cents" } });
  expect(await cli(dir, json(["payment", "refund"], { payment_id: q.id, date: "2026-10-30", reason: "x", fee_returned_cents: 2911 }))).toMatchObject({ code: 2, out: { field: "fee_returned_cents" } });
  const rest = (await ok(dir, json(["payment", "refund"], { payment_id: q.id, date: "2026-10-30", reason: "Cancelled after all" }))).payment;
  expect(rest).toMatchObject({ refunded_cents: 100000, refundable_cents: 0, invoice_open_cents: 100000 });
  expect(rest.refunds.map((x: any) => x.amount_cents)).toEqual([40000, 60000]);

  // An overpayment's refund comes out of the client credit it made first, then off the invoice.
  const over = await pay(dir, { invoice_id: inv.id, amount_cents: 150000 });
  expect(over).toMatchObject({ applied_cents: 100000, credit_cents: 50000, client_credit: { client_balance_cents: 50000 } });
  const back = (await ok(dir, json(["payment", "refund"], { payment_id: over.id, date: "2026-10-30", reason: "Overpaid by mistake", amount_cents: 20000 }))).payment;
  expect(back.refunds[0]).toMatchObject({ amount_cents: 20000, credit_cents: 20000, applied_cents: 0 });
  expect(back.invoice_open_cents).toBe(0);
  expect((await ok(dir, ["client", "credits"])).balances).toEqual([{ client_id: 2, client: "Beta LLC", balance_cents: 30000 }]);
  const all = (await ok(dir, json(["payment", "refund"], { payment_id: over.id, date: "2026-10-31", reason: "Cancelled" }))).payment;
  expect(all.refunds[1]).toMatchObject({ amount_cents: 130000, credit_cents: 30000, applied_cents: 100000 });
  expect((await ok(dir, ["client", "credits"])).balances).toEqual([{ client_id: 2, client: "Beta LLC", balance_cents: 0 }]);
  expect(balance(dir, "Client credits")).toBe(0);
  expect(await open(dir, inv.id)).toBe(100000);

  // With every payment refunded, the invoice can be voided again.
  expect((await ok(dir, json(["invoice", "void"], { id: inv.id, reason: "Cancelled" }))).invoice.status).toBe("void");
});

test("ISC-111 apply credit: a client's overpayment credit pays down their later invoice, posted, never below zero and never across clients", async () => {
  const { dir, inv } = await thousandDollarInvoice();
  const over = await pay(dir, { invoice_id: inv.id, amount_cents: 130000 }); // $300 left as Beta's credit
  expect(over.client_credit.client_balance_cents).toBe(30000);
  const issue = async (client_id: number, cents: number) => {
    const d = (await ok(dir, json(["invoice", "draft"], { client_id, period_start: "2026-11-01", period_end: "2026-11-30", lines: [{ description: "November", amount_cents: cents }] }))).invoice;
    return (await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S])).invoice;
  };
  const nov = await issue(2, 50000);
  const acme = await issue(1, 20000);
  const draft = (await ok(dir, json(["invoice", "draft"], { client_id: 2, period_start: "2026-12-01", period_end: "2026-12-31", lines: [{ description: "Dec", amount_cents: 100 }] }))).invoice;
  const apply = (body: Record<string, unknown>) => cli(dir, json(["client", "credit", "apply"], { client_id: 2, date: "2026-11-30", ...body }));
  const checking = balance(dir, "Checking");
  const income = await pnlLine(dir, "Consulting income");
  const entries = (await ok(dir, ["entry", "list"])).entries.length;

  // Never across clients, never more than the credit or what is owed, and only on an issued invoice.
  for (const [body, field] of [
    [{ invoice_id: acme.id }, "invoice_id"], // Acme's invoice
    [{ client_id: 1, invoice_id: acme.id }, "client_id"], // Acme holds no credit
    [{ invoice_id: nov.id, amount_cents: 30001 }, "amount_cents"], // more than Beta's $300
    [{ invoice_id: inv.id }, "invoice_id"], // already settled
    [{ invoice_id: draft.id }, "invoice_id"],
    [{ invoice_id: 999 }, "invoice_id"],
    [{ client_id: 99, invoice_id: nov.id }, "client_id"],
  ] as const) {
    expect(await apply(body)).toMatchObject({ code: 2, out: { field } });
  }

  // $120 of it, then the rest by default: the invoice's open balance and the credit drop together, by the same amount.
  const first = (await apply({ invoice_id: nov.id, amount_cents: 12000 })).out;
  expect(first).toMatchObject({ applied: { client_id: 2, invoice_id: nov.id, invoice_number: nov.number, amount_cents: 12000 }, invoice_open_cents: 38000, client_balance_cents: 18000 });
  const ar = asPerson(dir, (db) => (db.query("SELECT id FROM accounts WHERE name = 'Accounts receivable'").get() as { id: number }).id);
  const held = asPerson(dir, (db) => (db.query("SELECT id FROM accounts WHERE name = 'Client credits'").get() as { id: number }).id);
  const posted = (await ok(dir, ["entry", "list"])).entries.find((e: any) => e.id === first.applied.entry_id);
  expect(posted).toMatchObject({ date: "2026-11-30", memo: `Client credit applied to invoice ${nov.number} for Beta LLC` });
  expect(posted.lines).toEqual([
    { account_id: held, debit_cents: 12000, credit_cents: 0 },
    { account_id: ar, debit_cents: 0, credit_cents: 12000 },
  ]);
  const rest = (await apply({ invoice_id: nov.id })).out;
  expect(rest).toMatchObject({ applied: { amount_cents: 18000 }, invoice_open_cents: 20000, client_balance_cents: 0 });
  expect(await open(dir, nov.id)).toBe(20000);
  expect((await ok(dir, ["report", "unpaid", "--client-id", "2"])).invoices).toEqual([expect.objectContaining({ invoice_id: nov.id, open_cents: 20000 })]);

  // The credit is used up: it can't go below zero, through the tool or straight at the database.
  expect(await apply({ invoice_id: nov.id })).toMatchObject({ code: 2, out: { field: "client_id" } });
  const credits = await ok(dir, ["client", "credits", "--client-id", "2"]);
  expect(credits.balances).toEqual([{ client_id: 2, client: "Beta LLC", balance_cents: 0 }]);
  expect(credits.credits.map((c: any) => [c.amount_cents, c.payment_id, c.application_id !== null, c.applied_to_invoice_id])).toEqual([
    [30000, over.id, false, null],
    [-12000, null, true, nov.id],
    [-18000, null, true, nov.id],
  ]);
  asPerson(dir, (db) => {
    expect(() => db.exec("INSERT INTO client_credits (client_id, date, amount_cents, payment_id, refund_id, source) VALUES (2, 'd', -1, 1, NULL, 's')")).toThrow();
    expect(() => db.exec("UPDATE credit_applications SET amount_cents = 1")).toThrow(/never change/);
    expect(() => db.exec("DELETE FROM credit_applications")).toThrow(/never change/);
  });

  // The money never left the books: checking is untouched, two entries were posted, and the payment that made the
  // credit can't be refunded past what wasn't used. On the cash basis the credit, held until now, became income the
  // day it settled the invoice.
  expect(balance(dir, "Checking")).toBe(checking);
  expect(await pnlLine(dir, "Consulting income")).toBe(income + 30000);
  expect((await ok(dir, ["entry", "list"])).entries.length).toBe(entries + 2);
  expect((await ok(dir, ["payment", "list", "--invoice-id", String(inv.id)])).payments[0]).toMatchObject({ refundable_cents: 100000 });
  expect(await cli(dir, json(["payment", "refund"], { payment_id: over.id, date: "2026-12-01", reason: "x", amount_cents: 100001 }))).toMatchObject({ code: 2, out: { field: "amount_cents" } });
  // An invoice paid down with credit can't be voided out from under it.
  expect(await cli(dir, json(["invoice", "void"], { id: nov.id, reason: "x" }))).toMatchObject({ code: 2, out: { field: "id" } });
});
