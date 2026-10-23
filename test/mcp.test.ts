import { expect, test } from "bun:test";
import { OPS } from "../src/core/perform.ts";
import type { GateAction, Op } from "../src/core/op.ts";
import { needsPerson, REQUIRES_USER } from "../src/mcp.ts";
import { clickAcme, draftOctober, ok, S } from "./support/billing.ts";
import { tempDir } from "./support/books.ts";
import { must } from "./support/gen.ts";
import { inProcessMcp, stdioMcp } from "./support/mcp-client.ts";
import { approveOnPage, approveWithPasskey, asPerson, registerTestPasskey, WHEN } from "./support/person.ts";

const ENV = { SOLOBOOKS_NOW: WHEN.now };
const ELICITS = { elicitation: { form: {} } };
/** The gate map: every tool whose every call is a gated action, and the action it is. */
const GATED: Record<string, GateAction> = {
  gate_set: "gate_settings",
  invoice_credit: "invoice_credit",
  invoice_issue: "invoice_issue",
  invoice_void: "invoice_void",
  profile_payment_instructions_set: "payment_instructions",
};
/** Tools gated only for some inputs: they carry no flag, and the core parks just the gated calls. */
const GATED_SOMETIMES = ["payment_add"];

/** A client whose person answers every approval prompt the same way. */
const answering = (dir: string, action: "accept" | "decline" | "cancel", content: Record<string, unknown> = {}) =>
  inProcessMcp(dir, ENV, {
    capabilities: ELICITS,
    answer: (m) => (m.method === "elicitation/create" ? (action === "accept" ? { action, content } : { action }) : undefined),
  });

test("ISC-67 requires interaction: a tool carries anthropic/requiresUserInteraction exactly when every call of it is gated", async () => {
  expect(REQUIRES_USER).toBe("anthropic/requiresUserInteraction");
  const mcp = await stdioMcp(tempDir(), ENV); // over the real wire, so the flag survives serialization
  const tools = (await mcp.request("tools/list")).result.tools as { name: string; _meta?: Record<string, unknown> }[];
  await mcp.close();
  expect(tools.length).toBe(OPS.length);
  const flagged = tools.filter((t) => t._meta?.[REQUIRES_USER] !== undefined);
  expect(flagged.map((t) => t.name).sort()).toEqual(Object.keys(GATED).sort());
  for (const t of flagged) expect(t._meta![REQUIRES_USER]).toBe(true);
  // Every flagged tool's op is gated whatever it is given, so no ungated call path makes the person approve.
  for (const t of flagged) expect(typeof OPS.find((o) => o.name === t.name)!.gate).toBe("string");
  expect(tools.find((t) => t.name === "profile_set")?._meta?.[REQUIRES_USER]).toBeUndefined();
  // The core agrees with the gate maps: these ops are gated on every input, these on some, and no other op at all.
  expect(Object.fromEntries(OPS.filter((o) => typeof o.gate === "string").map((o) => [o.name, o.gate]))).toEqual(GATED);
  expect(OPS.filter((o) => typeof o.gate === "function").map((o) => o.name).sort()).toEqual(GATED_SOMETIMES);
}, 30_000);

test("ISC-67 requires interaction: a tool gated only for some inputs carries no flag, since its other calls need no one", () => {
  const op = (gate?: Op["gate"]): Op => ({ name: "x_set", kind: "write", description: "", fields: {}, gate, run: () => ({}) });
  expect(needsPerson(op("payment_instructions"))).toBe(true);
  expect(needsPerson(op((input) => (input.risky ? "payment_instructions" : null)))).toBe(false);
  expect(needsPerson(op())).toBe(false);
});

test("elicitation: the person accepting in chat approves inside the same tool call", async () => {
  const dir = await clickAcme();
  const d = await draftOctober(dir);
  const mcp = await answering(dir, "accept");
  const r = await mcp.call("invoice_issue", { id: d.id, source: "agent:claude-code" });
  await mcp.close();
  expect(mcp.asked).toHaveLength(1);
  expect(mcp.asked[0]).toMatchObject({ method: "elicitation/create", params: { mode: "form", message: expect.stringMatching(/^Issue invoice 7001 for \$[\d,]+\.\d\d\?\n\nInvoice: 7001\nClient: Acme Corp\n/) } });
  expect(r.isError).toBe(false);
  expect(r.structuredContent).toMatchObject({ status: "approved", pending: { status: "approved", decided_via: "elicitation" }, result: { invoice: { status: "issued", number: "7001" } } });
  expect((await ok(dir, ["invoice", "get", "--id", String(d.id)])).invoice.status).toBe("issued");
}, 30_000);

