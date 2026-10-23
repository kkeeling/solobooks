import { parseKinds, requireClient, TAX_KINDS, type TaxKind } from "./clients.ts";
import type { Books } from "./db.ts";
import { addDays, monthName, taxCents, today } from "./format.ts";
import type { Ctx, Op } from "./op.ts";
import { getProfile, nextInvoiceNumber } from "./profile.ts";
import { Refusal } from "./refusal.ts";
import { getTimeEntry, timeLine } from "./time.ts";
import { MAX_CENTS } from "./validate.ts";

// Invoices and credit notes. Drafts are free; issuing locks the document, posts it to the ledger and gives it
// the next number. After that it can only be marked sent, voided (a reversing entry) or credited (a credit note).

export type InvoiceRow = {
  id: number;
  kind: "invoice" | "credit";
  status: "draft" | "issued" | "sent" | "void";
  client_id: number;
  number: number | null;
  credits_invoice_id: number | null;
  period_start: string;
  period_end: string;
  terms_days: number;
  invoice_date: string | null;
  due_date: string | null;
  tax_rate_ppm: number | null;
  tax_label: string | null;
  tax_applies_to: string | null;
  seller_legal_name: string | null;
  seller_address: string | null;
  seller_ein: string | null;
  seller_email: string | null;
  payment_instructions: string | null;
  client_name: string | null;
  client_address: string | null;
  client_email: string | null;
  note: string | null;
  created_at: string;
  issued_at: string | null;
  sent_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  source: string;
};

export type LineRow = {
  id: number;
  kind: "time" | "fixed" | "recurring" | "pass_through" | "manual";
  description: string;
  amount_cents: number;
  time_entry_id: number | null;
  milestone_id: number | null;
  engagement_id: number | null;
  cycle_start: string | null;
  expense_id: number | null;
  /** The date of what the line bills: the time entry's day, the milestone's billable day, the cycle start, the cost's day. */
  item_date: string | null;
};

export function getInvoiceRow(db: Books, id: number): InvoiceRow | null {
  return db.query("SELECT * FROM invoices WHERE id = ?").get(id) as InvoiceRow | null;
}

export function requireInvoice(db: Books, id: number, field = "id"): InvoiceRow {
  const r = getInvoiceRow(db, id);
  if (!r) throw new Refusal(`There is no invoice or credit note with id ${id}.`, field);
  return r;
}

export function linesOf(db: Books, invoiceId: number): LineRow[] {
  return db
    .query(
      `SELECT id, kind, description, amount_cents, time_entry_id, milestone_id, engagement_id, cycle_start, expense_id, item_date
       FROM invoice_lines WHERE invoice_id = ? ORDER BY id`,
    )
    .all(invoiceId) as LineRow[];
}

/** The printed number: 1043 for an invoice, CN-3 for a credit note, null for a draft. */
export function displayNumber(r: { kind: string; number: number | null }): string | null {
  if (r.number === null) return null;
  return r.kind === "credit" ? `CN-${r.number}` : String(r.number);
}

/** How a document is named in a sentence. */
export function docName(r: InvoiceRow): string {
  if (r.number === null) return `draft invoice ${r.id}`;
  return r.kind === "credit" ? `credit note ${displayNumber(r)}` : `invoice ${r.number}`;
}

/**
 * Sums, computed from the lines every time. Tax applies only to the kinds of line the person listed for the client.
 * A draft uses the client's current rate; an issued document the rate it was issued with.
 */
export function amounts(db: Books, r: InvoiceRow) {
  const lines = linesOf(db, r.id);
  const live = r.status === "draft" && r.kind === "invoice" ? requireClient(db, r.client_id) : null;
  const rate = live ? live.tax_rate_ppm : r.tax_rate_ppm;
  const label = live ? live.tax_label : r.tax_label;
  const kinds = live ? live.tax_applies_to : parseKinds(r.tax_applies_to);
  const sum = (ls: LineRow[]) => ls.reduce((s, l) => s + l.amount_cents, 0);
  const subtotal = sum(lines);
  const passThrough = sum(lines.filter((l) => l.kind === "pass_through"));
  const taxable = rate === null || kinds === null ? 0 : sum(lines.filter((l) => kinds.includes(l.kind)));
  // No taxable lines, no tax line.
  const tax =
    rate === null || taxable === 0
      ? null
      : { label: label ?? "Sales tax", rate_ppm: rate, applies_to: kinds, taxable_cents: taxable, amount_cents: taxCents(taxable, rate) };
  return { lines, subtotal, passThrough, tax, total: subtotal + (tax?.amount_cents ?? 0) };
}

