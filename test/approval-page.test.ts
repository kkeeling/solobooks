import { afterEach, expect, test } from "bun:test";
import { approvePending } from "../src/core/approve.ts";
import { authenticationOptions, verifyPasskey } from "../src/core/passkey.ts";
import { startPage, type Page } from "../src/page.ts";
import { SoftAuthenticator } from "./support/authenticator.ts";
import { clickAcme, draftOctober, json, ok, S } from "./support/billing.ts";
import { cli } from "./support/books.ts";
import { inProcessMcp } from "./support/mcp-client.ts";
import { asPerson, WHEN } from "./support/person.ts";

// The HTTP path of the local approval page. The real-browser screenshot (ISC-73) and the Touch ID check (ISC-74) are
// the maintainer's; these prove the server side with plain requests and a software authenticator.

const ENV = { SOLOBOOKS_NOW: WHEN.now };
let pages: Page[] = [];
afterEach(() => {
  pages.forEach((p) => p.stop());
  pages = [];
});

function serve(dir: string): Page {
  const p = startPage({ books: dir, port: 0, env: ENV });
  pages.push(p);
  return p;
}

/** Loads the page as a browser would, returning its HTML and the data its script runs on. */
async function load(page: Page) {
  const r = await fetch(page.url);
  expect(r.status).toBe(200);
  const html = await r.text();
  const data = JSON.parse(html.match(/<script type="application\/json" id="data">(.*?)<\/script>/s)![1]!);
  return { html, data, item: (id: number) => data.pending.find((p: any) => p.id === id) };
}

