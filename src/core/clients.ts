import type { Books } from "./db.ts";
import type { Op } from "./op.ts";
import { Refusal } from "./refusal.ts";
import { currency, MAX_CENTS } from "./validate.ts";

export const INTERVALS = ["monthly", "quarterly", "yearly"] as const;

export type Client = {
  id: number;
  name: string;
  increment_minutes: number;
  minimum_minutes: number;
  address: string | null;
  email: string | null;
  terms_days: number;
  tax_rate_ppm: number | null;
  tax_label: string | null;
  source: string;
};

const CLIENT_COLS = "id, name, increment_minutes, minimum_minutes, address, email, terms_days, tax_rate_ppm, tax_label, source";

export function getClient(db: Books, id: number): Client | null {
  return db.query(`SELECT ${CLIENT_COLS} FROM clients WHERE id = ?`).get(id) as Client | null;
}

/** Billing details a client can carry; all optional. */
const billingFields = {
  address: { type: "text", description: "Billing address printed on invoices; separate lines with a newline." },
  email: { type: "text", description: "Where the client's invoices go." },
  terms_days: { type: "int", min: 0, max: 365, unit: "days", description: "Days to pay after the invoice date. Default 30; 0 is due on receipt." },
  tax_rate_ppm: {
    type: "int", min: 0, max: 1_000_000, unit: "parts per million",
    description: "Sales tax rate the person set for this client, in parts per million (6.25% is 62500). 0 removes it. No rate, no tax line.",
  },
  tax_label: { type: "text", description: "Name of the tax line, such as IL sales tax. Default Sales tax." },
} as const;

/** The tax columns for a requested rate: 0 clears both, and a rate without a label gets the default one. */
function taxColumns(rate: number | undefined, label: string | undefined, old: { tax_rate_ppm: number | null; tax_label: string | null }) {
  const r = rate === undefined ? old.tax_rate_ppm : rate === 0 ? null : rate;
  if (r === null) {
    if (label !== undefined) throw new Refusal("A tax label needs a tax rate, so set tax_rate_ppm too.", "tax_label");
    return { tax_rate_ppm: null, tax_label: null };
  }
  return { tax_rate_ppm: r, tax_label: label ?? old.tax_label ?? "Sales tax" };
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
    .query("SELECT id, name, amount_cents, billable_on, source FROM milestones WHERE engagement_id = ? ORDER BY id")
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
  description: "Add a client, with optional per-client time rounding, billing address, payment terms and sales tax rate.",
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
    ...billingFields,
  },
  run(db, input, ctx) {
    if (db.query("SELECT 1 FROM clients WHERE name = ?").get(input.name)) {
      throw new Refusal("A client with this name already exists.", "name");
    }
    const tax = taxColumns(input.tax_rate_ppm, input.tax_label, { tax_rate_ppm: null, tax_label: null });
    const { id } = db
      .query(
        `INSERT INTO clients (name, increment_minutes, minimum_minutes, address, email, terms_days, tax_rate_ppm, tax_label, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        input.name,
        input.increment_minutes ?? 1,
        input.minimum_minutes ?? 0,
        input.address ?? null,
        input.email ?? null,
        input.terms_days ?? 30,
        tax.tax_rate_ppm,
        tax.tax_label,
        ctx.source,
      ) as { id: number };
    return { client: getClient(db, id) };
  },
};

const clientEdit: Op = {
  name: "client_edit",
  kind: "write",
  description: "Change a client's name, time rounding, billing address, email, payment terms or sales tax rate. Only the fields given change; issued invoices keep what they were issued with.",
  fields: {
    id: { type: "int", required: true, min: 1, description: "Client id." },
    name: { type: "text", description: "Client name, unique." },
    increment_minutes: { type: "int", min: 1, max: 1440, unit: "minutes", description: "Round each time entry up to this many minutes." },
    minimum_minutes: { type: "int", min: 0, max: 1440, unit: "minutes", description: "Bill each time entry for at least this many minutes." },
    ...billingFields,
  },
  run(db, input, ctx) {
    const old = requireClient(db, input.id, "id");
    if (input.name !== undefined && db.query("SELECT 1 FROM clients WHERE name = ? AND id <> ?").get(input.name, old.id)) {
      throw new Refusal("A client with this name already exists.", "name");
    }
    const { tax_rate_ppm, tax_label, ...rest } = input;
    const next = { ...old, ...rest, ...taxColumns(tax_rate_ppm, tax_label, old), source: ctx.source };
    db.query(
      `UPDATE clients SET name = ?, increment_minutes = ?, minimum_minutes = ?, address = ?, email = ?, terms_days = ?,
         tax_rate_ppm = ?, tax_label = ?, source = ? WHERE id = ?`,
    ).run(
      next.name,
      next.increment_minutes,
      next.minimum_minutes,
      next.address,
      next.email,
      next.terms_days,
      next.tax_rate_ppm,
      next.tax_label,
      next.source,
      old.id,
    );
    return { client: getClient(db, old.id) };
  },
};

const clientList: Op = {
  name: "client_list",
  kind: "read",
  description: "List clients.",
  fields: {},
  run(db) {
    return { clients: db.query(`SELECT ${CLIENT_COLS} FROM clients ORDER BY id`).all() };
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
      description: "Fixed-fee milestones, each with a name and amount_cents, and optionally the day it becomes billable.",
      of: {
        name: { type: "text", required: true, description: "Milestone name." },
        amount_cents: { type: "int", required: true, min: 1, max: MAX_CENTS, unit: "cents", description: "Fee in cents." },
        billable_on: { type: "date", description: "Day the fee becomes billable, YYYY-MM-DD; a period's draft picks it up." },
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
    const ins = db.query("INSERT INTO milestones (engagement_id, name, amount_cents, billable_on, source) VALUES (?, ?, ?, ?, ?)");
    for (const m of input.milestones ?? []) ins.run(id, m.name, m.amount_cents, m.billable_on ?? null, ctx.source);
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

const milestoneBillable: Op = {
  name: "milestone_billable",
  kind: "write",
  description: "Set the day a fixed-fee milestone becomes billable, so the draft for that period picks it up.",
  fields: {
    id: { type: "int", required: true, min: 1, description: "Milestone id." },
    date: { type: "date", required: true, description: "Day the fee becomes billable, YYYY-MM-DD." },
  },
  run(db, input, ctx) {
    const m = db.query("SELECT id, engagement_id FROM milestones WHERE id = ?").get(input.id) as { id: number; engagement_id: number } | null;
    if (!m) throw new Refusal(`There is no milestone with id ${input.id}.`, "id");
    const billed = db
      .query("SELECT 1 FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id WHERE l.milestone_id = ? AND i.status <> 'void'")
      .get(m.id);
    if (billed) throw new Refusal(`Milestone ${m.id} is already on an invoice, so its billable day can't change.`, "id");
    db.query("UPDATE milestones SET billable_on = ?, source = ? WHERE id = ?").run(input.date, ctx.source, m.id);
    return { engagement: getEngagement(db, m.engagement_id) };
  },
};

export const clientOps: Op[] = [clientAdd, clientEdit, clientList, engagementAdd, engagementList, milestoneBillable];