/** Credit notes against an invoice that still stand. */
function creditsOf(db: Books, invoiceId: number): InvoiceRow[] {
  return db
    .query("SELECT * FROM invoices WHERE kind = 'credit' AND credits_invoice_id = ? AND status <> 'void' ORDER BY id")
    .all(invoiceId) as InvoiceRow[];
}

/** What is still owed on an invoice: its total less the credit notes against it. Payments arrive in a later step. */
export function openBalance(db: Books, r: InvoiceRow): number {
  return amounts(db, r).total - creditsOf(db, r.id).reduce((s, c) => s + amounts(db, c).total, 0);
}

export function invoiceView(db: Books, id: number) {
  const r = requireInvoice(db, id);
  const a = amounts(db, r);
  const original = r.credits_invoice_id === null ? null : getInvoiceRow(db, r.credits_invoice_id);
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    number: displayNumber(r),
    client_id: r.client_id,
    credits_invoice: original ? { id: original.id, number: displayNumber(original) } : null,
    period_start: r.period_start,
    period_end: r.period_end,
    terms_days: r.terms_days,
    invoice_date: r.invoice_date,
    due_date: r.due_date,
    // A line dated before the period was unbilled when the draft was made, so it was carried over.
    lines: a.lines.map((l) => ({ ...l, carried_over: l.item_date !== null && l.item_date < r.period_start })),
    subtotal_cents: a.subtotal,
    tax: a.tax,
    total_cents: a.total,
    open_cents: r.kind === "invoice" && r.status !== "draft" && r.status !== "void" ? openBalance(db, r) : null,
    note: r.note,
    created_at: r.created_at,
    issued_at: r.issued_at,
    sent_at: r.sent_at,
    voided_at: r.voided_at,
    void_reason: r.void_reason,
    source: r.source,
  };
}

// ---------------------------------------------------------------- ledger

const ACCOUNTS = {
  receivable: { name: "Accounts receivable", type: "asset" },
  services: { name: "Consulting income", type: "income" },
  reimbursed: { name: "Reimbursed expense income", type: "income" },
  salesTax: { name: "Sales tax payable", type: "liability" },
} as const;

/** The account a posting needs, created on first use. */
function account(db: Books, which: keyof typeof ACCOUNTS, ctx: Ctx): number {
  const { name, type } = ACCOUNTS[which];
  const found = db.query("SELECT id, type FROM accounts WHERE name = ?").get(name) as { id: number; type: string } | null;
  if (found) {
    if (found.type !== type) throw new Refusal(`The account named ${name} must be type ${type} for invoices to post to it.`, "id");
    return found.id;
  }
  return (db.query("INSERT INTO accounts (name, type, source) VALUES (?, ?, ?) RETURNING id").get(name, type, ctx.source) as { id: number }).id;
}

/**
 * Posts a document. "forward" is the receivable an invoice creates; "reverse" undoes one, which is what a credit
 * note does and what voiding does to the document it voids.
 */
function post(db: Books, r: InvoiceRow, direction: "forward" | "reverse", date: string, memo: string, ctx: Ctx): number {
  const a = amounts(db, r);
  const legs: [number, number][] = [
    [account(db, "receivable", ctx), a.total],
    [account(db, "services", ctx), -(a.subtotal - a.passThrough)],
    [account(db, "reimbursed", ctx), -a.passThrough],
    [account(db, "salesTax", ctx), -(a.tax?.amount_cents ?? 0)],
  ];
  const sign = direction === "forward" ? 1 : -1;
  const { id } = db.query("INSERT INTO entries (date, memo, source) VALUES (?, ?, ?) RETURNING id").get(date, memo, ctx.source) as {
    id: number;
  };
  const ins = db.query("INSERT INTO lines (entry_id, account_id, debit_cents, credit_cents, source) VALUES (?, ?, ?, ?, ?)");
  for (const [acct, amt] of legs) {
    const v = amt * sign;
    if (v > 0) ins.run(id, acct, v, 0, ctx.source);
    if (v < 0) ins.run(id, acct, 0, -v, ctx.source);
  }
  return id;
}

