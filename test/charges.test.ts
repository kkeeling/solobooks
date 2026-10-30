import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { acmeBooks, cli, draftOctober, issueOctober, json, ok, S } from "./support/billing.ts";
import { acct, dbPath } from "./support/books.ts";
import { RECEIPT } from "./support/scenario.ts";

// acmeBooks: Acme (client 1) with October time, a milestone, a monthly fee, and two pass-through expenses recorded
// with pass_through_client_id: expense 1, $42.00 on Oct 5 (charge 1), and expense 2, $9.99 on Nov 5 (charge 2).

const USAGE = { client_id: 1, date: "2026-10-31", amount_cents: 4812, line_text: "OpenAI API usage, Oct 2026" };
const charge = (dir: string, body: Record<string, unknown>) => cli(dir, json(["charge", "add"], body));
const addExpense = (dir: string, body: Record<string, unknown> = {}) =>
  ok(dir, json(["expense", "add"], { date: "2026-10-01", amount_cents: 10000, vendor: "OpenAI", account_id: acct(2), paid_from_account_id: acct(1), ...body }));

test("ISC-119 standalone: a charge carries client, date, amount, line text and source, and needs no expense", async () => {
  const dir = await acmeBooks();
  const r = await charge(dir, USAGE);
  expect(r.code).toBe(0);
  expect(r.out.charge).toEqual({
    id: 3, ...USAGE, reference: null, expense_id: null, evidence: null, status: "waiting", invoice: null, source: "agent:test",
  });
  // Each of the five is required.
  for (const field of ["client_id", "date", "amount_cents", "line_text"]) {
    const { [field]: _, ...rest } = USAGE as Record<string, unknown>;
    expect((await charge(dir, rest)).out).toEqual({ reason: `${field} is required.`, field });
  }
  expect((await cli(dir, ["charge", "add", "--json", JSON.stringify(USAGE)])).out.field).toBe("source");
});

test("ISC-121 split: one expense carries charges to several clients", async () => {
  const dir = await acmeBooks();
  await ok(dir, json(["client", "add"], { name: "ETR" }));
  const { expense } = await addExpense(dir);
  expect((await charge(dir, { ...USAGE, amount_cents: 6000, expense_id: expense.id })).code).toBe(0);
  expect((await charge(dir, { ...USAGE, client_id: 2, amount_cents: 4000, expense_id: expense.id })).code).toBe(0);
  const [e] = (await ok(dir, ["expense", "list", "--vendor", "openai"])).expenses;
  expect(e.charges.map((c: any) => [c.client_id, c.amount_cents])).toEqual([[1, 6000], [2, 4000]]);
  expect(e.not_yet_charged_cents).toBe(0);
});

test("ISC-122 after the fact: a charge added to an earlier expense leaves the expense row and its ledger entry unchanged", async () => {
  const dir = await acmeBooks();
  const { expense } = await addExpense(dir);
  const snapshot = () => {
    const db = new Database(dbPath(dir), { readonly: true });
    const rows = {
      expense: db.query("SELECT * FROM expenses WHERE id = ?").get(expense.id),
      entry: db.query("SELECT * FROM entries WHERE id = ?").get(expense.entry_id),
      lines: db.query("SELECT * FROM lines WHERE entry_id = ? ORDER BY id").all(expense.entry_id),
      entries: db.query("SELECT COUNT(*) AS n FROM entries").get(),
    };
    db.close();
    return rows;
  };
  const before = snapshot();
  expect((await charge(dir, { ...USAGE, date: "2026-10-20", amount_cents: 2500, expense_id: expense.id })).code).toBe(0);
  expect(snapshot()).toEqual(before); // and no new ledger entry either: a charge posts nothing until it is invoiced
});

