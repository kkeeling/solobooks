import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { openBooks } from "../src/core/db.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";
import { dbPath, dumpDb, tempDir } from "./support/books.ts";
import { buildFixture } from "../scripts/compat-fixtures.ts";
import { perform } from "../src/core/perform.ts";

test("migrations: books saved before the payment gate open with every gate level and pending action kept, still locked", () => {
  const path = dbPath(tempDir());
  const old = new Database(path, { create: true, strict: true });
  for (const [v, sql] of MIGRATIONS.slice(0, 5).entries()) {
    old.exec(sql);
    old.exec(`PRAGMA user_version = ${v + 1}`);
  }
  old.exec("INSERT INTO gate_levels (action, level, source) VALUES ('invoice_issue', 'passkey', 'person:page')");
  old.exec(`INSERT INTO pending_actions (id, created_at, action, op, input, level, prompt, source) VALUES
    (7, '2026-10-01T00:00:00Z', 'invoice_void', 'invoice_void', '{"id":1}', 'click', '{"title":"t","items":[]}', 'agent:old')`);
  old.close();

  const db = openBooks(path);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
  expect(db.query("SELECT action, level, source FROM gate_levels").all()).toEqual([{ action: "invoice_issue", level: "passkey", source: "person:page" }]);
  expect(db.query("SELECT id, action, status, source FROM pending_actions").all()).toEqual([{ id: 7, action: "invoice_void", status: "pending", source: "agent:old" }]);
  // The rules came back with the rebuilt tables, and the new action is allowed.
  expect(() => db.exec("DELETE FROM pending_actions")).toThrow(/kept/);
  expect(() => db.exec("UPDATE pending_actions SET input = '{}'")).toThrow(/never changes/);
  db.exec("INSERT INTO gate_levels (action, level, source) VALUES ('payment_unmatched', 'agent_decides', 'person:page')");
  // Ids keep counting up from the old ones.
  db.exec(`INSERT INTO pending_actions (created_at, action, op, input, level, prompt, source) VALUES ('t', 'payment_unmatched', 'payment_add', '{}', 'click', '{}', 's')`);
  expect(db.query("SELECT MAX(id) AS n FROM pending_actions").get()).toEqual({ n: 8 });
  db.close();
});

test("migrations: books saved before partial refunds and applied credits open with every refund and credit kept, still locked", () => {
  const path = dbPath(tempDir());
  const old = new Database(path, { create: true, strict: true });
  old.exec("PRAGMA foreign_keys = ON");
  for (const [v, sql] of MIGRATIONS.slice(0, 9).entries()) {
    old.exec(sql);
    old.exec(`PRAGMA user_version = ${v + 1}`);
  }
  // One overpaid invoice, refunded in full the old way.
  old.exec(`
    INSERT INTO clients (id, name, source) VALUES (1, 'Beta LLC', 'agent:old');
    INSERT INTO accounts (id, name, type, source) VALUES (1, 'Checking', 'asset', 'agent:old'), (2, 'Accounts receivable', 'asset', 'agent:old');
    INSERT INTO entries (id, date, memo, source) VALUES (1, '2026-10-20', 'Payment', 'agent:old'), (2, '2026-10-21', 'Refund', 'agent:old');
    INSERT INTO invoices (id, kind, status, client_id, number, period_start, period_end, terms_days, invoice_date, issued_at, seller_legal_name, created_at, source)
      VALUES (1, 'invoice', 'issued', 1, 7001, '2026-10-01', '2026-10-31', 30, '2026-10-01', '2026-10-01', 'Jane Doe LLC', '2026-10-01', 'agent:old');
    INSERT INTO payments (id, invoice_id, date, amount_cents, fee_cents, deposit_account_id, applied_cents, credit_cents, entry_id, source)
      VALUES (1, 1, '2026-10-20', 120000, 3000, 1, 100000, 20000, 1, 'agent:old');
    INSERT INTO refunds (id, payment_id, date, reason, entry_id, source) VALUES (1, 1, '2026-10-21', 'Cancelled', 2, 'agent:old');
    INSERT INTO client_credits (id, client_id, date, amount_cents, payment_id, refund_id, source)
      VALUES (1, 1, '2026-10-20', 20000, 1, NULL, 'agent:old'), (2, 1, '2026-10-21', -20000, 1, 1, 'agent:old');
  `);
  old.close();

  const db = openBooks(path);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  // The old refund was a full one that also reversed the fee, so it says so.
  expect(db.query("SELECT * FROM refunds").all()).toEqual([
    { id: 1, payment_id: 1, date: "2026-10-21", reason: "Cancelled", amount_cents: 120000, fee_returned_cents: 3000, applied_cents: 100000, credit_cents: 20000, entry_id: 2, source: "agent:old" },
  ]);
  expect(db.query("SELECT id, amount_cents, payment_id, refund_id, application_id FROM client_credits ORDER BY id").all()).toEqual([
    { id: 1, amount_cents: 20000, payment_id: 1, refund_id: null, application_id: null },
    { id: 2, amount_cents: -20000, payment_id: 1, refund_id: 1, application_id: null },
  ]);

  // The rules came back with the rebuilt tables, and a balance never goes below zero.
  for (const t of ["refunds", "client_credits"]) {
    expect(() => db.exec(`DELETE FROM ${t}`)).toThrow(/never change/);
    expect(() => db.exec(`UPDATE ${t} SET source = 'x'`)).toThrow(/never change/);
  }
  expect(() => db.exec("INSERT INTO client_credits (client_id, date, amount_cents, payment_id, refund_id, source) VALUES (1, 'd', -1, 1, 1, 's')")).toThrow(/below zero/);
  // A payment can now be refunded more than once.
  db.exec("INSERT INTO entries (id, date, memo, source) VALUES (3, '2026-10-23', 'Refund', 's')");
  db.exec("INSERT INTO refunds (payment_id, date, reason, amount_cents, fee_returned_cents, applied_cents, credit_cents, entry_id, source) VALUES (1, 'd', 'r', 1, 0, 1, 0, 3, 's')");
  expect(db.query("SELECT COUNT(*) AS n FROM refunds WHERE payment_id = 1").get()).toEqual({ n: 2 });
  db.close();
});