// ---------------------------------------------------------------- drafting

/** An item already on an invoice that wasn't voided can't be drafted again: that is what stops double billing. */
const ON_LIVE_INVOICE = (col: string) =>
  `EXISTS (SELECT 1 FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id WHERE l.${col} = x.id AND i.status <> 'void')`;

type NewLine = Omit<LineRow, "id">;

const blank = { time_entry_id: null, milestone_id: null, engagement_id: null, cycle_start: null, expense_id: null, item_date: null };

/** First days of the recurring-fee cycles that start between two days. */
function cycleStarts(interval: string, start: string, end: string): string[] {
  const step = interval === "monthly" ? 1 : interval === "quarterly" ? 3 : 12;
  const out: string[] = [];
  let [y, m] = start.split("-").map(Number) as [number, number];
  m = Math.floor((m - 1) / step) * step + 1; // back to this cycle's first month
  for (;;) {
    const d = `${y}-${String(m).padStart(2, "0")}-01`;
    if (d > end) return out;
    if (d >= start) out.push(d);
    m += step;
    if (m > 12) {
      m -= 12;
      y++;
    }
  }
}

function cycleName(interval: string, d: string): string {
  const [y, m] = d.split("-").map(Number) as [number, number];
  if (interval === "monthly") return `${monthName(m)} ${y}`;
  if (interval === "quarterly") return `Q${(m - 1) / 3 + 1} ${y}`;
  return String(y);
}

/**
 * Everything unbilled for a client dated on or before the period's end: time, billable milestones, recurring cycles
 * and pass-through costs. Items from before the period are carried over, so nothing billable is left behind.
 */
function unbilled(db: Books, clientId: number, start: string, end: string): NewLine[] {
  const lines: NewLine[] = [];
  const time = db
    .query(
      `SELECT x.id, x.date FROM time_entries x WHERE x.client_id = ? AND x.date <= ? AND NOT ${ON_LIVE_INVOICE("time_entry_id")}
       ORDER BY x.date, x.id`,
    )
    .all(clientId, end) as { id: number; date: string }[];
  for (const t of time) {
    lines.push({ ...blank, kind: "time", ...timeLine(db, getTimeEntry(db, t.id)!), time_entry_id: t.id, item_date: t.date });
  }

  const fixed = db
    .query(
      `SELECT x.id, x.name, x.amount_cents, x.billable_on, e.name AS engagement FROM milestones x JOIN engagements e ON e.id = x.engagement_id
       WHERE e.client_id = ? AND x.billable_on <= ? AND NOT ${ON_LIVE_INVOICE("milestone_id")} ORDER BY x.billable_on, x.id`,
    )
    .all(clientId, end) as { id: number; name: string; amount_cents: number; billable_on: string; engagement: string }[];
  for (const f of fixed) {
    lines.push({
      ...blank, kind: "fixed", description: `${f.engagement}: ${f.name}`, amount_cents: f.amount_cents, milestone_id: f.id, item_date: f.billable_on,
    });
  }

  const recurring = db
    .query("SELECT id, name, recurring_amount_cents AS amt, recurring_interval AS iv FROM engagements WHERE client_id = ? AND recurring_amount_cents IS NOT NULL ORDER BY id")
    .all(clientId) as { id: number; name: string; amt: number; iv: string }[];
  const liveCycles = `FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
     WHERE l.engagement_id = ? AND l.kind = 'recurring' AND i.status <> 'void'`;
  const billedCycle = db.query(`SELECT 1 ${liveCycles} AND l.cycle_start = ?`);
  const firstBilled = db.query(`SELECT MIN(l.cycle_start) AS d ${liveCycles}`);
  for (const e of recurring) {
    // An engagement has no start date, so cycles are owed from the first one ever billed; before any is billed,
    // the period's own cycles are where billing starts.
    const first = (firstBilled.get(e.id) as { d: string | null }).d;
    for (const d of cycleStarts(e.iv, first !== null && first < start ? first : start, end)) {
      if (billedCycle.get(e.id, d)) continue;
      lines.push({
        ...blank, kind: "recurring", description: `${e.name}, ${cycleName(e.iv, d)}`, amount_cents: e.amt, engagement_id: e.id, cycle_start: d, item_date: d,
      });
    }
  }

  const costs = db
    .query(
      `SELECT x.id, x.date, x.vendor, x.memo, x.amount_cents FROM expenses x
       WHERE x.pass_through_client_id = ? AND x.date <= ? AND NOT ${ON_LIVE_INVOICE("expense_id")} ORDER BY x.date, x.id`,
    )
    .all(clientId, end) as { id: number; date: string; vendor: string; memo: string | null; amount_cents: number }[];
  for (const c of costs) {
    const what = c.memo ? `${c.vendor}, ${c.memo}` : c.vendor;
    lines.push({
      ...blank, kind: "pass_through", description: `${c.date} ${what} (pass-through cost)`, amount_cents: c.amount_cents, expense_id: c.id, item_date: c.date,
    });
  }
  return lines;
}

