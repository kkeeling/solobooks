import type { Books } from "./db.ts";
import { dollars, termsText } from "./format.ts";
import { getInvoiceRow, invoiceView } from "./invoices.ts";
import { getAccount } from "./ledger.ts";
import type { Ctx, GateAction, Op } from "./op.ts";
import { getProfile } from "./profile.ts";
import { Refusal } from "./refusal.ts";

// The approval gate. The person picks, per gated action, how much the agent may do alone. A gated request the
// person hasn't left to the agent is parked here, exactly as asked, and runs only when the person approves it on the
// local page or in the agent app's own prompt. No command or tool approves anything.

export const LEVELS = ["agent_decides", "click", "passkey"] as const;
export type Level = (typeof LEVELS)[number];

/** The gated actions whose level the person sets. Changing a level is gated too, always. */
export const ACTIONS = ["invoice_issue", "invoice_void", "invoice_credit", "payment_instructions", "payment_unmatched"] as const;
type SetAction = (typeof ACTIONS)[number];

/** A fresh install asks the person before anything reaches a client. */
export const DEFAULT_LEVEL: Level = "click";

/** Where `solobooks serve` listens unless told otherwise. localhost, because a passkey can't belong to an IP address. */
export const DEFAULT_PORT = 7317;
export const DEFAULT_PAGE = `http://localhost:${DEFAULT_PORT}/`;

const RANK: Record<Level, number> = { agent_decides: 0, click: 1, passkey: 2 };
export const stricter = (a: Level, b: Level): Level => (RANK[a] >= RANK[b] ? a : b);

const WHAT: Record<SetAction, string> = {
  invoice_issue: "issuing invoices",
  invoice_void: "voiding invoices and credit notes",
  invoice_credit: "issuing credit notes",
  payment_instructions: "changing the payment instructions printed on invoices",
  payment_unmatched: "recording an invoice payment with no imported bank line behind it",
};

export function levelOf(db: Books, action: SetAction): Level {
  const row = db.query("SELECT level FROM gate_levels WHERE action = ?").get(action) as { level: Level } | null;
  return row?.level ?? DEFAULT_LEVEL;
}

export function hasPasskey(db: Books): boolean {
  return db.query("SELECT 1 FROM passkeys LIMIT 1").get() !== null;
}

/**
 * The level a request has to clear. A gate setting change clears the stricter of each old and new level it touches,
 * and never less than click, so the gate can't be switched off without the person.
 */
export function requiredLevel(db: Books, action: GateAction, input: Record<string, any>): Level {
  if (action !== "gate_settings") return levelOf(db, action);
  let level: Level = "click";
  for (const a of ACTIONS) if (input[a] !== undefined) level = stricter(level, stricter(levelOf(db, a), input[a]));
  return level;
}

function gateView(db: Books) {
  return ACTIONS.map((action) => ({ action, what: WHAT[action], level: levelOf(db, action), levels: [...LEVELS], default: DEFAULT_LEVEL }));
}

// ---------------------------------------------------------------- pending actions

type PendingRow = {
  id: number;
  created_at: string;
  action: GateAction;
  op: string;
  input: string;
  level: "click" | "passkey";
  prompt: string;
  idempotency_key: string | null;
  status: "pending" | "approved" | "rejected";
  decided_at: string | null;
  decided_via: string | null;
  excluded: string | null;
  result: string | null;
  source: string;
};

export type PendingAction = Omit<PendingRow, "input" | "prompt" | "excluded" | "result"> & {
  input: Record<string, any>;
  title: string;
  items: Record<string, unknown>[];
  excluded: number[];
  result: Record<string, unknown> | null;
};

export function getPending(db: Books, id: number): PendingAction | null {
  const r = db.query("SELECT * FROM pending_actions WHERE id = ?").get(id) as PendingRow | null;
  if (!r) return null;
  const { prompt, ...row } = r;
  const shown = JSON.parse(prompt) as Prompt;
  return {
    ...row,
    input: JSON.parse(r.input),
    title: shown.title,
    items: shown.items,
    excluded: r.excluded ? JSON.parse(r.excluded) : [],
    result: r.result ? JSON.parse(r.result) : null,
  };
}

export function requirePending(db: Books, id: number, field = "pending_id"): PendingAction {
  const p = getPending(db, id);
  if (!p) throw new Refusal(`There is no pending action with id ${id}.`, field);
  return p;
}

export function pendingView(db: Books, id: number, page: string) {
  const { idempotency_key, ...p } = requirePending(db, id);
  return { ...p, idempotency_key, approve_url: `${page}#pending-${id}` };
}

