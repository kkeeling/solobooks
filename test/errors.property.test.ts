import { expect, test } from "bun:test";
import fc from "fast-check";
import { OPS } from "../src/core/perform.ts";
import { cli, memBooks, tempDir } from "./support/books.ts";
import { must, seedAccounts, write } from "./support/gen.ts";
import { letAgentDecide } from "./support/person.ts";

const VALID: Record<string, Record<string, unknown>> = {
  account_add: { name: "New", type: "asset" },
  entry_post: { date: "2026-10-01", memo: "m", lines: [{ account_id: 1, debit_cents: 100 }, { account_id: 4, credit_cents: 100 }] },
  client_add: { name: "Zeta", increment_minutes: 6 },
  engagement_add: { client_id: 1, name: "E", rate_cents_per_hour: 15000 },
  time_add: { client_id: 1, date: "2026-10-01", minutes: 30, note: "n" },
  time_edit: { id: 1, minutes: 10 },
  time_delete: { id: 1 },
  profile_set: { legal_name: "New LLC", ein: "98-7654321" },
  client_edit: { id: 1, address: "2 Side St", tax_rate_ppm: 50000, tax_applies_to: ["time", "fixed"] },
  milestone_billable: { id: 1, date: "2026-10-15" },
  expense_add: { date: "2026-10-01", amount_cents: 500, vendor: "V", account_id: 5, paid_from_account_id: 1 },
  invoice_draft: { client_id: 1, period_start: "2026-10-01", period_end: "2026-10-31", lines: [{ description: "d", amount_cents: 100 }] },
  invoice_edit: { id: 1, terms_days: 10 },
  invoice_delete: { id: 1 },
  invoice_issue: { id: 1 },
  invoice_sent: { id: 2 },
  invoice_void: { id: 2, reason: "r" },
  invoice_credit: { invoice_id: 2, reason: "r", amount_cents: 50 },
  gate_set: { invoice_issue: "click" },
  transfer_add: { date: "2026-10-01", legs: [{ account_id: 1, amount_cents: -100 }, { account_id: 2, amount_cents: 100 }] },
  owner_draw: { date: "2026-10-01", amount_cents: 100, account_id: 1 },
  owner_contribute: { date: "2026-10-01", amount_cents: 100, account_id: 1 },
  payment_add: { invoice_id: 2, date: "2026-10-01", amount_cents: 50, fee_cents: 2, deposit_account_id: 1 },
  bank_match: { line_id: 1, entry_id: 1 },
};
const ENVELOPE = ["source", "idempotency_key", "input", "command"];

function setup() {
  const db = memBooks();
  letAgentDecide(db);
  seedAccounts(db);
  must(db, "client_add", { name: "Acme" });
  must(db, "time_add", { client_id: 1, date: "2026-10-01", minutes: 30, note: "n" }, { idempotency_key: "used" });
  must(db, "profile_set", { legal_name: "Jane Doe LLC", address: "1 Main St", ein: "12-3456789" });
  must(db, "client_edit", { id: 1, address: "500 Market St" });
  must(db, "engagement_add", { client_id: 1, name: "Fixed", rate_cents_per_hour: 100, milestones: [{ name: "Spec", amount_cents: 1000 }] });
  const manual = (month: string) => ({ client_id: 1, period_start: `2026-${month}-01`, period_end: `2026-${month}-28`, lines: [{ description: "d", amount_cents: 100 }] });
  must(db, "invoice_draft", manual("09")); // 1 stays a draft
  must(db, "invoice_draft", manual("08"));
  must(db, "invoice_issue", { id: 2 }); // 2 is issued
  return db;
}

/** One sentence: text ending in a single full stop, with no sentence break inside. */
export function isOneSentence(s: string): boolean {
  return s.length > 0 && s.endsWith(".") && !/[.!?]\s/.test(s.slice(0, -1)) && !s.includes("\n");
}

const bad = fc.oneof(fc.constantFrom<unknown>(undefined, null, "", "  ", "abc", -5, 0, 1.5, 99, 1e20, true, [], {}, "2026-02-30", "EUR", [{}]), fc.string(), fc.constantFrom("Acme", "Checking", "x. Y", "toString", "__proto__"));

