import { expect, test } from "bun:test";
import { run } from "../src/cli.ts";
import { acmeBooks, cli, json, ok, S } from "./support/billing.ts";
import { asPerson } from "./support/person.ts";

// The unpaid list, against the solobooks clock. cli() runs at 2026-10-22; at() runs a command on another day.

async function at(dir: string, now: string, args: string[]) {
  const r = await run([...args, "--books", dir], { SOLOBOOKS_NOW: `${now}T12:00:00.000Z` });
  if (r.code !== 0) throw new Error(`expected success for ${args.join(" ")}: ${r.stdout}`);
  return JSON.parse(r.stdout);
}

/** Issues a one-line invoice for a client (default 2) on a given day, with given terms, and returns it. */
async function issued(dir: string, day: string, cents: number, terms: number, client = 2) {
  const d = (await ok(dir, json(["invoice", "draft"], { client_id: client, period_start: "2026-01-01", period_end: "2026-12-31", terms_days: terms, lines: [{ description: `Work billed ${day}`, amount_cents: cents }] }))).invoice;
  return (await at(dir, day, ["invoice", "issue", "--id", String(d.id), ...S])).invoice;
}

test("ISC-43 unpaid: the unpaid list shows every overdue invoice with its days late, past invoices marked historical", async () => {
  const dir = await acmeBooks();
  await ok(dir, json(["client", "add"], { name: "Beta LLC", address: "9 Elm Rd" }));
  const late = await issued(dir, "2026-09-01", 100000, 30); // due 2026-10-01: 21 days late on 2026-10-22
  const notDue = await issued(dir, "2026-10-15", 50000, 30); // due 2026-11-14
  const paidUp = await issued(dir, "2026-08-01", 70000, 15); // due 2026-08-16, then paid in full
  const credited = await issued(dir, "2026-08-10", 40000, 10); // due 2026-08-20: 63 days late, part credited
  const voided = await issued(dir, "2026-07-01", 30000, 30);
  await ok(dir, json(["payment", "add"], { invoice_id: late.id, date: "2026-10-05", amount_cents: 25000, deposit_account_id: 1 }));
  await ok(dir, json(["payment", "add"], { invoice_id: paidUp.id, date: "2026-08-20", amount_cents: 70000, deposit_account_id: 1 }));
  await ok(dir, json(["invoice", "credit"], { invoice_id: credited.id, amount_cents: 15000, reason: "Discount" }));
  await ok(dir, json(["invoice", "void"], { id: voided.id, reason: "Wrong client" }));
  // A past invoice still owed, and one brought in as paid.
  const past = (await ok(dir, json(["invoice", "import"], { client_id: 2, number: 511, invoice_date: "2026-07-01", due_date: "2026-07-31", lines: [{ description: "June work", amount_cents: 80000 }] }))).invoice;
  await ok(dir, json(["invoice", "import"], { client_id: 2, number: 512, invoice_date: "2026-07-05", lines: [{ description: "Paid", amount_cents: 1000 }], paid_on: "2026-07-20", paid_account_id: 1 }));

  const r = await ok(dir, ["report", "unpaid"]);
  expect(r.as_of).toBe("2026-10-22");
  expect(r.invoices.map((i: any) => [i.number, i.due_date, i.open_cents, i.overdue, i.days_late, i.historical])).toEqual([
    ["511", "2026-07-31", 80000, true, 83, true],
    [credited.number, "2026-08-20", 25000, true, 63, false],
    [late.number, "2026-10-01", 75000, true, 21, false],
    [notDue.number, "2026-11-14", 50000, false, 0, false],
  ]);
  expect(r.invoices[2]).toMatchObject({ invoice_id: late.id, client: "Beta LLC", total_cents: 100000, paid_cents: 25000 });
  expect(r.open_total_cents).toBe(80000 + 25000 + 75000 + 50000);
  expect(r.overdue_total_cents).toBe(80000 + 25000 + 75000);
  // Every overdue invoice, and only those still owed: the paid, voided and paid-past invoices aren't on it.
  expect(r.invoices.map((i: any) => i.invoice_id)).not.toContain(paidUp.id);
  expect(r.invoices.map((i: any) => i.invoice_id)).not.toContain(voided.id);

  // The days late follow the solobooks clock.
  const later = await at(dir, "2026-11-20", ["report", "unpaid"]);
  expect(later.as_of).toBe("2026-11-20");
  expect(later.invoices.map((i: any) => [i.number, i.days_late])).toEqual([["511", 112], [credited.number, 92], [late.number, 50], [notDue.number, 6]]);
  expect((await at(dir, "2026-11-20", ["report", "unpaid", "--client-id", "1"])).invoices).toEqual([]);

  // Listed, but the past invoice still never gets a reminder; the invoice solobooks issued does.
  expect(await cli(dir, ["invoice", "reminder", "--id", String(past.id)])).toMatchObject({ code: 2, out: { field: "id" } });
  expect(await ok(dir, ["invoice", "reminder", "--id", String(late.id)])).toMatchObject({ balance_cents: 75000, days_late: 21 });
});