/** What the person must clear to approve this pending action now: its own level, or a stricter one set since. */
export function levelToApprove(db: Books, p: PendingAction): Level {
  // A gate change is re-checked against the levels in force now, in case the person raised one meanwhile.
  const now = p.action === "gate_settings" ? requiredLevel(db, "gate_settings", p.input) : levelOf(db, p.action);
  return stricter(p.level, now);
}

type Prompt = { title: string; items: Record<string, unknown>[] };

/**
 * Everything issuing freezes into a document, read from the row as the action leaves it: what the person approves
 * and, at approval, what must still be true. Only the number may differ later.
 */
function frozen(db: Books, id: number, reason?: string) {
  const r = getInvoiceRow(db, id)!;
  const v = invoiceView(db, id);
  return {
    invoice_id: r.id,
    kind: r.kind,
    number: v.number,
    credits_invoice: v.credits_invoice?.number ?? null,
    client: r.client_name,
    client_address: r.client_address,
    client_email: r.client_email,
    seller: { legal_name: r.seller_legal_name, address: r.seller_address, ein: r.seller_ein, email: r.seller_email },
    payment_instructions: r.payment_instructions,
    period_start: r.period_start,
    period_end: r.period_end,
    invoice_date: r.invoice_date,
    terms_days: r.terms_days,
    due_date: r.due_date,
    note: r.note,
    lines: v.lines.map((l) => ({ kind: l.kind, description: l.description, amount_cents: l.amount_cents })),
    tax: v.tax ? { label: v.tax.label, rate_ppm: v.tax.rate_ppm, amount_cents: v.tax.amount_cents } : null,
    subtotal_cents: v.subtotal_cents,
    total_cents: v.total_cents,
    ...(reason !== undefined && { reason }),
  };
}

/**
 * What a gated request would do, as the person is asked it. The action runs inside a savepoint, so a request that
 * would be refused is refused now; what it would freeze is read before the savepoint is rolled back.
 * The question itself carries no text the agent wrote: that goes only in labeled fields.
 */
export function promptFor(db: Books, op: Op, input: Record<string, any>, ctx: Ctx, action: GateAction): Prompt {
  const levelsBefore = Object.fromEntries(ACTIONS.map((a) => [a, levelOf(db, a)]));
  const instructionsBefore = getProfile(db).payment_instructions;
  db.exec("SAVEPOINT gate_preview");
  try {
    const r = op.run(db, input, ctx);
    if (r instanceof Promise) throw new Error(`${op.name} is a write, so it must finish inside its transaction`);
    const preview = r as Record<string, any>;
    switch (action) {
      case "invoice_issue": {
        const ids: number[] = preview.invoice ? [preview.invoice.id] : preview.invoices.map((v: { id: number }) => v.id);
        const items = ids.map((id) => frozen(db, id));
        if (input.ids === undefined) return { title: `Issue invoice ${items[0]!.number} for ${dollars(items[0]!.total_cents)}?`, items };
        const n = items.length;
        const total = items.reduce((sum, i) => sum + i.total_cents, 0);
        return { title: `Issue ${n} invoice${n === 1 ? "" : "s"} totalling ${dollars(total)}?`, items };
      }
      case "invoice_void": {
        const doc = frozen(db, preview.invoice.id, input.reason);
        const name = doc.kind === "credit" ? `credit note ${doc.number}` : `invoice ${doc.number}`;
        return { title: `Void ${name} for ${dollars(doc.total_cents)}?`, items: [doc] };
      }
      case "invoice_credit": {
        const doc = frozen(db, preview.credit_note.id, input.reason);
        return { title: `Issue credit note ${doc.number} for ${dollars(doc.total_cents)} against invoice ${doc.credits_invoice}?`, items: [doc] };
      }
      case "payment_instructions":
        return { title: "Change the payment instructions printed on invoices?", items: [{ from: instructionsBefore, to: input.payment_instructions }] };
      case "payment_unmatched": {
        const p = preview.payment;
        const item = {
          invoice_id: p.invoice_id,
          invoice_number: p.invoice_number,
          client: getInvoiceRow(db, p.invoice_id)!.client_name,
          date: p.date,
          amount_cents: p.amount_cents,
          fee_cents: p.fee_cents,
          deposit_cents: p.deposit_cents,
          deposit_account: getAccount(db, p.deposit_account_id)!.name,
          applied_cents: p.applied_cents,
          credit_cents: p.credit_cents,
          open_after_cents: p.invoice_open_cents,
          memo: p.memo,
        };
        return { title: `Record a payment of ${dollars(p.amount_cents)} on invoice ${p.invoice_number} with no bank line behind it?`, items: [item] };
      }
      case "gate_settings": {
        const items = ACTIONS.filter((a) => input[a] !== undefined).map((a) => ({ action: a, what: WHAT[a], from: levelsBefore[a], to: input[a] }));
        return { title: "Change approval levels?", items };
      }
    }
  } finally {
    db.exec("ROLLBACK TO gate_preview");
    db.exec("RELEASE gate_preview");
    ctx.files.length = 0;
  }
}

