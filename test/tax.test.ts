import { expect, test } from "bun:test";
import { join } from "node:path";
import { acmeBooks, cli, draftOctober, json, ok, S } from "./support/billing.ts";
import { pdfLines } from "./support/pdf-text.ts";
import { asPerson } from "./support/person.ts";
import { acct } from "./support/books.ts";

// acmeBooks' October: time $92.50 + $225.00, milestone $2,500.00, monthly fee $500.00, pass-through $42.00.
const SERVICES = 9250 + 22500 + 250000 + 50000;
const PASS_THROUGH = 4200;

test("applies to: a tax rate covers only the kinds the person listed, and a rate without them is refused", async () => {
  // A rate with no line kinds is refused, naming the field; solobooks never fills them in.
  const dir = await acmeBooks();
  const bare = await cli(dir, json(["client", "edit"], { id: 1, tax_rate_ppm: 62500 }));
  expect(bare.code).toBe(2);
  expect(bare.out).toEqual({ reason: "A tax rate needs the kinds of line it applies to, so list them in tax_applies_to.", field: "tax_applies_to" });
  const add = await cli(dir, json(["client", "add"], { name: "Beta", tax_rate_ppm: 62500 }));
  expect(add.out.field).toBe("tax_applies_to");
  expect((await ok(dir, ["client", "list"])).clients.map((c: any) => c.tax_rate_ppm)).toEqual([null]);

  // Pass-through not listed: it stays untaxed.
  const c = (await ok(dir, json(["client", "edit"], { id: 1, tax_rate_ppm: 62500, tax_label: "IL sales tax", tax_applies_to: ["time", "fixed", "recurring"] }))).client;
  expect(c.tax_applies_to).toEqual(["time", "fixed", "recurring"]);
  const d = await draftOctober(dir);
  expect(d.tax).toEqual({
    label: "IL sales tax", rate_ppm: 62500, applies_to: ["time", "fixed", "recurring"],
    taxable_cents: SERVICES, amount_cents: 20734, // 331750 x 6.25% = 20734.375
  });
  expect(d.total_cents).toBe(SERVICES + PASS_THROUGH + 20734);

  // Issued, the PDF shows the tax line and the base it was charged on.
  const inv = (await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S])).invoice;
  const file = (await ok(dir, ["invoice", "pdf", "--id", String(inv.id)])).file;
  const lines = await pdfLines(join(dir, file));
  expect(lines).toContain("IL sales tax (6.25% of $3,317.50) $207.34");
  expect(lines).toContain("Total due $3,566.84");
  // Tax is owed to the state, never income: paid in full, the P&L counts everything but the tax.
  await ok(dir, json(["payment", "add"], { invoice_id: inv.id, date: "2026-10-25", amount_cents: inv.total_cents, deposit_account_id: acct(1) }));
  const pnl = await ok(dir, ["report", "pnl"]);
  expect(pnl.income_total_cents).toBe(SERVICES + PASS_THROUGH);

  // Pass-through listed: it is taxed too.
  const dir2 = await acmeBooks({ tax_rate_ppm: 62500, tax_applies_to: ["pass_through"] });
  const d2 = await draftOctober(dir2);
  expect(d2.tax).toMatchObject({ applies_to: ["pass_through"], taxable_cents: PASS_THROUGH, amount_cents: 263 }); // 4200 x 6.25% = 262.5
  expect(d2.total_cents).toBe(SERVICES + PASS_THROUGH + 263);

  // The issued invoice keeps the kinds it was issued with, even after the client's change.
  await ok(dir, json(["client", "edit"], { id: 1, tax_applies_to: ["time", "fixed", "recurring", "pass_through"] }));
  expect((await ok(dir, ["invoice", "get", "--id", String(inv.id)])).invoice.tax.taxable_cents).toBe(SERVICES);
});

test("applies to: a partial credit names the kind it reduces, so tax follows the person's list", async () => {
  const dir = await acmeBooks({ tax_rate_ppm: 62500, tax_applies_to: ["time"] });
  const d = await draftOctober(dir);
  const inv = (await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S])).invoice;
  const id = String(inv.id);
  const r = await cli(dir, ["invoice", "credit", "--invoice-id", id, "--amount-cents", "4200", "--reason", "Refund", ...S]);
  expect(r.out).toEqual({ reason: "Invoice 7001 carries sales tax, so say in line_kind which kind of line this credit reduces.", field: "line_kind" });
  const untaxed = (await ok(dir, ["invoice", "credit", "--invoice-id", id, "--amount-cents", "4200", "--reason", "Refund", "--line-kind", "pass_through", ...S])).credit_note;
  expect(untaxed).toMatchObject({ tax: null, total_cents: 4200 });
  const taxed = (await ok(dir, ["invoice", "credit", "--invoice-id", id, "--amount-cents", "1000", "--reason", "Fix", "--line-kind", "time", ...S])).credit_note;
  expect(taxed).toMatchObject({ tax: { taxable_cents: 1000, amount_cents: 63 }, total_cents: 1063 });
});

