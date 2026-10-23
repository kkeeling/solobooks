import { expect, test } from "bun:test";
import { clickAcme, cli, draftOctober, json, ok, S } from "./support/billing.ts";
import { asPerson } from "./support/person.ts";

// Past invoices brought in from an old spreadsheet. The clock in these tests is 2026-10-22, and every gated action
// waits for the person's click, so anything that slipped past the gate would show up as an issued invoice.

const PAST = { client_id: 1, invoice_date: "2026-08-01", due_date: "2026-08-31", lines: [{ description: "July work", amount_cents: 120000 }] };
const imported = async (dir: string, body: Record<string, unknown>) => (await ok(dir, json(["invoice", "import"], { ...PAST, ...body }))).invoice;

const balance = (dir: string, name: string) =>
  asPerson(dir, (db) => {
    const r = db
      .query("SELECT COALESCE(SUM(l.debit_cents) - SUM(l.credit_cents), 0) AS n FROM lines l JOIN accounts a ON a.id = l.account_id WHERE a.name = ?")
      .get(name) as { n: number };
    return r.n;
  });

test("ISC-81: past invoices keep their numbers, post to the books, never wait at the gate and never get a reminder", async () => {
  const dir = await clickAcme();
  const unpaid = await imported(dir, { number: 511, note: "From the old spreadsheet" });
  const paid = await imported(dir, {
    number: 512, invoice_date: "2026-09-01", due_date: "2026-10-01", sent_on: "2026-09-02",
    lines: [{ description: "August work", amount_cents: 80000 }], paid_on: "2026-09-25", paid_account_id: 1,
  });

  // Already happened: sent, numbered as they were, and marked historical.
  expect(unpaid).toMatchObject({ status: "sent", number: "511", historical: true, invoice_date: "2026-08-01", due_date: "2026-08-31", total_cents: 120000, open_cents: 120000, paid_on: null });
  expect(paid).toMatchObject({ status: "sent", number: "512", historical: true, sent_at: "2026-09-02T00:00:00.000Z", total_cents: 80000, open_cents: 0, paid_on: "2026-09-25" });

  // Nothing waited for the person, though every gated action is at click.
  expect((await ok(dir, ["gate", "list"])).gate.every((g: any) => g.level === "click")).toBe(true);
  expect((await ok(dir, ["pending", "list"])).pending).toEqual([]);

  // They post like any invoice: the ledger holds both as income, the unpaid one is still owed, and the paid one landed
  // in checking. The cash-basis P&L counts only the paid one, on the day it was paid.
  expect(balance(dir, "Consulting income")).toBe(-200000);
  expect((await ok(dir, ["report", "pnl"])).income_total_cents).toBe(80000);
  expect((await ok(dir, ["report", "pnl", "--from", "2026-09-25", "--to", "2026-09-25"])).income_total_cents).toBe(80000);
  expect(balance(dir, "Accounts receivable")).toBe(120000);
  expect(balance(dir, "Checking")).toBe(80000 - 4200 - 999); // less the two expenses acmeBooks paid from checking
  const memos = (await ok(dir, ["entry", "list"])).entries.map((e: any) => [e.date, e.memo]);
  expect(memos).toContainEqual(["2026-08-01", "Past invoice 511 to Acme Corp"]);
  expect(memos).toContainEqual(["2026-09-25", "Payment for past invoice 512 from Acme Corp"]);

  // Never reminded: there is no overdue list yet, and the reminder, email and PDF are all refused, though 511 is overdue.
  for (const cmd of ["reminder", "email", "pdf"]) {
    for (const inv of [unpaid, paid]) {
      const r = await cli(dir, ["invoice", cmd, "--id", String(inv.id)]);
      expect(r).toEqual({ code: 2, out: { reason: `Invoice ${inv.number} was brought in as already sent, so solobooks makes no PDF, email or reminder for it.`, field: "id" } });
    }
  }

  // Marked historical wherever invoices are listed, next to an invoice solobooks issued.
  const d = await draftOctober(dir);
  const issue = await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S]);
  expect(issue).toMatchObject({ status: "pending", level: "click" }); // a new invoice still waits for the person
  const list = (await ok(dir, ["invoice", "list"])).invoices.map((i: any) => [i.number, i.status, i.historical]);
  expect(list).toEqual([["511", "sent", true], ["512", "sent", true], [null, "draft", false]]);
  expect((await ok(dir, ["invoice", "get", "--id", String(unpaid.id)])).invoice.historical).toBe(true);

  // Numbers solobooks issues continue from the configured next number, not from the past ones.
  expect((await ok(dir, ["profile", "get"])).next_invoice_number).toBe(7001);
});