/** Agent-written text as one capped line, so it can only ever fill its own field. */
export const FIELD_MAX = 240;
export function field(v: unknown): string {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s.length > FIELD_MAX ? `${s.slice(0, FIELD_MAX - 1)}…` : s;
}

/** One pending action's fields, label first, as the page card and the chat prompt both show them. */
export function promptFields(p: Pick<PendingAction, "action" | "items">): [string, string][][] {
  if (p.action === "payment_instructions") {
    const [i] = p.items as { from: string | null; to: string }[];
    return [[["Current", i!.from === null ? "(none)" : field(i!.from)], ["New", field(i!.to)]]];
  }
  if (p.action === "gate_settings") {
    return [(p.items as { what: string; from: string; to: string }[]).map((i) => [i.what, `${i.from} → ${i.to}`] as [string, string])];
  }
  if (p.action === "payment_unmatched") {
    const [i] = p.items as Record<string, any>[];
    const out: [string, string][] = [
      ["Invoice", i!.invoice_number],
      ["Client", field(i!.client)],
      ["Paid on", i!.date],
      ["Amount paid", dollars(i!.amount_cents)],
      ["Processor fee", dollars(i!.fee_cents)],
      ["Deposit", `${dollars(i!.deposit_cents)} into ${field(i!.deposit_account)}`],
      ["Settles on the invoice", dollars(i!.applied_cents)],
    ];
    if (i!.credit_cents > 0) out.push(["Client credit", dollars(i!.credit_cents)]);
    out.push(["Still owed after", dollars(i!.open_after_cents)], ["Bank line", "none imported; this payment isn't backed by the bank"]);
    if (i!.memo) out.push(["Memo", field(i!.memo)]);
    return [out];
  }
  return (p.items as ReturnType<typeof frozen>[]).map((d) => {
    const out: [string, string][] = [];
    if (d.kind === "credit") out.push(["Credit note", `${d.number ?? "draft"} against invoice ${d.credits_invoice}`]);
    else out.push(["Invoice", d.number ?? "draft"]);
    out.push(["Client", field(d.client)]);
    if (d.client_address) out.push(["Client address", field(d.client_address)]);
    for (const l of d.lines) out.push(["Line", `${field(l.description)}: ${dollars(l.amount_cents)}`]);
    if (d.tax) out.push(["Tax", `${field(d.tax.label)}: ${dollars(d.tax.amount_cents)}`]);
    out.push(["Total", dollars(d.total_cents)]);
    if (d.note) out.push(["Note", field(d.note)]);
    if (d.kind === "invoice") out.push(["Terms", `${termsText(d.terms_days)}; dated the day it is approved, so due ${d.due_date} if approved today`]);
    out.push(["Payment instructions", d.payment_instructions ? field(d.payment_instructions) : "(none)"]);
    if (d.reason !== undefined) out.push(["Reason", field(d.reason)]);
    return out;
  });
}

/** Draft invoices a pending issue is holding, so nothing about them can change before the person decides. */
function heldDrafts(db: Books): Set<number> {
  const held = new Set<number>();
  const rows = db.query("SELECT input FROM pending_actions WHERE status = 'pending' AND op = 'invoice_issue'").all() as { input: string }[];
  for (const r of rows) {
    const i = JSON.parse(r.input) as { id?: number; ids?: number[] };
    for (const id of i.ids ?? [i.id!]) held.add(id);
  }
  return held;
}

/** Refuses a write that would change a draft waiting for approval: its lines, note, terms, time or client. */
export function refuseIfHeld(db: Books, op: string, input: Record<string, any>): void {
  const held = heldDrafts(db);
  if (held.size === 0) return;
  const ids = (sql: string, v: number) => (db.query(sql).all(v) as { id: number }[]).map((r) => r.id);
  const touched =
    op === "invoice_edit" || op === "invoice_delete" ? [input.id as number]
    : op === "time_edit" || op === "time_delete" ? ids("SELECT invoice_id AS id FROM invoice_lines WHERE time_entry_id = ?", input.id)
    : op === "client_edit" ? ids("SELECT id FROM invoices WHERE status = 'draft' AND client_id = ?", input.id)
    : [];
  const hit = touched.find((id) => held.has(id));
  if (hit !== undefined) {
    throw new Refusal(`Draft invoice ${hit} is waiting for approval, so it can't change until the person approves or rejects it.`, "id");
  }
}

