import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { openBooks } from "../src/core/db.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";
import { dbPath, tempDir } from "./support/books.ts";

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