test("ISC-123 next draft: the next draft bills every waiting charge dated by its period end, reading exactly its line text", async () => {
  const dir = await acmeBooks();
  await charge(dir, USAGE);
  await charge(dir, { ...USAGE, date: "2026-09-30", amount_cents: 3100, line_text: "OpenAI API usage, Sep 2026" }); // late-recorded
  await charge(dir, { ...USAGE, date: "2026-11-30", line_text: "OpenAI API usage, Nov 2026" });
  const d = await draftOctober(dir);
  const pass = d.lines.filter((l: any) => l.kind === "pass_through").map((l: any) => [l.description, l.amount_cents]);
  expect(pass).toEqual([
    ["OpenAI API usage, Sep 2026", 3100],
    ["2026-10-05 Print shop, Workshop handouts (pass-through cost)", 4200],
    ["OpenAI API usage, Oct 2026", 4812],
  ]);
  const listed = (await ok(dir, ["charge", "list", "--client-id", "1"])).charges.map((c: any) => [c.line_text, c.status]);
  expect(listed.filter(([, s]: any) => s === "waiting").map(([t]: any) => t)).toEqual([
    "2026-11-05 Courier (pass-through cost)",
    "OpenAI API usage, Nov 2026",
  ]);
});

test("ISC-124 at cost: a charge has no markup or rate field, and its line equals its amount to the cent", async () => {
  const db = new Database(dbPath(await acmeBooks()), { readonly: true });
  const columns = (db.query("PRAGMA table_info(charges)").all() as { name: string }[]).map((c) => c.name);
  db.close();
  expect(columns.filter((c) => /markup|rate|percent|margin|fee/i.test(c))).toEqual([]);
  const dir = await acmeBooks();
  expect((await charge(dir, { ...USAGE, markup_ppm: 100000 })).out.field).toBe("markup_ppm");
  await charge(dir, { ...USAGE, amount_cents: 1 });
  await charge(dir, { ...USAGE, amount_cents: 123457, reference: "big" });
  const lines = (await draftOctober(dir)).lines.filter((l: any) => l.kind === "pass_through").map((l: any) => l.amount_cents);
  expect(lines).toEqual([4200, 1, 123457]);
});

test("ISC-125 reimbursed: a billed charge posts to Reimbursed expense income and is taxed only when pass-through is listed", async () => {
  for (const kinds of [["time", "fixed", "recurring"], ["time", "fixed", "recurring", "pass_through"]]) {
    const dir = await acmeBooks({ tax_rate_ppm: 62500, tax_label: "IL sales tax", tax_applies_to: kinds });
    await charge(dir, USAGE);
    const d = await draftOctober(dir);
    const services = 9250 + 22500 + 250000 + 50000;
    expect(d.tax.taxable_cents).toBe(kinds.includes("pass_through") ? services + 4200 + 4812 : services);
    await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S]);
    const reimbursed = (await ok(dir, ["account", "list"])).accounts.find((a: any) => a.name === "Reimbursed expense income").id;
    const posted = (await ok(dir, ["entry", "list"])).entries.at(-1);
    expect(posted.lines).toContainEqual({ account_id: reimbursed, debit_cents: 0, credit_cents: 4200 + 4812 });
  }
});

test("ISC-126 reference: a second charge with the same reference for the same client is refused", async () => {
  const dir = await acmeBooks();
  await ok(dir, json(["client", "add"], { name: "ETR" }));
  const ref = { ...USAGE, reference: "openai:etr-key:2026-10" };
  expect((await charge(dir, ref)).code).toBe(0);
  const again = await charge(dir, { ...ref, amount_cents: 1 });
  expect(again.code).toBe(2);
  expect(again.out).toEqual({ reason: 'Charge 3 already bills reference "openai:etr-key:2026-10" to this client, so this would bill it twice.', field: "reference" });
  expect((await charge(dir, { ...ref, client_id: 2 })).code).toBe(0); // another client's reference is its own
  const other = (await charge(dir, { ...USAGE, reference: "other" })).out.charge;
  expect((await cli(dir, json(["charge", "edit"], { id: other.id, reference: "openai:etr-key:2026-10" }))).out.field).toBe("reference");
  expect((await ok(dir, ["charge", "list", "--client-id", "1"])).charges).toHaveLength(4);
});

test("ISC-127 evidence: a charge carries an optional evidence file, copied into the books folder", async () => {
  const dir = await acmeBooks();
  const original = readFileSync(RECEIPT);
  const sha = new Bun.CryptoHasher("sha256").update(original).digest("hex");
  const { out } = await charge(dir, { ...USAGE, evidence_path: RECEIPT });
  expect(out.charge.evidence).toEqual({ file: `evidence/${sha}.png`, sha256: sha, bytes: original.length });
  expect(readFileSync(join(dir, out.charge.evidence.file)).equals(original)).toBe(true);
  const missing = await charge(dir, { ...USAGE, reference: "x", evidence_path: join(dir, "nope.csv") });
  expect(missing.out).toEqual({ reason: "There is no readable file at evidence_path.", field: "evidence_path" });
  expect((await ok(dir, ["charge", "list"])).charges).toHaveLength(3);
});

