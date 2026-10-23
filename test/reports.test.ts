import { expect, test } from "bun:test";
import { run } from "../src/cli.ts";
import { acmeBooks, cli, json, ok, S } from "./support/billing.ts";

// The unpaid list, against the solobooks clock. cli() runs at 2026-10-22; at() runs a command on another day.

async function at(dir: string, now: string, args: string[]) {
  const r = await run([...args, "--books", dir], { SOLOBOOKS_NOW: `${now}T12:00:00.000Z` });
  if (r.code !== 0) throw new Error(`expected success for ${args.join(" ")}: ${r.stdout}`);
  return JSON.parse(r.stdout);
}

/** Issues a one-line invoice for client 2 on a given day, with given terms, and returns it. */
async function issued(dir: string, day: string, cents: number, terms: number) {
  const d = (await ok(dir, json(["invoice", "draft"], { client_id: 2, period_start: "2026-01-01", period_end: "2026-12-31", terms_days: terms, lines: [{ description: `Work billed ${day}`, amount_cents: cents }] }))).invoice;
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
