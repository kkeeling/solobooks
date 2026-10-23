import { requireClient } from "./clients.ts";
import type { Books } from "./db.ts";
import { expenseView } from "./expenses.ts";
import { getEntry, namedAccount, postEntry, requireOwnAccount } from "./ledger.ts";
import RATES from "./mileage-rates.json" with { type: "json" };
import type { Op } from "./op.ts";
import { insertMove, OWNER_ACCOUNTS } from "./owner.ts";
import { Refusal } from "./refusal.ts";
import { BASIS_NOTE, pnl } from "./reports.ts";
import { salesTax } from "./salestax.ts";
import { currency, MAX_CENTS } from "./validate.ts";

// The records an accountant asks for at year end, beyond the books themselves: the mileage log, home office figures,
// owner items and contractors. solobooks keeps the figures the person gives it and the IRS mileage rate by date. It
// computes no tax and decides nothing about what is deductible; the year-end report states figures for the accountant.

const yearField = { type: "int", required: true, min: 2000, max: 2100, description: "Calendar year, such as 2026." } as const;
const yearRange = (y: number) => ({ from: `${y}-01-01`, to: `${y}-12-31` });

// ---------------------------------------------------------------- mileage

type Rate = { from: string; mills_per_mile: number; source: string };

/** The IRS business rate for a day, from the table: the latest entry starting on or before it, if the table covers it. */
export function mileageRate(date: string): Rate | null {
  if (date > RATES.known_through) return null;
  return [...RATES.rates].reverse().find((r) => r.from <= date) ?? null;
}

/** 72.5¢ from 725 mills. */
const millsText = (m: number) => `${Math.trunc(m / 10)}${m % 10 ? `.${m % 10}` : ""}¢`;
const milesText = (tenths: number) => `${Math.trunc(tenths / 10)}.${tenths % 10}`;

function tripView(db: Books, id: number) {
  const t = db.query("SELECT * FROM mileage_trips WHERE id = ?").get(id) as Record<string, any>;
  const rate = mileageRate(t.date);
  return {
    id: t.id,
    date: t.date,
    miles_tenths: t.miles_tenths,
    miles: milesText(t.miles_tenths),
    destination: t.destination,
    purpose: t.purpose,
    client_id: t.client_id,
    // The IRS business standard mileage rate for the trip's date, in mills (tenths of a cent) per mile.
    rate_mills_per_mile: rate?.mills_per_mile ?? null,
    rate: rate ? `${millsText(rate.mills_per_mile)} a mile` : null,
    rate_source: rate?.source ?? null,
    // Miles times the rate, rounded half-up to the cent: the standard mileage figure, if the person uses that method.
    standard_mileage_cents: rate ? Math.floor((t.miles_tenths * rate.mills_per_mile + 50) / 100) : null,
    note: rate ? null : `solobooks has no IRS rate for ${t.date} yet; its table runs ${RATES.rates[0]!.from} to ${RATES.known_through}.`,
    source: t.source,
  };
}

