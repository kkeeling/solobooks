import type { Books } from "./core/db.ts";
import { dollars, longDate, today } from "./core/format.ts";
import { getPending } from "./core/gate.ts";
import { invoiceView } from "./core/invoices.ts";
import type { Ctx } from "./core/op.ts";
import { findOp } from "./core/perform.ts";
import { pnl } from "./core/reports.ts";

// The four read-only panels on the local page: invoices, unpaid, the year's P&L and recent changes. Each is rendered
// here as markup from the books as they stand, so the page script only places it. Nothing here writes, and every
// piece of text the agent wrote is escaped and kept short.

export type PanelName = "invoices" | "unpaid" | "pnl" | "changes";
export type Panels = Record<PanelName, string>;

/** How many of the newest invoices and history rows the page shows; the agent can list the rest. */
export const SHOW_INVOICES = 15;
export const SHOW_CHANGES = 10;

export const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Agent-written text, flattened to one line and capped, then escaped. */
const short = (s: unknown, max = 80) => {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return esc(flat.length > max ? `${flat.slice(0, max - 1)}…` : flat);
};

/** Money as the page prints it: dollars with a true minus sign, so columns of figures line up. */
const money = (cents: number) => dollars(cents).replace(/^-/, "−");
const num = (cents: number) => `<td class="num">${money(cents)}</td>`;
const shortDate = (date: string) => longDate(date).replace(/^(\w{3})\w*/, "$1");

const empty = (what: string, hint: string) => `<p class="state empty"><strong>${what}</strong> ${hint}</p>`;
const historicalTag = `<span class="tag" title="Brought in from before solobooks. It gets no reminders.">historical</span>`;

export function panels(db: Books, nowIso: string): Panels {
  return { invoices: invoices(db), unpaid: unpaid(db, nowIso), pnl: profit(db, nowIso), changes: changes(db) };
}

/** The four figures across the top of the page, and the counts beside each panel's label. */
export interface Summary {
  owed_cents: number;
  overdue_cents: number;
  net_cents: number;
  year: string;
  waiting: number;
  counts: { invoices: number; unpaid: number; changes: number };
}

export function summary(db: Books, nowIso: string): Summary {
  const u = findOp("report_unpaid")!.run(db, {}, ctx(nowIso)) as { invoices: unknown[]; open_total_cents: number; overdue_total_cents: number };
  const to = today(nowIso);
  const count = (sql: string) => (db.query(sql).get() as { n: number }).n;
  return {
    owed_cents: u.open_total_cents,
    overdue_cents: u.overdue_total_cents,
    net_cents: pnl(db, `${to.slice(0, 4)}-01-01`, to).net_cents,
    year: to.slice(0, 4),
    waiting: count("SELECT COUNT(*) AS n FROM pending_actions WHERE status = 'pending'"),
    counts: { invoices: count("SELECT COUNT(*) AS n FROM invoices"), unpaid: u.invoices.length, changes: count("SELECT COUNT(*) AS n FROM history") },
  };
}

function clientNames(db: Books): Map<number, string> {
  const rows = db.query("SELECT id, name FROM clients").all() as { id: number; name: string }[];
  return new Map(rows.map((r) => [r.id, r.name]));
}

function invoices(db: Books): string {
  const { n } = db.query("SELECT COUNT(*) AS n FROM invoices").get() as { n: number };
  if (n === 0) return empty("No invoices yet.", "Your agent fills this in as it drafts and issues them.");
  const names = clientNames(db);
  const ids = db.query("SELECT id FROM invoices ORDER BY id DESC LIMIT ?").all(SHOW_INVOICES) as { id: number }[];
  const rows = ids.map(({ id }) => {
    const v = invoiceView(db, id);
    const credit = v.kind === "credit";
    const status =
      v.status === "draft" ? "Draft"
      : v.status === "void" ? "Void"
      : credit ? `Credit note${v.credits_invoice ? ` on ${esc(v.credits_invoice.number)}` : ""}`
      : v.open_cents === 0 ? "Paid"
      : v.open_cents !== null && v.open_cents < v.total_cents ? "Part paid"
      : v.status === "sent" ? "Sent"
      : "Issued, not sent";
    const number = v.number === null ? `Draft ${v.id}` : esc(v.number);
    return `<tr class="status-${v.status}${v.open_cents === 0 ? " paid" : ""}">
  <td class="two"><span class="strong">${number}</span><span class="sub">${short(names.get(v.client_id) ?? `client ${v.client_id}`, 48)}</span></td>
  <td class="two"><span>${v.invoice_date ? shortDate(v.invoice_date) : "Not issued"}</span><span class="sub">${status}${v.historical ? ` ${historicalTag}` : ""}</span></td>
  ${num(credit ? -v.total_cents : v.total_cents)}
</tr>`;
  });
  const more = n > SHOW_INVOICES ? `<p class="foot">The newest ${SHOW_INVOICES} of ${n}. Ask your agent for the rest.</p>` : "";
  return `<table><thead><tr><th>Invoice</th><th>Date</th><th class="num">Total</th></tr></thead><tbody>${rows.join("")}</tbody></table>${more}`;
}