const post = (page: Page, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(new URL(path, page.url), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const invoice = async (dir: string, id: number) => (await ok(dir, ["invoice", "get", "--id", String(id)])).invoice;

test("ISC-73 page approves: the local page lists a click-level pending action and its Approve completes it", async () => {
  const dir = await clickAcme();
  const d = await draftOctober(dir);
  const pid = (await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S])).pending_id;
  const page = serve(dir);
  expect(page.url).toBe(`http://localhost:${page.port}/`);

  const { html, item } = await load(page);
  expect(html).toContain(`id="pending-${pid}"`);
  expect(html).toContain("Issue invoice 7001 for $");
  expect(html).toContain("<dt>Client</dt><dd>Acme Corp</dd>");
  expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)=["']?https?:/); // nothing loaded from anywhere
  const code = item(pid).code;

  // A bare POST to a guessed address does nothing, nor does one from another site or with a made-up code.
  expect((await post(page, "/approve", { pending_id: pid })).status).toBe(403);
  expect((await post(page, "/approve", { pending_id: pid, code: "guessed" })).status).toBe(403);
  expect((await post(page, "/approve", { pending_id: pid, code }, { origin: "http://evil.example" })).status).toBe(403);
  expect((await fetch(new URL("/approve", page.url), { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
  expect((await invoice(dir, d.id)).status).toBe("draft");

  const r = await post(page, "/approve", { pending_id: pid, code });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ ok: true, result: { status: "approved", pending: { decided_via: "page" }, result: { invoice: { number: "7001" } } } });
  expect((await invoice(dir, d.id)).status).toBe("issued");
  expect((await post(page, "/approve", { pending_id: pid, code })).status).toBe(403); // each code works once

  // Reject closes one with no effect.
  const v = (await ok(dir, ["invoice", "void", "--id", String(d.id), "--reason", "x", ...S])).pending_id;
  const rej = await post(page, "/reject", { pending_id: v, code: (await load(page)).item(v).code });
  expect(await rej.json()).toMatchObject({ ok: true, result: { status: "rejected" } });
  expect((await invoice(dir, d.id)).status).toBe("issued");
  expect((await load(page)).data.pending).toEqual([]);

  // The page always runs on localhost, because that is where a passkey can live.
  const ip = await fetch(`http://127.0.0.1:${page.port}/`, { redirect: "manual" });
  expect([ip.status, ip.headers.get("location")]).toEqual([302, `http://localhost:${page.port}/`]);
}, 30_000);

test("ISC-73 page approves: a batch can have an invoice unticked, and what the agent wrote is shown as text, not markup", async () => {
  const dir = await clickAcme();
  const a = await draftOctober(dir);
  await ok(dir, ["time", "add", "--client-id", "1", "--date", "2026-12-02", "--minutes", "60", "--note", "December", ...S]);
  const b = (await ok(dir, ["invoice", "draft", "--client-id", "1", "--period-start", "2026-12-01", "--period-end", "2026-12-31", ...S])).invoice;
  const batch = (await ok(dir, ["invoice", "issue", "--ids", `${a.id},${b.id}`, ...S])).pending_id;
  const sneaky = (await ok(dir, json(["profile", "payment", "instructions", "set"], { payment_instructions: '<script>alert("pay me")</script>' }))).pending_id;
  const page = serve(dir);
  const { html, item } = await load(page);
  expect(html).toContain(`data-batch="${batch}" value="${b.id}"`);
  expect(html).not.toContain('<script>alert("pay me")');
  expect(html).toContain("&lt;script&gt;alert(&quot;pay me&quot;)&lt;/script&gt;");

  expect((await post(page, "/approve", { pending_id: batch, code: item(batch).code, exclude: [b.id] })).status).toBe(200);
  expect([(await invoice(dir, a.id)).status, (await invoice(dir, b.id)).status]).toEqual(["issued", "draft"]);
  expect((await post(page, "/reject", { pending_id: sneaky, code: item(sneaky).code })).status).toBe(200);
}, 30_000);

test("ISC-74 passkey: at passkey level approval completes only with a valid WebAuthn assertion from the passkey registered on the page", async () => {
  const dir = await clickAcme();
  const d = await draftOctober(dir);
  const page = serve(dir);
  const origin = `http://localhost:${page.port}`;
  const auth = await SoftAuthenticator.create();

  // First run: register a passkey on the page. The agent loaded the page too, first, and kept its own unspent code.
  const agentsCopy = await load(page);
  const first = await load(page);
  expect(first.html).toContain("Register a passkey");
  const reg = await post(page, "/passkey/register", { code: first.data.register.code, response: await auth.register(first.data.register.options, origin) });
  expect(reg.status).toBe(200);
  const second = await load(page);
  expect(second.data.register).toBeNull(); // one passkey per books; no second registration offered
  expect(second.html).not.toContain("Register a passkey"); // registered: the page says nothing more about it
  expect((await post(page, "/passkey/register", { code: first.data.register.code, response: {} })).status).toBe(403); // spent
  // The agent's unspent code reaches the one-passkey rule, which refuses a second passkey.
  const rogue = await SoftAuthenticator.create({ impostor: true, ownId: true });
  const late = await post(page, "/passkey/register", { code: agentsCopy.data.register.code, response: await rogue.register(agentsCopy.data.register.options, origin) });
  expect(late.status).toBe(409);
  expect(await late.json()).toMatchObject({ ok: false, refusal: { reason: "These books already have a passkey, so use that one.", field: "passkey" } });
  expect(asPerson(dir, (db) => db.query("SELECT COUNT(*) n FROM passkeys").get())).toEqual({ n: 1 });

  /** One approve attempt with whatever assertion `sign` makes from the page's fresh challenge. */
  const attempt = async (pid: number, sign?: (o: any) => Promise<unknown>) => {
    const it = (await load(page)).item(pid);
    expect(it.passkey).toMatchObject({ rpId: "localhost", userVerification: "required" });
    const r = await post(page, "/approve", { pending_id: pid, code: it.code, assertion: sign ? await sign(it.passkey) : undefined });
    return { status: r.status, body: (await r.json()) as any };
  };

  // Moving issuing up to passkey is approved at passkey level, so it already needs the passkey.
  const up = await ok(dir, ["gate", "set", "--invoice-issue", "passkey", ...S]);
  expect(up.level).toBe("passkey");
  expect((await attempt(up.pending_id)).body.refusal.field).toBe("passkey");
  expect((await attempt(up.pending_id, async (o) => auth.assert(o, origin))).status).toBe(200);

  const pid = (await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S])).pending_id;
  const impostor = await SoftAuthenticator.create({ impostor: true });
  const failures = [
    await attempt(pid), // no assertion: a plain click isn't enough
    await attempt(pid, (o) => impostor.assert(o, origin)), // same credential id, wrong key
    await attempt(pid, (o) => auth.assert({ ...o, challenge: "c3RhbGUtY2hhbGxlbmdl" }, origin)), // signed a different challenge
    await attempt(pid, (o) => auth.assert(o, "http://localhost:1")), // signed for another origin
    await attempt(pid, (o) => auth.assert(o, origin, { verified: false })), // touched but no Touch ID
  ];
  for (const f of failures) {
    expect(f.status).toBeGreaterThanOrEqual(400);
    expect(f.body.refusal.field).toBe("passkey");
  }
  expect((await invoice(dir, d.id)).status).toBe("draft");

  // Neither the CLI nor MCP takes an assertion, and the in-chat prompt never approves a passkey-level action.
  const fake = await auth.assert({ challenge: "AAAA", rpId: "localhost" }, origin);
  expect((await cli(dir, json(["invoice", "issue"], { id: d.id, assertion: fake }))).out.field).toBe("assertion");
  const mcp = await inProcessMcp(dir, ENV, { capabilities: { elicitation: {} }, answer: () => ({ action: "accept", content: {} }) });
  expect((await mcp.call("invoice_issue", { id: d.id, assertion: fake, source: "agent:x" })).structuredContent.field).toBe("assertion");
  expect((await mcp.call("invoice_issue", { id: d.id, source: "agent:x" })).structuredContent).toMatchObject({ status: "pending", level: "passkey" });
  await mcp.close();
  expect(mcp.asked).toHaveLength(0);
  await asPerson(dir, async (db) => {
    const o = await authenticationOptions(db);
    const proof = await verifyPasskey(db, (await auth.assert(o, origin)) as any, o.challenge, origin, pid);
    expect(approvePending(db, pid, { via: "elicitation", passkey: proof }, WHEN)).toMatchObject({ ok: false, refusal: { field: "passkey" } });
    expect(approvePending(db, pid, { via: "page", passkey: { ...proof } }, WHEN)).toMatchObject({ ok: false, refusal: { field: "passkey" } }); // a copy isn't the proof
  });

  const good = await attempt(pid, (o) => auth.assert(o, origin));
  expect(good).toMatchObject({ status: 200, body: { ok: true, result: { result: { invoice: { status: "issued" } } } } });
  expect(asPerson(dir, (db) => db.query("SELECT counter FROM passkeys").get())).toEqual({ counter: expect.any(Number) });
  expect((asPerson(dir, (db) => db.query("SELECT counter FROM passkeys").get()) as any).counter).toBeGreaterThan(0);
}, 60_000);