const corrupt = fc.constantFrom(...Object.keys(VALID)).chain((op) => {
  const top = Object.keys(OPS.find((o) => o.name === op)!.fields);
  const paths = op === "entry_post" ? [...top, "lines.0.account_id", "lines.0.debit_cents", "lines.1.currency", "extra", "toString"] : [...top, "extra", "toString"];
  return fc.record({
    op: fc.constant(op),
    changes: fc.array(fc.tuple(fc.constantFrom(...paths), bad), { minLength: 1, maxLength: 3 }),
    source: fc.constantFrom<unknown>("test", "test", "test", "", undefined, 7),
    key: fc.constantFrom<unknown>(undefined, undefined, "used", "", 3),
  });
});

function apply(base: Record<string, unknown>, changes: [string, unknown][]) {
  const input = structuredClone(base) as any;
  for (const [path, v] of changes) {
    const parts = path.split(".");
    let o = input;
    for (const p of parts.slice(0, -1)) o = o?.[p];
    if (o && typeof o === "object") {
      if (v === undefined) delete o[parts.at(-1)!];
      else o[parts.at(-1)!] = v;
    }
  }
  return input;
}

test("ISC-13: every refused write returns a one-sentence reason and the field to change", () => {
  let refused = 0;
  fc.assert(
    fc.property(corrupt, ({ op, changes, source, key }) => {
      const db = setup();
      const input = apply(VALID[op]!, changes);
      const r = write(db, op, input, { source, idempotency_key: key }); // must not throw: bad input is a refusal, not a crash
      if (!r.ok) {
        refused++;
        expect(Object.keys(r.refusal).sort()).toEqual(["field", "reason"]);
        expect(isOneSentence(r.refusal.reason)).toBe(true);
        const top = r.refusal.field.split(/[.[]/)[0]!;
        const known = [...Object.keys(OPS.find((o) => o.name === op)!.fields), ...ENVELOPE, ...Object.keys(input ?? {})];
        expect(known).toContain(top);
      }
      db.close();
    }),
    { numRuns: 1000 },
  );
  expect(refused).toBeGreaterThan(700);
}, 60_000); // 1000 runs: allow for a busy machine

test("ISC-13: the CLI prints exactly the reason and field for a refused write", async () => {
  const r = await cli(tempDir(), ["time", "add", "--client-id", "1", "--date", "2026-10-01", "--minutes", "ten", "--note", "x", "--source", "s"]);
  expect(r.code).toBe(2);
  expect(r.out).toEqual({ reason: "minutes must be a whole number of minutes.", field: "minutes" });
});

test("ISC-13: every business-rule refusal also gives one sentence and the field to change", () => {
  const db = setup();
  must(db, "engagement_add", { client_id: 1, name: "Build", rate_cents_per_hour: 100 });
  must(db, "client_add", { name: "Beta" });
  // Time entry 2 is billed on an issued invoice, so it is locked.
  must(db, "time_add", { client_id: 2, date: "2026-07-04", minutes: 30, note: "n" });
  must(db, "client_edit", { id: 2, address: "9 Elm Rd" });
  must(db, "engagement_add", { client_id: 2, name: "Hourly", rate_cents_per_hour: 100 });
  must(db, "invoice_issue", { id: must(db, "invoice_draft", { client_id: 2, period_start: "2026-07-01", period_end: "2026-07-31" }).invoice.id });
  const lines = (a: number, b: number) => [{ account_id: 1, debit_cents: a }, { account_id: 4, credit_cents: b }];
  const cases: [string, unknown, Record<string, unknown>, string][] = [
    ["client_add", { name: "acme" }, {}, "name"],
    ["account_add", { name: "Checking", type: "asset" }, {}, "name"],
    ["engagement_add", { client_id: 1, name: "Build", rate_cents_per_hour: 1 }, {}, "name"],
    ["engagement_add", { client_id: 9, name: "X", rate_cents_per_hour: 1 }, {}, "client_id"],
    ["engagement_add", { client_id: 1, name: "X" }, {}, "rate_cents_per_hour"],
    ["engagement_add", { client_id: 1, name: "X", recurring_amount_cents: 5 }, {}, "recurring_interval"],
    ["engagement_add", { client_id: 1, name: "X", recurring_interval: "monthly" }, {}, "recurring_amount_cents"],
    ["entry_post", { date: "2026-10-01", memo: "m", lines: lines(5, 6) }, {}, "lines"],
    ["entry_post", { date: "2026-10-01", memo: "m", lines: [{ account_id: 99, debit_cents: 5 }, { account_id: 4, credit_cents: 5 }] }, {}, "lines[0].account_id"],
    ["entry_post", { date: "2026-10-01", memo: "m", lines: [{ account_id: 1, debit_cents: 5, credit_cents: 5 }, { account_id: 4, credit_cents: 5 }] }, {}, "lines[0].debit_cents"],
    ["time_add", { client_id: 9, date: "2026-10-01", minutes: 5, note: "n" }, {}, "client_id"],
    ["time_add", { client_id: 2, engagement_id: 1, date: "2026-10-01", minutes: 5, note: "n" }, {}, "engagement_id"],
    ["time_add", { client_id: 1, engagement_id: 7, date: "2026-10-01", minutes: 5, note: "n" }, {}, "engagement_id"],
    ["time_edit", { id: 99, minutes: 5 }, {}, "id"],
    ["time_delete", { id: 99 }, {}, "id"],
    ["time_delete", { id: 1 }, { idempotency_key: "used" }, "idempotency_key"],
    ["time_delete", { id: 1 }, { source: "" }, "source"],
    ["no_such_op", {}, {}, "command"],
    ["profile_set", {}, {}, "legal_name"],
    ["profile_set", { ein: "12-345" }, {}, "ein"],
    ["profile_set", { next_invoice_number: 9 }, {}, "next_invoice_number"],
    ["client_edit", { id: 9, name: "X" }, {}, "id"],
    ["client_edit", { id: 1, tax_label: "VAT" }, {}, "tax_label"],
    ["client_edit", { id: 1, tax_rate_ppm: 62500 }, {}, "tax_applies_to"],
    ["client_edit", { id: 1, tax_applies_to: ["time"] }, {}, "tax_applies_to"],
    ["client_edit", { id: 1, tax_rate_ppm: 62500, tax_applies_to: ["time", "time"] }, {}, "tax_applies_to"],
    ["client_add", { name: "Taxed", tax_rate_ppm: 62500, tax_applies_to: [] }, {}, "tax_applies_to"],
    ["milestone_billable", { id: 9, date: "2026-10-01" }, {}, "id"],
    ["expense_add", { date: "2026-10-01", amount_cents: 5, vendor: "V", account_id: 1, paid_from_account_id: 1 }, {}, "account_id"],
    ["expense_add", { date: "2026-10-01", amount_cents: 5, vendor: "V", account_id: 5, paid_from_account_id: 4 }, {}, "paid_from_account_id"],
    ["expense_add", { date: "2026-10-01", amount_cents: 5, vendor: "V", account_id: 5, paid_from_account_id: 1, receipt_path: "/no/such/file" }, {}, "receipt_path"],
    ["expense_add", { date: "2026-10-01", amount_cents: 5, vendor: "V", account_id: 5, paid_from_account_id: 1, pass_through_client_id: 9 }, {}, "pass_through_client_id"],
    ["invoice_draft", { client_id: 1, period_start: "2026-10-31", period_end: "2026-10-01" }, {}, "period_start"],
    ["invoice_draft", { client_id: 1, period_start: "2025-01-01", period_end: "2025-01-31" }, {}, "period_end"],
    ["invoice_draft", { client_id: 9, period_start: "2026-10-01", period_end: "2026-10-31" }, {}, "client_id"],
    ["invoice_edit", { id: 1 }, {}, "terms_days"],
    ["invoice_edit", { id: 1, remove_lines: [{ line_id: 99 }] }, {}, "remove_lines[0].line_id"],
    ["invoice_edit", { id: 2, terms_days: 3 }, {}, "id"],
    ["invoice_delete", { id: 2 }, {}, "id"],
    ["invoice_issue", { id: 2 }, {}, "id"],
    ["invoice_issue", { id: 99 }, {}, "id"],
    ["invoice_sent", { id: 1 }, {}, "id"],
    ["invoice_void", { id: 1, reason: "r" }, {}, "id"],
    ["invoice_credit", { invoice_id: 1, reason: "r" }, {}, "invoice_id"],
    ["invoice_credit", { invoice_id: 2, reason: "r", amount_cents: 101 }, {}, "amount_cents"],
    ["invoice_email", { id: 1 }, {}, "id"],
    ["invoice_reminder", { id: 2, as_of: "2026-10-23" }, {}, "as_of"],
    ["invoice_get", { id: 99 }, {}, "id"],
    ["time_edit", { id: 2, minutes: 9 }, {}, "id"],
    ["invoice_issue", { id: 1, ids: [1] }, {}, "id"],
    ["invoice_issue", {}, {}, "id"],
    ["invoice_issue", { ids: [1, 2] }, {}, "ids[1]"],
    ["invoice_issue", { ids: [1, 1] }, {}, "ids"],
    ["gate_set", {}, {}, "invoice_issue"],
    ["gate_set", { invoice_void: "agent_decides" }, {}, "invoice_void"],
    ["gate_set", { invoice_credit: "passkey" }, {}, "invoice_credit"],
    ["gate_set", { invoice_issue: "always" }, {}, "invoice_issue"],
    ["pending_get", { id: 99 }, {}, "id"],
    ["transfer_add", { date: "2026-10-01", legs: [{ account_id: 1, amount_cents: -5 }, { account_id: 2, amount_cents: 4 }] }, {}, "legs"],
    ["transfer_add", { date: "2026-10-01", legs: [{ account_id: 4, amount_cents: -5 }, { account_id: 1, amount_cents: 5 }] }, {}, "legs[0].account_id"],
    ["transfer_add", { date: "2026-10-01", legs: [{ account_id: 1, amount_cents: -5 }, { account_id: 1, amount_cents: 5 }] }, {}, "legs[1].account_id"],
    ["owner_draw", { date: "2026-10-01", amount_cents: 5, account_id: 4 }, {}, "account_id"],
    ["owner_contribute", { date: "2026-10-01", amount_cents: 5, account_id: 99 }, {}, "account_id"],
    ["expense_add", { date: "2026-10-01", amount_cents: 5, vendor: "V", account_id: 5, paid_from_account_id: 1, paid_personally: true }, {}, "paid_from_account_id"],
    ["payment_add", { invoice_id: 1, date: "2026-10-01", amount_cents: 5, deposit_account_id: 1 }, {}, "invoice_id"],
    ["payment_add", { invoice_id: 2, date: "2026-10-01", amount_cents: 5, fee_cents: 5, deposit_account_id: 1 }, {}, "fee_cents"],
    ["payment_add", { invoice_id: 2, date: "2026-10-01", amount_cents: 5, deposit_account_id: 2 }, {}, "deposit_account_id"],
    ["payment_add", { invoice_id: 2, date: "2026-10-01", amount_cents: 5, deposit_account_id: 1, bank_line_id: 99 }, {}, "bank_line_id"],
    ["payment_refund", { payment_id: 99, date: "2026-10-01", reason: "r" }, {}, "payment_id"],
    ["bank_import", { account_id: 4, file_path: "/no/such/file", date_column: "Date", date_format: "MM/DD/YYYY", description_column: "D", amount_column: "A" }, {}, "account_id"],
    ["bank_import", { account_id: 1, file_path: "/no/such/file", date_column: "Date", date_format: "MM/DD/YYYY", description_column: "D", amount_column: "A" }, {}, "file_path"],
    ["bank_match", { line_id: 99, entry_id: 1 }, {}, "line_id"],
    ["bank_unmatch", { line_id: 99, reason: "r" }, {}, "line_id"],
    ["client_credit_apply", { client_id: 9, invoice_id: 2, date: "2026-10-01" }, {}, "client_id"],
    ["client_credit_apply", { client_id: 2, invoice_id: 99, date: "2026-10-01" }, {}, "invoice_id"],
    ["client_credit_apply", { client_id: 1, invoice_id: 2, date: "2026-10-01" }, {}, "client_id"], // Acme holds no credit
    ["client_credit_apply", { client_id: 2, invoice_id: 2, date: "2026-10-01" }, {}, "invoice_id"], // invoice 2 is Acme's
  ];
  for (const [op, input, env, field] of cases) {
    const r = write(db, op, input, env);
    expect(r.ok).toBe(false);
    if (r.ok) continue;
    expect(r.refusal.field).toBe(field);
    expect(isOneSentence(r.refusal.reason)).toBe(true);
  }
});