test("ISC-128 locked: waiting charges change freely; a charge on an issued invoice is refused with a reason", async () => {
  const dir = await acmeBooks();
  const c = (await charge(dir, USAGE)).out.charge;
  const edited = (await ok(dir, json(["charge", "edit"], { id: c.id, amount_cents: 5000, line_text: "OpenAI API usage, October" }))).charge;
  expect([edited.amount_cents, edited.line_text]).toEqual([5000, "OpenAI API usage, October"]);
  const gone = (await charge(dir, { ...USAGE, reference: "throwaway" })).out.charge;
  expect((await ok(dir, ["charge", "delete", "--id", String(gone.id), ...S])).deleted.charge.id).toBe(gone.id);

  // On a draft it is still free, and the draft follows.
  const d = await draftOctober(dir);
  await ok(dir, json(["charge", "edit"], { id: c.id, amount_cents: 5100 }));
  const line = (await ok(dir, ["invoice", "get", "--id", String(d.id)])).invoice.lines.find((l: any) => l.description === "OpenAI API usage, October");
  expect(line.amount_cents).toBe(5100);

  await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S]);
  const reason = "Charge 3 is billed on issued invoice 7001, so it can't change; void or credit that invoice instead.";
  expect((await cli(dir, json(["charge", "edit"], { id: c.id, amount_cents: 1 }))).out).toEqual({ reason, field: "id" });
  expect((await cli(dir, ["charge", "delete", "--id", String(c.id), ...S])).out).toEqual({ reason, field: "id" });
  // The database holds the line even past the core's refusal.
  const db = new Database(dbPath(dir));
  expect(() => db.exec(`UPDATE charges SET amount_cents = 1 WHERE id = ${c.id}`)).toThrow(/locked/);
  expect(() => db.exec(`DELETE FROM charges WHERE id = ${c.id}`)).toThrow(/locked/);
  db.close();
});

test("ISC-128 draft follows: a client change, or a date past the draft's period, drops the line; a delete drops it too", async () => {
  const dir = await acmeBooks();
  await ok(dir, json(["client", "add"], { name: "ETR" }));
  const a = (await charge(dir, USAGE)).out.charge;
  const b = (await charge(dir, { ...USAGE, reference: "b" })).out.charge;
  const c = (await charge(dir, { ...USAGE, reference: "c" })).out.charge;
  const d = await draftOctober(dir);
  const usage = async () =>
    (await ok(dir, ["invoice", "get", "--id", String(d.id)])).invoice.lines.filter((l: any) => l.description === USAGE.line_text).length;
  expect(await usage()).toBe(3);
  expect((await ok(dir, json(["charge", "edit"], { id: a.id, client_id: 2 }))).charge.status).toBe("waiting");
  expect((await ok(dir, json(["charge", "edit"], { id: b.id, date: "2026-11-30" }))).charge.status).toBe("waiting");
  expect(await usage()).toBe(1);
  await ok(dir, ["charge", "delete", "--id", String(c.id), ...S]);
  expect(await usage()).toBe(0);
});

test("ISC-128 clearing: an edit can drop a charge's expense link or its reference", async () => {
  const dir = await acmeBooks();
  const { expense } = await addExpense(dir);
  const c = (await charge(dir, { ...USAGE, reference: "openai:oct", expense_id: expense.id })).out.charge;
  const both = await cli(dir, json(["charge", "edit"], { id: c.id, expense_id: expense.id, unlink_expense: true }));
  expect(both.out.field).toBe("unlink_expense");
  const cleared = (await ok(dir, json(["charge", "edit"], { id: c.id, unlink_expense: true, clear_reference: true }))).charge;
  expect([cleared.expense_id, cleared.reference]).toEqual([null, null]);
  expect((await ok(dir, ["expense", "list", "--vendor", "openai"])).expenses[0].not_yet_charged_cents).toBe(10000);
  expect((await charge(dir, { ...USAGE, reference: "openai:oct" })).code).toBe(0); // the reference is free again
});