test("migrations: books saved before bank unmatch open with every match kept and still locked, and a line can be matched again once undone", () => {
  const path = dbPath(tempDir());
  const old = new Database(path, { create: true, strict: true });
  old.exec("PRAGMA foreign_keys = ON");
  for (const [v, sql] of MIGRATIONS.slice(0, 10).entries()) {
    old.exec(sql);
    old.exec(`PRAGMA user_version = ${v + 1}`);
  }
  old.exec(`
    INSERT INTO accounts (id, name, type, source) VALUES (1, 'Checking', 'asset', 'agent:old'), (2, 'Printing', 'expense', 'agent:old');
    INSERT INTO entries (id, date, memo, source) VALUES (1, '2026-10-05', 'Print shop', 'agent:old');
    INSERT INTO lines (entry_id, account_id, debit_cents, credit_cents, source) VALUES (1, 2, 4200, 0, 'agent:old'), (1, 1, 0, 4200, 'agent:old');
    INSERT INTO bank_imports (id, account_id, file_name, file_sha256, stored_file, row_count, new_lines, imported_at, source)
      VALUES (1, 1, 'oct.csv', 'abc', 'statements/abc.csv', 1, 1, '2026-10-22', 'agent:old');
    INSERT INTO bank_lines (id, import_id, account_id, file_row, date, description, amount_cents, source)
      VALUES (1, 1, 1, 2, '2026-10-05', 'PRINT SHOP', -4200, 'agent:old');
    INSERT INTO bank_matches (id, line_id, entry_id, account_id, kind, matched_at, source) VALUES (1, 1, 1, 1, 'exact', '2026-10-22', 'agent:old');
  `);
  old.close();

  const db = openBooks(path);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query("SELECT * FROM bank_matches").all()).toEqual([
    { id: 1, line_id: 1, entry_id: 1, account_id: 1, kind: "exact", matched_at: "2026-10-22", source: "agent:old" },
  ]);
  expect(db.query("SELECT id FROM live_bank_matches").all()).toEqual([{ id: 1 }]);
  expect(() => db.exec("DELETE FROM bank_matches")).toThrow(/kept/);
  expect(() => db.exec("UPDATE bank_matches SET source = 'x'")).toThrow(/kept/);
  // A standing match can't be doubled; once undone, the line can be matched again, and both rows stay.
  const rematch = "INSERT INTO bank_matches (line_id, entry_id, account_id, kind, matched_at, source) VALUES (1, 1, 1, 'agent', 'd', 's')";
  expect(() => db.exec(rematch)).toThrow(/at most one match/);
  db.exec("INSERT INTO bank_unmatches (match_id, reason, unmatched_at, source) VALUES (1, 'Wrong', 'd', 's')");
  expect(() => db.exec("INSERT INTO bank_unmatches (match_id, reason, unmatched_at, source) VALUES (1, 'Again', 'd', 's')")).toThrow();
  expect(() => db.exec("DELETE FROM bank_unmatches")).toThrow(/kept/);
  db.exec(rematch);
  expect(db.query("SELECT id FROM bank_matches ORDER BY id").all()).toEqual([{ id: 1 }, { id: 2 }]);
  expect(db.query("SELECT id FROM live_bank_matches").all()).toEqual([{ id: 2 }]);
  db.close();
});

