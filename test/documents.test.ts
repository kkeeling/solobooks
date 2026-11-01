import { expect, test } from "bun:test";
import { acmeBooks, cli, draftOctober, issueOctober, ok, S } from "./support/billing.ts";
import { asPerson } from "./support/person.ts";

test("ISC-35 invoice email: the invoice email text carries the invoice number, amount and due date", async () => {
  const dir = await acmeBooks();
  const draft = await draftOctober(dir);
  const early = await cli(dir, ["invoice", "email", "--id", String(draft.id)]);
  expect(early.out).toEqual({ reason: `Draft invoice ${draft.id} has no number yet, so issue it first.`, field: "id" });

  await ok(dir, ["invoice", "issue", "--id", String(draft.id), ...S]);
  const email = await ok(dir, ["invoice", "email", "--id", String(draft.id)]);
  expect(email).toMatchObject({ from: "jane@example.com", to: "ap@acme.example", attachment: "invoices/7001.pdf" });
  for (const part of [email.subject, email.body]) {
    expect(part).toContain("7001");
    expect(part).toContain("$3,359.50");
    expect(part).toContain("November 21, 2026");
  }
  expect(email.body).toContain("ACH to First Bank, routing 011000015, account 1234567");
  expect(email.body).toContain("Jane Doe Consulting LLC");
});

test("ISC-36 reminder: the overdue reminder text carries the unpaid balance and days late", async () => {
  const dir = await acmeBooks();
  const inv = await issueOctober(dir); // $3,359.50, due November 21, 2026
  const id = String(inv.id);

  const notYet = await cli(dir, ["invoice", "reminder", "--id", id, "--as-of", "2026-11-21"]);
  expect(notYet.out).toEqual({ reason: "Invoice 7001 isn't overdue until after November 21, 2026.", field: "as_of" });

  const r = await ok(dir, ["invoice", "reminder", "--id", id, "--as-of", "2026-12-03"]);
  expect(r).toMatchObject({ days_late: 12, balance_cents: 335950, to: "ap@acme.example", from: "jane@example.com" });
  for (const part of [r.subject, r.body]) {
    expect(part).toContain("$3,359.50");
    expect(part).toContain("12 days late");
  }
  expect(r.body).toContain("was due November 21, 2026");

  // The balance is what is still unpaid: a credit note lowers it.
  await ok(dir, ["invoice", "credit", "--invoice-id", id, "--amount-cents", "35950", "--reason", "Discount", ...S]);
  const after = await ok(dir, ["invoice", "reminder", "--id", id, "--as-of", "2026-11-22"]);
  expect(after).toMatchObject({ days_late: 1, balance_cents: 300000 });
  expect(after.body).toContain("is now 1 day late. The unpaid balance is $3,000.00.");

  // Today is the default day.
  const today = await cli(dir, ["invoice", "reminder", "--id", id]);
  expect(today.out.field).toBe("as_of");
});

test("ISC-151: invoice email refuses, naming the fix, when the client has no email address, and the fix works on the issued invoice", async () => {
  const dir = await acmeBooks({ email: undefined });
  const inv = await issueOctober(dir);
  const r = await cli(dir, ["invoice", "email", "--id", String(inv.id)]);
  expect(r).toMatchObject({ code: 2, out: { field: "id" } });
  expect(r.out.reason).toContain("Acme Corp has no email address");
  expect(r.out.reason).toContain("solobooks client edit --id 1 --email");
  await ok(dir, ["client", "edit", "--id", "1", "--email", "new@acme.example", ...S]);
  expect((await ok(dir, ["invoice", "email", "--id", String(inv.id)])).to).toBe("new@acme.example");
});

test("ISC-151: invoice email refuses, naming the fix, when the business has no email address, and the fix works on the issued invoice", async () => {
  const dir = await acmeBooks();
  asPerson(dir, (db) => db.query("UPDATE business_profile SET email = NULL").run());
  const inv = await issueOctober(dir);
  const r = await cli(dir, ["invoice", "email", "--id", String(inv.id)]);
  expect(r).toMatchObject({ code: 2, out: { field: "id" } });
  expect(r.out.reason).toContain("Your business has no email address");
  expect(r.out.reason).toContain("solobooks profile set --email");
  await ok(dir, ["profile", "set", "--email", "billing@example.com", ...S]);
  expect((await ok(dir, ["invoice", "email", "--id", String(inv.id)])).from).toBe("billing@example.com");
});

test("ISC-151: addresses frozen at issue still win over ones changed since", async () => {
  const dir = await acmeBooks();
  const inv = await issueOctober(dir);
  await ok(dir, ["client", "edit", "--id", "1", "--email", "changed@acme.example", ...S]);
  expect((await ok(dir, ["invoice", "email", "--id", String(inv.id)])).to).toBe("ap@acme.example");
});

test("ISC-151: invoice reminder uses the same address check as invoice email, and its fix works too", async () => {
  const dir = await acmeBooks({ email: undefined });
  asPerson(dir, (db) => db.query("UPDATE business_profile SET email = NULL").run());
  const inv = await issueOctober(dir);
  const remind = ["invoice", "reminder", "--id", String(inv.id), "--as-of", "2027-01-15"];
  const client = await cli(dir, remind);
  expect(client).toMatchObject({ code: 2, out: { field: "id" } });
  expect(client.out.reason).toContain("solobooks client edit --id 1 --email");
  await ok(dir, ["client", "edit", "--id", "1", "--email", "new@acme.example", ...S]);
  const business = await cli(dir, remind);
  expect(business).toMatchObject({ code: 2, out: { field: "id" } });
  expect(business.out.reason).toContain("solobooks profile set --email");
  await ok(dir, ["profile", "set", "--email", "billing@example.com", ...S]);
  expect(await ok(dir, remind)).toMatchObject({ from: "billing@example.com", to: "new@acme.example" });
});
