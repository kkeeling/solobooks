import { expect, test } from "bun:test";
import { join } from "node:path";
import { acmeBooks, draftOctober, ok, S } from "./support/billing.ts";
import { pdfLines } from "./support/pdf-text.ts";

async function pdf(dir: string, id: number) {
  const r = await ok(dir, ["invoice", "pdf", "--id", String(id)]);
  return { file: r.file as string, lines: await pdfLines(join(dir, r.file)) };
}

test("ISC-30 draft: a draft invoice PDF is stamped DRAFT and carries no final number", async () => {
  const dir = await acmeBooks();
  const d = await draftOctober(dir);
  const { file, lines } = await pdf(dir, d.id);
  const text = lines.join("\n");

  expect(file).toBe(`invoices/draft-${d.id}.pdf`);
  expect(lines).toContain("DRAFT");
  expect(lines.some((l) => l.includes("DRAFT INVOICE"))).toBe(true);
  expect(text).toContain("Invoice number: assigned when issued");
  // The number this invoice would get, 7001, appears nowhere, and no line claims an invoice date or due date.
  expect(text).not.toContain("7001");
  expect(text).not.toMatch(/Invoice number: \d/);
  expect(text).toContain("Invoice date: set when issued");
  expect(text).toContain("Due date: set when issued");
  // Still a useful preview: the lines and total are there.
  expect(text).toContain("Build: Spec $2,500.00");
  expect(text).toContain("Total due $3,359.50");

  // The same invoice once issued has its number and no stamp.
  await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S]);
  const issued = await pdf(dir, d.id);
  expect(issued.file).toBe("invoices/7001.pdf");
  expect(issued.lines).not.toContain("DRAFT");
  expect(issued.lines.join("\n")).toContain("Invoice number: 7001");
});

test("ISC-31 standard fields: an issued PDF carries all 13 standard fields and the payment instructions", async () => {
  const dir = await acmeBooks({ tax_rate_ppm: 62500, tax_label: "IL sales tax", tax_applies_to: ["time", "fixed", "recurring", "pass_through"] });
  const d = await draftOctober(dir);
  await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S]);
  const { lines } = await pdf(dir, d.id);
  // Left and right columns share baselines, so a field counts when a printed row contains it.
  const has = (s: string) => expect(lines.filter((l) => l.includes(s))).not.toEqual([]);

  has("Jane Doe Consulting LLC"); //                                         1 seller legal name
  has("1 Main St"); has("Springfield, IL 62701"); //                          2 seller address
  has("EIN 12-3456789"); //                                                  3 EIN
  has("Acme Corp"); has("500 Market St"); has("San Francisco, CA 94105"); //  4 client name and address
  has("Invoice number: 7001"); //                                            5 unique number
  has("Invoice date: October 22, 2026"); //                                  6 invoice date
  has("Service period: October 1, 2026 – October 31, 2026"); //        7 service period
  has("2026-10-03 API design (37 min at $150.00/hr) $92.50"); //            8 line items
  has("2026-10-20 Load testing (90 min at $150.00/hr) $225.00");
  has("Build: Spec $2,500.00");
  has("Build, October 2026 $500.00");
  has("2026-10-05 Print shop, Workshop handouts (pass-through cost) $42.00");
  has("Subtotal $3,359.50"); //                                              9 subtotal
  has("IL sales tax (6.25%) $209.97"); //                                   10 tax line (335950 x 6.25% = 20996.875)
  has("Total due $3,569.47"); //                                            11 total
  has("Terms: Net 30"); //                                                  12 terms
  has("Due date: November 21, 2026"); //                                    13 due date
  has("How to pay");
  has("ACH to First Bank, routing 011000015, account 1234567");
});

test("ISC-31 standard fields: a client with no tax rate gets no tax line", async () => {
  const dir = await acmeBooks();
  const d = await draftOctober(dir);
  await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S]);
  const { lines } = await pdf(dir, d.id);
  expect(lines.filter((l) => /tax/i.test(l))).toEqual([]);
  expect(lines).toContain("Total due $3,359.50");
});

test("ISC-31 standard fields: long invoices run onto more pages, and characters outside the font print as ?", async () => {
  const dir = await acmeBooks();
  for (let i = 0; i < 60; i++) {
    await ok(dir, ["time", "add", "--client-id", "1", "--date", "2026-10-21", "--minutes", "15", "--note", `Review ${i} → notes`, ...S]);
  }
  const d = await draftOctober(dir);
  await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S]);
  const { lines } = await pdf(dir, d.id);
  expect(lines).toContain("Page 2 of 3");
  expect(lines).toContain("2026-10-21 Review 59 ? notes (15 min at $150.00/hr) $37.50");
  expect(lines.filter((l) => l.startsWith("Total due"))).toEqual([`Total due $${(3359.5 + 60 * 37.5).toLocaleString("en-US", { minimumFractionDigits: 2 })}`]);
});
