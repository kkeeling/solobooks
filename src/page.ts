import { existsSync } from "node:fs";
import type { Server } from "bun";
import { booksFile, now, pageUrl, type Env } from "./config.ts";
import { approvePending, registerPasskey, rejectPending } from "./core/approve.ts";
import { openBooks, type Books } from "./core/db.ts";
import { dollars } from "./core/format.ts";
import { getPending, hasPasskey, levelToApprove, type PendingAction } from "./core/gate.ts";
import { authenticationOptions, registrationOptions, verifyPasskey, verifyRegistration } from "./core/passkey.ts";
import { Refusal } from "./core/refusal.ts";

// The local approval page: the list of pending actions with Approve and Reject, and passkey registration. It listens
// on loopback only and loads nothing from anywhere else. Every approve or reject carries a one-time code the page
// itself handed out, so a bare POST to a guessed address does nothing.

const GRANT_MS = 15 * 60_000;

type Grant =
  | { kind: "act"; pendingId: number; challenge?: string; expires: number }
  | { kind: "register"; challenge: string; expires: number };

export interface Page {
  url: string;
  port: number;
  stop(): void;
}

export function startPage(o: { books: string; port: number; env: Env }): Page {
  const file = booksFile(o.books);
  if (!existsSync(file)) throw new Refusal(`There are no books in ${o.books} yet, so there is nothing to approve.`, "books");

  const grants = new Map<string, Grant>();
  const mint = (g: Grant) => {
    const code = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    grants.set(code, g);
    return code;
  };
  /** Takes a one-time code: it works once, for what it was issued for, before it expires. */
  const take = (code: unknown): Grant | null => {
    if (typeof code !== "string") return null;
    const g = grants.get(code);
    grants.delete(code);
    return g && g.expires > Date.now() ? g : null;
  };
  const prune = () => {
    for (const [k, g] of grants) if (g.expires <= Date.now()) grants.delete(k);
  };

  let port = o.port;
  const origin = () => `http://localhost:${port}`;
  const when = () => ({ now: now(o.env), page: pageUrl(o.env, port) });
  const withBooks = async <T>(f: (db: Books) => T | Promise<T>): Promise<T> => {
    const db = openBooks(file);
    try {
      return await f(db);
    } finally {
      db.close();
    }
  };

  const json = (status: number, body: unknown) => Response.json(body, { status });
  const refused = (status: number, reason: string, field: string) => json(status, { ok: false, refusal: { reason, field } });
  const expired = () => refused(403, "This approval link has expired or was already used, so reload the approval page and try again.", "code");

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const host = req.headers.get("host") ?? "";
    const hosts = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
    if (!hosts.includes(host)) return new Response("This page only answers on localhost.", { status: 403 });
    prune();

    if (req.method === "GET" && url.pathname === "/") {
      // Passkeys belong to localhost, so the page always runs there.
      if (!host.startsWith("localhost:")) return Response.redirect(`${origin()}/`, 302);
      return new Response(await withBooks(render), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    if (req.method !== "POST") return new Response("Not found.", { status: 404 });

    const from = req.headers.get("origin");
    if (from !== null && ![origin(), `http://127.0.0.1:${port}`].includes(from)) return new Response("Wrong origin.", { status: 403 });
    if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return new Response("Send JSON.", { status: 415 });
    let body: any;
    try {
      body = await req.json();
    } catch {
      return refused(400, "The request body is not valid JSON.", "body");
    }
    if (typeof body !== "object" || body === null) return refused(400, "The request body must be a JSON object.", "body");

    if (url.pathname === "/approve" || url.pathname === "/reject") {
      const id = body.pending_id;
      const g = take(body.code);
      if (!g || g.kind !== "act" || g.pendingId !== id) return expired();
      return withBooks(async (db) => {
        const p = getPending(db, id);
        if (!p) return refused(404, `There is no pending action with id ${id}.`, "pending_id");
        if (url.pathname === "/reject") return answer(rejectPending(db, id, "page", when()));
        let passkey;
        if (p.status === "pending" && levelToApprove(db, p) === "passkey") {
          if (!g.challenge || !body.assertion) return refused(400, "This action is set to passkey, so approve it with your passkey.", "passkey");
          try {
            passkey = await verifyPasskey(db, body.assertion, g.challenge, origin(), id);
          } catch (e) {
            if (e instanceof Refusal) return refused(403, e.reason, e.field);
            throw e;
          }
        }
        const exclude = Array.isArray(body.exclude) ? body.exclude : [];
        return answer(approvePending(db, id, { via: "page", exclude, passkey }, when()));
      });
    }

    if (url.pathname === "/passkey/register") {
      const g = take(body.code);
      if (!g || g.kind !== "register") return expired();
      return withBooks(async (db) => {
        try {
          const k = await verifyRegistration(body.response, g.challenge, origin());
          return answer(registerPasskey(db, k, when()));
        } catch (e) {
          if (e instanceof Refusal) return refused(400, e.reason, e.field);
          throw e;
        }
      });
    }
    return new Response("Not found.", { status: 404 });
  }

  const answer = (r: { ok: true; result: unknown } | { ok: false; refusal: unknown }) =>
    r.ok ? json(200, { ok: true, result: r.result }) : json(409, { ok: false, refusal: r.refusal });

  async function render(db: Books): Promise<string> {
    const open = (db.query("SELECT id FROM pending_actions WHERE status = 'pending' ORDER BY id").all() as { id: number }[]).map(
      (r) => getPending(db, r.id)!,
    );
    const items = [];
    for (const p of open) {
      const passkey = levelToApprove(db, p) === "passkey" && hasPasskey(db) ? await authenticationOptions(db) : undefined;
      items.push({ p, passkey, code: mint({ kind: "act", pendingId: p.id, challenge: passkey?.challenge, expires: Date.now() + GRANT_MS }) });
    }
    const keyRow = db.query("SELECT created_at FROM passkeys ORDER BY id LIMIT 1").get() as { created_at: string } | null;
    let register;
    if (!keyRow) {
      const options = await registrationOptions();
      register = { options, code: mint({ kind: "register", challenge: options.challenge, expires: Date.now() + GRANT_MS }) };
    }
    const data = { pending: items.map((i) => ({ id: i.p.id, code: i.code, passkey: i.passkey ?? null })), register: register ?? null };
    return html(items.map((i) => card(i.p, levelToApprove(db, i.p), !!i.passkey)), keyRow?.created_at ?? null, data);
  }

  const fetch = (req: Request) =>
    handle(req).catch((e) => {
      console.error("solobooks serve:", e);
      return refused(500, "Something went wrong on the approval page, so reload it and try again.", "page");
    });
  const servers: Server<undefined>[] = [Bun.serve({ hostname: "127.0.0.1", port: o.port, fetch, maxRequestBodySize: 65_536 })];
  port = servers[0]!.port!;
  try {
    // Browsers may try ::1 first for localhost; answer there too when it's free. Still loopback only.
    servers.push(Bun.serve({ hostname: "::1", port, fetch, maxRequestBodySize: 65_536 }));
  } catch {
    // no IPv6 loopback here; 127.0.0.1 alone is enough
  }
  return { url: `${origin()}/`, port, stop: () => servers.forEach((s) => s.stop(true)) };
}

// ---------------------------------------------------------------- markup

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const LEVEL_TEXT = { click: "Click to approve", passkey: "Passkey required", agent_decides: "Agent decides" } as const;

function card(p: PendingAction, level: keyof typeof LEVEL_TEXT, passkeyReady: boolean): string {
  const batch = p.op === "invoice_issue" && Array.isArray(p.input.ids);
  const rows = p.items
    .map((it: any) => {
      if (it.invoice_id === undefined) {
        if (it.action !== undefined) return `<li>${esc(it.what)}: ${esc(it.from)} &rarr; <strong>${esc(it.to)}</strong></li>`;
        return `<li>From: ${esc(it.from ?? "(none)")}</li><li>To: <strong>${esc(it.to)}</strong></li>`;
      }
      const label = `${esc(it.client)} &middot; ${it.number ? `No. ${esc(it.number)}` : "draft"} &middot; ${esc(dollars(it.total_cents))}`;
      if (!batch) return `<li>${label}</li>`;
      return `<li><label><input type="checkbox" checked data-batch="${p.id}" value="${it.invoice_id}"> ${label}</label></li>`;
    })
    .join("");
  const hint = batch ? `<p class="hint">Untick an invoice to keep it a draft.</p>` : "";
  const blocked = level === "passkey" && !passkeyReady;
  return `<article class="card" id="pending-${p.id}">
  <header><span class="level ${level}">${LEVEL_TEXT[level]}</span><span class="meta">#${p.id} &middot; asked by ${esc(p.source)}</span></header>
  <h2>${esc(p.title)}</h2>
  <ul>${rows}</ul>${hint}
  <div class="actions">
    <button class="approve" data-approve="${p.id}"${blocked ? " disabled" : ""}>${level === "passkey" ? "Approve with passkey" : "Approve"}</button>
    <button class="reject" data-reject="${p.id}">Reject</button>
  </div>
  <p class="outcome" role="status"></p>
</article>`;
}

function html(cards: string[], passkeyCreated: string | null, data: unknown): string {
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");
  const passkey = passkeyCreated
    ? `<p>A passkey is registered for these books (since ${esc(passkeyCreated.slice(0, 10))}). Actions set to passkey need it.</p>`
    : `<p>No passkey yet. Register one to use the passkey level for any action.</p>
       <button id="register">Register a passkey</button><p class="outcome" id="register-outcome" role="status"></p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>solobooks approvals</title>
<style>
:root { --bg:#f6f5f2; --card:#fff; --ink:#1d1d1b; --muted:#6b6a66; --line:#e4e2dc; --ok:#1f7a4d; --bad:#a33a2b; --accent:#2c5fd6; --key:#7a4bc2; }
@media (prefers-color-scheme: dark) { :root { --bg:#161615; --card:#21211f; --ink:#ecebe7; --muted:#a09e98; --line:#34332f; --ok:#5cc28f; --bad:#e07b6c; --accent:#7ea2ff; --key:#b794f0; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width:680px; margin:0 auto; padding:32px 16px 64px; }
h1 { font-size:22px; margin:0 0 4px; } .sub { color:var(--muted); margin:0 0 24px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin:0 0 16px; }
.card header { display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; font-size:13px; color:var(--muted); }
.level { font-weight:600; } .level.click { color:var(--accent); } .level.passkey { color:var(--key); }
.card h2 { font-size:18px; margin:8px 0; overflow-wrap:anywhere; }
.card ul { margin:0 0 8px; padding-left:20px; overflow-wrap:anywhere; } .card li { margin:2px 0; }
.hint { color:var(--muted); font-size:14px; margin:0 0 8px; }
.actions { display:flex; gap:8px; margin-top:12px; }
button { font:inherit; padding:8px 16px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--ink); cursor:pointer; }
button.approve { background:var(--ok); border-color:var(--ok); color:#fff; } button:disabled { opacity:.5; cursor:default; }
.outcome { margin:8px 0 0; font-size:14px; } .outcome.ok { color:var(--ok); } .outcome.bad { color:var(--bad); }
section.passkey { border-top:1px solid var(--line); margin-top:32px; padding-top:16px; color:var(--muted); }
.empty { color:var(--muted); }
</style></head>
<body><main>
<h1>Waiting for your approval</h1>
<p class="sub">Your agent asked for these. Nothing happens until you approve.</p>
${cards.length ? cards.join("\n") : `<p class="empty">Nothing is waiting for approval.</p>`}
<section class="passkey"><h2>Passkey</h2>${passkey}</section>
</main>
<script type="application/json" id="data">${payload}</script>
<script>
const data = JSON.parse(document.getElementById("data").textContent);
const enc = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
const dec = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function post(path, body) {
  try {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return await r.json();
  } catch (e) { return { ok: false, refusal: { reason: String(e) } }; }
}
function say(el, ok, text) { el.className = "outcome " + (ok ? "ok" : "bad"); el.textContent = text; }
async function assertion(o) {
  const c = await navigator.credentials.get({ publicKey: { challenge: dec(o.challenge), rpId: o.rpId, timeout: o.timeout,
    userVerification: o.userVerification, allowCredentials: (o.allowCredentials || []).map((a) => ({ type: "public-key", id: dec(a.id), transports: a.transports })) } });
  return { id: c.id, rawId: enc(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(),
    authenticatorAttachment: c.authenticatorAttachment || undefined,
    response: { clientDataJSON: enc(c.response.clientDataJSON), authenticatorData: enc(c.response.authenticatorData),
      signature: enc(c.response.signature), userHandle: c.response.userHandle ? enc(c.response.userHandle) : undefined } };
}
for (const item of data.pending) {
  const card = document.getElementById("pending-" + item.id);
  const out = card.querySelector(".outcome");
  const done = (r, verb) => {
    if (r.ok) { card.querySelectorAll("button, input").forEach((b) => (b.disabled = true)); say(out, true, verb); }
    else say(out, false, (r.refusal && r.refusal.reason) + " Reload the page to try again.");
  };
  card.querySelector("[data-approve]").onclick = async () => {
    const exclude = [...card.querySelectorAll("input[data-batch]")].filter((c) => !c.checked).map((c) => Number(c.value));
    let a;
    if (item.passkey) {
      try { a = await assertion(item.passkey); } catch (e) { return say(out, false, "The passkey check didn't finish: " + e.message); }
    }
    done(await post("/approve", { pending_id: item.id, code: item.code, exclude, assertion: a }), "Approved. It's done.");
  };
  card.querySelector("[data-reject]").onclick = async () =>
    done(await post("/reject", { pending_id: item.id, code: item.code }), "Rejected. Nothing changed.");
}
const reg = document.getElementById("register");
if (reg && data.register) reg.onclick = async () => {
  const out = document.getElementById("register-outcome");
  const o = data.register.options;
  try {
    const c = await navigator.credentials.create({ publicKey: { ...o, challenge: dec(o.challenge), user: { ...o.user, id: dec(o.user.id) },
      excludeCredentials: (o.excludeCredentials || []).map((x) => ({ ...x, id: dec(x.id) })) } });
    const response = { id: c.id, rawId: enc(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(),
      authenticatorAttachment: c.authenticatorAttachment || undefined,
      response: { clientDataJSON: enc(c.response.clientDataJSON), attestationObject: enc(c.response.attestationObject),
        transports: c.response.getTransports ? c.response.getTransports() : [] } };
    const r = await post("/passkey/register", { code: data.register.code, response });
    if (r.ok) { reg.disabled = true; say(out, true, "Passkey registered. Reload the page to use it."); }
    else say(out, false, r.refusal.reason);
  } catch (e) { say(out, false, "Registration didn't finish: " + e.message); }
};
</script>
</body></html>`;
}
