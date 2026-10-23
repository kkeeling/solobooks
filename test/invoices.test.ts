import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { dbPath } from "./support/books.ts";
import { acmeBooks, cli, draftOctober, issueOctober, json, OCTOBER, ok, S } from "./support/billing.ts";

const kinds = (inv: any) => inv.lines.map((l: any) => l.kind);

test("ISC-29 draft sources: a period's draft pulls in its unbilled time, fixed fees, recurring fees and pass-through costs", async () => {
  const dir = await acmeBooks();
  // Entered late: September work nobody billed. October's draft must carry it over, not leave it behind.
  await ok(dir, ["time", "add", "--client-id", "1", "--date", "2026-09-29", "--minutes", "30", "--note", "Kickoff call", ...S]);
  const d = await draftOctober(dir);
  expect(d).toMatchObject({ status: "draft", number: null, period_start: "2026-10-01", period_end: "2026-10-31" });

  expect(new Set(kinds(d))).toEqual(new Set(["time", "fixed", "recurring", "pass_through"]));
  expect(d.lines.map((l: any) => [l.kind, l.description, l.amount_cents, l.item_date, l.carried_over])).toEqual([
    ["time", "2026-09-29 Kickoff call (30 min at $150.00/hr)", 7500, "2026-09-29", true],
    ["time", "2026-10-03 API design (37 min at $150.00/hr)", 9250, "2026-10-03", false],
    ["time", "2026-10-20 Load testing (90 min at $150.00/hr)", 22500, "2026-10-20", false],
    ["fixed", "Build: Spec", 250000, "2026-10-15", false],
    ["recurring", "Build, October 2026", 50000, "2026-10-01", false],
    ["pass_through", "2026-10-05 Print shop, Workshop handouts (pass-through cost)", 4200, "2026-10-05", false],
  ]);
  // Each line points back at what it bills.
  expect(d.lines.map((l: any) => l.time_entry_id ?? l.milestone_id ?? l.cycle_start ?? l.expense_id)).toEqual([4, 1, 2, 1, "2026-10-01", 1]);
  expect(d.subtotal_cents).toBe(7500 + 9250 + 22500 + 250000 + 50000 + 4200);

  // Items dated after the period stay out, and nothing is drafted twice.
  const again = await cli(dir, ["invoice", "draft", ...OCTOBER, ...S]);
  expect(again.code).toBe(2);
  expect(again.out.field).toBe("period_end");
  const nov = (await ok(dir, ["invoice", "draft", "--client-id", "1", "--period-start", "2026-11-01", "--period-end", "2026-11-30", ...S])).invoice;
  expect(nov.lines.map((l: any) => [l.kind, l.amount_cents, l.carried_over])).toEqual([
    ["time", 15000, false],
    ["recurring", 50000, false],
    ["pass_through", 999, false],
  ]);

  // Skip December, then draft January: the Ship milestone (billable December 1) and December's fee carry over.
  const jan = (await ok(dir, ["invoice", "draft", "--client-id", "1", "--period-start", "2027-01-01", "--period-end", "2027-01-31", ...S])).invoice;
  expect(jan.lines.map((l: any) => [l.description, l.carried_over])).toEqual([
    ["Build: Ship", true],
    ["Build, December 2026", true],
    ["Build, January 2027", false],
  ]);

  // A quarterly and a yearly fee bill once per cycle that starts in the period.
  await ok(dir, json(["engagement", "add"], { client_id: 1, name: "Care", recurring_amount_cents: 90000, recurring_interval: "quarterly" }));
  await ok(dir, json(["engagement", "add"], { client_id: 1, name: "Licence", recurring_amount_cents: 120000, recurring_interval: "yearly" }));
  const year = (await ok(dir, ["invoice", "draft", "--client-id", "1", "--period-start", "2027-01-01", "--period-end", "2027-12-31", ...S])).invoice;
  expect(year.lines.map((l: any) => l.description)).toEqual([
    ...["February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map(
      (m) => `Build, ${m} 2027`,
    ),
    "Care, Q1 2027", "Care, Q2 2027", "Care, Q3 2027", "Care, Q4 2027",
    "Licence, 2027",
  ]);
});

test("ISC-33 never delete: deleting an issued invoice is refused, and voiding keeps the record", async () => {
  const dir = await acmeBooks();
  const inv = await issueOctober(dir);
  expect(inv).toMatchObject({ status: "issued", number: "7001" });

  const del = await cli(dir, ["invoice", "delete", "--id", String(inv.id), ...S]);
  expect(del.code).toBe(2);
  expect(del.out).toEqual({ reason: "Invoice 7001 is issued, and issued documents are never deleted, so void it instead.", field: "id" });
  expect((await ok(dir, ["invoice", "get", "--id", String(inv.id)])).invoice).toEqual(inv);

  // The database refuses too, even if a code path forgot to check.
  const db = new Database(dbPath(dir));
  expect(() => db.exec(`DELETE FROM invoices WHERE id = ${inv.id}`)).toThrow(/never deleted/);
  expect(() => db.exec(`DELETE FROM invoice_lines WHERE invoice_id = ${inv.id}`)).toThrow(/locked/);
  expect(() => db.exec(`UPDATE invoices SET number = 9999 WHERE id = ${inv.id}`)).toThrow(/locked/);
  expect(() => db.exec(`UPDATE invoice_lines SET amount_cents = 1 WHERE invoice_id = ${inv.id}`)).toThrow(/locked/);
  db.close();

  const voided = (await ok(dir, ["invoice", "void", "--id", String(inv.id), "--reason", "Billed the wrong period", ...S])).invoice;
  expect(voided).toMatchObject({ id: inv.id, status: "void", number: "7001", void_reason: "Billed the wrong period", total_cents: inv.total_cents });
  expect(voided.lines).toEqual(inv.lines);
  expect((await ok(dir, ["invoice", "list"])).invoices.map((i: any) => [i.number, i.status])).toEqual([["7001", "void"]]);
  expect((await cli(dir, ["invoice", "delete", "--id", String(inv.id), ...S])).code).toBe(2);

  // Voiding posts a reversal: the receivable and the income are back to zero, and both entries stay.
  const pnl = await ok(dir, ["report", "pnl"]);
  expect(pnl.income_total_cents).toBe(0);
  const entries = (await ok(dir, ["entry", "list"])).entries;
  expect(entries.map((e: any) => e.memo).slice(-2)).toEqual(["Invoice 7001 to Acme Corp", "Void invoice 7001: Billed the wrong period"]);

  // The next invoice takes the next number: the voided one keeps 7001.
  const next = await issueOctober(dir);
  expect(next.number).toBe("7002");
});