const pnlFor = (dir: string, from: string, to: string) => ok(dir, ["report", "pnl", "--from", from, "--to", to]);
const consulting = (p: any) => p.income.find((i: any) => i.name === "Consulting income")?.total_cents ?? 0;

test("ISC-110 cash basis: an invoice issued in December and paid in January is January income, and the P&L says so", async () => {
  const dir = await acmeBooks();
  await ok(dir, json(["client", "add"], { name: "Beta LLC", address: "9 Elm Rd", tax_rate_ppm: 100000, tax_label: "TX sales tax", tax_applies_to: ["manual"] }));
  const dec = await issued(dir, "2026-12-15", 200000, 30); // $2,000 of work plus $200 tax, issued in December
  expect(dec).toMatchObject({ invoice_date: "2026-12-15", total_cents: 220000 });

  // Issued but unpaid: no income yet, in December or any other time.
  expect(consulting(await pnlFor(dir, "2026-12-01", "2026-12-31"))).toBe(0);
  expect((await ok(dir, ["report", "pnl"])).income_total_cents).toBe(0);

  // Paid on January 5: it is January's income, the work only, and none of it lands in 2026.
  await ok(dir, json(["payment", "add"], { invoice_id: dec.id, date: "2027-01-05", amount_cents: 220000, deposit_account_id: 1 }));
  const y2026 = await pnlFor(dir, "2026-01-01", "2026-12-31");
  const jan = await pnlFor(dir, "2027-01-01", "2027-01-31");
  expect(consulting(y2026)).toBe(0);
  expect(consulting(jan)).toBe(200000);
  expect(jan.income_total_cents).toBe(200000);
  // The P&L states its basis.
  for (const p of [y2026, jan]) {
    expect(p.basis).toBe("cash");
    expect(p.basis_note).toContain("counts as income on the day it is paid, not the day it is invoiced");
  }
  // Year-to-date profit follows it too.
  expect((await at(dir, "2026-12-31", ["report", "ytd"])).income_cents).toBe(0);
  expect((await at(dir, "2027-01-31", ["report", "ytd"])).income_cents).toBe(200000);

  // Sales tax owed follows the money the same way: collected in January, though charged in December.
  expect((await ok(dir, ["report", "sales", "tax", "--from", "2026-12-01", "--to", "2026-12-31"])).taxes[0]).toMatchObject({ collected_cents: 0, invoiced_cents: 20000, owed_cents: 0 });
  expect((await ok(dir, ["report", "sales", "tax", "--from", "2027-01-01", "--to", "2027-01-31"])).taxes[0]).toMatchObject({ collected_cents: 20000, invoiced_cents: 0, owed_cents: 20000 });

  // Paid across the year end, each part counts in the month it arrived, split from its tax; the parts add up exactly.
  const split = await issued(dir, "2026-12-20", 100001, 30); // $1,000.01 plus $100.00 tax
  await ok(dir, json(["payment", "add"], { invoice_id: split.id, date: "2026-12-28", amount_cents: 33333, deposit_account_id: 1 }));
  await ok(dir, json(["payment", "add"], { invoice_id: split.id, date: "2027-01-02", amount_cents: split.total_cents - 33333, deposit_account_id: 1 }));
  const dec2 = consulting(await pnlFor(dir, "2026-12-01", "2026-12-31"));
  const jan2 = consulting(await pnlFor(dir, "2027-01-01", "2027-01-31")) - 200000;
  expect(dec2).toBe(30303); // 33333 x 100001 / 110001, rounded
  expect(dec2 + jan2).toBe(100001);

  // A refund takes back what its payment counted, on the refund's day; a credit note moves no money, so counts nothing.
  const p = (await ok(dir, json(["payment", "add"], { invoice_id: (await issued(dir, "2026-11-02", 50000, 30)).id, date: "2026-11-10", amount_cents: 55000, deposit_account_id: 1 }))).payment;
  await ok(dir, json(["payment", "refund"], { payment_id: p.id, date: "2026-12-03", reason: "Charged twice" }));
  expect(consulting(await pnlFor(dir, "2026-11-01", "2026-11-30"))).toBe(50000);
  expect(consulting(await pnlFor(dir, "2026-12-03", "2026-12-03"))).toBe(-50000);
  const credited = await issued(dir, "2026-11-05", 40000, 30);
  await ok(dir, json(["invoice", "credit"], { invoice_id: credited.id, reason: "Discount", line_kind: "manual", amount_cents: 10000 }));
  expect(consulting(await ok(dir, ["report", "pnl"]))).toBe(200000 + 100001);

  // The ledger still posts what was owed when each invoice was issued.
  const ar = asPerson(dir, (db) => (db.query("SELECT SUM(l.debit_cents) - SUM(l.credit_cents) AS n FROM lines l JOIN accounts a ON a.id = l.account_id WHERE a.name = 'Accounts receivable'").get() as { n: number }).n);
  expect(ar).toBe(55000 + 44000 - 11000); // the refunded invoice is owed again, and the credited one is unpaid
});