type Unpaid = {
  number: string;
  client: string;
  due_date: string;
  open_cents: number;
  overdue: boolean;
  days_late: number;
  historical: boolean;
};

const ctx = (nowIso: string): Ctx => ({ source: "person:page", now: nowIso, files: [], page: "" });

function unpaid(db: Books, nowIso: string): string {
  const r = findOp("report_unpaid")!.run(db, {}, ctx(nowIso)) as { invoices: Unpaid[]; open_total_cents: number; overdue_total_cents: number };
  if (r.invoices.length === 0) {
    const { n } = db.query("SELECT COUNT(*) AS n FROM invoices WHERE kind = 'invoice' AND status IN ('issued', 'sent')").get() as { n: number };
    return n === 0
      ? empty("Nothing is owed yet.", "Your agent fills this in once invoices go out.")
      : empty("Nothing is owed.", "Every issued invoice is paid.");
  }
  const rows = r.invoices.map(
    (u) => `<tr class="${u.overdue ? "late" : ""}">
  <td class="two"><span class="strong">${esc(u.number)}</span><span class="sub">${short(u.client, 48)}${u.historical ? ` ${historicalTag}` : ""}</span></td>
  <td class="two"><span class="${u.overdue ? "bad" : ""}">${u.overdue ? `${u.days_late} day${u.days_late === 1 ? "" : "s"} late` : "Not due yet"}</span><span class="sub">Due ${shortDate(u.due_date)}</span></td>
  ${num(u.open_cents)}
</tr>`,
  );
  return `<table><thead><tr><th>Invoice</th><th>When</th><th class="num">Still owed</th></tr></thead><tbody>${rows.join("")}</tbody>
<tfoot>${r.overdue_total_cents ? `<tr class="late-total"><td colspan="2">Overdue</td>${num(r.overdue_total_cents)}</tr>` : ""}<tr><td colspan="2">Owed in all</td>${num(r.open_total_cents)}</tr></tfoot></table>`;
}

function profit(db: Books, nowIso: string): string {
  const to = today(nowIso);
  const from = `${to.slice(0, 4)}-01-01`;
  const p = pnl(db, from, to);
  const span = `<p class="basis"><strong>Cash basis</strong>, ${shortDate(from)} to ${shortDate(to)}. ${esc(p.basis_note.replace(/^Cash basis: /, "").replace(/^./, (c) => c.toUpperCase()))}</p>`;
  if (p.income.length === 0 && p.expense.length === 0) {
    return `${empty("Nothing earned or spent this year yet.", "Your agent fills this in as it records payments and expenses.")}${span}`;
  }
  const incomeIds = new Set(p.income.map((a) => a.account_id));
  const row = (label: string, cents: number) => `<tr><td>${label}</td>${num(cents)}</tr>`;
  const section = (title: string, income: boolean, total: number) => {
    const lines = p.schedule_c.filter((l) => l.account_ids.some((id) => incomeIds.has(id)) === income);
    const unplaced = (income ? p.income : p.expense).filter((a) => a.schedule_c === null);
    const body = [
      ...lines.map((l) => row(`<span class="line">${esc(l.line)}</span> ${esc(l.name)}`, l.total_cents)),
      ...unplaced.map((a) => row(`<span class="line">–</span> ${short(a.name, 48)} <span class="sub inline">not on a Schedule C line</span>`, a.total_cents)),
    ];
    if (body.length === 0) body.push(`<tr><td class="muted">None yet</td>${num(0)}</tr>`);
    return `<tbody><tr class="group"><th colspan="2">${title}</th></tr>${body.join("")}<tr class="subtotal"><td>Total ${title.toLowerCase()}</td>${num(total)}</tr></tbody>`;
  };
  return `${span}<table class="pnl"><thead><tr><th>Schedule C line</th><th class="num">Amount</th></tr></thead>
${section("Income", true, p.income_total_cents)}${section("Expenses", false, p.expense_total_cents)}
<tfoot><tr><td>Net profit</td>${num(p.net_cents)}</tr></tfoot></table>`;
}

type HistoryRow = { id: number; at: string; op: string; source: string; payload: string; result: string };

function changes(db: Books): string {
  const rows = db.query("SELECT id, at, op, source, payload, result FROM history ORDER BY id DESC LIMIT ?").all(SHOW_CHANGES) as HistoryRow[];
  if (rows.length === 0) return empty("No changes yet.", "Your agent fills this in; every change it makes shows here with who made it.");
  const names = clientNames(db);
  const items = rows.map((r) => {
    let what: string;
    try {
      what = describe(db, r.op, JSON.parse(r.payload)?.input ?? {}, JSON.parse(r.result) ?? {}, names);
    } catch {
      what = words(r.op);
    }
    return `<li><span class="what">${what}</span><span class="sub">by <span class="source">${short(r.source, 60)}</span> · <time datetime="${esc(r.at)}">${esc(r.at.slice(0, 16).replace("T", " "))} UTC</time></span></li>`;
  });
  return `<ol class="changes">${items.join("")}</ol>`;
}