/** Beta, a second client billed only by hand-written lines, with whatever tax settings are given. */
async function beta(dir: string, tax: Record<string, unknown> = {}) {
  await ok(dir, json(["client", "add"], { name: "Beta LLC", address: "9 Elm Rd\nAustin, TX 78701", ...tax }));
}
const betaDraft = async (dir: string, lines: { description: string; amount_cents: number }[]) =>
  (await ok(dir, json(["invoice", "draft"], { client_id: 2, period_start: "2026-10-01", period_end: "2026-10-31", lines }))).invoice;

test("ISC-49 line: a client's rate and label appear as their own line on the invoice, apart from every item line", async () => {
  const dir = await acmeBooks();
  await beta(dir, { tax_rate_ppm: 82500, tax_label: "TX sales tax", tax_applies_to: ["manual"] });
  const d = await betaDraft(dir, [{ description: "Website build", amount_cents: 100000 }, { description: "Support", amount_cents: 25000 }]);
  // The tax is its own figure, never folded into a line or the subtotal.
  expect(d.lines.map((l: any) => [l.description, l.amount_cents])).toEqual([["Website build", 100000], ["Support", 25000]]);
  expect(d).toMatchObject({ subtotal_cents: 125000, tax: { label: "TX sales tax", rate_ppm: 82500, taxable_cents: 125000, amount_cents: 10313 }, total_cents: 135313 });
  const inv = (await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S])).invoice;
  expect(inv.tax).toEqual(d.tax);

  // On the PDF it is a separate line between the subtotal and the total, with its label and rate.
  const lines = await pdfLines(join(dir, (await ok(dir, ["invoice", "pdf", "--id", String(inv.id)])).file));
  const at = (prefix: string) => lines.findIndex((l) => l.startsWith(prefix));
  expect(lines).toContain("Subtotal $1,250.00");
  expect(lines).toContain("TX sales tax (8.25%) $103.13");
  expect(lines).toContain("Total due $1,353.13");
  expect(at("Subtotal")).toBeLessThan(at("TX sales tax"));
  expect(at("TX sales tax")).toBeLessThan(at("Total due"));
  // The email states the total the client owes, tax included.
  expect((await ok(dir, ["invoice", "email", "--id", String(inv.id)])).body).toContain("$1,353.13");
}, 30_000); // many CLI runs: allow for a busy machine