function insertLines(db: Books, invoiceId: number, lines: NewLine[], ctx: Ctx): void {
  const ins = db.query(
    `INSERT INTO invoice_lines (invoice_id, kind, description, amount_cents, time_entry_id, milestone_id, engagement_id, cycle_start, expense_id, item_date, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const l of lines) {
    ins.run(invoiceId, l.kind, l.description, l.amount_cents, l.time_entry_id, l.milestone_id, l.engagement_id, l.cycle_start, l.expense_id, l.item_date, ctx.source);
  }
}

const manualLine = {
  type: "list",
  minItems: 1,
  description: "Extra lines, each with a description and amount_cents.",
  of: {
    description: { type: "text", required: true, description: "What the line is for." },
    amount_cents: { type: "int", required: true, min: 1, max: MAX_CENTS, unit: "cents", description: "Amount in cents." },
  },
} as const;

const manual = (ls: { description: string; amount_cents: number }[] | undefined): NewLine[] =>
  (ls ?? []).map((l) => ({ ...blank, kind: "manual", description: l.description, amount_cents: l.amount_cents }));

function requireDraft(db: Books, id: number, doing: string): InvoiceRow {
  const r = requireInvoice(db, id);
  if (r.status !== "draft") {
    throw new Refusal(`${cap(docName(r))} is ${r.status}, so it can't be ${doing}; void or credit it instead.`, "id");
  }
  return r;
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

const invoiceDraft: Op = {
  name: "invoice_draft",
  kind: "write",
  description:
    "Draft an invoice for a client and service period. It pulls in everything unbilled dated on or before the period's end: time, fixed-fee milestones billable by then, recurring fee cycles starting by then, and pass-through costs. Lines from before the period are marked carried_over. A draft holds no number and can be edited or deleted freely.",
  fields: {
    client_id: { type: "int", required: true, min: 1, description: "Client id." },
    period_start: { type: "date", required: true, description: "First day of the service period, YYYY-MM-DD." },
    period_end: { type: "date", required: true, description: "Last day of the service period, YYYY-MM-DD." },
    terms_days: { type: "int", min: 0, max: 365, unit: "days", description: "Days to pay after the invoice date. Default: the client's terms." },
    note: { type: "text", description: "A note printed on the invoice." },
    lines: manualLine,
  },
  run(db, input, ctx) {
    const client = requireClient(db, input.client_id);
    if (input.period_start > input.period_end) throw new Refusal("period_start must be on or before period_end.", "period_start");
    const lines = [...unbilled(db, client.id, input.period_start, input.period_end), ...manual(input.lines)];
    if (lines.length === 0) {
      throw new Refusal("Nothing unbilled for this client is dated on or before period_end, so there is nothing to draft.", "period_end");
    }
    const { id } = db
      .query(
        `INSERT INTO invoices (kind, status, client_id, period_start, period_end, terms_days, note, created_at, source)
         VALUES ('invoice', 'draft', ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(client.id, input.period_start, input.period_end, input.terms_days ?? client.terms_days, input.note ?? null, ctx.now, ctx.source) as {
      id: number;
    };
    insertLines(db, id, lines, ctx);
    return { invoice: invoiceView(db, id) };
  },
};

const invoiceEdit: Op = {
  name: "invoice_edit",
  kind: "write",
  description: "Change a draft invoice: its terms or note, remove lines, or add lines. Removed items go back to unbilled. Issued invoices can't be edited.",
  fields: {
    id: { type: "int", required: true, min: 1, description: "Draft invoice id." },
    terms_days: { type: "int", min: 0, max: 365, unit: "days", description: "Days to pay after the invoice date." },
    note: { type: "text", description: "A note printed on the invoice." },
    remove_lines: {
      type: "list",
      minItems: 1,
      description: "Lines to take off, each as line_id.",
      of: { line_id: { type: "int", required: true, min: 1, description: "Invoice line id." } },
    },
    add_lines: manualLine,
  },
  run(db, input, ctx) {
    const r = requireDraft(db, input.id, "edited");
    if (Object.keys(input).length === 1) throw new Refusal("Give at least one change to make to the draft.", "terms_days");
    (input.remove_lines ?? []).forEach((l: { line_id: number }, i: number) => {
      const found = db.query("SELECT 1 FROM invoice_lines WHERE id = ? AND invoice_id = ?").get(l.line_id, r.id);
      if (!found) throw new Refusal(`Line ${l.line_id} isn't on draft invoice ${r.id}.`, `remove_lines[${i}].line_id`);
      db.query("DELETE FROM invoice_lines WHERE id = ?").run(l.line_id);
    });
    insertLines(db, r.id, manual(input.add_lines), ctx);
    db.query("UPDATE invoices SET terms_days = ?, note = ?, source = ? WHERE id = ?").run(
      input.terms_days ?? r.terms_days,
      input.note ?? r.note,
      ctx.source,
      r.id,
    );
    return { invoice: invoiceView(db, r.id) };
  },
};

