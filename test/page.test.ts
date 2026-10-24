import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { run, serve } from "../src/cli.ts";
import { openBooks } from "../src/core/db.ts";
import { startPage, type Page } from "../src/page.ts";
import { clickAcme, draftOctober, json, ok, S } from "./support/billing.ts";
import { cli, dbPath, tempDir } from "./support/books.ts";
import { setUpPerson } from "./support/person.ts";
import { cliArgs, SCENARIO } from "./support/scenario.ts";

// The human page's four read-only panels (F14). The screenshots of each state in a real browser are the
// maintainer's; these prove what the server hands the browser, and that nothing on the page takes data entry.

/** The page's clock: mid-December, so October's invoices are overdue and the P&L covers most of the year. */
const ENV = { SOLOBOOKS_NOW: "2026-12-15T12:00:00.000Z" };
let pages: Page[] = [];
afterEach(() => {
  pages.forEach((p) => p.stop());
  pages = [];
});

function start(dir: string, dataDelayMs = 0): Page {
  const p = startPage({ books: dir, port: 0, env: ENV, dataDelayMs });
  pages.push(p);
  return p;
}

const page = async (p: Page) => {
  const r = await fetch(p.url);
  expect(r.status).toBe(200);
  return r.text();
};
const data = async (p: Page) => {
  const r = await fetch(new URL("/data", p.url));
  return { status: r.status, body: (await r.json()) as any };
};

/** Books with one pass through every operation, plus a past invoice from August still owed. */
async function populated(): Promise<string> {
  const dir = tempDir();
  await setUpPerson(dir);
  for (const step of SCENARIO) expect((await cli(dir, cliArgs(step))).code).toBe(0);
  await ok(dir, json(["invoice", "import"], { client_id: 2, number: 899, invoice_date: "2026-08-01", lines: [{ description: "July retainer", amount_cents: 300000 }] }));
  return dir;
}

/** New books, as the first command against an empty folder leaves them. */
function fresh(): string {
  const dir = tempDir();
  openBooks(dbPath(dir)).close();
  return dir;
}

const PANELS = ["invoices", "unpaid", "pnl", "changes"];

test("ISC-102.4 four panels: populated books show invoices, unpaid, the year's P&L and recent changes, in dollars", async () => {
  const dir = await populated();
  const { status, body } = await data(start(dir));
  expect(status).toBe(200);
  expect(Object.keys(body.panels).sort()).toEqual([...PANELS].sort());
  const { invoices, unpaid, pnl, changes } = body.panels as Record<string, string>;

  // Invoices: number, client, date, total, status, and historical marked.
  for (const s of ["1043", "1044", "1045", "CN-1", "899", "Acme", "Beta", "Oct 22, 2026", "Void", "Paid", "Credit note on 1043", ">historical<"]) {
    expect(invoices).toContain(s);
  }
  expect(invoices).toContain("$791.06");

  // Unpaid: most days late first, each with its days late.
  expect(unpaid.indexOf("899")).toBeLessThan(unpaid.indexOf("1045"));
  expect(unpaid).toContain("121 days late");
  expect(unpaid).toContain("24 days late");
  expect(unpaid).toContain("Due Nov 21, 2026");

  // P&L: the year to date, cash basis and saying so, by Schedule C line.
  expect(pnl).toContain("<strong>Cash basis</strong>, Jan 1, 2026 to Dec 15, 2026");
  for (const s of ["Gross receipts or sales", "Contract labor", "Office expense", "not on a Schedule C line", "Net profit"]) expect(pnl).toContain(s);

  // Recent changes: the newest history rows in plain words, each with its source.
  expect(changes.indexOf("Brought in past invoice 899 for Beta")).toBeLessThan(changes.indexOf("Asked for your approval: Change approval levels?"));
  expect(changes.match(/<li>/g)).toHaveLength(10);
  expect(changes.match(/by <span class="source">[^<]+<\/span>/g)).toHaveLength(10);
  expect(changes).not.toMatch(/_add|_set|_import/); // words, not operation names

  // Money is dollars, never cents, and every figure sits in a right-aligned number cell.
  const all = Object.values(body.panels).join("");
  const figures = [...all.matchAll(/<td class="num">([^<]*)<\/td>/g)].map((m) => m[1]);
  expect(figures.length).toBeGreaterThan(15);
  for (const f of figures) expect(f).toMatch(/^−?\$\d{1,3}(,\d{3})*\.\d\d$/);
  expect(all).not.toMatch(/_cents|\d{5,}(?![^<]*>)/);
}, 60_000);

