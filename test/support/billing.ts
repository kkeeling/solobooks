import { cli, ok, tempDir } from "./books.ts";
import { asPerson, letAgentDecideIn, setEveryLevel } from "./person.ts";
import { RECEIPT } from "./scenario.ts";

export const S = ["--source", "agent:test"];

export const SELLER = {
  legal_name: "Jane Doe Consulting LLC",
  address: "1 Main St\nSpringfield, IL 62701",
  ein: "12-3456789",
  email: "jane@example.com",
  payment_instructions: "ACH to First Bank, routing 011000015, account 1234567",
  next_invoice_number: 7001,
};

export const json = (cmd: string[], body: unknown) => [...cmd, "--json", JSON.stringify(body), ...S];

/**
 * Books where the person lets the agent decide every gated action, with one client, Acme, holding all four kinds of billable item in October 2026, plus one of each
 * dated outside it: time at $150/hr, a $2,500 milestone billable Oct 15, a $500 monthly fee and a $42 pass-through cost.
 * Accounts: 1 Checking, 2 Printing (expense).
 */
export async function acmeBooks(client: Record<string, unknown> = {}) {
  const dir = tempDir();
  letAgentDecideIn(dir);
  const { payment_instructions, ...seller } = SELLER;
  await ok(dir, json(["profile", "set"], seller));
  await ok(dir, json(["profile", "payment", "instructions", "set"], { payment_instructions })); // their own gated command
  await ok(dir, json(["client", "add"], { name: "Acme Corp", address: "500 Market St\nSan Francisco, CA 94105", email: "ap@acme.example", ...client }));
  await ok(dir, json(["engagement", "add"], {
    client_id: 1,
    name: "Build",
    rate_cents_per_hour: 15000,
    recurring_amount_cents: 50000,
    recurring_interval: "monthly",
    milestones: [
      { name: "Spec", amount_cents: 250000, billable_on: "2026-10-15" },
      { name: "Ship", amount_cents: 500000, billable_on: "2026-12-01" },
    ],
  }));
  await ok(dir, ["account", "add", "--name", "Checking", "--type", "asset", ...S]);
  await ok(dir, ["account", "add", "--name", "Printing", "--type", "expense", ...S]);
  await ok(dir, ["time", "add", "--client-id", "1", "--date", "2026-10-03", "--minutes", "37", "--note", "API design", ...S]);
  await ok(dir, ["time", "add", "--client-id", "1", "--date", "2026-10-20", "--minutes", "90", "--note", "Load testing", ...S]);
  await ok(dir, ["time", "add", "--client-id", "1", "--date", "2026-11-02", "--minutes", "60", "--note", "November work", ...S]);
  await ok(dir, json(["expense", "add"], {
    date: "2026-10-05", amount_cents: 4200, vendor: "Print shop", memo: "Workshop handouts",
    account_id: 2, paid_from_account_id: 1, receipt_path: RECEIPT, pass_through_client_id: 1,
  }));
  await ok(dir, json(["expense", "add"], {
    date: "2026-11-05", amount_cents: 999, vendor: "Courier", account_id: 2, paid_from_account_id: 1, pass_through_client_id: 1,
  }));
  return dir;
}

/** acmeBooks(), after which the person set every gated action to click. */
export async function clickAcme() {
  const dir = await acmeBooks();
  asPerson(dir, (db) => setEveryLevel(db, "click"));
  return dir;
}

export const OCTOBER = ["--client-id", "1", "--period-start", "2026-10-01", "--period-end", "2026-10-31"];

/** Drafts October for Acme and returns the draft. */
export async function draftOctober(dir: string) {
  return (await ok(dir, ["invoice", "draft", ...OCTOBER, ...S])).invoice;
}

/** Drafts and issues October for Acme and returns the issued invoice. */
export async function issueOctober(dir: string) {
  const d = await draftOctober(dir);
  return (await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S])).invoice;
}

export { cli, ok };
