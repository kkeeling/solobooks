import { join } from "node:path";

export const RECEIPT = join(import.meta.dir, "..", "fixtures", "receipt.png");
/** A checking statement: interest that matches its entry exactly, a charge two days after its entry, and two others. */
export const STATEMENT = join(import.meta.dir, "..", "fixtures", "checking.csv");

/**
 * One pass through every operation solobooks has, in an order where each step succeeds, on books set up with
 * setUpPerson(): a passkey registered and every gated action left to the agent (pending action 1). gate_set then
 * parks pending action 2.
 */
export const SCENARIO: { op: string; input: Record<string, unknown> }[] = [
  { op: "account_add", input: { name: "Checking", type: "asset" } },
  { op: "account_add", input: { name: "Interest income", type: "income" } },
  { op: "account_add", input: { name: "Software", type: "expense" } },
  { op: "account_add", input: { name: "Card", type: "liability" } },
  {
    op: "entry_post",
    input: { date: "2026-10-01", memo: "Bank interest", lines: [{ account_id: 1, debit_cents: 92500 }, { account_id: 2, credit_cents: 92500 }] },
  },
  {
    op: "entry_post",
    input: { date: "2026-10-02", memo: "Editor licence", lines: [{ account_id: 3, debit_cents: 1999 }, { account_id: 1, credit_cents: 1999, currency: "USD" }] },
  },
  { op: "client_add", input: { name: "Acme", increment_minutes: 6 } },
  { op: "client_add", input: { name: "Beta", minimum_minutes: 15 } },
  { op: "engagement_add", input: { client_id: 1, name: "Build", rate_cents_per_hour: 15000 } },
  {
    op: "engagement_add",
    input: { client_id: 2, name: "Launch", milestones: [{ name: "Spec", amount_cents: 250000 }, { name: "Ship", amount_cents: 500000 }] },
  },
  { op: "engagement_add", input: { client_id: 2, name: "Retainer", recurring_amount_cents: 300000, recurring_interval: "monthly" } },
  {
    op: "engagement_add",
    input: { client_id: 1, name: "Support", rate_cents_per_hour: 12000, recurring_amount_cents: 50000, recurring_interval: "monthly" },
  },
  { op: "time_add", input: { client_id: 1, engagement_id: 1, date: "2026-10-03", minutes: 37, note: "API design" } },
  { op: "time_add", input: { client_id: 2, date: "2026-10-04", minutes: 5, note: "Call" } },
  { op: "time_edit", input: { id: 1, minutes: 40 } },
  { op: "time_delete", input: { id: 2 } },
  {
    op: "profile_set",
    input: {
      legal_name: "Jane Doe Consulting LLC",
      address: "1 Main St\nSpringfield, IL 62701",
      ein: "12-3456789",
      email: "jane@example.com",
      next_invoice_number: 1043,
    },
  },
  { op: "profile_payment_instructions_set", input: { payment_instructions: "ACH to First Bank, routing 011000015, account 1234567" } },
  {
    op: "client_edit",
    input: { id: 1, address: "500 Market St\nSan Francisco, CA 94105", email: "ap@acme.example", tax_rate_ppm: 62500, tax_label: "IL sales tax", tax_applies_to: ["time", "recurring", "manual"] },
  },
  { op: "client_edit", input: { id: 2, address: "9 Elm Rd\nAustin, TX 78701", terms_days: 15 } },
  { op: "milestone_billable", input: { id: 1, date: "2026-10-15" } },
  {
    op: "expense_add",
    input: {
      date: "2026-10-05", amount_cents: 4200, vendor: "Print shop", memo: "Workshop handouts",
      account_id: 3, paid_from_account_id: 1, receipt_path: RECEIPT, pass_through_client_id: 1,
    },
  },
  { op: "invoice_draft", input: { client_id: 1, period_start: "2026-10-01", period_end: "2026-10-31", lines: [{ description: "Setup", amount_cents: 10000 }] } },
  { op: "invoice_edit", input: { id: 1, terms_days: 15, note: "Thank you for your business" } },
  { op: "invoice_draft", input: { client_id: 2, period_start: "2026-10-01", period_end: "2026-10-31" } },
  { op: "invoice_delete", input: { id: 2 } },
  { op: "invoice_issue", input: { id: 1 } },
  { op: "invoice_sent", input: { id: 1 } },
  { op: "invoice_credit", input: { invoice_id: 1, amount_cents: 1000, reason: "Goodwill discount", line_kind: "time" } },
  { op: "invoice_draft", input: { client_id: 2, period_start: "2026-10-01", period_end: "2026-10-31" } },
  { op: "invoice_issue", input: { id: 4 } },
  { op: "invoice_void", input: { id: 4, reason: "Wrong period" } },
  {
    op: "invoice_import",
    input: { client_id: 2, number: 900, invoice_date: "2026-09-01", lines: [{ description: "August retainer", amount_cents: 300000 }], paid_on: "2026-09-20", paid_account_id: 1 },
  },
  { op: "transfer_add", input: { date: "2026-10-06", memo: "Pay off the card", legs: [{ account_id: 1, amount_cents: -1999 }, { account_id: 4, amount_cents: 1999 }] } },
  { op: "owner_draw", input: { date: "2026-10-07", amount_cents: 50000, account_id: 1 } },
  { op: "owner_contribute", input: { date: "2026-10-08", amount_cents: 20000, account_id: 1, memo: "Top-up" } },
  { op: "expense_add", input: { date: "2026-10-09", amount_cents: 1500, vendor: "Cafe", memo: "Client lunch", account_id: 3, paid_personally: true } },
  { op: "payment_add", input: { invoice_id: 1, date: "2026-10-10", amount_cents: 5000, fee_cents: 175, deposit_account_id: 1, memo: "Card payment" } },
  { op: "payment_refund", input: { payment_id: 1, date: "2026-10-11", reason: "Paid on the wrong invoice" } },
  { op: "payment_add", input: { invoice_id: 1, date: "2026-10-12", amount_cents: 500000, deposit_account_id: 1 } }, // more than is owed
  { op: "payment_refund", input: { payment_id: 2, date: "2026-10-13", reason: "Overpaid" } },
  {
    op: "bank_import",
    input: { account_id: 1, file_path: STATEMENT, date_column: "Date", date_format: "MM/DD/YYYY", description_column: "Description", amount_column: "Amount" },
  },
  { op: "bank_match", input: { line_id: 2, entry_id: 2 } }, // the editor licence, charged two days after its entry
  { op: "payment_add", input: { invoice_id: 1, date: "2026-10-20", amount_cents: 25000, deposit_account_id: 1, bank_line_id: 3 } }, // backed by the ACH deposit
  { op: "bank_unmatch", input: { line_id: 2, reason: "Matched the wrong charge" } }, // not a payment's line, so not gated
  { op: "payment_add", input: { invoice_id: 1, date: "2026-10-21", amount_cents: 900000, fee_cents: 2000, deposit_account_id: 1 } }, // overpaid: a credit
  { op: "payment_refund", input: { payment_id: 4, date: "2026-10-22", reason: "Part of the overpayment", amount_cents: 1000, fee_returned_cents: 30 } },
  { op: "invoice_draft", input: { client_id: 1, period_start: "2026-11-01", period_end: "2026-11-30" } },
  { op: "invoice_issue", input: { id: 6 } },
  { op: "client_credit_apply", input: { client_id: 1, invoice_id: 6, date: "2026-11-30", amount_cents: 1000 } },
  { op: "gate_set", input: { invoice_issue: "click" } },
  { op: "gate_list", input: {} },
  { op: "pending_list", input: {} },
  { op: "pending_get", input: { id: 2 } },
  { op: "account_list", input: {} },
  { op: "entry_list", input: {} },
  { op: "client_list", input: {} },
  { op: "engagement_list", input: { client_id: 1 } },
  { op: "time_list", input: {} },
  { op: "report_pnl", input: { from: "2026-01-01", to: "2026-12-31" } },
  { op: "profile_get", input: {} },
  { op: "invoice_list", input: {} },
  { op: "invoice_get", input: { id: 1 } },
  { op: "invoice_pdf", input: { id: 1 } },
  { op: "invoice_pdf", input: { id: 3 } },
  { op: "invoice_email", input: { id: 1 } },
  { op: "invoice_reminder", input: { id: 6, as_of: "2099-01-01" } }, // invoice 1 was overpaid
  { op: "expense_list", input: {} },
  { op: "owner_list", input: {} },
  { op: "payment_list", input: { invoice_id: 1 } },
  { op: "client_credits", input: {} },
  { op: "report_unpaid", input: {} },
  { op: "bank_list", input: { status: "unmatched" } },
  { op: "history_list", input: {} },
];

export function cliArgs(step: { op: string; input: Record<string, unknown> }, source = "test:scenario"): string[] {
  return [...step.op.split("_"), "--json", JSON.stringify(step.input), "--source", source];
}