/** An operation's name as words: "bank_unmatch" is "Bank unmatch". */
const words = (op: string) => esc(op.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()));

/** One history row in plain words, from the fixed wording below plus a few facts from what the write returned. */
function describe(db: Books, op: string, input: any, result: any, names: Map<number, string>): string {
  if (result.status === "pending") return `Asked for your approval: ${short(result.title, 120)}`;
  const inv = result.invoice ?? {};
  const pay = result.payment ?? {};
  const client = (id: unknown) => short(names.get(Number(id)) ?? `client ${id}`, 48);
  const title = (id: unknown) => short(getPending(db, Number(id))?.title ?? `pending action ${id}`, 120);
  const amount = (o: any) => (typeof o?.amount_cents === "number" ? ` of ${money(o.amount_cents)}` : "");
  const phrases: Record<string, () => string> = {
    profile_set: () => "Updated the business profile",
    profile_payment_instructions_set: () => "Changed the payment instructions printed on invoices",
    client_add: () => `Added client ${short(result.client?.name, 48)}`,
    client_edit: () => `Updated client ${short(result.client?.name, 48)}`,
    engagement_add: () => `Added engagement ${short(result.engagement?.name, 48)} for ${client(result.engagement?.client_id)}`,
    milestone_billable: () => `Marked a milestone ready to bill for ${client(result.engagement?.client_id)}`,
    time_add: () => `Logged ${Number(result.time_entry?.minutes)} minutes for ${client(result.time_entry?.client_id)}`,
    time_edit: () => `Changed a time entry for ${client(result.time_entry?.client_id)}`,
    time_delete: () => `Deleted a time entry for ${client(result.deleted?.time_entry?.client_id)}`,
    expense_add: () => `Recorded an expense${amount(result.expense)}${result.expense?.vendor ? ` at ${short(result.expense.vendor, 48)}` : ""}`,
    invoice_draft: () => `Drafted an invoice for ${client(inv.client_id)}`,
    invoice_edit: () => `Edited a draft invoice for ${client(inv.client_id)}`,
    invoice_delete: () => `Deleted a draft invoice for ${client(result.deleted?.invoice?.client_id)}`,
    invoice_issue: () =>
      Array.isArray(result.invoices)
        ? `Issued ${result.invoices.length} invoices`
        : `Issued invoice ${esc(inv.number)} to ${client(inv.client_id)} for ${money(inv.total_cents)}`,
    invoice_sent: () => `Marked invoice ${esc(inv.number)} as sent`,
    invoice_void: () => `Voided invoice ${esc(inv.number)}`,
    invoice_credit: () => `Issued credit note ${esc(result.credit_note?.number)} for ${money(result.credit_note?.total_cents)}`,
    invoice_import: () => `Brought in past invoice ${esc(inv.number)} for ${client(inv.client_id)}`,
    payment_add: () => `Recorded a payment${amount(pay)} on invoice ${esc(pay.invoice_number)}`,
    payment_refund: () => `Recorded a refund on invoice ${esc(pay.invoice_number)}`,
    client_credit_apply: () => `Applied client credit${amount(result.applied)} to invoice ${esc(result.applied?.invoice_number)}`,
    account_add: () => `Added account ${short(result.account?.name, 48)}`,
    account_edit: () => `Changed account ${short(result.account?.name, 48)}`,
    entry_post: () => `Posted a ledger entry${result.entry?.memo ? `: ${short(result.entry.memo, 60)}` : ""}`,
    transfer_add: () => `Recorded a transfer${amount(result.transfer)}`,
    owner_draw: () => `Recorded an owner draw${amount(result.draw)}`,
    owner_contribute: () => `Recorded an owner contribution${amount(result.contribution)}`,
    bank_import: () => `Imported a bank statement${result.import?.file ? `, ${short(result.import.file, 48)}` : ""}`,
    bank_match: () => "Matched a bank line to the books",
    bank_unmatch: () => "Undid a bank match",
    sales_tax_payment_add: () => `Recorded a sales tax payment${amount(result.sales_tax_payment)}`,
    mileage_add: () => `Logged a trip of ${esc(result.trip?.miles)} miles`,
    mileage_delete: () => "Deleted a trip",
    home_office_set: () => `Set the home office for ${esc(result.home_office?.year)}`,
    owner_item_add: () => `Recorded ${esc(String(result.owner_item?.kind ?? "an owner item").replace(/_/g, " "))}${amount(result.owner_item)}`,
    contractor_add: () => `Added contractor ${short(result.contractor?.name, 48)}`,
    contractor_edit: () => `Updated contractor ${short(result.contractor?.name, 48)}`,
    gate_set: () => "Changed approval levels",
    pending_approve: () => `Approved: ${title(input.pending_id)}`,
    pending_reject: () => `Rejected: ${title(input.pending_id)}`,
    passkey_register: () => "Registered a passkey",
  };
  return (phrases[op] ?? (() => words(op)))();
}
