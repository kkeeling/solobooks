import { existsSync } from "node:fs";
import type { Server } from "bun";
import { booksFile, now, pageUrl, type Env } from "./config.ts";
import { approvePending, registerPasskey, rejectPending } from "./core/approve.ts";
import { openBooks, type Books } from "./core/db.ts";
import { openOptions } from "./durability.ts";
import { field, getPending, hasPasskey, levelToApprove, type PendingAction, promptFields } from "./core/gate.ts";
import { authenticationOptions, registrationOptions, verifyPasskey, verifyRegistration } from "./core/passkey.ts";
import { Refusal } from "./core/refusal.ts";
import { esc, panels } from "./panels.ts";

// The local page: the list of pending actions with Approve and Reject, passkey registration, and four read-only
// panels (invoices, unpaid, the year's P&L, recent changes) that load from /data. It listens on loopback only and
// loads nothing from anywhere else. Every approve or reject carries a one-time code the page itself handed out, so a
// bare POST to a guessed address does nothing. There is no other way to change the books here; the agent does that.

const GRANT_MS = 15 * 60_000;

type Grant =
  | { kind: "act"; pendingId: number; challenge?: string; expires: number }
  | { kind: "register"; challenge: string; expires: number };

export interface Page {
  url: string;
  port: number;
  stop(): void;
}