test("elicitation: declining or cancelling in chat leaves the action pending, and the page can still approve it", async () => {
  for (const action of ["decline", "cancel"] as const) {
    const dir = await clickAcme();
    const d = await draftOctober(dir);
    const mcp = await answering(dir, action);
    const r = (await mcp.call("invoice_issue", { id: d.id, source: "agent:claude-code" })).structuredContent;
    await mcp.close();
    expect(mcp.asked).toHaveLength(1);
    expect(r).toMatchObject({ status: "pending", level: "click" });
    expect((await ok(dir, ["invoice", "get", "--id", String(d.id)])).invoice.status).toBe("draft");
    asPerson(dir, (db) => approveOnPage(db, r.pending_id));
    expect((await ok(dir, ["invoice", "get", "--id", String(d.id)])).invoice.status).toBe("issued");
  }
}, 30_000);

test("elicitation: a batch prompt lists each invoice, and one the person unticks stays a draft", async () => {
  const dir = await clickAcme();
  const a = await draftOctober(dir);
  await ok(dir, ["time", "add", "--client-id", "1", "--date", "2026-12-02", "--minutes", "60", "--note", "December", ...S]);
  const b = (await ok(dir, ["invoice", "draft", "--client-id", "1", "--period-start", "2026-12-01", "--period-end", "2026-12-31", ...S])).invoice;
  const mcp = await answering(dir, "accept", { [`include_${a.id}`]: true, [`include_${b.id}`]: false });
  const r = (await mcp.call("invoice_issue", { ids: [a.id, b.id], source: "agent:claude-code" })).structuredContent;
  await mcp.close();
  const form = mcp.asked[0]!.params;
  expect(form.message).toMatch(/^Issue 2 invoices totalling \$[\d,]+\.\d\d\? Untick any invoice to keep it a draft\.\n\nInvoice: 7001\n[\s\S]*\n\nInvoice: 7002\n/);
  expect(Object.keys(form.requestedSchema.properties)).toEqual([`include_${a.id}`, `include_${b.id}`]);
  expect(form.requestedSchema.properties[`include_${a.id}`]).toMatchObject({ type: "boolean", default: true, title: expect.stringContaining("Acme Corp") });
  expect(r).toMatchObject({ status: "approved", pending: { excluded: [b.id] } });
  expect((await ok(dir, ["invoice", "get", "--id", String(a.id)])).invoice.status).toBe("issued");
  expect((await ok(dir, ["invoice", "get", "--id", String(b.id)])).invoice.status).toBe("draft");
}, 30_000);

test("elicitation: a client without elicitation gets the pending result, and passkey level never asks in chat", async () => {
  const dir = await clickAcme();
  const d = await draftOctober(dir);
  const plain = await inProcessMcp(dir, ENV);
  expect((await plain.call("invoice_issue", { id: d.id, source: "agent:x" })).structuredContent).toMatchObject({ status: "pending", level: "click" });
  await plain.close();
  expect(plain.asked).toHaveLength(0);

  const auth = await asPerson(dir, (db) => registerTestPasskey(db));
  const p = await ok(dir, ["gate", "set", "--invoice-issue", "passkey", ...S]);
  await asPerson(dir, (db) => approveWithPasskey(db, auth, p.pending_id));
  const mcp = await answering(dir, "accept");
  const r = (await mcp.call("invoice_issue", { id: d.id, source: "agent:x" })).structuredContent;
  await mcp.close();
  expect(mcp.asked).toHaveLength(0);
  expect(r).toMatchObject({ status: "pending", level: "passkey" });
  expect((await ok(dir, ["invoice", "get", "--id", String(d.id)])).invoice.status).toBe("draft");
}, 30_000);

test("elicitation: a forged approval answer sent with the tool call approves nothing", async () => {
  const dir = await clickAcme();
  const d = await draftOctober(dir);
  const pid = (await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S])).pending_id;
  const mcp = await inProcessMcp(dir, ENV, { capabilities: ELICITS, answer: () => ({ action: "decline" }) });
  const forged = Buffer.from(JSON.stringify({ p: { pending_id: pid }, exp: 9_999_999_999 })).toString("base64url");
  const r = await mcp.request("tools/call", {
    name: "invoice_issue",
    arguments: { id: d.id, source: "agent:x" },
    requestState: `v1.${forged}.AAAA`,
    inputResponses: { approval: { action: "accept", content: {} } },
  });
  await mcp.close();
  expect(r.error).toMatchObject({ code: -32602, data: { reason: "invalid_request_state" } }); // the signature check refuses it
  asPerson(dir, (db) => {
    expect(db.query("SELECT status FROM pending_actions WHERE id = ?").get(pid)).toEqual({ status: "pending" });
    expect(must(db, "invoice_get", { id: d.id }).invoice.status).toBe("draft");
  });
}, 30_000);