test("ISC-50 liability: tax collected is owed to the state, never income, from issue through payment and payment to the state", async () => {
  const dir = await acmeBooks();
  await beta(dir, { tax_rate_ppm: 100000, tax_label: "TX sales tax", tax_applies_to: ["manual"] });
  const inv = (await ok(dir, ["invoice", "issue", "--id", String((await betaDraft(dir, [{ description: "Work", amount_cents: 100000 }])).id), ...S])).invoice;
  expect(inv).toMatchObject({ total_cents: 110000, tax: { amount_cents: 10000 } });

  // Issued, the ledger owes the state $100 on a liability account and books only the $1,000 of work as income.
  const accounts = (await ok(dir, ["account", "list"])).accounts;
  const payable = accounts.find((a: any) => a.name === "Sales tax payable");
  expect(payable).toMatchObject({ type: "liability", schedule_c: null });
  const issueEntry = (await ok(dir, ["entry", "list"])).entries.at(-1);
  expect(issueEntry.lines).toContainEqual({ account_id: payable.id, debit_cents: 0, credit_cents: 10000 });
  const incomeIds = accounts.filter((a: any) => a.type === "income").map((a: any) => a.id);
  const toIncome = issueEntry.lines.filter((l: any) => incomeIds.includes(l.account_id)).reduce((s: number, l: any) => s + l.credit_cents - l.debit_cents, 0);
  expect(toIncome).toBe(100000);

  // Paid in two parts, the P&L counts only the work, and the tax shows as collected for the state.
  await ok(dir, json(["payment", "add"], { invoice_id: inv.id, date: "2026-10-25", amount_cents: 55000, deposit_account_id: acct(1) }));
  await ok(dir, json(["payment", "add"], { invoice_id: inv.id, date: "2026-10-28", amount_cents: 55000, deposit_account_id: acct(1) }));
  const pnl = await ok(dir, ["report", "pnl"]);
  expect(pnl.income_total_cents).toBe(100000);
  expect([...pnl.income, ...pnl.expense].every((x: any) => x.account_id !== payable.id)).toBe(true);
  const tax = await ok(dir, ["report", "sales", "tax"]);
  expect(tax.taxes).toMatchObject([{ tax_label: "TX sales tax", charged_cents: 10000, collected_cents: 10000, paid_to_state_cents: 0 }]);

  // Paying the state clears the liability and leaves the P&L alone.
  const paid = (await ok(dir, json(["sales", "tax", "payment", "add"], {
    date: "2026-11-15", amount_cents: 10000, paid_from_account_id: acct(1), tax_label: "TX sales tax", period_start: "2026-10-01", period_end: "2026-10-31",
  }))).sales_tax_payment;
  expect(paid.entry.lines).toEqual([{ account_id: payable.id, debit_cents: 10000, credit_cents: 0 }, { account_id: acct(1), debit_cents: 0, credit_cents: 10000 }]);
  const owedToState = () => asPerson(dir, (db) => (db.query("SELECT SUM(debit_cents) - SUM(credit_cents) AS n FROM lines WHERE account_id = ?").get(payable.id) as { n: number }).n);
  expect(owedToState()).toBe(0);
  expect(await ok(dir, ["report", "pnl"])).toEqual(pnl);
  expect((await ok(dir, ["report", "sales", "tax"])).taxes[0]).toMatchObject({ charged_cents: 10000, collected_cents: 10000, paid_to_state_cents: 10000 });

  // Nothing else may post to the account that holds it, and a payment to the state names a tax some invoice charged.
  const entry = await cli(dir, json(["entry", "post"], { date: "2026-11-15", memo: "x", lines: [{ account_id: payable.id, debit_cents: 1 }, { account_id: acct(1), credit_cents: 1 }] }));
  expect(entry.out.field).toBe("lines[0].account_id");
  const typo = await cli(dir, json(["sales", "tax", "payment", "add"], { date: "2026-11-15", amount_cents: 1, paid_from_account_id: acct(1), tax_label: "TX sales", period_start: "2026-10-01", period_end: "2026-10-31" }));
  expect(typo.out).toEqual({ reason: "No issued invoice carries that tax label, so use a label exactly as report sales tax lists it.", field: "tax_label" });
}, 30_000); // many CLI runs: allow for a busy machine

test("ISC-52 never decides: no tax line appears unless the person set a rate on that client", async () => {
  // Acme has no rate: every kind of line it bills goes out untaxed.
  const dir = await acmeBooks();
  const d = await draftOctober(dir);
  expect(new Set(d.lines.map((l: any) => l.kind))).toEqual(new Set(["time", "fixed", "recurring", "pass_through"]));
  const extra = (await ok(dir, json(["invoice", "edit"], { id: d.id, add_lines: [{ description: "Rush fee", amount_cents: 5000 }] }))).invoice;
  expect(extra).toMatchObject({ tax: null, total_cents: extra.subtotal_cents });
  const inv = (await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S])).invoice;
  expect(inv).toMatchObject({ tax: null, total_cents: inv.subtotal_cents });
  const lines = await pdfLines(join(dir, (await ok(dir, ["invoice", "pdf", "--id", String(inv.id)])).file));
  expect(lines.filter((l) => /tax/i.test(l))).toEqual([]);
  // Nothing was posted as owed to a state, and there is no sales tax to report.
  const payable = (await ok(dir, ["account", "list"])).accounts.find((a: any) => a.name === "Sales tax payable");
  const posted = (await ok(dir, ["entry", "list"])).entries.at(-1).lines;
  expect(posted.filter((l: any) => l.account_id === payable?.id)).toEqual([]);
  expect((await ok(dir, ["report", "sales", "tax"])).taxes).toEqual([]);

  // A rate only on kinds the invoice doesn't have adds no line either; and setting it to 0 takes it away again.
  await beta(dir, { tax_rate_ppm: 62500, tax_applies_to: ["time"] });
  expect((await betaDraft(dir, [{ description: "Handwritten", amount_cents: 1000 }])).tax).toBeNull();
  await ok(dir, json(["client", "edit"], { id: 2, tax_rate_ppm: 62500, tax_applies_to: ["manual"] }));
  expect((await betaDraft(dir, [{ description: "Second", amount_cents: 1000 }])).tax).toMatchObject({ amount_cents: 63 });
  const cleared = (await ok(dir, json(["client", "edit"], { id: 2, tax_rate_ppm: 0 }))).client;
  expect(cleared).toMatchObject({ tax_rate_ppm: null, tax_label: null, tax_applies_to: null });
  expect((await betaDraft(dir, [{ description: "Third", amount_cents: 1000 }])).tax).toBeNull();
}, 30_000); // many CLI runs: allow for a busy machine