test("ISC-102.1 loading: the page arrives with a loading state in every panel, and the data follows from /data", async () => {
  const dir = fresh();
  const p = start(dir, 400);
  const t0 = performance.now();
  const html = await page(p);
  expect(performance.now() - t0).toBeLessThan(400); // the page itself isn't held back
  for (const name of PANELS) expect(html).toMatch(new RegExp(`id="panel-${name}"[^>]*aria-busy="true"[^>]*>\\s*<p class="state loading">Loading `));
  const t1 = performance.now();
  expect((await data(p)).body.ok).toBe(true);
  expect(performance.now() - t1).toBeGreaterThanOrEqual(390);

  // The delay is serve's test seam, from SOLOBOOKS_PAGE_DELAY_MS, and nothing else sets it.
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = String(probe.port);
  probe.stop(true);
  const served = await serve(["serve", "--books", dir, "--port", port], { ...ENV, SOLOBOOKS_PAGE_DELAY_MS: "300" });
  pages.push(served);
  const t2 = performance.now();
  await data(served);
  expect(performance.now() - t2).toBeGreaterThanOrEqual(290);
  expect(serve(["serve", "--books", dir], { SOLOBOOKS_PAGE_DELAY_MS: "soon" })).rejects.toMatchObject({ field: "SOLOBOOKS_PAGE_DELAY_MS" });
}, 30_000);

test("ISC-102.2 error: unreadable books give a plain-words error in the approvals and every panel, never a crash", async () => {
  const dir = await clickAcme();
  const d = await draftOctober(dir);
  await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S]); // waits for approval
  const p = start(dir);
  expect(await page(p)).toContain('class="card"');

  const check = async () => {
    const html = await page(p);
    expect(html).toMatch(/<div class="alert" id="alert" role="alert"><p>solobooks can&#39;t read the books file at .*solobooks doctor --books/);
    expect(html).toContain("can't show what is waiting for your approval, and nothing can be approved here until it can.");
    expect(html).not.toContain('class="card"');
    const { status, body } = await data(p);
    expect(status).toBe(503);
    expect(body).toMatchObject({ ok: false, refusal: { field: "books" } });
    expect(body.refusal.reason).toStartWith("solobooks can't read the books file at ");
    expect(body.refusal.reason).toEndWith("then reload this page.");
  };

  writeFileSync(dbPath(dir), "this is not a books file, it is a shopping list");
  await check();
  if (process.getuid?.() !== 0) {
    // Real books this user can't read.
    rmSync(dbPath(dir));
    openBooks(dbPath(dir)).close();
    chmodSync(dbPath(dir), 0o000);
    await check();
    chmodSync(dbPath(dir), 0o600);
  }
  rmSync(dbPath(dir));
  await check();
  expect(existsSync(dbPath(dir))).toBe(false); // a page read never makes new, empty books in its place
}, 30_000);

test("ISC-102.3 empty: new books show an empty state in each panel, each saying the agent fills it", async () => {
  const p = start(fresh());
  expect(await page(p)).toContain("Nothing is waiting for approval.");
  const { body } = await data(p);
  for (const name of PANELS) {
    expect(body.panels[name]).toMatch(/<p class="state empty"><strong>[^<]+<\/strong> Your agent fills this in[^<]*<\/p>/);
    expect(body.panels[name]).not.toContain("<table");
  }
});