test("migrations: books saved before the Schedule C chart get it, keeping every account, id and posting they had", () => {
  const path = dbPath(tempDir());
  const old = new Database(path, { create: true, strict: true });
  const before = 12; // everything up to the chart, which is migration 13
  for (const [v, sql] of MIGRATIONS.slice(0, before).entries()) {
    old.exec(sql);
    old.exec(`PRAGMA user_version = ${v + 1}`);
  }
  old.exec(`INSERT INTO accounts (id, name, type, source) VALUES
    (1, 'Checking', 'asset', 'agent:old'), (2, 'supplies', 'expense', 'agent:old'), (3, 'Travel', 'asset', 'agent:old'),
    (4, 'Software', 'expense', 'agent:old'), (5, 'Consulting income', 'income', 'agent:old')`);
  old.exec("INSERT INTO entries (id, date, memo, source) VALUES (1, '2026-01-02', 'Pens', 'agent:old')");
  old.exec("INSERT INTO lines (entry_id, account_id, debit_cents, source) VALUES (1, 2, 500, 'agent:old')");
  old.exec("INSERT INTO lines (entry_id, account_id, credit_cents, source) VALUES (1, 1, 500, 'agent:old')");
  old.close();

  const db = openBooks(path);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
  // The old accounts keep their ids and sources. One of the same name and type gets its line; any other is left alone.
  expect(db.query("SELECT id, name, type, schedule_c, source FROM accounts WHERE id <= 5 ORDER BY id").all()).toEqual([
    { id: 1, name: "Checking", type: "asset", schedule_c: null, source: "agent:old" },
    { id: 2, name: "supplies", type: "expense", schedule_c: "22", source: "agent:old" },
    { id: 3, name: "Travel", type: "asset", schedule_c: null, source: "agent:old" },
    { id: 4, name: "Software", type: "expense", schedule_c: null, source: "agent:old" },
    { id: 5, name: "Consulting income", type: "income", schedule_c: "1", source: "agent:old" },
  ]);
  // The rest of the chart arrives after them, each on its line, with no second account for a name already taken.
  const added = db.query("SELECT name, type, schedule_c FROM accounts WHERE id > 5 ORDER BY id").all() as { name: string; type: string; schedule_c: string }[];
  expect(added.every((a) => a.schedule_c !== null)).toBe(true);
  expect(added.map((a) => a.name)).not.toContain("Travel");
  expect(added.map((a) => a.name.toLowerCase())).not.toContain("supplies");
  expect(added).toContainEqual({ name: "Office expense", type: "expense", schedule_c: "18" });
  expect(db.query("SELECT COUNT(*) AS n FROM lines").get()).toEqual({ n: 2 });
  db.close();
});