test("ISC-37 sent: an issued invoice turns sent only when the agent reports sending it", async () => {
  const dir = await acmeBooks();
  const draft = await draftOctober(dir);
  const early = await cli(dir, ["invoice", "sent", "--id", String(draft.id), ...S]);
  expect(early.code).toBe(2);
  expect(early.out.field).toBe("id");

  const inv = (await ok(dir, ["invoice", "issue", "--id", String(draft.id), ...S])).invoice;
  expect(inv).toMatchObject({ status: "issued", sent_at: null });

  // Making the PDF, the email and a reminder sends nothing and changes nothing.
  const id = String(inv.id);
  await ok(dir, ["invoice", "pdf", "--id", id]);
  await ok(dir, ["invoice", "email", "--id", id]);
  await ok(dir, ["invoice", "reminder", "--id", id, "--as-of", "2027-01-15"]);
  expect((await ok(dir, ["invoice", "get", "--id", id])).invoice).toMatchObject({ status: "issued", sent_at: null });

  const sent = (await ok(dir, ["invoice", "sent", "--id", id, "--source", "agent:claude-code"])).invoice;
  expect(sent).toMatchObject({ status: "sent", sent_at: "2026-10-22T12:00:00.000Z" });
  const history = (await ok(dir, ["history", "list"])).history.at(-1);
  expect(history).toMatchObject({ op: "invoice_sent", source: "agent:claude-code" });

  const twice = await cli(dir, ["invoice", "sent", "--id", id, ...S]);
  expect(twice.out).toEqual({ reason: "Invoice 7001 is already sent.", field: "id" });
});

test("ISC-38 draft free: draft invoices can be edited and deleted freely", async () => {
  const dir = await acmeBooks();
  const d = await draftOctober(dir);
  const id = String(d.id);

  const edited = (
    await ok(dir, json(["invoice", "edit"], {
      id: d.id,
      terms_days: 15,
      note: "Thanks",
      remove_lines: [{ line_id: d.lines[1].id }],
      add_lines: [{ description: "Rush fee", amount_cents: 7500 }],
    }))
  ).invoice;
  expect(edited).toMatchObject({ status: "draft", number: null, terms_days: 15, note: "Thanks" });
  expect(edited.lines.map((l: any) => l.description)).toEqual([
    "2026-10-03 API design (37 min at $150.00/hr)",
    "Build: Spec",
    "Build, October 2026",
    "2026-10-05 Print shop, Workshop handouts (pass-through cost)",
    "Rush fee",
  ]);
  expect(edited.subtotal_cents).toBe(d.subtotal_cents - 22500 + 7500);
  // The removed time entry is unbilled again.
  const redraft = (await ok(dir, ["invoice", "draft", ...OCTOBER, ...S])).invoice;
  expect(redraft.lines.map((l: any) => l.time_entry_id)).toEqual([2]);
  await ok(dir, ["invoice", "delete", "--id", String(redraft.id), ...S]);

  // Delete the draft: it is gone, and everything on it can be drafted again with no number used up.
  expect((await ok(dir, ["invoice", "delete", "--id", id, ...S])).deleted.invoice.id).toBe(d.id);
  expect((await ok(dir, ["invoice", "list"])).invoices).toEqual([]);
  const fresh = await draftOctober(dir);
  expect(kinds(fresh)).toEqual(kinds(d));
  expect((await ok(dir, ["invoice", "issue", "--id", String(fresh.id), ...S])).invoice.number).toBe("7001");

  // Once issued, the same edits are refused.
  const locked = await cli(dir, json(["invoice", "edit"], { id: fresh.id, terms_days: 5 }));
  expect(locked.code).toBe(2);
  expect(locked.out).toEqual({ reason: "Invoice 7001 is issued, so it can't be edited; void or credit it instead.", field: "id" });
});

test("issue checks: issuing needs every standard field, and says which one is missing", async () => {
  const dir = await acmeBooks({ address: undefined });
  const d = await draftOctober(dir);
  const r = await cli(dir, ["invoice", "issue", "--id", String(d.id), ...S]);
  expect(r.out).toEqual({ reason: "Set client 1's billing address with client edit before issuing an invoice.", field: "address" });
});