test("the data endpoint answers only GET on localhost, like the page", async () => {
  const p = start(fresh());
  // fetch() sets Host itself, so these go through node:http, which sends the Host given.
  const raw = (host: string) =>
    new Promise<number>((res, rej) =>
      request({ hostname: "127.0.0.1", port: p.port, path: "/data", headers: { host } }, (r) => (r.resume(), res(r.statusCode!))).on("error", rej).end(),
    );
  expect(await raw(`localhost:${p.port}`)).toBe(200);
  expect(await raw(`evil.example:${p.port}`)).toBe(403);
  expect(await raw(`evil.example`)).toBe(403);
  expect((await fetch(new URL("/data", p.url), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
});

// ---------------------------------------------------------------- ISC-103

const ENTRY = "input, textarea, select, form, button, [contenteditable]";

/**
 * Every control in a piece of markup that isn't approve or reject. Allowed: each card's Approve and Reject buttons,
 * the checkbox that pulls an invoice out of a batch before approving it, and the passkey register button.
 */
async function entryControls(html: string): Promise<string[]> {
  const found: string[] = [];
  const scripts: string[] = [];
  let script = "";
  await new HTMLRewriter()
    .on(ENTRY, {
      element(e) {
        const tag = e.tagName.toLowerCase();
        const allowed =
          (tag === "button" && (e.hasAttribute("data-approve") || e.hasAttribute("data-reject") || e.getAttribute("id") === "register")) ||
          (tag === "input" && e.getAttribute("type") === "checkbox" && e.hasAttribute("data-batch"));
        if (!allowed) found.push(`<${tag} ${[...e.attributes].map(([k, v]) => `${k}="${v}"`).join(" ")}>`);
      },
    })
    .on("script", {
      text(t) {
        script += t.text;
        if (t.lastInTextNode) (scripts.push(script), (script = ""));
      },
    })
    .transform(new Response(html))
    .text();
  // Markup a script would put on the page: tags written into strings, or elements it creates.
  for (const s of scripts) {
    for (const m of s.matchAll(/<\s*(input|textarea|select|form|button)\b|createElement\(\s*["'`](input|textarea|select|form|button)|contentEditable|\.innerHTML\s*=(?!\s*r\.panels\[name\])/gi)) {
      found.push(`script: ${m[0]}`);
    }
  }
  return found;
}

/** The page and everything its script places on it: the served HTML plus each panel /data hands it. */
async function everything(p: Page): Promise<string[]> {
  const { body } = await data(p);
  return [await page(p), ...(body.ok ? Object.values(body.panels as Record<string, string>) : [])];
}

test("ISC-103 no entry forms: the check itself catches planted entry controls, in markup and in script", async () => {
  const planted = [
    `<form action="/x"><button>Save</button></form>`,
    `<input name="amount">`,
    `<input type="checkbox" name="paid">`,
    `<textarea></textarea>`,
    `<select><option>1</option></select>`,
    `<div contenteditable="true"></div>`,
    `<button id="edit">Edit</button>`,
    `<script>el.innerHTML = "<input name=x>";</script>`,
    `<script>document.body.append(document.createElement("input"));</script>`,
  ];
  for (const html of planted) expect((await entryControls(html)).length).toBeGreaterThan(0);
  expect(await entryControls(`<button data-approve="1">Approve</button><button data-reject="1">Reject</button><input type="checkbox" data-batch="1" value="2"><button id="register">Register a passkey</button>`)).toEqual([]);
});

test("ISC-103 no entry forms: the page, in every state, has no controls besides approve and reject", async () => {
  // Pending approvals including a batch, and no passkey yet, so every allowed control is on the page.
  const batch = await clickAcme();
  const a = await draftOctober(batch);
  await ok(batch, ["time", "add", "--client-id", "1", "--date", "2026-12-02", "--minutes", "60", "--note", "December", ...S]);
  const b = (await ok(batch, ["invoice", "draft", "--client-id", "1", "--period-start", "2026-12-01", "--period-end", "2026-12-31", ...S])).invoice;
  await ok(batch, ["invoice", "issue", "--ids", `${a.id},${b.id}`, ...S]);
  const withBatch = start(batch);
  const shown = await page(withBatch);
  expect(shown).toContain("data-batch=");
  expect(shown).toContain('id="register"');

  const broken = fresh();
  const unreadable = start(broken);
  writeFileSync(dbPath(broken), "not books");

  for (const p of [withBatch, start(await populated()), start(fresh()), unreadable]) {
    for (const html of await everything(p)) expect(await entryControls(html)).toEqual([]);
  }
}, 60_000);

// ---------------------------------------------------------------- the design (ISC-113..117)

/** The page's own stylesheet, as the browser gets it. */
const styles = (html: string) => html.match(/<style>([\s\S]*?)<\/style>/)![1]!;

test("ISC-113 summary strip: owed, overdue, net profit and waiting each equal the reports they come from", async () => {
  const dir = await populated();
  const p = start(dir);
  const html = await page(p);
  for (const id of ["owed", "overdue", "net", "waiting"]) expect(html).toContain(`id="fig-${id}"`);
  const { body } = await data(p);
  // The reports as the agent would run them, on the page's clock.
  const report = async (args: string[]) => JSON.parse((await run([...args, ...S, "--books", dir], ENV)).stdout);
  const unpaidReport = await report(["report", "unpaid"]);
  const pnlReport = await report(["report", "pnl", "--from", "2026-01-01", "--to", "2026-12-15"]);
  const db = openBooks(dbPath(dir));
  const { n } = db.query("SELECT COUNT(*) AS n FROM pending_actions WHERE status = 'pending'").get() as { n: number };
  db.close();
  expect(body.summary).toMatchObject({
    owed_cents: unpaidReport.open_total_cents,
    overdue_cents: unpaidReport.overdue_total_cents,
    net_cents: pnlReport.net_cents,
    year: "2026",
    waiting: n,
  });
  expect(body.summary.overdue_cents).toBeGreaterThan(0);
  expect(body.summary.counts.unpaid).toBe(unpaidReport.invoices.length);
}, 60_000);

test("ISC-114 type: figures, labels and the wordmark use the system monospace face with tabular figures; no font files", async () => {
  const html = await page(start(fresh()));
  const css = styles(html);
  expect(css).toMatch(/--mono:ui-monospace,/);
  for (const sel of [".label", ".mark", ".fig .value", "td.num", "th", "button"]) {
    const rules = [...css.matchAll(new RegExp(`(^|[\\s},])${sel.replace(/\./g, "\\.")} \\{([^}]*)\\}`, "gm"))].map((m) => m[2]!);
    expect(rules.some((r) => r.includes("var(--mono)"))).toBe(true);
  }
  expect(css).toMatch(/\.fig \.value \{[^}]*tabular-nums/);
  expect(css).toMatch(/table \{[^}]*tabular-nums/);
  expect(html).not.toMatch(/@font-face|url\(|<link\b|fonts\.googleapis/i);
});

/** WCAG contrast ratio of two #rrggbb colors. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

test("ISC-116 contrast: body and muted text reach 4.5:1 on the page background, light and dark", async () => {
  const css = styles(await page(start(fresh())));
  const light = css.match(/^:root \{([^}]*)\}/m)![1]!;
  const dark = css.match(/prefers-color-scheme: dark\) \{ :root \{([^}]*)\}/)![1]!;
  const token = (block: string, name: string) => block.match(new RegExp(`--${name}:(#[0-9a-f]{6})`))![1]!;
  for (const block of [light, dark]) {
    for (const name of ["ink", "muted", "bad", "wait"]) expect(contrast(token(block, name), token(block, "bg"))).toBeGreaterThanOrEqual(4.5);
  }
});

test("ISC-117 flat: no corner radius over 4px, no shadow, no gradient anywhere on the page", async () => {
  const dir = await clickAcme();
  const d = await draftOctober(dir);
  await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S]); // a waiting card on the page
  const html = await page(start(dir));
  const css = styles(html);
  for (const m of css.matchAll(/border-radius:\s*([\d.]+)(px|%|em|rem)?/g)) {
    expect(m[2] ?? "px").toBe("px");
    expect(Number(m[1])).toBeLessThanOrEqual(4);
  }
  expect(html).not.toMatch(/box-shadow|text-shadow|gradient\(/);
}, 30_000);
