#!/usr/bin/env bun
// Writes test/fixtures/books/vNN.sqlite: books as each schema version of solobooks saved them, for the test that
// every later solobooks opens them (ISC-94). Fixture N is made by running the real migrations 1 to N, and after each
// migration v, DATA[v - 1]: what a consultant would have written with that version, using what it added. So the v12
// fixture holds a year of work begun at v1, carried through every upgrade since.
//
//   bun scripts/compat-fixtures.ts
//
// A new migration needs a new DATA block (can be empty, but should use what the migration adds), then run this to add
// its fixture. Earlier fixtures come out the same, and the compat test checks they still match this script.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS } from "../src/db/migrations.ts";

export const FIXTURES = join(import.meta.dir, "..", "test", "fixtures", "books");
export const fixtureFile = (version: number) => join(FIXTURES, `v${String(version).padStart(2, "0")}.sqlite`);

const S = "'agent:fixture'";
/** One history row, as each write leaves. */
const history = (at: string, op: string, key: string | null = null) =>
  `INSERT INTO history (at, op, source, idempotency_key, payload_hash, payload, result) VALUES ('${at}', '${op}', ${S}, ${key ? `'${key}'` : "NULL"}, '${new Bun.CryptoHasher("sha256").update(op + at).digest("hex")}', '{"op":"${op}"}', '{}');`;

