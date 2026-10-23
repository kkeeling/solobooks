import { expect, test } from "bun:test";
import { join } from "node:path";
import { acmeBooks, cli, draftOctober, json, ok, S } from "./support/billing.ts";
import { pdfLines } from "./support/pdf-text.ts";

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
  // Tax is owed to the state, never income.
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