const invoiceDelete: Op = {
  name: "invoice_delete",
  kind: "write",
  destructive: true,
  description: "Delete a draft invoice; everything on it goes back to unbilled. Issued invoices are never deleted: void them instead.",
  fields: { id: { type: "int", required: true, min: 1, description: "Draft invoice id." } },
  run(db, input) {
    const r = requireInvoice(db, input.id);
    if (r.status !== "draft") {
      throw new Refusal(`${cap(docName(r))} is ${r.status}, and issued documents are never deleted, so void it instead.`, "id");
    }
    const view = invoiceView(db, r.id);
    db.query("DELETE FROM invoice_lines WHERE invoice_id = ?").run(r.id);
    db.query("DELETE FROM invoices WHERE id = ?").run(r.id);
    return { deleted: { invoice: view } };
  },
};

/**
 * Issues a draft: checks the 13 standard fields are there, copies the seller, client and tax details in, assigns the
 * next number and posts the receivable. One function, so the approval gate can wrap it.
 */
export function issueInvoice(db: Books, id: number, ctx: Ctx) {
  const r = requireDraft(db, id, "issued again");
  const p = getProfile(db);
  const missing = (
    [
      ["legal_name", "the business's legal name"],
      ["address", "the business address"],
      ["ein", "the business EIN"],
    ] as const
  ).find(([k]) => !p[k]);
  if (missing) throw new Refusal(`Set ${missing[1]} with profile set before issuing an invoice.`, missing[0]);
  const client = requireClient(db, r.client_id);
  if (!client.address) throw new Refusal(`Set client ${client.id}'s billing address with client edit before issuing an invoice.`, "address");
  const a = amounts(db, r);
  if (a.lines.length === 0) throw new Refusal(`Draft invoice ${r.id} has no lines, so add one before issuing it.`, "id");

  const number = nextInvoiceNumber(db);
  const date = today(ctx.now);
  db.query(
    `UPDATE invoices SET status = 'issued', number = ?, invoice_date = ?, due_date = ?, tax_rate_ppm = ?, tax_label = ?, tax_applies_to = ?,
       seller_legal_name = ?, seller_address = ?, seller_ein = ?, seller_email = ?, payment_instructions = ?,
       client_name = ?, client_address = ?, client_email = ?, issued_at = ? WHERE id = ?`,
  ).run(
    number,
    date,
    addDays(date, r.terms_days),
    client.tax_rate_ppm,
    client.tax_label,
    client.tax_applies_to?.join(",") ?? null,
    p.legal_name,
    p.address,
    p.ein,
    p.email,
    p.payment_instructions,
    client.name,
    client.address,
    client.email,
    ctx.now,
    r.id,
  );
  const issued = requireInvoice(db, r.id);
  post(db, issued, "forward", date, `Invoice ${number} to ${client.name}`, ctx);
  return { invoice: invoiceView(db, r.id) };
}