const mileageAdd: Op = {
  name: "mileage_add",
  kind: "write",
  description:
    "Log a business trip for the mileage log: the day, the miles in tenths (12.5 miles is 125), where to and why. Its IRS business standard mileage rate is looked up by the trip's date, from a table of the IRS's published rates. Nothing is posted to the books; the year-end report totals the log.",
  fields: {
    date: { type: "date", required: true, description: "Day of the trip, YYYY-MM-DD." },
    miles_tenths: { type: "int", required: true, min: 1, max: 10_000_000, unit: "tenths of a mile", description: "Business miles driven, in tenths of a mile: 12.5 miles is 125." },
    destination: { type: "text", required: true, description: "Where the trip went." },
    purpose: { type: "text", required: true, description: "The business purpose, such as Client workshop at Acme." },
    client_id: { type: "int", min: 1, description: "The client the trip was for, if any." },
  },
  run(db, input, ctx) {
    if (input.client_id !== undefined) requireClient(db, input.client_id, "client_id");
    const { id } = db
      .query("INSERT INTO mileage_trips (date, miles_tenths, destination, purpose, client_id, source) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
      .get(input.date, input.miles_tenths, input.destination, input.purpose, input.client_id ?? null, ctx.source) as { id: number };
    return { trip: tripView(db, id) };
  },
};

const mileageDelete: Op = {
  name: "mileage_delete",
  kind: "write",
  destructive: true,
  description: "Remove a trip logged by mistake from the mileage log. Nothing was posted for it, so nothing else changes.",
  fields: { id: { type: "int", required: true, min: 1, description: "Trip id." } },
  run(db, input) {
    if (!db.query("SELECT 1 FROM mileage_trips WHERE id = ?").get(input.id)) throw new Refusal(`There is no trip with id ${input.id}.`, "id");
    const trip = tripView(db, input.id);
    db.query("DELETE FROM mileage_trips WHERE id = ?").run(input.id);
    return { deleted: { trip } };
  },
};

function mileageLog(db: Books, from: string, to: string) {
  const ids = db.query("SELECT id FROM mileage_trips WHERE date BETWEEN ? AND ? ORDER BY date, id").all(from, to) as { id: number }[];
  const trips = ids.map((r) => tripView(db, r.id));
  const tenths = trips.reduce((s, t) => s + t.miles_tenths, 0);
  return {
    trips,
    miles_tenths: tenths,
    miles: milesText(tenths),
    standard_mileage_cents: trips.reduce((s, t) => s + (t.standard_mileage_cents ?? 0), 0),
    trips_without_rate: trips.filter((t) => t.rate_mills_per_mile === null).length,
    rates_source: RATES.source,
  };
}

const mileageList: Op = {
  name: "mileage_list",
  kind: "read",
  description: "List the mileage log for a date range, each trip with the IRS rate for its date, plus total miles and the standard mileage figure.",
  fields: {
    from: { type: "date", description: "First day included, YYYY-MM-DD. Default: the beginning." },
    to: { type: "date", description: "Last day included, YYYY-MM-DD. Default: the end." },
  },
  run(db, input) {
    return mileageLog(db, input.from ?? "0000-01-01", input.to ?? "9999-12-31");
  },
};

// ---------------------------------------------------------------- home office

function homeOffice(db: Books, year: number) {
  const h = db.query("SELECT * FROM home_offices WHERE year = ?").get(year) as Record<string, any> | null;
  if (!h) return null;
  const expenses = db.query("SELECT description, amount_cents FROM home_office_expenses WHERE year = ? ORDER BY id").all(year) as {
    description: string;
    amount_cents: number;
  }[];
  // Office area over home area, in parts per million, rounded half-up.
  const ppm = Math.floor((h.office_square_feet * 1_000_000 * 2 + h.home_square_feet) / (h.home_square_feet * 2));
  return {
    year: h.year,
    office_square_feet: h.office_square_feet,
    home_square_feet: h.home_square_feet,
    office_share_ppm: ppm,
    office_share: `${(ppm / 10_000).toFixed(2)}%`,
    expenses,
    expenses_total_cents: expenses.reduce((s, e) => s + e.amount_cents, 0),
    note: h.note,
    source: h.source,
  };
}

const homeOfficeSet: Op = {
  name: "home_office_set",
  kind: "write",
  description:
    "Set a year's home office figures as the person gives them: the office's and the whole home's square feet, and the home's expenses for the year (rent or mortgage interest, utilities, insurance, repairs). Setting a year again replaces it. solobooks states the figures and the office's share of the home; whether and how to deduct it is the accountant's call.",
  fields: {
    year: yearField,
    office_square_feet: { type: "int", required: true, min: 1, max: 1_000_000, unit: "square feet", description: "Area used for the business." },
    home_square_feet: { type: "int", required: true, min: 1, max: 1_000_000, unit: "square feet", description: "Area of the whole home." },
    expenses: {
      type: "list",
      description: "The home's expenses for the year, each with a description and amount_cents.",
      of: {
        description: { type: "text", required: true, description: "What it was, such as Rent or Electricity." },
        amount_cents: { type: "int", required: true, min: 1, max: MAX_CENTS, unit: "cents", description: "The year's total for it, in cents." },
      },
    },
    note: { type: "text", description: "Anything the accountant should know, such as the months it was used." },
  },
  run(db, input, ctx) {
    if (input.office_square_feet > input.home_square_feet) {
      throw new Refusal("office_square_feet can't be more than home_square_feet.", "office_square_feet");
    }
    db.query("DELETE FROM home_office_expenses WHERE year = ?").run(input.year);
    db.query("DELETE FROM home_offices WHERE year = ?").run(input.year);
    db.query("INSERT INTO home_offices (year, office_square_feet, home_square_feet, note, source) VALUES (?, ?, ?, ?, ?)").run(
      input.year, input.office_square_feet, input.home_square_feet, input.note ?? null, ctx.source,
    );
    const ins = db.query("INSERT INTO home_office_expenses (year, description, amount_cents, source) VALUES (?, ?, ?, ?)");
    for (const e of input.expenses ?? []) ins.run(input.year, e.description, e.amount_cents, ctx.source);
    return { home_office: homeOffice(db, input.year) };
  },
};

// ---------------------------------------------------------------- owner items

const OWNER_ITEM_KINDS = ["estimated_tax", "health_insurance", "retirement"] as const;

function ownerItemView(db: Books, id: number) {
  const i = db.query("SELECT * FROM owner_items WHERE id = ?").get(id) as Record<string, any>;
  return {
    id: i.id,
    kind: i.kind,
    date: i.date,
    amount_cents: i.amount_cents,
    paid_personally: i.paid_personally === 1,
    paid_from_account_id: i.account_id,
    jurisdiction: i.jurisdiction,
    confirmation: i.confirmation,
    memo: i.memo,
    owner_move_id: i.owner_move_id,
    entry: i.entry_id === null ? null : getEntry(db, i.entry_id),
    source: i.source,
  };
}

const ownerItemAdd: Op = {
  name: "owner_item_add",
  kind: "write",
  description:
    "Record an owner item the accountant totals apart from the business: an estimated tax payment (with jurisdiction, such as federal or a state), the person's own health insurance, or a retirement contribution. Paid from a business account it is posted as an owner draw; paid personally it is only recorded. Either way it never reaches the P&L.",
  fields: {
    kind: { type: "enum", required: true, values: OWNER_ITEM_KINDS, description: "estimated_tax, health_insurance or retirement." },
    date: { type: "date", required: true, description: "Day it was paid, YYYY-MM-DD." },
    amount_cents: { type: "int", required: true, min: 1, max: MAX_CENTS, unit: "cents", description: "Amount paid, in cents." },
    paid_from_account_id: { type: "int", min: 1, description: "The business account it was paid from; give this or paid_personally." },
    paid_personally: { type: "bool", description: "true when the person paid it from their own money, outside the business accounts." },
    jurisdiction: { type: "text", description: "Who an estimated tax payment went to, such as federal or Illinois; required for estimated_tax." },
    confirmation: { type: "text", description: "The confirmation number, if any." },
    memo: { type: "text", description: "Anything worth keeping, such as Q3 2026." },
    currency,
  },
  run(db, input, ctx) {
    const personal = input.paid_personally === true;
    if (personal === (input.paid_from_account_id !== undefined)) {
      throw new Refusal("Say how it was paid with paid_from_account_id, or set paid_personally to true, but not both.", "paid_from_account_id");
    }
    if ((input.kind === "estimated_tax") !== (input.jurisdiction !== undefined)) {
      throw new Refusal(
        input.kind === "estimated_tax" ? "An estimated tax payment needs its jurisdiction, such as federal or a state." : "Only an estimated tax payment takes a jurisdiction.",
        "jurisdiction",
      );
    }
    let entry: number | null = null;
    let move: number | null = null;
    if (!personal) {
      requireOwnAccount(db, input.paid_from_account_id, "paid_from_account_id");
      const draws = namedAccount(db, OWNER_ACCOUNTS.draws, ctx.source, "paid_from_account_id");
      const what = `${input.kind.replace("_", " ")}${input.jurisdiction ? ` (${input.jurisdiction})` : ""}`;
      const memo = `Owner draw for ${what}${input.memo ? `: ${input.memo}` : ""}`;
      entry = postEntry(db, input.date, memo, [[draws, input.amount_cents], [input.paid_from_account_id, -input.amount_cents]], ctx.source);
      move = insertMove(db, "draw", input.date, input.amount_cents, memo, entry, null, ctx);
    }
    const { id } = db
      .query(
        `INSERT INTO owner_items (kind, date, amount_cents, paid_personally, account_id, entry_id, owner_move_id, jurisdiction, confirmation, memo, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        input.kind, input.date, input.amount_cents, personal ? 1 : 0, personal ? null : input.paid_from_account_id, entry, move,
        input.jurisdiction ?? null, input.confirmation ?? null, input.memo ?? null, ctx.source,
      ) as { id: number };
    return { owner_item: ownerItemView(db, id) };
  },
};

function ownerItems(db: Books, from: string, to: string) {
  const ids = db.query("SELECT id FROM owner_items WHERE date BETWEEN ? AND ? ORDER BY date, id").all(from, to) as { id: number }[];
  const items = ids.map((r) => ownerItemView(db, r.id));
  const group = (kind: string) => {
    const mine = items.filter((i) => i.kind === kind);
    return { total_cents: mine.reduce((s, i) => s + i.amount_cents, 0), items: mine };
  };
  const estimated = group("estimated_tax");
  const jurisdictions = [...new Set(estimated.items.map((i) => i.jurisdiction as string))].sort();
  return {
    note: "Owner items are the person's own, not business expenses: they are totalled here and never counted in the P&L.",
    estimated_tax: {
      ...estimated,
      by_jurisdiction: jurisdictions.map((j) => ({ jurisdiction: j, total_cents: estimated.items.filter((i) => i.jurisdiction === j).reduce((s, i) => s + i.amount_cents, 0) })),
    },
    health_insurance: group("health_insurance"),
    retirement: group("retirement"),
  };
}

// ---------------------------------------------------------------- contractors

const W9 = ["on_file", "not_on_file"] as const;
/** Payments made by card or through PayPal are reported on Form 1099-K by the card company or network, not on 1099-NEC. */
const OUTSIDE_NEC = new Set(["card", "paypal"]);
const OUTSIDE_NEC_NOTE = "Paid by card or PayPal: such payments are reported on Form 1099-K by the card company or payment network, so they stay off the 1099-NEC list.";

function contractorRow(db: Books, id: number) {
  return db.query("SELECT id, name, w9_status, w9_received_on, source FROM contractors WHERE id = ?").get(id) as
    | { id: number; name: string; w9_status: string; w9_received_on: string | null; source: string }
    | null;
}

/** A contractor with what they were paid between two days, each payment flagged when it stays off the 1099-NEC list. */
function contractorView(db: Books, id: number, from = "0000-01-01", to = "9999-12-31") {
  const c = contractorRow(db, id)!;
  const ids = db.query("SELECT id FROM expenses WHERE contractor_id = ? AND date BETWEEN ? AND ? ORDER BY date, id").all(id, from, to) as { id: number }[];
  const payments = ids.map((r) => {
    const e = expenseView(db, r.id);
    const outside = OUTSIDE_NEC.has(e.payment_method);
    return {
      expense_id: e.id,
      date: e.date,
      amount_cents: e.amount_cents,
      payment_method: e.payment_method,
      w9_status: c.w9_status,
      outside_1099_nec: outside,
      outside_1099_nec_reason: outside ? OUTSIDE_NEC_NOTE : null,
      memo: e.memo,
    };
  });
  const sum = (xs: typeof payments) => xs.reduce((s, p) => s + p.amount_cents, 0);
  return {
    ...c,
    paid_cents: sum(payments),
    // Paid by bank transfer, check, cash and the like: the payments a 1099-NEC would cover.
    nec_method_cents: sum(payments.filter((p) => !p.outside_1099_nec)),
    outside_1099_nec_cents: sum(payments.filter((p) => p.outside_1099_nec)),
    payments,
  };
}

const contractorAdd: Op = {
  name: "contractor_add",
  kind: "write",
  description:
    "Add a contractor the business pays for work, with whether their W-9 is on file. Record each payment to them with expense add, giving contractor_id and payment_method.",
  fields: {
    name: { type: "text", required: true, description: "The contractor's name, as on their W-9." },
    w9_status: { type: "enum", required: true, values: W9, description: "on_file or not_on_file." },
    w9_received_on: { type: "date", description: "The day their W-9 arrived, YYYY-MM-DD; only with on_file." },
  },
  run(db, input, ctx) {
    if (db.query("SELECT 1 FROM contractors WHERE name = ?").get(input.name)) throw new Refusal("A contractor with this name already exists.", "name");
    if (input.w9_received_on !== undefined && input.w9_status !== "on_file") throw new Refusal("w9_received_on goes with a W-9 that is on_file.", "w9_received_on");
    const { id } = db
      .query("INSERT INTO contractors (name, w9_status, w9_received_on, source) VALUES (?, ?, ?, ?) RETURNING id")
      .get(input.name, input.w9_status, input.w9_received_on ?? null, ctx.source) as { id: number };
    return { contractor: contractorView(db, id) };
  },
};

const contractorEdit: Op = {
  name: "contractor_edit",
  kind: "write",
  description: "Change a contractor's name or W-9 status, such as when their W-9 arrives.",
  fields: {
    id: { type: "int", required: true, min: 1, description: "Contractor id." },
    name: { type: "text", description: "New name." },
    w9_status: { type: "enum", values: W9, description: "on_file or not_on_file." },
    w9_received_on: { type: "date", description: "The day their W-9 arrived, YYYY-MM-DD; only with on_file." },
  },
  run(db, input, ctx) {
    const c = contractorRow(db, input.id);
    if (!c) throw new Refusal(`There is no contractor with id ${input.id}.`, "id");
    if (Object.keys(input).length === 1) throw new Refusal("Give at least one change to make to the contractor.", "w9_status");
    const name = input.name ?? c.name;
    if (name.toLowerCase() !== c.name.toLowerCase() && db.query("SELECT 1 FROM contractors WHERE name = ?").get(name)) {
      throw new Refusal("A contractor with this name already exists.", "name");
    }
    const status = input.w9_status ?? c.w9_status;
    const received = status === "on_file" ? (input.w9_received_on ?? c.w9_received_on) : null;
    if (input.w9_received_on !== undefined && status !== "on_file") throw new Refusal("w9_received_on goes with a W-9 that is on_file.", "w9_received_on");
    db.query("UPDATE contractors SET name = ?, w9_status = ?, w9_received_on = ?, source = ? WHERE id = ?").run(name, status, received, ctx.source, c.id);
    return { contractor: contractorView(db, c.id) };
  },
};

function contractors(db: Books, from: string, to: string) {
  const ids = db.query("SELECT id FROM contractors ORDER BY name, id").all() as { id: number }[];
  return ids.map((r) => contractorView(db, r.id, from, to));
}

const contractorList: Op = {
  name: "contractor_list",
  kind: "read",
  description:
    "List contractors with their W-9 status and what they were paid in a year (default: every year): each payment with its method, flagged outside_1099_nec when paid by card or PayPal, and the totals by method. 1099s are prepared elsewhere.",
  fields: { year: { ...yearField, required: false } },
  run(db, input) {
    const r = input.year === undefined ? { from: "0000-01-01", to: "9999-12-31" } : yearRange(input.year);
    return { year: input.year ?? null, contractors: contractors(db, r.from, r.to) };
  },
};

// ---------------------------------------------------------------- the year-end report

const reportYearEnd: Op = {
  name: "report_yearend",
  kind: "read",
  description:
    "Everything an accountant asks for at year end, in one report: the P&L by Schedule C line and year-to-date profit (cash basis), sales tax collected and paid, the mileage log at the IRS rate for each trip's date, home office figures, owner items (estimated taxes, health insurance, retirement) totalled apart from the P&L, and contractors with W-9 status and payment methods. Pair it with export --format csv for the transactions. Figures only, not tax advice.",
  fields: { year: yearField },
  run(db, input) {
    const { from, to } = yearRange(input.year);
    const p = pnl(db, from, to);
    return {
      year: input.year,
      from,
      to,
      basis: "cash",
      basis_note: BASIS_NOTE,
      note: "solobooks states these figures as recorded; it computes no tax, decides nothing about what is deductible, and files nothing.",
      profit_cents: p.net_cents,
      pnl: p,
      sales_tax: salesTax(db, from, to),
      mileage: mileageLog(db, from, to),
      home_office: homeOffice(db, input.year),
      owner_items: ownerItems(db, from, to),
      contractors: contractors(db, from, to),
    };
  },
};

export const yearEndOps: Op[] = [
  mileageAdd, mileageDelete, mileageList, homeOfficeSet, ownerItemAdd, contractorAdd, contractorEdit, contractorList, reportYearEnd,
];
