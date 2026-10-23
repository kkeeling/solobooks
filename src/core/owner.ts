import type { Books } from "./db.ts";
import { getEntry, namedAccount, postEntry, requireOwnAccount } from "./ledger.ts";
import type { Ctx, Op } from "./op.ts";
import { Refusal } from "./refusal.ts";
import { currency, MAX_CENTS } from "./validate.ts";

// Owner money: the person's own money moving. None of it is income or expense, so none of it reaches the P&L.
// A transfer moves money between their own accounts and must net to zero; a draw takes money out of the business
// and a contribution puts it in, both through equity accounts solobooks keeps.

export const OWNER_ACCOUNTS = {
  draws: { name: "Owner draws", type: "equity" },
  contributions: { name: "Owner contributions", type: "equity" },
} as const;

export function ownerMoveView(db: Books, id: number) {
  const m = db.query("SELECT * FROM owner_moves WHERE id = ?").get(id) as Record<string, any>;
  return {
    id: m.id,
    kind: m.kind,
    date: m.date,
    amount_cents: m.amount_cents,
    memo: m.memo,
    entry: getEntry(db, m.entry_id),
    expense_id: m.expense_id,
    source: m.source,
  };
}

export function insertMove(db: Books, kind: string, date: string, cents: number, memo: string | null, entryId: number, expenseId: number | null, ctx: Ctx): number {
  return (
    db
      .query("INSERT INTO owner_moves (kind, date, amount_cents, memo, entry_id, expense_id, source) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
      .get(kind, date, cents, memo, entryId, expenseId, ctx.source) as { id: number }
  ).id;
}

/** A business cost the person paid with their own money: the expense's entry credits their contribution, recorded as one. */
export function contributionAccount(db: Books, ctx: Ctx, field: string): number {
  return namedAccount(db, OWNER_ACCOUNTS.contributions, ctx.source, field);
}

export function recordPersonalCost(db: Books, date: string, cents: number, memo: string, entryId: number, expenseId: number, ctx: Ctx) {
  return ownerMoveView(db, insertMove(db, "contribution", date, cents, memo, entryId, expenseId, ctx));
}

const transferAdd: Op = {
  name: "transfer_add",
  kind: "write",
  description:
    "Record money moving between the person's own accounts, such as checking to savings or paying a card off from checking. Each leg is one account and its signed amount: positive when money goes into that account (a deposit, or a payment that lowers what a card owes), negative when it leaves. The legs must net to zero, so a transfer is never income or expense.",
  fields: {
    date: { type: "date", required: true, description: "Day of the transfer, YYYY-MM-DD." },
    memo: { type: "text", description: "What it was, such as Pay off October card." },
    legs: {
      type: "list",
      required: true,
      minItems: 2,
      description: "Two or more legs, each with account_id and a signed amount_cents; they must add up to zero.",
      of: {
        account_id: { type: "int", required: true, min: 1, description: "One of the person's own bank, card or balance accounts." },
        amount_cents: {
          type: "int", required: true, min: -MAX_CENTS, max: MAX_CENTS, unit: "cents",
          description: "Positive when money goes into this account, negative when it leaves; never zero.",
        },
        currency,
      },
    },
  },
  run(db, input, ctx) {
    const seen = new Set<number>();
    input.legs.forEach((l: { account_id: number; amount_cents: number }, i: number) => {
      requireOwnAccount(db, l.account_id, `legs[${i}].account_id`);
      if (seen.has(l.account_id)) throw new Refusal(`Account ${l.account_id} is already a leg of this transfer, so give each account once.`, `legs[${i}].account_id`);
      seen.add(l.account_id);
      if (l.amount_cents === 0) throw new Refusal(`legs[${i}].amount_cents must not be zero.`, `legs[${i}].amount_cents`);
    });
    const net = input.legs.reduce((s: number, l: { amount_cents: number }) => s + l.amount_cents, 0);
    if (net !== 0) {
      throw new Refusal(`The legs add up to ${net} cents, but a transfer between your own accounts must net to zero.`, "legs");
    }
    const moved = input.legs.reduce((s: number, l: { amount_cents: number }) => s + Math.max(l.amount_cents, 0), 0);
    const memo = input.memo ?? null;
    const legs: [number, number][] = input.legs.map((l: { account_id: number; amount_cents: number }) => [l.account_id, l.amount_cents]);
    const entry = postEntry(db, input.date, memo ? `Transfer: ${memo}` : "Transfer between own accounts", legs, ctx.source);
    return { transfer: ownerMoveView(db, insertMove(db, "transfer", input.date, moved, memo, entry, null, ctx)) };
  },
};

const moveFields = (what: string) =>
  ({
    date: { type: "date", required: true, description: "Day of it, YYYY-MM-DD." },
    amount_cents: { type: "int", required: true, min: 1, max: MAX_CENTS, unit: "cents", description: "Amount in cents." },
    account_id: { type: "int", required: true, min: 1, description: what },
    memo: { type: "text", description: "What it was for." },
    currency,
  }) as const;

const ownerDraw: Op = {
  name: "owner_draw",
  kind: "write",
  description:
    "Record the person taking money out of the business for themselves, such as a transfer from business checking to their personal account. It never counts as an expense.",
  fields: moveFields("The business account the money left, such as checking."),
  run(db, input, ctx) {
    requireOwnAccount(db, input.account_id, "account_id");
    const draws = namedAccount(db, OWNER_ACCOUNTS.draws, ctx.source, "account_id");
    const memo = input.memo ?? null;
    const entry = postEntry(db, input.date, memo ? `Owner draw: ${memo}` : "Owner draw", [[draws, input.amount_cents], [input.account_id, -input.amount_cents]], ctx.source);
    return { draw: ownerMoveView(db, insertMove(db, "draw", input.date, input.amount_cents, memo, entry, null, ctx)) };
  },
};

const ownerContribute: Op = {
  name: "owner_contribute",
  kind: "write",
  description:
    "Record the person putting their own money into the business, such as a transfer from their personal account into business checking. It never counts as income. A business cost paid with a personal card goes through expense add with paid_personally instead.",
  fields: moveFields("The business account the money went into, such as checking."),
  run(db, input, ctx) {
    requireOwnAccount(db, input.account_id, "account_id");
    const contributions = contributionAccount(db, ctx, "account_id");
    const memo = input.memo ?? null;
    const entry = postEntry(
      db, input.date, memo ? `Owner contribution: ${memo}` : "Owner contribution", [[input.account_id, input.amount_cents], [contributions, -input.amount_cents]], ctx.source,
    );
    return { contribution: ownerMoveView(db, insertMove(db, "contribution", input.date, input.amount_cents, memo, entry, null, ctx)) };
  },
};

const ownerList: Op = {
  name: "owner_list",
  kind: "read",
  description: "List owner money: transfers between the person's own accounts, draws and contributions, with their entries.",
  fields: { kind: { type: "enum", values: ["transfer", "draw", "contribution"], description: "Only this kind." } },
  run(db, input) {
    const rows = db.query("SELECT id FROM owner_moves WHERE ?1 IS NULL OR kind = ?1 ORDER BY date, id").all(input.kind ?? null) as { id: number }[];
    return { owner_money: rows.map((r) => ownerMoveView(db, r.id)) };
  },
};

export const ownerOps: Op[] = [transferAdd, ownerDraw, ownerContribute, ownerList];