/** What was written with each version, run right after its migration. Index 0 is version 1. */
export const DATA: readonly string[] = [
  // 001: accounts, entries, clients, engagements, milestones, time.
  `
  INSERT INTO accounts (id, name, type, source) VALUES
    (1, 'Checking', 'asset', ${S}), (2, 'Owner capital', 'equity', ${S}), (3, 'Software', 'expense', ${S}),
    (4, 'Accounts receivable', 'asset', ${S}), (5, 'Consulting income', 'income', ${S});
  INSERT INTO entries (id, date, memo, source) VALUES (1, '2026-01-02', 'Opening balance', ${S}), (2, '2026-01-05', 'Editor licence', ${S});
  INSERT INTO lines (entry_id, account_id, debit_cents, credit_cents, source) VALUES
    (1, 1, 1000000, 0, ${S}), (1, 2, 0, 1000000, ${S}), (2, 3, 1999, 0, ${S}), (2, 1, 0, 1999, ${S});
  INSERT INTO clients (id, name, increment_minutes, minimum_minutes, source) VALUES (1, 'Acme', 6, 0, ${S}), (2, 'Beta LLC', 1, 15, ${S});
  INSERT INTO engagements (id, client_id, name, rate_cents_per_hour, recurring_amount_cents, recurring_interval, source) VALUES
    (1, 1, 'Build', 15000, NULL, NULL, ${S}), (2, 2, 'Launch', NULL, NULL, NULL, ${S}), (3, 2, 'Retainer', NULL, 300000, 'monthly', ${S});
  INSERT INTO milestones (id, engagement_id, name, amount_cents, source) VALUES (1, 2, 'Spec', 250000, ${S}), (2, 2, 'Ship', 500000, ${S});
  INSERT INTO time_entries (id, client_id, engagement_id, date, minutes, note, source) VALUES
    (1, 1, 1, '2026-01-06', 37, 'API design', ${S}), (2, 1, 1, '2026-01-07', 90, 'Review', ${S}), (3, 2, NULL, '2026-01-08', 5, 'Call', ${S});
  ${history("2026-01-02T09:00:00.000Z", "entry_post")}
  ${history("2026-01-06T17:00:00.000Z", "time_add", "fixture-time-1")}
  `,
  // 002: the business profile, client billing details, an expense with a receipt, an invoice issued and sent, a draft.
  `
  INSERT INTO business_profile (id, legal_name, address, ein, email, payment_instructions, next_invoice_number, source) VALUES
    (1, 'Jane Doe Consulting LLC', '1 Main St
Springfield, IL 62701', '12-3456789', 'jane@example.com', 'ACH to First Bank, account 1234567', 1001, ${S});
  UPDATE clients SET address = '500 Market St
San Francisco, CA 94105', email = 'ap@acme.example', terms_days = 15, tax_rate_ppm = 62500, tax_label = 'IL sales tax' WHERE id = 1;
  UPDATE clients SET address = '9 Elm Rd
Austin, TX 78701', email = 'pay@beta.example' WHERE id = 2;
  UPDATE milestones SET billable_on = '2026-01-20' WHERE id = 1;
  INSERT INTO accounts (id, name, type, source) VALUES (6, 'Reimbursed expense income', 'income', ${S}), (7, 'Sales tax payable', 'liability', ${S});
  INSERT INTO entries (id, date, memo, source) VALUES (3, '2026-01-09', 'Print shop', ${S});
  INSERT INTO lines (entry_id, account_id, debit_cents, credit_cents, source) VALUES (3, 3, 4200, 0, ${S}), (3, 1, 0, 4200, ${S});
  INSERT INTO expenses (id, date, amount_cents, vendor, memo, account_id, paid_from_account_id, entry_id, pass_through_client_id, receipt_file, receipt_sha256, receipt_bytes, source)
    VALUES (1, '2026-01-09', 4200, 'Print shop', 'Workshop handouts', 3, 1, 3, 1, 'receipts/2b8f.png', '2b8f', 68, ${S});
  INSERT INTO invoices (id, kind, status, client_id, period_start, period_end, terms_days, created_at, source)
    VALUES (1, 'invoice', 'draft', 1, '2026-01-01', '2026-01-31', 15, '2026-01-31T10:00:00.000Z', ${S});
  INSERT INTO invoice_lines (invoice_id, kind, description, amount_cents, time_entry_id, engagement_id, expense_id, source) VALUES
    (1, 'time', 'API design (42 min)', 10500, 1, 1, NULL, ${S}),
    (1, 'time', 'Review (90 min)', 22500, 2, 1, NULL, ${S}),
    (1, 'pass_through', 'Print shop: Workshop handouts', 4200, NULL, NULL, 1, ${S});
  UPDATE invoices SET status = 'issued', number = 1001, invoice_date = '2026-01-31', due_date = '2026-02-15', tax_rate_ppm = 62500,
    tax_label = 'IL sales tax', seller_legal_name = 'Jane Doe Consulting LLC', seller_address = '1 Main St
Springfield, IL 62701', seller_ein = '12-3456789', seller_email = 'jane@example.com', payment_instructions = 'ACH to First Bank, account 1234567',
    client_name = 'Acme', client_address = '500 Market St
San Francisco, CA 94105', client_email = 'ap@acme.example', note = 'Thank you for your business', issued_at = '2026-01-31T10:05:00.000Z' WHERE id = 1;
  UPDATE business_profile SET next_invoice_number = 1002;
  INSERT INTO entries (id, date, memo, source) VALUES (4, '2026-01-31', 'Invoice 1001 for Acme', ${S});
  INSERT INTO lines (entry_id, account_id, debit_cents, credit_cents, source) VALUES
    (4, 4, 39525, 0, ${S}), (4, 5, 0, 33000, ${S}), (4, 6, 0, 4200, ${S}), (4, 7, 0, 2325, ${S});
  UPDATE invoices SET status = 'sent', sent_at = '2026-01-31T11:00:00.000Z' WHERE id = 1;
  INSERT INTO invoices (id, kind, status, client_id, period_start, period_end, terms_days, note, created_at, source)
    VALUES (2, 'invoice', 'draft', 2, '2026-01-01', '2026-01-31', 30, 'Spec and January retainer', '2026-01-31T10:10:00.000Z', ${S});
  INSERT INTO invoice_lines (invoice_id, kind, description, amount_cents, milestone_id, engagement_id, cycle_start, source) VALUES
    (2, 'fixed', 'Launch: Spec', 250000, 1, 2, NULL, ${S}), (2, 'recurring', 'Retainer, January', 300000, NULL, 3, '2026-01-01', ${S});
  ${history("2026-01-31T10:05:00.000Z", "invoice_issue")}
  `,
  // 003: which lines a client's tax covers, and each line's date.
  `
  UPDATE clients SET tax_applies_to = 'time,manual' WHERE id = 1;
  UPDATE invoice_lines SET item_date = '2026-01-20' WHERE invoice_id = 2 AND milestone_id = 1;
  UPDATE invoice_lines SET item_date = '2026-01-01' WHERE invoice_id = 2 AND cycle_start IS NOT NULL;
  INSERT INTO time_entries (id, client_id, engagement_id, date, minutes, note, source) VALUES (4, 1, 1, '2026-02-02', 120, 'Load testing', ${S});
  ${history("2026-02-02T17:00:00.000Z", "time_add")}
  `,
  // 004: gate levels, a passkey, a pending action and a decided one.
  `
  INSERT INTO gate_levels (action, level, source) VALUES ('invoice_void', 'passkey', 'person:page');
  INSERT INTO passkeys (id, credential_id, public_key, counter, transports, aaguid, created_at, source)
    VALUES (1, 'Zml4dHVyZS1jcmVk', X'A501020326200121582000112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF', 3, 'internal', NULL, '2026-02-03T09:00:00.000Z', 'person:page');
  INSERT INTO pending_actions (id, created_at, action, op, input, level, prompt, status, decided_at, decided_via, result, source) VALUES
    (1, '2026-02-03T09:05:00.000Z', 'gate_settings', 'gate_set', '{"invoice_void":"passkey"}', 'click',
     '{"title":"Change approval levels?","items":[{"what":"Voiding an invoice","from":"click","to":"passkey"}]}',
     'approved', '2026-02-03T09:06:00.000Z', 'page', '{"gate":[]}', 'agent:fixture'),
    (2, '2026-02-03T09:10:00.000Z', 'payment_instructions', 'profile_payment_instructions_set', '{"payment_instructions":"ACH to Second Bank, account 7654321"}', 'click',
     '{"title":"Change the payment instructions printed on invoices?","items":[{"from":"ACH to First Bank, account 1234567","to":"ACH to Second Bank, account 7654321"}]}',
     'pending', NULL, NULL, NULL, 'agent:fixture');
  ${history("2026-02-03T09:05:00.000Z", "gate_set")}
  `,
  // 005: an invoice from before solobooks, brought in already sent and paid.
  `
  INSERT INTO invoices (id, kind, status, client_id, period_start, period_end, terms_days, created_at, source)
    VALUES (3, 'invoice', 'draft', 2, '2025-12-01', '2025-12-31', 30, '2026-02-04T09:00:00.000Z', ${S});
  INSERT INTO invoice_lines (invoice_id, kind, description, amount_cents, item_date, source) VALUES (3, 'manual', 'December retainer', 300000, '2025-12-01', ${S});
  UPDATE invoices SET status = 'sent', number = 900, invoice_date = '2025-12-01', due_date = '2025-12-31', seller_legal_name = 'Jane Doe Consulting LLC',
    client_name = 'Beta LLC', issued_at = '2026-02-04T09:00:00.000Z', sent_at = '2026-02-04T09:00:00.000Z', historical = 1,
    paid_on = '2025-12-20', paid_account_id = 1 WHERE id = 3;
  INSERT INTO entries (id, date, memo, source) VALUES (5, '2025-12-01', 'Invoice 900 for Beta LLC (brought in)', ${S}), (6, '2025-12-20', 'Invoice 900 paid (brought in)', ${S});
  INSERT INTO lines (entry_id, account_id, debit_cents, credit_cents, source) VALUES
    (5, 4, 300000, 0, ${S}), (5, 5, 0, 300000, ${S}), (6, 1, 300000, 0, ${S}), (6, 4, 0, 300000, ${S});
  ${history("2026-02-04T09:00:00.000Z", "invoice_import", "fixture-import-900")}
  `,
  // 006: owner money, a draw and a transfer to the card.
  `
  INSERT INTO accounts (id, name, type, source) VALUES (8, 'Owner draws', 'equity', ${S}), (9, 'Card', 'liability', ${S});
  INSERT INTO entries (id, date, memo, source) VALUES (7, '2026-02-05', 'Owner draw', ${S}), (8, '2026-02-06', 'Pay off the card', ${S});
  INSERT INTO lines (entry_id, account_id, debit_cents, credit_cents, source) VALUES
    (7, 8, 50000, 0, ${S}), (7, 1, 0, 50000, ${S}), (8, 9, 1999, 0, ${S}), (8, 1, 0, 1999, ${S});
  INSERT INTO owner_moves (id, kind, date, amount_cents, memo, entry_id, source) VALUES
    (1, 'draw', '2026-02-05', 50000, NULL, 7, ${S}), (2, 'transfer', '2026-02-06', 1999, 'Pay off the card', 8, ${S});
  ${history("2026-02-05T09:00:00.000Z", "owner_draw")}
  `,
  // 007: payments with a fee, an overpayment held as client credit, and a full refund the old way.
  `
  INSERT INTO accounts (id, name, type, source) VALUES (10, 'Payment processing fees', 'expense', ${S}), (11, 'Client credits', 'liability', ${S});
  INSERT INTO entries (id, date, memo, source) VALUES
    (9, '2026-02-10', 'Payment on invoice 1001', ${S}), (10, '2026-02-12', 'Payment on invoice 1001', ${S}), (11, '2026-02-13', 'Refund of payment 1', ${S});
  INSERT INTO lines (entry_id, account_id, debit_cents, credit_cents, source) VALUES
    (9, 1, 19390, 0, ${S}), (9, 10, 610, 0, ${S}), (9, 4, 0, 20000, ${S}),
    (10, 1, 25000, 0, ${S}), (10, 4, 0, 19525, ${S}), (10, 11, 0, 5475, ${S}),
    (11, 4, 20000, 0, ${S}), (11, 1, 0, 19390, ${S}), (11, 10, 0, 610, ${S});
  INSERT INTO payments (id, invoice_id, date, amount_cents, fee_cents, deposit_account_id, applied_cents, credit_cents, memo, entry_id, source) VALUES
    (1, 1, '2026-02-10', 20000, 610, 1, 20000, 0, 'Card payment', 9, ${S}), (2, 1, '2026-02-12', 25000, 0, 1, 19525, 5475, 'ACH', 10, ${S});
  INSERT INTO client_credits (id, client_id, date, amount_cents, payment_id, refund_id, source) VALUES (1, 1, '2026-02-12', 5475, 2, NULL, ${S});
  INSERT INTO refunds (id, payment_id, date, reason, entry_id, source) VALUES (1, 1, '2026-02-13', 'Charged twice', 11, ${S});
  ${history("2026-02-12T09:00:00.000Z", "payment_add")}
  `,
  // 008: a bank statement, one line matched exactly and one backing a payment.
  `
  INSERT INTO bank_imports (id, account_id, file_name, file_sha256, stored_file, row_count, new_lines, imported_at, source)
    VALUES (1, 1, 'checking-feb.csv', '9c1e', 'statements/9c1e.csv', 2, 2, '2026-02-14T09:00:00.000Z', ${S});
  INSERT INTO bank_lines (id, import_id, account_id, file_row, date, description, amount_cents, source) VALUES
    (1, 1, 1, 2, '2026-01-05', 'EDITOR LICENCE', -1999, ${S}), (2, 1, 1, 3, '2026-02-12', 'ACH ACME CORP', 25000, ${S});
  INSERT INTO bank_matches (id, line_id, entry_id, account_id, kind, matched_at, source) VALUES
    (1, 1, 2, 1, 'exact', '2026-02-14T09:00:00.000Z', ${S}), (2, 2, 10, 1, 'payment', '2026-02-14T09:00:00.000Z', ${S});
  ${history("2026-02-14T09:00:00.000Z", "bank_import")}
  `,
  // 009: the payment gate's level.
  `
  INSERT INTO gate_levels (action, level, source) VALUES ('payment_unmatched', 'agent_decides', 'person:page');
  ${history("2026-02-15T09:00:00.000Z", "gate_set")}
  `,
  // 010: a partial refund out of client credit, a second invoice, and credit applied to it.
  `
  INSERT INTO entries (id, date, memo, source) VALUES
    (12, '2026-02-20', 'Refund of part of payment 2', ${S}), (13, '2026-02-28', 'Invoice 1002 for Acme', ${S}), (14, '2026-02-28', 'Client credit applied to invoice 1002', ${S});
  INSERT INTO lines (entry_id, account_id, debit_cents, credit_cents, source) VALUES
    (12, 11, 1000, 0, ${S}), (12, 1, 0, 1000, ${S}),
    (13, 4, 8500, 0, ${S}), (13, 5, 0, 8000, ${S}), (13, 7, 0, 500, ${S}),
    (14, 11, 2000, 0, ${S}), (14, 4, 0, 2000, ${S});
  INSERT INTO refunds (id, payment_id, date, reason, amount_cents, fee_returned_cents, applied_cents, credit_cents, entry_id, source)
    VALUES (2, 2, '2026-02-20', 'Part of the overpayment', 1000, 0, 0, 1000, 12, ${S});
  INSERT INTO client_credits (id, client_id, date, amount_cents, payment_id, refund_id, application_id, source) VALUES (2, 1, '2026-02-20', -1000, 2, 2, NULL, ${S});
  INSERT INTO invoices (id, kind, status, client_id, period_start, period_end, terms_days, created_at, source)
    VALUES (4, 'invoice', 'draft', 1, '2026-02-01', '2026-02-28', 15, '2026-02-28T10:00:00.000Z', ${S});
  INSERT INTO invoice_lines (invoice_id, kind, description, amount_cents, item_date, source) VALUES (4, 'manual', 'Workshop', 8000, '2026-02-27', ${S});
  UPDATE invoices SET status = 'issued', number = 1002, invoice_date = '2026-02-28', due_date = '2026-03-15', tax_rate_ppm = 62500, tax_label = 'IL sales tax',
    tax_applies_to = 'time,manual', seller_legal_name = 'Jane Doe Consulting LLC', seller_ein = '12-3456789', payment_instructions = 'ACH to First Bank, account 1234567',
    client_name = 'Acme', issued_at = '2026-02-28T10:05:00.000Z' WHERE id = 4;
  UPDATE business_profile SET next_invoice_number = 1003;
  INSERT INTO credit_applications (id, client_id, invoice_id, date, amount_cents, entry_id, source) VALUES (1, 1, 4, '2026-02-28', 2000, 14, ${S});
  INSERT INTO client_credits (id, client_id, date, amount_cents, payment_id, refund_id, application_id, source) VALUES (3, 1, '2026-02-28', -2000, NULL, NULL, 1, ${S});
  ${history("2026-02-28T10:05:00.000Z", "client_credit_apply")}
  `,
  // 011: a wrong bank match undone.
  `
  INSERT INTO bank_unmatches (id, match_id, reason, unmatched_at, source) VALUES (1, 1, 'Matched the wrong charge', '2026-03-01T09:00:00.000Z', ${S});
  ${history("2026-03-01T09:00:00.000Z", "bank_unmatch")}
  `,
  // 012: Schedule C lines, sales tax paid, the mileage log, home office, owner items and a contractor.
  `
  UPDATE accounts SET schedule_c = '18' WHERE id = 3;
  INSERT INTO accounts (id, name, type, schedule_c, source) VALUES (12, 'Design contractors', 'expense', '11', ${S});
  INSERT INTO entries (id, date, memo, source) VALUES
    (15, '2026-03-20', 'Sales tax paid: IL sales tax', ${S}), (16, '2026-04-15', 'Estimated tax: federal', ${S}), (17, '2026-03-05', 'Sam Rivera', ${S});
  INSERT INTO lines (entry_id, account_id, debit_cents, credit_cents, source) VALUES
    (15, 7, 2325, 0, ${S}), (15, 1, 0, 2325, ${S}), (16, 8, 300000, 0, ${S}), (16, 1, 0, 300000, ${S}), (17, 12, 80000, 0, ${S}), (17, 1, 0, 80000, ${S});
  INSERT INTO sales_tax_payments (id, date, amount_cents, tax_label, period_start, period_end, account_id, entry_id, confirmation, source)
    VALUES (1, '2026-03-20', 2325, 'IL sales tax', '2026-01-01', '2026-01-31', 1, 15, 'IL-778', ${S});
  INSERT INTO mileage_trips (id, date, miles_tenths, destination, purpose, client_id, source) VALUES (1, '2026-03-02', 125, 'Acme HQ', 'Kickoff workshop', 1, ${S});
  INSERT INTO home_offices (year, office_square_feet, home_square_feet, note, source) VALUES (2026, 150, 1500, 'Used all year', ${S});
  INSERT INTO home_office_expenses (id, year, description, amount_cents, source) VALUES (1, 2026, 'Rent', 2400000, ${S});
  INSERT INTO owner_moves (id, kind, date, amount_cents, memo, entry_id, source) VALUES (3, 'draw', '2026-04-15', 300000, 'Estimated tax: federal', 16, ${S});
  INSERT INTO owner_items (id, kind, date, amount_cents, paid_personally, account_id, entry_id, owner_move_id, jurisdiction, confirmation, source) VALUES
    (1, 'estimated_tax', '2026-04-15', 300000, 0, 1, 16, 3, 'federal', 'EFT-1', ${S}),
    (2, 'health_insurance', '2026-03-01', 45000, 1, NULL, NULL, NULL, NULL, NULL, ${S});
  INSERT INTO contractors (id, name, w9_status, w9_received_on, source) VALUES (1, 'Sam Rivera', 'on_file', '2026-03-01', ${S});
  INSERT INTO expenses (id, date, amount_cents, vendor, account_id, paid_from_account_id, entry_id, contractor_id, payment_method, source)
    VALUES (2, '2026-03-05', 80000, 'Sam Rivera', 12, 1, 17, 1, 'ach', ${S});
  ${history("2026-04-15T09:00:00.000Z", "owner_item_add")}
  `,
  // 013: an expense on an account from the Schedule C chart.
  `
  INSERT INTO entries (id, date, memo, source) VALUES (18, '2026-04-20', 'Printer paper', ${S});
  INSERT INTO lines (entry_id, account_id, debit_cents, credit_cents, source) VALUES
    (18, (SELECT id FROM accounts WHERE name = 'Supplies'), 2599, 0, ${S}), (18, 1, 0, 2599, ${S});
  INSERT INTO expenses (id, date, amount_cents, vendor, memo, account_id, paid_from_account_id, entry_id, payment_method, source)
    VALUES (3, '2026-04-20', 2599, 'Office Depot', 'Printer paper', (SELECT id FROM accounts WHERE name = 'Supplies'), 1, 18, 'card', ${S});
  ${history("2026-04-20T09:00:00.000Z", "expense_add")}
  `,
];

/** Books as solobooks at schema `version` would have saved them, in memory. */
export function buildFixture(version: number): Database {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  for (let v = 0; v < version; v++) {
    // Exactly as migrate() applies each one.
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
    db.transaction(() => db.exec(DATA[v]!))();
  }
  return db;
}

if (import.meta.main) {
  if (DATA.length !== MIGRATIONS.length) {
    console.error(`There are ${MIGRATIONS.length} migrations but ${DATA.length} DATA blocks; add a block for each new migration.`);
    process.exit(1);
  }
  mkdirSync(FIXTURES, { recursive: true });
  for (let v = 1; v <= MIGRATIONS.length; v++) {
    const db = buildFixture(v);
    const bad = db.query("PRAGMA foreign_key_check").all();
    if (bad.length > 0) throw new Error(`v${v} breaks a foreign key: ${JSON.stringify(bad)}`);
    const file = fixtureFile(v);
    if (existsSync(file)) unlinkSync(file);
    db.query("VACUUM INTO ?").run(file);
    db.close();
    console.log(`wrote ${file}`);
  }
}