export function startPage(o: { books: string; port: number; env: Env; dataDelayMs?: number }): Page {
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
    const db = openBooks(file, openOptions(o.env));
    try {
      return await f(db);
    } finally {
      db.close();
    }
  };

  /** For what the page only reads: the books must already be there, so a missing file is an error, never new books. */
  const readBooks = <T>(f: (db: Books) => T | Promise<T>): Promise<T> => {
    if (!existsSync(file)) return Promise.reject(new Error("the file is not there"));
    return withBooks(f);
  };
  /** Says, in plain words, that the books can't be read and what to do about it. */
  const unreadable = (e: unknown) => {
    const why = e instanceof Refusal ? e.reason : e instanceof Error ? e.message : String(e);
    console.error("solobooks serve: can't read the books:", why);
    return `solobooks can't read the books file at ${file} (${why}). Check the file is there and that you can open it, or run solobooks doctor --books ${o.books} to see what's wrong, then reload this page.`;
  };

  const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
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
      let page: string;
      try {
        page = await readBooks(render);
      } catch (e) {
        page = html({ error: unreadable(e) });
      }
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    if (req.method === "GET" && url.pathname === "/data") {
      // The panels, read fresh on every load. SOLOBOOKS_PAGE_DELAY_MS (read by serve only) holds the answer back so
      // the loading state can be seen.
      if (o.dataDelayMs) await Bun.sleep(o.dataDelayMs);
      try {
        return json(200, { ok: true, panels: await readBooks((db) => panels(db, now(o.env))) });
      } catch (e) {
        return refused(503, unreadable(e), "books");
      }
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
    return html({ cards: items.map((i) => card(i.p, levelToApprove(db, i.p), !!i.passkey)), passkeyCreated: keyRow?.created_at ?? null, data });
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

const LEVEL_TEXT = { click: "Click to approve", passkey: "Passkey required", agent_decides: "Agent decides" } as const;

function card(p: PendingAction, level: keyof typeof LEVEL_TEXT, passkeyReady: boolean): string {
  const batch = p.op === "invoice_issue" && Array.isArray(p.input.ids);
  // The same labeled fields the chat prompt shows: every line, the note, terms, due date and payment instructions.
  const rows = promptFields(p)
    .map((fields, i) => {
      const it = p.items[i] as { invoice_id?: number };
      const list = `<dl>${fields.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
      if (!batch) return `<li>${list}</li>`;
      return `<li><label><input type="checkbox" checked data-batch="${p.id}" value="${it.invoice_id}"> Keep in this batch</label>${list}</li>`;
    })
    .join("");
  const hint = batch ? `<p class="hint">Untick an invoice to keep it a draft.</p>` : "";
  const blocked = level === "passkey" && !passkeyReady;
  return `<article class="card" id="pending-${p.id}">
  <header><span class="level ${level}">${LEVEL_TEXT[level]}</span><span class="meta">#${p.id} &middot; asked by ${esc(field(p.source))}</span></header>
  <h3>${esc(p.title)}</h3>
  <ul class="docs">${rows}</ul>${hint}
  <div class="actions">
    <button class="approve" data-approve="${p.id}"${blocked ? " disabled" : ""}>${level === "passkey" ? "Approve with passkey" : "Approve"}</button>
    <button class="reject" data-reject="${p.id}">Reject</button>
  </div>
  <p class="outcome" role="status"></p>
</article>`;
}

const PANELS = [
  ["invoices", "Invoices", "invoices"],
  ["unpaid", "Unpaid", "what is owed"],
  ["pnl", "Profit and loss this year", "the profit and loss"],
  ["changes", "Recent changes", "recent changes"],
] as const;

type View = { cards: string[]; passkeyCreated: string | null; data: unknown } | { error: string };

function html(v: View): string {
  const error = "error" in v ? v.error : null;
  const data = "error" in v ? { pending: [], register: null } : v.data;
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");
  let approvals: string;
  let passkey = "";
  if ("error" in v) {
    approvals = `<p class="state error">solobooks can't read the books, so it can't show what is waiting for your approval, and nothing can be approved here until it can.</p>`;
  } else {
    approvals = v.cards.length ? v.cards.join("\n") : `<p class="empty">Nothing is waiting for approval.</p>`;
    passkey = `<section class="passkey"><h2>Passkey</h2>${
      v.passkeyCreated
        ? `<p>A passkey is registered for these books (since ${esc(v.passkeyCreated.slice(0, 10))}). Actions set to passkey need it.</p>`
        : `<p>No passkey yet. Register one to use the passkey level for any action.</p>
       <button id="register">Register a passkey</button><p class="outcome" id="register-outcome" role="status"></p>`
    }</section>`;
  }
  const loading = (label: string) =>
    `<p class="state loading">Loading ${label}…</p><div class="skeleton" aria-hidden="true"><i></i><i></i><i></i></div>`;
  const panelHtml = PANELS.map(
    ([id, title, label]) =>
      `<section class="block" aria-labelledby="h-${id}"><h2 id="h-${id}">${title}</h2><div class="panel" id="panel-${id}" data-label="${label}" aria-busy="true" aria-live="polite">${loading(label)}</div></section>`,
  ).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>solobooks</title>
<style>
:root { color-scheme:light dark; --bg:#f6f5f2; --card:#fff; --ink:#1d1d1b; --muted:#6b6a66; --line:#e4e2dc; --ok:#1f7a4d; --on-ok:#fff; --bad:#a33a2b; --accent:#2c5fd6; }
@media (prefers-color-scheme: dark) { :root { --bg:#161615; --card:#21211f; --ink:#ecebe7; --muted:#a09e98; --line:#34332f; --ok:#5cc28f; --on-ok:#0d2418; --bad:#e07b6c; --accent:#7ea2ff; } }
* { box-sizing: border-box; }
html { background:var(--bg); }
body { margin:0; min-height:100vh; min-height:100dvh; background:var(--bg); color:var(--ink); font:16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width:720px; margin:0 auto; padding:32px 16px 64px; }
h1 { font-size:22px; margin:0 0 4px; } .lede { color:var(--muted); margin:0 0 28px; }
.alert { border:1px solid var(--bad); color:var(--bad); background:var(--card); border-radius:12px; padding:12px 16px; margin:0 0 24px; overflow-wrap:anywhere; }
.alert p { margin:0; } .alert[hidden] { display:none; }
.block { margin:0 0 28px; } .block > h2, .approvals > h2 { font-size:17px; margin:0 0 10px; }
.approvals > .lede { margin:-6px 0 14px; font-size:15px; }
.panel { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:2px 16px 4px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin:0 0 16px; }
.card header { display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; font-size:13px; color:var(--muted); }
.level { font-weight:600; color:var(--accent); }
.card h3 { font-size:18px; margin:8px 0; overflow-wrap:anywhere; }
.card ul.docs { list-style:none; margin:0 0 8px; padding:0; overflow-wrap:anywhere; } .card ul.docs > li { margin:8px 0; padding-top:8px; border-top:1px solid var(--line); }
.card dl { display:grid; grid-template-columns:max-content 1fr; gap:2px 12px; margin:6px 0 0; font-size:15px; }
.card dt { color:var(--muted); } .card dd { margin:0; overflow-wrap:anywhere; }
.hint { color:var(--muted); font-size:14px; margin:0 0 8px; }
.actions { display:flex; gap:8px; margin-top:12px; }
button { font:inherit; padding:8px 16px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--ink); cursor:pointer; }
button.approve { background:var(--ok); border-color:var(--ok); color:var(--on-ok); } button:disabled { opacity:.5; cursor:default; }
.outcome { margin:8px 0 0; font-size:14px; } .outcome.ok { color:var(--ok); } .outcome.bad { color:var(--bad); }
section.passkey { border-top:1px solid var(--line); margin-top:36px; padding-top:16px; color:var(--muted); } section.passkey h2 { font-size:17px; color:var(--ink); }
.empty { color:var(--muted); }
table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
th { text-align:left; font-size:12px; font-weight:500; color:var(--muted); padding:12px 8px 6px 0; border-bottom:1px solid var(--line); }
td { padding:10px 8px 10px 0; vertical-align:top; border-bottom:1px solid var(--line); overflow-wrap:anywhere; }
tbody:last-of-type tr:last-child td { border-bottom:0; }
th.num, td.num { text-align:right; white-space:nowrap; padding-right:0; }
td.two > span { display:block; } .sub { display:block; font-size:13px; color:var(--muted); } .sub.inline { display:inline; }
.strong { font-weight:600; } .bad { color:var(--bad); } .muted { color:var(--muted); }
.tag { display:inline-block; font-size:11px; line-height:16px; padding:0 6px; border:1px solid var(--line); border-radius:999px; color:var(--muted); vertical-align:1px; }
tfoot td { font-weight:600; border-top:1px solid var(--line); border-bottom:0; } tfoot .late-total td { color:var(--bad); font-weight:500; }
.pnl .group th { padding-top:16px; font-size:13px; font-weight:600; color:var(--ink); border-bottom:0; }
.pnl .line { display:inline-block; min-width:2.4em; color:var(--muted); }
.pnl .subtotal td { color:var(--muted); }
.basis { font-size:13px; color:var(--muted); margin:12px 0 0; }
.changes { list-style:none; margin:0; padding:0; } .changes li { padding:10px 0; border-bottom:1px solid var(--line); overflow-wrap:anywhere; } .changes li:last-child { border-bottom:0; }
.changes .what { display:block; }
.state { margin:12px 0; color:var(--muted); } .state strong { color:var(--ink); font-weight:600; } .state.error { color:var(--bad); }
.foot { font-size:13px; color:var(--muted); margin:8px 0; }
.skeleton i { display:block; height:12px; margin:0 0 14px; border-radius:6px; background:var(--line); animation:pulse 1.4s ease-in-out infinite; }
.skeleton i:nth-child(2) { width:80%; } .skeleton i:nth-child(3) { width:60%; }
@keyframes pulse { 50% { opacity:.45; } }
@media (prefers-reduced-motion: reduce) { .skeleton i { animation:none; } }
</style></head>
<body><main>
<h1>Your books</h1>
<p class="lede">Your agent keeps them. This page is for a look, and for approving what it asks.</p>
<div class="alert" id="alert" role="alert"${error ? "" : " hidden"}><p>${esc(error ?? "")}</p></div>
<section class="approvals" aria-labelledby="h-approvals">
<h2 id="h-approvals">Waiting for your approval</h2>
<p class="lede">Your agent asked for these. Nothing happens until you approve.</p>
${approvals}
</section>
${panelHtml}
${passkey}
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
async function loadPanels() {
  let r;
  try { r = await (await fetch("/data", { cache: "no-store" })).json(); }
  catch (e) { r = { ok: false, refusal: { reason: "This page can't reach solobooks, so start it again with solobooks serve and reload this page." } }; }
  for (const el of document.querySelectorAll(".panel[aria-busy]")) {
    const name = el.id.slice("panel-".length);
    el.removeAttribute("aria-busy");
    if (r.ok) { el.innerHTML = r.panels[name]; continue; }
    const p = document.createElement("p");
    p.className = "state error";
    p.textContent = "Can't show " + el.dataset.label + " while the books can't be read.";
    el.replaceChildren(p);
  }
  if (!r.ok) {
    const a = document.getElementById("alert");
    a.firstElementChild.textContent = (r.refusal && r.refusal.reason) || "The books can't be read right now. Reload this page to try again.";
    a.hidden = false;
  }
  for (const t of document.querySelectorAll("time[datetime]")) {
    const d = new Date(t.dateTime);
    if (!isNaN(d)) t.textContent = d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
}
loadPanels();
</script>
</body></html>`;
}
