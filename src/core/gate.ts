import type { Books } from "./db.ts";
import { dollars } from "./format.ts";
import type { Ctx, GateAction, Op } from "./op.ts";
import { getProfile } from "./profile.ts";
import { Refusal } from "./refusal.ts";

// The approval gate. The person picks, per gated action, how much the agent may do alone. A gated request the
// person hasn't left to the agent is parked here, exactly as asked, and runs only when the person approves it on the
// local page or in the agent app's own prompt. No command or tool approves anything.

export const LEVELS = ["agent_decides", "click", "passkey"] as const;
export type Level = (typeof LEVELS)[number];

/** The gated actions whose level the person sets. Changing a level is gated too, always. */
export const ACTIONS = ["invoice_issue", "invoice_void", "invoice_credit", "payment_instructions"] as const;
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
  return p.action === "gate_settings" ? p.level : stricter(p.level, levelOf(db, p.action));
}

const clientName = (db: Books, id: unknown) =>
  (db.query("SELECT name FROM clients WHERE id = ?").get(id as number) as { name: string } | null)?.name ?? `client ${id}`;

type View = { id: number; kind: string; number: string | null; client_id: number; total_cents: number; credits_invoice?: { number: string | null } | null };

type Prompt = { title: string; items: Record<string, unknown>[] };

/** The sentence the person approves, and the lines of a batch, worked out from what the action would do. */
function describe(db: Books, action: GateAction, input: Record<string, any>, preview: Record<string, any>): Prompt {
  const doc = (v: View) => ({ invoice_id: v.id, number: v.number, client: clientName(db, v.client_id), total_cents: v.total_cents });
  switch (action) {
    case "invoice_issue": {
      const views: View[] = preview.invoice ? [preview.invoice] : preview.invoices;
      const items = views.map(doc);
      if (input.ids === undefined) {
        const [i] = items;
        return { title: `Issue invoice ${i!.number} to ${i!.client} for ${dollars(i!.total_cents)}?`, items };
      }
      const total = items.reduce((s, i) => s + i.total_cents, 0);
      const n = items.length;
      return { title: `Issue ${n} invoice${n === 1 ? "" : "s"} totalling ${dollars(total)}?`, items };
    }
    case "invoice_void": {
      const v = preview.invoice as View;
      const name = v.kind === "credit" ? `credit note ${v.number}` : `invoice ${v.number}`;
      return { title: `Void ${name} to ${clientName(db, v.client_id)} for ${dollars(v.total_cents)} because: ${input.reason}?`, items: [doc(v)] };
    }
    case "invoice_credit": {
      const v = preview.credit_note as View;
      return {
        title: `Issue credit note ${v.number} against invoice ${v.credits_invoice?.number} to ${clientName(db, v.client_id)} for ${dollars(v.total_cents)}?`,
        items: [doc(v)],
      };
    }
    case "payment_instructions": {
      const from = getProfile(db).payment_instructions;
      return {
        title: `Change the payment instructions printed on invoices to "${input.payment_instructions}"?`,
        items: [{ from, to: input.payment_instructions }],
      };
    }
    case "gate_settings": {
      const items = ACTIONS.filter((a) => input[a] !== undefined).map((a) => ({ action: a, what: WHAT[a], from: levelOf(db, a), to: input[a] }));
      return { title: `Change approval levels: ${items.map((i) => `${i.what} from ${i.from} to ${i.to}`).join("; ")}?`, items };
    }
  }
}

/**
 * What a gated request would do, as the person is asked it. The action runs inside a savepoint, so a request that
 * would be refused is refused now, and is then rolled back.
 */
export function promptFor(db: Books, op: Op, input: Record<string, any>, ctx: Ctx, action: GateAction): Prompt {
  db.exec("SAVEPOINT gate_preview");
  let preview: Record<string, any>;
  try {
    const r = op.run(db, input, ctx);
    if (r instanceof Promise) throw new Error(`${op.name} is a write, so it must finish inside its transaction`);
    preview = r;
  } finally {
    db.exec("ROLLBACK TO gate_preview");
    db.exec("RELEASE gate_preview");
    ctx.files.length = 0;
  }
  return describe(db, action, input, preview);
}

/**
 * Whether what an approval would do now is what the person was shown: the same documents, clients, amounts and
 * changes. Only an invoice number may move, when another invoice was issued in between.
 */
export function stillAsShown(shown: Record<string, unknown>[], now: Record<string, unknown>[]): boolean {
  const strip = (xs: Record<string, unknown>[]) => JSON.stringify(xs.map(({ number, ...rest }) => rest));
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
      : `the person approves it in this chat or on the approval page at ${page} (start it with solobooks serve)`;
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
  gate: () => "gate_settings",
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
