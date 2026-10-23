import type { Books } from "./db.ts";
import type { Op } from "./op.ts";
import { Refusal } from "./refusal.ts";
import { currency, MAX_CENTS } from "./validate.ts";

export const INTERVALS = ["monthly", "quarterly", "yearly"] as const;

export function getClient(db: Books, id: number) {
  return db
    .query("SELECT id, name, increment_minutes, minimum_minutes, source FROM clients WHERE id = ?")
    .get(id) as { id: number; name: string; increment_minutes: number; minimum_minutes: number; source: string } | null;
}

export function getEngagement(db: Books, id: number) {
  const e = db
    .query(
      `SELECT id, client_id, name, rate_cents_per_hour, recurring_amount_cents, recurring_interval, source
       FROM engagements WHERE id = ?`,
    )
    .get(id) as Record<string, any> | null;
  if (!e) return null;
  const milestones = db
    .query("SELECT id, name, amount_cents, source FROM milestones WHERE engagement_id = ? ORDER BY id")
    .all(id);
  const kinds = [
    e.rate_cents_per_hour !== null ? "hourly" : null,
    milestones.length ? "fixed-milestone" : null,
    e.recurring_amount_cents !== null ? "recurring" : null,
  ].filter(Boolean);
  return {
    id: e.id,
    client_id: e.client_id,
    name: e.name,
    type: kinds.length > 1 ? "mixed" : kinds[0],
    rate_cents_per_hour: e.rate_cents_per_hour,
    recurring_amount_cents: e.recurring_amount_cents,
    recurring_interval: e.recurring_interval,
    milestones,
    source: e.source,
  };
}

export function requireClient(db: Books, id: number, field = "client_id") {
  const c = getClient(db, id);
  if (!c) throw new Refusal(`There is no client with id ${id}.`, field);
  return c;
}

const clientAdd: Op = {
  name: "client_add",
  kind: "write",
  description: "Add a client, with optional per-client time rounding.",
  fields: {
    name: { type: "text", required: true, description: "Client name, unique." },
    increment_minutes: {
      type: "int", min: 1, max: 1440, unit: "minutes",
      description: "Round each time entry up to this many minutes. Default 1 (exact minutes).",
    },
    minimum_minutes: {
      type: "int", min: 0, max: 1440, unit: "minutes",
      description: "Bill each time entry for at least this many minutes. Default 0.",
    },
  },
  run(db, input, ctx) {
    if (db.query("SELECT 1 FROM clients WHERE name = ?").get(input.name)) {
      throw new Refusal("A client with this name already exists.", "name");
    }
    const { id } = db
      .query("INSERT INTO clients (name, increment_minutes, minimum_minutes, source) VALUES (?, ?, ?, ?) RETURNING id")
      .get(input.name, input.increment_minutes ?? 1, input.minimum_minutes ?? 0, ctx.source) as { id: number };
    return { client: getClient(db, id) };
  },
};

const clientList: Op = {
  name: "client_list",
  kind: "read",
  description: "List clients.",
  fields: {},
  run(db) {
    return {
      clients: db.query("SELECT id, name, increment_minutes, minimum_minutes, source FROM clients ORDER BY id").all(),
    };
  },
};

const engagementAdd: Op = {
  name: "engagement_add",
  kind: "write",
  description:
    "Add an engagement for a client. Its terms are any mix of an hourly rate, fixed milestones and a recurring fee; two or more kinds make it mixed.",
  fields: {
    client_id: { type: "int", required: true, min: 1, description: "Client id." },
    name: { type: "text", required: true, description: "Engagement name, unique per client." },
    rate_cents_per_hour: { type: "int", min: 1, max: MAX_CENTS, unit: "cents per hour", description: "Hourly rate in cents." },
    milestones: {
      type: "list",
      minItems: 1,
      description: "Fixed-fee milestones, each with a name and amount_cents.",
      of: {
        name: { type: "text", required: true, description: "Milestone name." },
        amount_cents: { type: "int", required: true, min: 1, max: MAX_CENTS, unit: "cents", description: "Fee in cents." },
        currency,
      },
    },
    recurring_amount_cents: { type: "int", min: 1, max: MAX_CENTS, unit: "cents", description: "Recurring fee in cents." },
    recurring_interval: { type: "enum", values: INTERVALS, description: "monthly, quarterly or yearly; required with a recurring fee." },
    currency,
  },
  run(db, input, ctx) {
    requireClient(db, input.client_id);
    if (db.query("SELECT 1 FROM engagements WHERE client_id = ? AND name = ?").get(input.client_id, input.name)) {
      throw new Refusal("This client already has an engagement with this name.", "name");
    }
    const recurring = input.recurring_amount_cents !== undefined;
    if (recurring !== (input.recurring_interval !== undefined)) {
      const field = recurring ? "recurring_interval" : "recurring_amount_cents";
      throw new Refusal("A recurring fee needs both recurring_amount_cents and recurring_interval.", field);
    }
    if (input.rate_cents_per_hour === undefined && !input.milestones && !recurring) {
      throw new Refusal(
        "An engagement needs at least one term: rate_cents_per_hour, milestones or a recurring fee.",
        "rate_cents_per_hour",
      );
    }
    const { id } = db
      .query(
        `INSERT INTO engagements (client_id, name, rate_cents_per_hour, recurring_amount_cents, recurring_interval, source)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        input.client_id,
        input.name,
        input.rate_cents_per_hour ?? null,
        input.recurring_amount_cents ?? null,
        input.recurring_interval ?? null,
        ctx.source,
      ) as { id: number };
    const ins = db.query("INSERT INTO milestones (engagement_id, name, amount_cents, source) VALUES (?, ?, ?, ?)");
    for (const m of input.milestones ?? []) ins.run(id, m.name, m.amount_cents, ctx.source);
    return { engagement: getEngagement(db, id) };
  },
};

const engagementList: Op = {
  name: "engagement_list",
  kind: "read",
  description: "List engagements, optionally for one client.",
  fields: { client_id: { type: "int", min: 1, description: "Only this client's engagements." } },
  run(db, input) {
    const rows = (
      input.client_id === undefined
        ? db.query("SELECT id FROM engagements ORDER BY id").all()
        : db.query("SELECT id FROM engagements WHERE client_id = ? ORDER BY id").all(input.client_id)
    ) as { id: number }[];
    return { engagements: rows.map((r) => getEngagement(db, r.id)) };
  },
};

export const clientOps: Op[] = [clientAdd, clientList, engagementAdd, engagementList];