test("ISC-81 guard: only an invoice dated before today, numbered below solobooks' own, can be brought in", async () => {
  const dir = await clickAcme();
  const refused = async (body: Record<string, unknown>) => (await cli(dir, json(["invoice", "import"], { ...PAST, number: 100, ...body }))).out;

  expect(await refused({ invoice_date: "2026-10-22", due_date: "2026-11-21" })).toEqual({
    reason: "A past invoice must be dated before today; a new invoice goes through invoice draft and invoice issue.",
    field: "invoice_date",
  });
  expect((await refused({ invoice_date: "2027-01-01", due_date: "2027-01-31" })).field).toBe("invoice_date");
  expect(await refused({ number: 7001 })).toEqual({
    reason: "Number 7001 is not below 7001, the next number solobooks will issue, so set next_invoice_number above your last past invoice with profile set first.",
    field: "number",
  });
  expect((await refused({ sent_on: "2026-10-23" })).field).toBe("sent_on");
  expect((await refused({ paid_on: "2026-10-23", paid_account_id: 1 })).field).toBe("paid_on");
  expect((await refused({ paid_on: "2026-07-01", paid_account_id: 1 })).field).toBe("paid_on"); // before it was issued
  expect((await refused({ paid_on: "2026-09-01" })).field).toBe("paid_account_id");
  expect((await refused({ paid_on: "2026-09-01", paid_account_id: 2 })).field).toBe("paid_account_id"); // an expense account
  expect((await refused({ total_cents: 120001 })).field).toBe("total_cents");
  expect((await refused({ tax_rate_ppm: 62500 })).field).toBe("tax_label");
  expect((await ok(dir, ["invoice", "list"])).invoices).toEqual([]);

  await imported(dir, { number: 100 });
  expect(await refused({})).toEqual({ reason: "Invoice 100 is already in the books.", field: "number" });

  // The configured next number can still move, but never down onto a past invoice.
  expect((await cli(dir, ["profile", "set", "--next-invoice-number", "100", ...S])).out).toEqual({
    reason: "Past invoice 100 is already in the books, so next_invoice_number must be above it.",
    field: "next_invoice_number",
  });
  expect((await ok(dir, ["profile", "set", "--next-invoice-number", "101", ...S])).profile.next_invoice_number).toBe(101);
});

test("ISC-81: a past invoice's sales tax is owed, not income, and changing one afterwards still waits at the gate", async () => {
  const dir = await clickAcme();
  const inv = await imported(dir, { number: 300, tax_rate_ppm: 62500, tax_label: "IL sales tax", total_cents: 127500 });
  expect(inv.tax).toMatchObject({ label: "IL sales tax", rate_ppm: 62500, amount_cents: 7500 });
  expect(balance(dir, "Consulting income")).toBe(-120000); // the ledger's income leaves the tax out
  expect((await ok(dir, ["report", "pnl"])).income_total_cents).toBe(0); // unpaid, so nothing counts yet on the cash basis
  expect(balance(dir, "Sales tax payable")).toBe(-7500);

  // Voiding or crediting it reaches money already booked, so the gate holds those as for any invoice.
  expect(await ok(dir, ["invoice", "void", "--id", String(inv.id), "--reason", "Duplicate", ...S])).toMatchObject({ status: "pending" });
  expect((await ok(dir, ["invoice", "get", "--id", String(inv.id)])).invoice.status).toBe("sent");

  // One brought in as paid is settled, so there is nothing to void or credit.
  const paid = await imported(dir, { number: 301, paid_on: "2026-08-15", paid_account_id: 1 });
  expect((await cli(dir, ["invoice", "void", "--id", String(paid.id), "--reason", "x", ...S])).out).toEqual({
    reason: "Invoice 301 was brought in as paid, so it can't be voided.",
    field: "id",
  });
  expect((await cli(dir, json(["invoice", "credit"], { invoice_id: paid.id, reason: "x" }))).out.field).toBe("invoice_id");
});