const invoiceIssue: Op = {
  name: "invoice_issue",
  kind: "write",
  description:
    "Issue a draft invoice: it gets the next invoice number and today's date, is posted to the books as money owed, and is locked. solobooks never sends it; report sending with invoice sent.",
  fields: { id: { type: "int", required: true, min: 1, description: "Draft invoice id." } },
  run(db, input, ctx) {
    return issueInvoice(db, input.id, ctx);
  },
};

const invoiceSent: Op = {
  name: "invoice_sent",
  kind: "write",
  description: "Record that the agent sent an issued invoice or credit note to the client. solobooks never sends anything itself.",
  fields: { id: { type: "int", required: true, min: 1, description: "Invoice or credit note id." } },
  run(db, input, ctx) {
    const r = requireInvoice(db, input.id);
    if (r.status === "draft") throw new Refusal(`Draft invoice ${r.id} hasn't been issued, so issue it before reporting it sent.`, "id");
    if (r.status !== "issued") throw new Refusal(`${cap(docName(r))} is already ${r.status}.`, "id");
    db.query("UPDATE invoices SET status = 'sent', sent_at = ? WHERE id = ?").run(ctx.now, r.id);
    return { invoice: invoiceView(db, r.id) };
  },
};

const invoiceVoid: Op = {
  name: "invoice_void",
  kind: "write",
  description:
    "Void an issued invoice or credit note. The record and its number stay; a reversing entry is posted, and what it billed goes back to unbilled.",
  fields: {
    id: { type: "int", required: true, min: 1, description: "Invoice or credit note id." },
    reason: { type: "text", required: true, description: "Why it is being voided." },
  },
  run(db, input, ctx) {
    const r = requireInvoice(db, input.id);
    if (r.status === "draft") throw new Refusal(`Draft invoice ${r.id} was never issued, so delete it instead.`, "id");
    if (r.status === "void") throw new Refusal(`${cap(docName(r))} is already void.`, "id");
    if (r.kind === "invoice" && creditsOf(db, r.id).length > 0) {
      throw new Refusal(`Invoice ${r.number} has credit notes against it, so credit the rest instead of voiding it.`, "id");
    }
    db.query("UPDATE invoices SET status = 'void', voided_at = ?, void_reason = ? WHERE id = ?").run(ctx.now, input.reason, r.id);
    const label = r.kind === "credit" ? `credit note ${displayNumber(r)}` : `invoice ${r.number}`;
    post(db, r, r.kind === "invoice" ? "reverse" : "forward", today(ctx.now), `Void ${label}: ${input.reason}`, ctx);
    return { invoice: invoiceView(db, r.id) };
  },
};