test("ISC-58 schedule c: the P&L groups income and expenses by Schedule C line, in the form's order", async () => {
  const dir = await acmeBooks(); // 1 Checking, 2 Printing (expense)
  await ok(dir, ["account", "add", "--name", "Software", "--type", "expense", "--schedule-c", "27b", ...S]);
  await ok(dir, ["account", "add", "--name", "Contractors", "--type", "expense", "--schedule-c", "11", ...S]);
  await ok(dir, ["account", "add", "--name", "Interest", "--type", "income", ...S]);
  await ok(dir, ["account", "edit", "--id", "2", "--schedule-c", "18", ...S]);
  const inv = await issued(dir, "2026-10-01", 100000, 30, 1); // Acme's October, everything unbilled
  await ok(dir, json(["payment", "add"], { invoice_id: inv.id, date: "2026-10-10", amount_cents: inv.total_cents, fee_cents: 2900, deposit_account_id: 1 }));
  await ok(dir, json(["expense", "add"], { date: "2026-10-11", amount_cents: 1500, vendor: "Editor", account_id: 3, paid_from_account_id: 1 }));
  await ok(dir, json(["expense", "add"], { date: "2026-10-12", amount_cents: 40000, vendor: "Sam", account_id: 4, paid_from_account_id: 1 }));
  await ok(dir, json(["entry", "post"], { date: "2026-10-31", memo: "Interest", lines: [{ account_id: 1, debit_cents: 12 }, { account_id: 5, credit_cents: 12 }] }));

  const p = await ok(dir, ["report", "pnl"]);
  const work = inv.subtotal_cents - 4200; // all but the pass-through cost
  expect(p.schedule_c.map((l: any) => [l.line, l.name, l.total_cents])).toEqual([
    ["1", "Gross receipts or sales", work + 4200], // work plus costs billed on at cost
    ["10", "Commissions and fees", 2900], // the processor's fee
    ["11", "Contract labor", 40000],
    ["18", "Office expense", 4200 + 999],
    ["27b", "Other expenses", 1500],
  ]);
  // Every line's total is the sum of its accounts, and an account with no line is listed for the person to place.
  for (const l of p.schedule_c) {
    expect(l.total_cents).toBe([...p.income, ...p.expense].filter((a: any) => l.account_ids.includes(a.account_id)).reduce((s: number, a: any) => s + a.total_cents, 0));
  }
  expect(p.not_on_schedule_c).toEqual([{ account_id: 5, name: "Interest", total_cents: 12 }]);
  expect(p.income.find((a: any) => a.name === "Consulting income").schedule_c).toBe("1");

  // Lines must fit the account: income lines for income, expense lines for expenses, none for anything else.
  expect((await cli(dir, ["account", "edit", "--id", "5", "--schedule-c", "18", ...S])).out).toEqual({
    reason: "Line 18 is an expense line, so it can't hold this income account.", field: "schedule_c",
  });
  expect((await cli(dir, ["account", "edit", "--id", "1", "--schedule-c", "1", ...S])).out.field).toBe("schedule_c");
  await ok(dir, ["account", "edit", "--id", "5", "--schedule-c", "6", ...S]);
  expect((await ok(dir, ["report", "pnl"])).schedule_c.find((l: any) => l.line === "6")).toMatchObject({ name: "Other income", total_cents: 12 });
});

test("ISC-60 ytd: year-to-date profit is one exact number, from January 1 through the day asked", async () => {
  const dir = await acmeBooks(); // two expenses from checking: $42.00 on Oct 5 and $9.99 on Nov 5
  await ok(dir, json(["client", "add"], { name: "Beta LLC", address: "9 Elm Rd" }));
  const inv = await issued(dir, "2026-03-02", 123457, 30);
  await ok(dir, json(["payment", "add"], { invoice_id: inv.id, date: "2026-03-20", amount_cents: 123457, fee_cents: 3611, deposit_account_id: 1 }));
  await ok(dir, json(["expense", "add"], { date: "2025-12-31", amount_cents: 70000, vendor: "Last year", account_id: 2, paid_from_account_id: 1 }));
  await ok(dir, json(["owner", "draw"], { date: "2026-06-01", amount_cents: 50000, account_id: 1 }));

  const ytd = await ok(dir, ["report", "ytd"]); // the clock says 2026-10-22
  expect(ytd).toEqual({
    year: 2026, from: "2026-01-01", to: "2026-10-22",
    profit_cents: 123457 - 3611 - 4200, income_cents: 123457, expense_cents: 3611 + 4200,
    basis: "cash", basis_note: expect.any(String),
  });
  // Another day of the year, and a past year, without the person's own money in either.
  expect((await ok(dir, ["report", "ytd", "--as-of", "2026-12-31"])).profit_cents).toBe(123457 - 3611 - 4200 - 999);
  expect((await ok(dir, ["report", "ytd", "--as-of", "2025-12-31"])).profit_cents).toBe(-70000);
});