test("migrations: new books, in memory or in a new file, are exactly books migrated from nothing, and never share state", () => {
  const slow = new Database(":memory:", { strict: true });
  slow.exec("PRAGMA foreign_keys = ON");
  for (const [v, sql] of MIGRATIONS.entries()) {
    slow.exec(sql);
    slow.exec(`PRAGMA user_version = ${v + 1}`);
  }
  const schema = (db: Database) => db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
  const want = { version: slow.query("PRAGMA user_version").get(), schema: schema(slow), rows: dumpDb(slow) };
  slow.close();

  const path = dbPath(tempDir());
  for (const db of [openBooks(":memory:"), openBooks(path)]) {
    expect({ version: db.query("PRAGMA user_version").get(), schema: schema(db), rows: dumpDb(db) }).toEqual(want);
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.exec("INSERT INTO clients (name, source) VALUES ('Acme', 'test')");
    db.close();
  }
  // What one books file wrote is in it alone: the next new books start empty again, and the file kept its client.
  const again = openBooks(":memory:");
  expect(again.query("SELECT COUNT(*) AS n FROM clients").get()).toEqual({ n: 0 });
  again.close();
  const file = new Database(path, { readonly: true });
  expect(file.query("SELECT name FROM clients").all()).toEqual([{ name: "Acme" }]);
  expect(file.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
  file.close();
});

test("ISC-134 pass-through to charges: books from an earlier release open with each pass-through cost as one charge, keeping its invoice link", () => {
  // The v13 fixture: expense 1 ($42.00, Print shop) billed on to Acme, on issued invoice 1001. Added here: expense 4
  // billed on to Acme on an invoice since voided, and expense 5 billed on to Beta on its January draft.
  const path = dbPath(tempDir());
  const old = buildFixture(13);
  const supplies = "(SELECT id FROM accounts WHERE name = 'Supplies')";
  for (const sql of [
    `INSERT INTO entries (id, date, memo, source) VALUES (40, '2026-03-01', 'Courier', 'agent:fixture'), (41, '2026-01-12', 'Binding', 'agent:fixture')`,
    `INSERT INTO lines (entry_id, account_id, debit_cents, credit_cents, source) VALUES
       (40, ${supplies}, 1500, 0, 'agent:fixture'), (40, 1, 0, 1500, 'agent:fixture'), (41, ${supplies}, 2599, 0, 'agent:fixture'), (41, 1, 0, 2599, 'agent:fixture')`,
    `INSERT INTO expenses (id, date, amount_cents, vendor, memo, account_id, paid_from_account_id, entry_id, pass_through_client_id, source) VALUES
       (4, '2026-03-01', 1500, 'Courier', NULL, ${supplies}, 1, 40, 1, 'agent:fixture'), (5, '2026-01-12', 2599, 'Binding', 'Spec copies', ${supplies}, 1, 41, 2, 'agent:fixture')`,
    `INSERT INTO invoice_lines (invoice_id, kind, description, amount_cents, expense_id, source) VALUES (2, 'pass_through', 'Binding', 2599, 5, 'agent:fixture')`,
    `INSERT INTO invoices (id, kind, status, client_id, period_start, period_end, terms_days, created_at, source)
       VALUES (9, 'invoice', 'draft', 1, '2026-03-01', '2026-03-31', 15, '2026-03-31T10:00:00.000Z', 'agent:fixture')`,
    `INSERT INTO invoice_lines (invoice_id, kind, description, amount_cents, expense_id, source) VALUES (9, 'pass_through', 'Courier', 1500, 4, 'agent:fixture')`,
    `UPDATE invoices SET status = 'issued', number = 1009, invoice_date = '2026-03-31', issued_at = '2026-03-31T10:05:00.000Z', seller_legal_name = 'Jane Doe Consulting LLC' WHERE id = 9`,
    `UPDATE invoices SET status = 'void', voided_at = '2026-04-01T09:00:00.000Z', void_reason = 'wrong client' WHERE id = 9`,
  ]) old.run(sql);
  old.query("VACUUM INTO ?").run(path);
  old.close();

  const db = openBooks(path);
  expect(db.query("SELECT id, client_id, date, amount_cents, line_text, reference, expense_id, source FROM charges").all()).toEqual([
    { id: 1, client_id: 1, date: "2026-01-09", amount_cents: 4200, line_text: "2026-01-09 Print shop, Workshop handouts (pass-through cost)", reference: null, expense_id: 1, source: "agent:fixture" },
    { id: 2, client_id: 1, date: "2026-03-01", amount_cents: 1500, line_text: "2026-03-01 Courier (pass-through cost)", reference: null, expense_id: 4, source: "agent:fixture" },
    { id: 3, client_id: 2, date: "2026-01-12", amount_cents: 2599, line_text: "2026-01-12 Binding, Spec copies (pass-through cost)", reference: null, expense_id: 5, source: "agent:fixture" },
  ]);
  // Issued, voided and draft lines alike now name their charge, so each reads as billed, waiting or on its draft.
  expect(db.query("SELECT invoice_id, kind, expense_id, charge_id FROM invoice_lines WHERE kind = 'pass_through' ORDER BY id").all()).toEqual([
    { invoice_id: 1, kind: "pass_through", expense_id: 1, charge_id: 1 },
    { invoice_id: 2, kind: "pass_through", expense_id: 5, charge_id: 3 },
    { invoice_id: 9, kind: "pass_through", expense_id: 4, charge_id: 2 },
  ]);
  const listed = perform(db, "charge_list", {}, { source: "test", now: "2026-10-29T12:00:00.000Z" });
  expect(listed.ok && (listed.result as any).charges.map((c: any) => [c.id, c.status, c.invoice?.number ?? null])).toEqual([
    [1, "billed", "1001"], [3, "on_draft", null], [2, "waiting", null], // by date
  ]);
  // The lock is back whole: an issued line can't change, and a draft line can't be moved onto an issued invoice.
  expect(() => db.exec("UPDATE invoice_lines SET charge_id = NULL WHERE invoice_id = 1 AND kind = 'pass_through'")).toThrow(/locked/);
  expect(() => db.exec("UPDATE invoice_lines SET invoice_id = 1 WHERE invoice_id = 2 AND kind = 'pass_through'")).toThrow(/locked/);
  const sql = (n: string) => (db.query("SELECT sql FROM sqlite_master WHERE name = ?").get(n) as { sql: string }).sql;
  expect(sql("invoice_lines_locked_update")).toContain("NEW.invoice_id");
  db.close();
});