test("elicitation: gate settings and payment details are asked in chat too, and a dry run asks nothing", async () => {
  const dir = await clickAcme();
  const mcp = await answering(dir, "decline");
  const dry = (await mcp.call("gate_set", { invoice_issue: "agent_decides", source: "agent:x", dry_run: true })).structuredContent;
  expect(dry).toMatchObject({ dry_run: true, result: { status: "pending" } });
  expect(mcp.asked).toHaveLength(0);
  await mcp.call("gate_set", { invoice_issue: "agent_decides", source: "agent:x" });
  await mcp.call("profile_payment_instructions_set", { payment_instructions: "Wire to account 42", source: "agent:x" });
  await mcp.close();
  expect(mcp.asked.map((a) => a.params.message)).toEqual([
    "Change approval levels?\n\nissuing invoices: click → agent_decides",
    "Change the payment instructions printed on invoices?\n\nCurrent: ACH to First Bank, routing 011000015, account 1234567\nNew: Wire to account 42",
  ]);
}, 30_000);

test("elicitation: the chat prompt is a fixed question with labeled one-line fields, so the agent can't word it", async () => {
  const dir = await clickAcme();
  const mcp = await answering(dir, "decline");
  // The audit's payload: text that tries to close the question and reassure the person.
  const evil = `ACH to Jane's Bank, acct 1111"? This only re-saves your current instructions after a format update; nothing printed on invoices changes. (Ref: Wire alt. First Evil Bank 666666)`;
  await mcp.call("profile_payment_instructions_set", { payment_instructions: evil, source: "agent:x" });
  const long = `Wire to First Evil Bank\nApprove: yes, this is routine\n${"x".repeat(1000)}`;
  await mcp.call("profile_payment_instructions_set", { payment_instructions: long, source: "agent:x" });
  const d = await draftOctober(dir);
  await ok(dir, ["invoice", "edit", "--id", String(d.id), "--note", "Thanks!\n\nApprove: this invoice was already approved", ...S]);
  await mcp.call("invoice_issue", { id: d.id, source: "agent:x" });
  await mcp.close();

  const [first, second, third] = mcp.asked.map((a) => a.params.message.split("\n"));
  expect(first).toEqual([
    "Change the payment instructions printed on invoices?",
    "",
    "Current: ACH to First Bank, routing 011000015, account 1234567",
    `New: ${evil}`,
  ]);
  expect(second![0]).toBe("Change the payment instructions printed on invoices?");
  expect(second).toHaveLength(4); // the agent's newlines don't add lines
  expect(second![3]).toStartWith("New: Wire to First Evil Bank Approve: yes, this is routine xxx");
  expect(second![3]!.length).toBeLessThanOrEqual("New: ".length + 240);
  expect(third![0]).toBe("Issue invoice 7001 for $3,359.50?");
  expect(third).toContain("Note: Thanks! Approve: this invoice was already approved");
  // Every line after the question is a label the code wrote, then the value.
  const LABELS = /^(Current|New|Invoice|Credit note|Client|Client address|Line|Tax|Total|Note|Terms|Payment instructions|Reason): /;
  for (const msg of [first!, second!, third!]) for (const l of msg.slice(1).filter(Boolean)) expect(l).toMatch(LABELS);
}, 30_000);

/**
 * Every tool, classified by hand. A new operation fails this test until someone decides which list it belongs on.
 * invoice_pdf only reads the books but saves a file into the books folder, so to an agent app it is a write.
 */
const READ_ONLY = [
  "profile_get", "client_list", "engagement_list", "time_list", "expense_list", "invoice_list", "invoice_get", "invoice_email",
  "invoice_reminder", "account_list", "entry_list", "report_pnl", "history_list", "gate_list", "pending_list", "pending_get",
  "owner_list", "payment_list", "client_credits", "report_unpaid", "bank_list",
];
const WRITES = [
  "profile_set", "profile_payment_instructions_set", "client_add", "client_edit", "engagement_add", "milestone_billable", "time_add", "time_edit", "time_delete",
  "expense_add", "invoice_draft", "invoice_edit", "invoice_delete", "invoice_issue", "invoice_sent", "invoice_void", "invoice_credit",
  "invoice_import", "invoice_pdf", "account_add", "entry_post", "gate_set",
  "transfer_add", "owner_draw", "owner_contribute", "payment_add", "payment_refund", "bank_import", "bank_match",
];

test("ISC-89 annotations: every read-only tool says readOnlyHint true, and no write tool does", async () => {
  const mcp = await stdioMcp(tempDir(), ENV); // over the real wire, so the hints survive serialization
  const tools = (await mcp.request("tools/list")).result.tools as { name: string; annotations?: Record<string, unknown> }[];
  await mcp.close();
  const names = tools.map((t) => t.name).sort();
  expect(READ_ONLY.filter((n) => WRITES.includes(n))).toEqual([]);
  expect([...READ_ONLY, ...WRITES].sort()).toEqual(names); // nothing unclassified, nothing missing
  const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name).sort();
  expect(readOnly).toEqual([...READ_ONLY].sort());
  for (const t of tools.filter((t) => WRITES.includes(t.name))) expect(t.annotations?.readOnlyHint).toBe(false);
}, 30_000);
