import { expect, test } from "bun:test";
import { OPS } from "../src/core/perform.ts";
import { REQUIRES_USER } from "../src/mcp.ts";
import { clickAcme, draftOctober, ok, S } from "./support/billing.ts";
import { tempDir } from "./support/books.ts";
import { must } from "./support/gen.ts";
import { inProcessMcp, stdioMcp } from "./support/mcp-client.ts";
import { approveOnPage, approveWithPasskey, asPerson, registerTestPasskey, WHEN } from "./support/person.ts";

const ENV = { SOLOBOOKS_NOW: WHEN.now };
const ELICITS = { elicitation: { form: {} } };
const GATED = ["gate_set", "invoice_credit", "invoice_issue", "invoice_void", "profile_set"];

/** A client whose person answers every approval prompt the same way. */
const answering = (dir: string, action: "accept" | "decline" | "cancel", content: Record<string, unknown> = {}) =>
  inProcessMcp(dir, ENV, {
    capabilities: ELICITS,
    answer: (m) => (m.method === "elicitation/create" ? (action === "accept" ? { action, content } : { action }) : undefined),
  });

test("ISC-67 requires interaction: every gated MCP tool carries anthropic/requiresUserInteraction, and no other tool does", async () => {
  expect(REQUIRES_USER).toBe("anthropic/requiresUserInteraction");
  expect(OPS.filter((o) => o.gate).map((o) => o.name).sort()).toEqual(GATED);
  const mcp = await stdioMcp(tempDir(), ENV); // over the real wire, so the flag survives serialization
  const tools = (await mcp.request("tools/list")).result.tools as { name: string; _meta?: Record<string, unknown> }[];
  await mcp.close();
  expect(tools.length).toBe(OPS.length);
  expect(tools.filter((t) => t._meta?.["anthropic/requiresUserInteraction"] === true).map((t) => t.name).sort()).toEqual(GATED);
  expect(tools.filter((t) => t._meta?.["anthropic/requiresUserInteraction"] !== undefined).length).toBe(GATED.length);
}, 30_000);

test("elicitation: the person accepting in chat approves inside the same tool call", async () => {
  const dir = await clickAcme();
  const d = await draftOctober(dir);
  const mcp = await answering(dir, "accept");
  const r = await mcp.call("invoice_issue", { id: d.id, source: "agent:claude-code" });
  await mcp.close();
  expect(mcp.asked).toHaveLength(1);
  expect(mcp.asked[0]).toMatchObject({ method: "elicitation/create", params: { mode: "form", message: expect.stringMatching(/^Issue invoice 7001 to Acme Corp for \$[\d,]+\.\d\d\?$/) } });
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
  expect(form.message).toMatch(/^Issue 2 invoices totalling \$[\d,]+\.\d\d\? Untick any invoice to keep it a draft\.$/);
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
  await mcp.call("profile_set", { payment_instructions: "Wire to account 42", source: "agent:x" });
  await mcp.close();
  expect(mcp.asked.map((a) => a.params.message)).toEqual([
    "Change approval levels: issuing invoices from click to agent_decides?",
    'Change the payment instructions printed on invoices to "Wire to account 42"?',
  ]);
}, 30_000);
