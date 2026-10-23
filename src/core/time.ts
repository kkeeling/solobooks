import { billableMinutes, lineAmountCents } from "./billing.ts";
import { getEngagement, requireClient } from "./clients.ts";
import type { Books } from "./db.ts";
import type { Op } from "./op.ts";
import { Refusal } from "./refusal.ts";

// solobooks stores time it is given. It never reads agent logs and never runs timers.

type Entry = { id: number; client_id: number; engagement_id: number | null; date: string; minutes: number; note: string; source: string };

export function getTimeEntry(db: Books, id: number): Entry | null {
  return db
    .query("SELECT id, client_id, engagement_id, date, minutes, note, source FROM time_entries WHERE id = ?")
    .get(id) as Entry | null;
}

function requireEntry(db: Books, id: number): Entry {
  const e = getTimeEntry(db, id);
  if (!e) throw new Refusal(`There is no time entry with id ${id}.`, "id");
  return e;
}

function checkEngagement(db: Books, clientId: number, engagementId: number | null | undefined): void {
  if (engagementId === undefined || engagementId === null) return;
  const e = getEngagement(db, engagementId);
  if (!e) throw new Refusal(`There is no engagement with id ${engagementId}.`, "engagement_id");
  if (e.client_id !== clientId) throw new Refusal(`Engagement ${engagementId} belongs to a different client.`, "engagement_id");
}

/** The hourly rate a time entry bills at: its own engagement's, or the client's only hourly engagement's. */
function rateFor(db: Books, e: Entry): number | null {
  if (e.engagement_id !== null) return getEngagement(db, e.engagement_id)?.rate_cents_per_hour ?? null;
  const rates = db
    .query("SELECT rate_cents_per_hour AS r FROM engagements WHERE client_id = ? AND rate_cents_per_hour IS NOT NULL")
    .all(e.client_id) as { r: number }[];
  return rates.length === 1 ? rates[0]!.r : null;
}

/** A time entry with what it would bill: minutes after the client's rounding, and cents at its rate. */
export function priced(db: Books, e: Entry) {
  const c = requireClient(db, e.client_id);
  const billable_minutes = billableMinutes(e.minutes, c.increment_minutes, c.minimum_minutes);
  const rate = rateFor(db, e);
  return {
    ...e,
    billable_minutes,
    rate_cents_per_hour: rate,
    amount_cents: rate === null ? null : lineAmountCents(billable_minutes, rate),
  };
}

const fields = {
  client_id: { type: "int", required: true, min: 1, description: "Client id." },
  date: { type: "date", required: true, description: "Day the work happened, YYYY-MM-DD." },
  minutes: { type: "int", required: true, min: 1, max: 1440, unit: "minutes", description: "Duration in whole minutes." },
  note: { type: "text", required: true, description: "What the time was spent on." },
  engagement_id: { type: "int", min: 1, description: "Engagement id; optional when the client has one hourly engagement." },
} as const;

const timeAdd: Op = {
  name: "time_add",
  kind: "write",
  description: "Record time worked for a client. solobooks stores time from any source; it doesn't track it.",
  fields,
  run(db, input, ctx) {
    requireClient(db, input.client_id);
    checkEngagement(db, input.client_id, input.engagement_id);
    const { id } = db
      .query(
        "INSERT INTO time_entries (client_id, engagement_id, date, minutes, note, source) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .get(input.client_id, input.engagement_id ?? null, input.date, input.minutes, input.note, ctx.source) as { id: number };
    return { time_entry: priced(db, getTimeEntry(db, id)!) };
  },
};

const timeEdit: Op = {
  name: "time_edit",
  kind: "write",
  description: "Change an unbilled time entry. Only the fields given change.",
  fields: {
    id: { type: "int", required: true, min: 1, description: "Time entry id." },
    client_id: { ...fields.client_id, required: false },
    date: { ...fields.date, required: false },
    minutes: { ...fields.minutes, required: false },
    note: { ...fields.note, required: false },
    engagement_id: fields.engagement_id,
  },
  run(db, input, ctx) {
    const old = requireEntry(db, input.id);
    const next = { ...old, ...input, source: ctx.source };
    requireClient(db, next.client_id);
    checkEngagement(db, next.client_id, next.engagement_id);
    db.query(
      "UPDATE time_entries SET client_id = ?, engagement_id = ?, date = ?, minutes = ?, note = ?, source = ? WHERE id = ?",
    ).run(next.client_id, next.engagement_id, next.date, next.minutes, next.note, next.source, old.id);
    return { time_entry: priced(db, getTimeEntry(db, old.id)!) };
  },
};

const timeDelete: Op = {
  name: "time_delete",
  kind: "write",
  destructive: true,
  description: "Delete an unbilled time entry.",
  fields: { id: { type: "int", required: true, min: 1, description: "Time entry id." } },
  run(db, input) {
    const old = requireEntry(db, input.id);
    db.query("DELETE FROM time_entries WHERE id = ?").run(old.id);
    return { deleted: { time_entry: old } };
  },
};

const timeList: Op = {
  name: "time_list",
  kind: "read",
  description: "List time entries with billable minutes and amount, optionally for one client.",
  fields: { client_id: { type: "int", min: 1, description: "Only this client's time." } },
  run(db, input) {
    const rows = (
      input.client_id === undefined
        ? db.query("SELECT id FROM time_entries ORDER BY date, id").all()
        : db.query("SELECT id FROM time_entries WHERE client_id = ? ORDER BY date, id").all(input.client_id)
    ) as { id: number }[];
    return { time_entries: rows.map((r) => priced(db, getTimeEntry(db, r.id)!)) };
  },
};

export const timeOps: Op[] = [timeAdd, timeEdit, timeDelete, timeList];