test("ISC-129 void: voiding an invoice returns its charges to waiting, to be billed again", async () => {
  const dir = await acmeBooks();
  await charge(dir, USAGE);
  const inv = await issueOctober(dir);
  const statuses = async () => (await ok(dir, ["charge", "list", "--client-id", "1"])).charges.map((c: any) => [c.id, c.status]);
  expect(await statuses()).toEqual([[1, "billed"], [3, "billed"], [2, "waiting"]]); // by date
  await ok(dir, ["invoice", "void", "--id", String(inv.id), "--reason", "redo", ...S]);
  expect(await statuses()).toEqual([[1, "waiting"], [3, "waiting"], [2, "waiting"]]);
  const again = (await draftOctober(dir)).lines.filter((l: any) => l.kind === "pass_through").map((l: any) => l.amount_cents);
  expect(again).toEqual([4200, 4812]);
});

test("ISC-129 wrong charge: a charge on a voided invoice can be deleted, and the voided invoice keeps its line", async () => {
  const dir = await acmeBooks();
  const c = (await charge(dir, { ...USAGE, reference: "openai:oct" })).out.charge;
  const inv = await issueOctober(dir);
  await ok(dir, ["invoice", "void", "--id", String(inv.id), "--reason", "wrong client", ...S]);
  expect((await ok(dir, ["charge", "delete", "--id", String(c.id), ...S])).deleted.charge.id).toBe(c.id);
  expect((await ok(dir, ["charge", "list"])).charges.map((x: any) => x.id)).toEqual([1, 2]);
  expect((await cli(dir, json(["charge", "edit"], { id: c.id, amount_cents: 1 }))).code).toBe(2);
  const voided = (await ok(dir, ["invoice", "get", "--id", String(inv.id)])).invoice.lines.map((l: any) => l.description);
  expect(voided).toContain(USAGE.line_text);
  const again = (await draftOctober(dir)).lines.filter((l: any) => l.kind === "pass_through").map((l: any) => l.amount_cents);
  expect(again).toEqual([4200]);
  expect((await charge(dir, { ...USAGE, reference: "openai:oct" })).code).toBe(0); // its reference can be billed afresh
});

test("ISC-130 unbilled list: every charge not yet billed, by client, with each client's total", async () => {
  const dir = await acmeBooks();
  await ok(dir, json(["client", "add"], { name: "ETR" }));
  await charge(dir, USAGE);
  await charge(dir, { ...USAGE, client_id: 2, amount_cents: 700 });
  await charge(dir, { ...USAGE, client_id: 2, amount_cents: 300, date: "2026-11-30" });
  await issueOctober(dir); // bills Acme's $42.00 and $48.12; the November $9.99 still waits
  const r = await ok(dir, ["charge", "list", "--unbilled", "true"]);
  expect(r.charges.map((c: any) => [c.client_id, c.amount_cents, c.status])).toEqual([[2, 700, "waiting"], [1, 999, "waiting"], [2, 300, "waiting"]]);
  expect(r.unbilled_by_client).toEqual([{ client_id: 1, count: 1, total_cents: 999 }, { client_id: 2, count: 2, total_cents: 1000 }]);
});

test("ISC-132 on record: naming a client when recording an expense records one charge for its full amount", async () => {
  const dir = await acmeBooks();
  const charges = (await ok(dir, ["charge", "list"])).charges;
  expect(charges.map((c: any) => [c.client_id, c.expense_id, c.amount_cents, c.line_text])).toEqual([
    [1, 1, 4200, "2026-10-05 Print shop, Workshop handouts (pass-through cost)"],
    [1, 2, 999, "2026-11-05 Courier (pass-through cost)"],
  ]);
});

test("ISC-133 no billing choice: an expense recorded with no client is recorded with no charge", async () => {
  const dir = await acmeBooks();
  const { expense } = await addExpense(dir);
  expect(expense.charges).toEqual([]);
  expect(expense.not_yet_charged_cents).toBe(10000);
  expect((await ok(dir, ["charge", "list", "--expense-id", String(expense.id)])).charges).toEqual([]);
  // And the field that would force a choice is optional: the ops' own field list says so.
  const { OPS } = await import("../src/core/perform.ts");
  const fields = OPS.find((o) => o.name === "expense_add")!.fields as Record<string, { required?: boolean }>;
  expect(Object.entries(fields).filter(([k, f]) => f.required && /client|charge|bill/.test(k))).toEqual([]);
});
