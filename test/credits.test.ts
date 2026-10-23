import { expect, test } from "bun:test";
import { join } from "node:path";
import { acmeBooks, cli, issueOctober, ok, S } from "./support/billing.ts";
import { pdfLines } from "./support/pdf-text.ts";

test("ISC-34: a credit note references the original invoice number", async () => {
  const dir = await acmeBooks({ tax_rate_ppm: 62500, tax_label: "IL sales tax", tax_applies_to: ["time", "fixed", "recurring", "pass_through"] });
  const inv = await issueOctober(dir);
  expect(inv.number).toBe("7001");

  const cn = (await ok(dir, ["invoice", "credit", "--invoice-id", String(inv.id), "--amount-cents", "10000", "--reason", "Goodwill discount", "--line-kind", "time", ...S])).credit_note;
  expect(cn).toMatchObject({
    kind: "credit",
    status: "issued",
    number: "CN-1",
    credits_invoice: { id: inv.id, number: "7001" },
    subtotal_cents: 10000,
    tax: { label: "IL sales tax", rate_ppm: 62500, taxable_cents: 10000, amount_cents: 625 },
    total_cents: 10625,
  });
  expect(cn.lines.map((l: any) => l.description)).toEqual(["Credit against invoice 7001: Goodwill discount"]);

  // The credit note's own document says which invoice it credits.
  const file = (await ok(dir, ["invoice", "pdf", "--id", String(cn.id)])).file;
  expect(file).toBe("invoices/CN-1.pdf");
  const text = (await pdfLines(join(dir, file))).join("\n");
  expect(text).toContain("CREDIT NOTE");
  expect(text).toContain("Credit note number: CN-1");
  expect(text).toContain("Credits invoice: 7001");
  expect(text).toContain("Credit against invoice 7001: Goodwill discount");
  expect(text).toContain("Total credit $106.25");
  const email = await ok(dir, ["invoice", "email", "--id", String(cn.id)]);
  expect(email.subject).toContain("against invoice 7001");
  expect(email.body).toContain("credit note CN-1 for $106.25, which reduces what you owe on invoice 7001");

  // The original is untouched; what is still owed drops by the credit, and the reversal is in the ledger.
  const after = (await ok(dir, ["invoice", "get", "--id", String(inv.id)])).invoice;
  expect(after).toMatchObject({ status: "issued", total_cents: inv.total_cents, open_cents: inv.total_cents - 10625 });
  const memo = (await ok(dir, ["entry", "list"])).entries.at(-1).memo;
  expect(memo).toBe("Credit note CN-1 for invoice 7001 to Acme Corp");

  // Crediting the rest with no amount clears the balance; a third credit is refused, and so is voiding a credited invoice.
  const rest = (await ok(dir, ["invoice", "credit", "--invoice-id", String(inv.id), "--reason", "Project cancelled", "--line-kind", "time", ...S])).credit_note;
  expect(rest).toMatchObject({ number: "CN-2", credits_invoice: { number: "7001" } });
  expect((await ok(dir, ["invoice", "get", "--id", String(inv.id)])).invoice.open_cents).toBe(0);
  expect((await cli(dir, ["invoice", "credit", "--invoice-id", String(inv.id), "--reason", "x", ...S])).out.reason).toBe(
    "Invoice 7001 is already fully credited.",
  );
  expect((await cli(dir, ["invoice", "void", "--id", String(inv.id), "--reason", "x", ...S])).out.field).toBe("id");
  expect((await ok(dir, ["report", "pnl"])).income_total_cents).toBe(0);
});

test("ISC-34: a full first credit mirrors the invoice line by line", async () => {
  const dir = await acmeBooks();
  const inv = await issueOctober(dir);
  const cn = (await ok(dir, ["invoice", "credit", "--invoice-id", String(inv.id), "--reason", "Billed in error", ...S])).credit_note;
  expect(cn.lines.map((l: any) => [l.kind, l.description, l.amount_cents])).toEqual(inv.lines.map((l: any) => [l.kind, l.description, l.amount_cents]));
  expect(cn.total_cents).toBe(inv.total_cents);
  expect(cn.credits_invoice.number).toBe("7001");
  // Credits reverse each income account they came from, so nothing is left in income.
  const pnl = await ok(dir, ["report", "pnl"]);
  expect(pnl.income.map((i: any) => i.total_cents)).toEqual([0, 0]);
});