const invoiceCredit: Op = {
  name: "invoice_credit",
  kind: "write",
  description:
    "Issue a credit note against an issued invoice, reducing what the client owes. With no amount it credits everything still open; amount_cents is before tax. Tax is credited at the invoice's rate when line_kind is one the tax applied to.",
  fields: {
    invoice_id: { type: "int", required: true, min: 1, description: "The issued invoice being credited." },
    reason: { type: "text", required: true, description: "Why, printed on the credit note." },
    amount_cents: { type: "int", min: 1, max: MAX_CENTS, unit: "cents", description: "Amount to credit before tax. Default: all that is still open." },
    line_kind: {
      type: "enum", values: TAX_KINDS,
      description: "The kind of line a partial credit reduces, which decides whether tax is credited with it. Required when the invoice carries a tax rate; otherwise manual.",
    },
  },
  run(db, input, ctx) {
    const orig = requireInvoice(db, input.invoice_id, "invoice_id");
    if (orig.kind !== "invoice" || orig.status === "draft" || orig.status === "void") {
      throw new Refusal(`Only an issued invoice can be credited, and ${docName(orig)} is ${orig.kind === "credit" ? "a credit note" : orig.status}.`, "invoice_id");
    }
    const prior = creditsOf(db, orig.id);
    const a = amounts(db, orig);
    const creditedSubtotal = prior.reduce((s, c) => s + amounts(db, c).subtotal, 0);
    const openSubtotal = a.subtotal - creditedSubtotal;
    if (openSubtotal <= 0) throw new Refusal(`Invoice ${orig.number} is already fully credited.`, "invoice_id");
    const amount = input.amount_cents ?? openSubtotal;
    if (amount > openSubtotal) {
      throw new Refusal(`That is more than the ${openSubtotal} cents still open on invoice ${orig.number}, before tax.`, "amount_cents");
    }
    // A full first credit mirrors the invoice line by line; anything else is one line, of the kind the person names.
    const mirror = prior.length === 0 && amount === a.subtotal;
    if (!mirror && input.line_kind === undefined && orig.tax_rate_ppm !== null) {
      throw new Refusal(
        `Invoice ${orig.number} carries sales tax, so say in line_kind which kind of line this credit reduces.`,
        "line_kind",
      );
    }
    const kind: TaxKind = input.line_kind ?? "manual";
    const lines: NewLine[] = mirror
      ? a.lines.map((l) => ({ ...blank, kind: l.kind, description: l.description, amount_cents: l.amount_cents, item_date: l.item_date }))
      : [{ ...blank, kind, description: `Credit against invoice ${orig.number}: ${input.reason}`, amount_cents: amount }];
    const { id } = db
      .query(
        `INSERT INTO invoices (kind, status, client_id, credits_invoice_id, period_start, period_end, terms_days, note, created_at, source)
         VALUES ('credit', 'draft', ?, ?, ?, ?, 0, ?, ?, ?) RETURNING id`,
      )
      .get(orig.client_id, orig.id, orig.period_start, orig.period_end, input.reason, ctx.now, ctx.source) as { id: number };
    insertLines(db, id, lines, ctx);

    const { n } = db.query("SELECT MAX(number) AS n FROM invoices WHERE kind = 'credit'").get() as { n: number | null };
    const date = today(ctx.now);
    db.query(
      `UPDATE invoices SET status = 'issued', number = ?, invoice_date = ?, tax_rate_ppm = ?, tax_label = ?, tax_applies_to = ?,
         seller_legal_name = ?, seller_address = ?, seller_ein = ?, seller_email = ?, payment_instructions = ?,
         client_name = ?, client_address = ?, client_email = ?, issued_at = ? WHERE id = ?`,
    ).run(
      (n ?? 0) + 1,
      date,
      orig.tax_rate_ppm,
      orig.tax_label,
      orig.tax_applies_to,
      orig.seller_legal_name,
      orig.seller_address,
      orig.seller_ein,
      orig.seller_email,
      orig.payment_instructions,
      orig.client_name,
      orig.client_address,
      orig.client_email,
      ctx.now,
      id,
    );
    const credit = requireInvoice(db, id);
    if (openBalance(db, orig) < 0) {
      throw new Refusal(`Tax rounding would credit more than is still owed on invoice ${orig.number}, so credit a little less.`, "amount_cents");
    }
    post(db, credit, "reverse", date, `Credit note ${displayNumber(credit)} for invoice ${orig.number} to ${orig.client_name}`, ctx);
    return { credit_note: invoiceView(db, id) };
  },
};

const invoiceList: Op = {
  name: "invoice_list",
  kind: "read",
  description: "List invoices and credit notes with their lines and totals, optionally for one client or status.",
  fields: {
    client_id: { type: "int", min: 1, description: "Only this client's." },
    status: { type: "enum", values: ["draft", "issued", "sent", "void"], description: "Only this status." },
  },
  run(db, input) {
    const rows = db
      .query("SELECT id FROM invoices WHERE (?1 IS NULL OR client_id = ?1) AND (?2 IS NULL OR status = ?2) ORDER BY id")
      .all(input.client_id ?? null, input.status ?? null) as { id: number }[];
    return { invoices: rows.map((r) => invoiceView(db, r.id)) };
  },
};

const invoiceGet: Op = {
  name: "invoice_get",
  kind: "read",
  description: "Show one invoice or credit note with its lines and totals.",
  fields: { id: { type: "int", required: true, min: 1, description: "Invoice or credit note id." } },
  run(db, input) {
    return { invoice: invoiceView(db, input.id) };
  },
};

export const invoiceOps: Op[] = [invoiceDraft, invoiceEdit, invoiceDelete, invoiceIssue, invoiceSent, invoiceVoid, invoiceCredit, invoiceList, invoiceGet];