/**
 * Whether what an approval would do now is exactly what the person was shown: every line, note, term, client and
 * seller detail and payment instruction. The number may move when another invoice was issued first, and an invoice
 * is dated the day it is approved, so a request parked in the evening can be approved the next morning.
 */
export function stillAsShown(shown: Record<string, unknown>[], now: Record<string, unknown>[]): boolean {
  // The number, invoice date and due date follow the day of approval; the terms that set the due date are compared.
  const strip = (xs: Record<string, unknown>[]) => JSON.stringify(xs.map(({ number, invoice_date, due_date, ...rest }) => rest));
  return strip(shown) === strip(now);
}

/** Parks a gated request: only the pending row stays, holding exactly what was asked and what the person will see. */
export function park(db: Books, op: Op, input: Record<string, any>, ctx: Ctx, action: GateAction, level: Level, key: string | undefined) {
  const prompt = promptFor(db, op, input, ctx, action);
  const { id } = db
    .query(
      `INSERT INTO pending_actions (created_at, action, op, input, level, prompt, idempotency_key, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(ctx.now, action, op.name, JSON.stringify(input), level, JSON.stringify(prompt), key ?? null, ctx.source) as { id: number };
  return waiting(requirePending(db, id), ctx.page);
}

/** What the agent gets back for an action waiting at the gate, including what to tell the person. */
export function waiting(p: PendingAction, page: string) {
  const how =
    p.level === "passkey"
      ? `the person approves it with their passkey on the approval page at ${page} (start it with solobooks serve)`
      : `the person approves it when their agent app asks them, or on the approval page at ${page} (start it with solobooks serve)`;
  return {
    status: "pending",
    pending_id: p.id,
    level: p.level,
    title: p.title,
    approve_url: `${page}#pending-${p.id}`,
    message: `Nothing has happened yet: this waits until ${how}. The agent can't approve it.`,
  };
}

// ---------------------------------------------------------------- operations

const gateList: Op = {
  name: "gate_list",
  kind: "read",
  description:
    "Show the approval level the person set for each gated action (agent_decides, click or passkey), whether a passkey is registered, and the approval page's address.",
  fields: {},
  run(db, _input, ctx) {
    return { gate: gateView(db), passkey_registered: hasPasskey(db), page: ctx.page };
  },
};

const gateSet: Op = {
  name: "gate_set",
  kind: "write",
  description:
    "Ask to change the approval level of one or more gated actions: agent_decides runs them at once, click waits for the person to approve, passkey waits for their passkey. Always gated: it returns a pending action the person must approve at the stricter of the old and new levels.",
  fields: Object.fromEntries(
    ACTIONS.map((a) => [a, { type: "enum", values: LEVELS, description: `Level for ${WHAT[a]}.` } as const]),
  ),
  gate: "gate_settings",
  run(db, input, ctx) {
    const asked = ACTIONS.filter((a) => input[a] !== undefined);
    if (asked.length === 0) throw new Refusal(`Name at least one gated action and the level to set it to, such as invoice_issue.`, "invoice_issue");
    const first = asked[0]!;
    if (asked.every((a) => input[a] === levelOf(db, a))) {
      throw new Refusal(`${first} is already at ${input[first]}, so there is nothing to change.`, first);
    }
    const needsKey = asked.find((a) => input[a] === "passkey");
    if (needsKey && !hasPasskey(db)) {
      throw new Refusal("Register a passkey on the approval page that solobooks serve opens before setting a level to passkey.", needsKey);
    }
    const put = db.query(
      "INSERT INTO gate_levels (action, level, source) VALUES (?, ?, ?) ON CONFLICT (action) DO UPDATE SET level = excluded.level, source = excluded.source",
    );
    for (const a of asked) put.run(a, input[a], ctx.source);
    return { gate: gateView(db) };
  },
};

const pendingList: Op = {
  name: "pending_list",
  kind: "read",
  description: "List actions waiting at the gate, or with status, ones the person already approved or rejected.",
  fields: { status: { type: "enum", values: ["pending", "approved", "rejected"], description: "Only this status. Default pending." } },
  run(db, input, ctx) {
    const rows = db.query("SELECT id FROM pending_actions WHERE status = ? ORDER BY id").all(input.status ?? "pending") as { id: number }[];
    return { pending: rows.map((r) => pendingView(db, r.id, ctx.page)) };
  },
};

const pendingGet: Op = {
  name: "pending_get",
  kind: "read",
  description: "Show one pending action: what it would do, its level, and whether the person approved or rejected it, with the result.",
  fields: { id: { type: "int", required: true, min: 1, description: "Pending action id." } },
  run(db, input, ctx) {
    requirePending(db, input.id, "id");
    return { pending: pendingView(db, input.id, ctx.page) };
  },
};

export const gateOps: Op[] = [gateList, gateSet, pendingList, pendingGet];
