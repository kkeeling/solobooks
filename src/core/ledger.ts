import type { Books } from "./db.ts";
import type { Op } from "./op.ts";
import { Refusal } from "./refusal.ts";
import { INCOME_LINES, lineOf, SCHEDULE_C, SCHEDULE_C_LINES, type ScheduleCLine } from "./schedule-c.ts";
import { currency, MAX_CENTS } from "./validate.ts";

export const ACCOUNT_TYPES = ["asset", "liability", "equity", "income", "expense"] as const;

/**
 * The accounts invoices and their payments post to. Only invoice issue, void and credit, and payments and their
 * refunds move them, each gated or tied to its own record, so no journal entry or expense may touch them: otherwise
 * an ungated write could quietly reverse an issued invoice or mark it paid.
 */
export const INVOICE_ACCOUNTS = {
  receivable: { name: "Accounts receivable", type: "asset" },
  services: { name: "Consulting income", type: "income" },
  reimbursed: { name: "Reimbursed expense income", type: "income" },
  salesTax: { name: "Sales tax payable", type: "liability" },
  clientCredits: { name: "Client credits", type: "liability" },
} as const;

/** Refuses an account invoices post to, naming the field that holds it. */
export function refuseInvoiceAccount(db: Books, id: number, field: string): void {
  const a = getAccount(db, id);
  if (a && Object.values(INVOICE_ACCOUNTS).some((x) => x.name.toLowerCase() === a.name.toLowerCase())) {
    throw new Refusal(`Account ${id} is one invoices post to, so change what an invoice owes with invoice void or invoice credit instead.`, field);
  }
}

/** An account solobooks posts to by name, created on first use. */
export function namedAccount(db: Books, a: { name: string; type: string }, source: string, field: string): number {
  const found = db.query("SELECT id, type FROM accounts WHERE name = ?").get(a.name) as { id: number; type: string } | null;
  if (found) {
    if (found.type !== a.type) throw new Refusal(`The account named ${a.name} must be type ${a.type} for solobooks to post to it.`, field);
    return found.id;
  }
  return (db.query("INSERT INTO accounts (name, type, source) VALUES (?, ?, ?) RETURNING id").get(a.name, a.type, source) as { id: number }).id;
}

/**
 * One of the person's own accounts, where their money actually sits: a bank, a card or a processor balance. Equity,
 * income and expense accounts aren't places money sits, and the accounts invoices post to aren't the person's to move.
 */
export function requireOwnAccount(db: Books, id: number, field: string) {
  const a = getAccount(db, id);
  if (!a) throw new Refusal(`There is no account with id ${id}.`, field);
  if (a.type !== "asset" && a.type !== "liability") {
    throw new Refusal(`Account ${id} is ${a.type}, but ${field} must be one of your own bank, card or balance accounts (asset or liability).`, field);
  }
  refuseInvoiceAccount(db, id, field);
  return a;
}

/** Posts one entry from signed amounts: positive is a debit, negative a credit, zero no line at all. */
export function postEntry(db: Books, date: string, memo: string, legs: [number, number][], source: string): number {
  const { id } = db.query("INSERT INTO entries (date, memo, source) VALUES (?, ?, ?) RETURNING id").get(date, memo, source) as { id: number };
  const ins = db.query("INSERT INTO lines (entry_id, account_id, debit_cents, credit_cents, source) VALUES (?, ?, ?, ?, ?)");
  for (const [account, cents] of legs) {
    if (cents > 0) ins.run(id, account, cents, 0, source);
    if (cents < 0) ins.run(id, account, 0, -cents, source);
  }
  return id;
}

export function getAccount(db: Books, id: number) {
  return db.query("SELECT id, name, type, source FROM accounts WHERE id = ?").get(id) as
    | { id: number; name: string; type: string; source: string }
    | null;
}

export function getEntry(db: Books, id: number) {
  const entry = db.query("SELECT id, date, memo, source FROM entries WHERE id = ?").get(id) as Record<string, unknown>;
  const lines = db
    .query("SELECT account_id, debit_cents, credit_cents FROM lines WHERE entry_id = ? ORDER BY id")
    .all(id);
  return { ...entry, lines };
}

/** Throws unless every entry, and so the whole ledger, has equal debits and credits. Runs inside every write. */
export function assertBalanced(db: Books): void {
  const bad = db
    .query("SELECT entry_id FROM lines GROUP BY entry_id HAVING SUM(debit_cents) <> SUM(credit_cents) LIMIT 1")
    .get();
  const total = db
    .query("SELECT COALESCE(SUM(debit_cents), 0) AS d, COALESCE(SUM(credit_cents), 0) AS c FROM lines")
    .get() as { d: number; c: number };
  if (bad || total.d !== total.c) {
    throw new Refusal("The books would not balance, because total debits must equal total credits.", "lines");
  }
}

/** An account as listed: with the Schedule C line it reports on, the one set on it or solobooks' standard one. */
export function accountView(db: Books, id: number) {
  const a = db.query("SELECT id, name, type, schedule_c, source FROM accounts WHERE id = ?").get(id) as
    | { id: number; name: string; type: string; schedule_c: string | null; source: string }
    | null;
  if (!a) return null;
  const line = lineOf(a);
  return { id: a.id, name: a.name, type: a.type, schedule_c: line, schedule_c_name: line ? SCHEDULE_C[line] : null, source: a.source };
}

const scheduleField = {
  type: "enum",
  values: [...SCHEDULE_C_LINES, "none"],
  description: `The Schedule C line an income or expense account reports on, as the person decides: ${SCHEDULE_C_LINES.map((l) => `${l} ${SCHEDULE_C[l]}`).join("; ")}. Income accounts take 1, 2 or 6; none clears it.`,
} as const;

/** The line to store for an account of a type, or a refusal naming the field. */
function checkLine(type: string, line: string | undefined): ScheduleCLine | null {
  if (line === undefined || line === "none") return null;
  if (type !== "income" && type !== "expense") {
    throw new Refusal(`Only income and expense accounts report on Schedule C, and this account is ${type}.`, "schedule_c");
  }
  const incomeLine = INCOME_LINES.includes(line as ScheduleCLine);
  if ((type === "income") !== incomeLine) {
    throw new Refusal(`Line ${line} is ${incomeLine ? "an income" : "an expense"} line, so it can't hold this ${type} account.`, "schedule_c");
  }
  return line as ScheduleCLine;
}

const accountAdd: Op = {
  name: "account_add",
  kind: "write",
  description: "Add an account to the chart of accounts, optionally with the Schedule C line it reports on.",
  fields: {
    name: { type: "text", required: true, description: "Account name, unique." },
    type: { type: "enum", required: true, values: ACCOUNT_TYPES, description: "asset, liability, equity, income or expense." },
    schedule_c: scheduleField,
  },
  run(db, input, ctx) {
    if (db.query("SELECT 1 FROM accounts WHERE name = ?").get(input.name)) {
      throw new Refusal("An account with this name already exists.", "name");
    }
    const line = checkLine(input.type, input.schedule_c);
    const { id } = db
      .query("INSERT INTO accounts (name, type, schedule_c, source) VALUES (?, ?, ?, ?) RETURNING id")
      .get(input.name, input.type, line, ctx.source) as { id: number };
    return { account: accountView(db, id) };
  },
};

const accountEdit: Op = {
  name: "account_edit",
  kind: "write",
  description:
    "Set or clear the Schedule C line an income or expense account reports on, as the person decides. Posted entries don't change; the P&L groups by the new line.",
  fields: {
    id: { type: "int", required: true, min: 1, description: "Account id." },
    schedule_c: { ...scheduleField, required: true },
  },
  run(db, input, ctx) {
    const a = getAccount(db, input.id);
    if (!a) throw new Refusal(`There is no account with id ${input.id}.`, "id");
    const line = checkLine(a.type, input.schedule_c);
    db.query("UPDATE accounts SET schedule_c = ?, source = ? WHERE id = ?").run(line, ctx.source, a.id);
    return { account: accountView(db, a.id) };
  },
};

const accountList: Op = {
  name: "account_list",
  kind: "read",
  description: "List the chart of accounts, each income and expense account with the Schedule C line it reports on.",
  fields: {},
  run(db) {
    const ids = db.query("SELECT id FROM accounts ORDER BY id").all() as { id: number }[];
    return { accounts: ids.map((r) => accountView(db, r.id)) };
  },
};

const entryPost: Op = {
  name: "entry_post",
  kind: "write",
  description: "Post a balanced journal entry. Posted entries can never be edited or deleted.",
  fields: {
    date: { type: "date", required: true, description: "Entry date, YYYY-MM-DD." },
    memo: { type: "text", required: true, description: "What the entry is for." },
    lines: {
      type: "list",
      required: true,
      minItems: 2,
      description: "Two or more lines; each has account_id and exactly one of debit_cents or credit_cents.",
      of: {
        account_id: { type: "int", required: true, min: 1, description: "Account id." },
        debit_cents: { type: "int", min: 1, max: MAX_CENTS, unit: "cents", description: "Debit in whole cents." },
        credit_cents: { type: "int", min: 1, max: MAX_CENTS, unit: "cents", description: "Credit in whole cents." },
        currency,
      },
    },
  },
  run(db, input, ctx) {
    let debits = 0;
    let credits = 0;
    input.lines.forEach((l: any, i: number) => {
      const has = (l.debit_cents !== undefined ? 1 : 0) + (l.credit_cents !== undefined ? 1 : 0);
      if (has !== 1) throw new Refusal(`Line ${i} needs exactly one of debit_cents or credit_cents.`, `lines[${i}].debit_cents`);
      if (!getAccount(db, l.account_id)) throw new Refusal(`There is no account with id ${l.account_id}.`, `lines[${i}].account_id`);
      refuseInvoiceAccount(db, l.account_id, `lines[${i}].account_id`);
      debits += l.debit_cents ?? 0;
      credits += l.credit_cents ?? 0;
    });
    if (debits !== credits) {
      throw new Refusal(`The lines don't balance: debits are ${debits} cents and credits are ${credits} cents.`, "lines");
    }
    const { id } = db
      .query("INSERT INTO entries (date, memo, source) VALUES (?, ?, ?) RETURNING id")
      .get(input.date, input.memo, ctx.source) as { id: number };
    const ins = db.query(
      "INSERT INTO lines (entry_id, account_id, debit_cents, credit_cents, source) VALUES (?, ?, ?, ?, ?)",
    );
    for (const l of input.lines) ins.run(id, l.account_id, l.debit_cents ?? 0, l.credit_cents ?? 0, ctx.source);
    return { entry: getEntry(db, id) };
  },
};

const entryList: Op = {
  name: "entry_list",
  kind: "read",
  description: "List posted journal entries with their lines.",
  fields: {},
  run(db) {
    const ids = db.query("SELECT id FROM entries ORDER BY id").all() as { id: number }[];
    return { entries: ids.map((r) => getEntry(db, r.id)) };
  },
};

export const ledgerOps: Op[] = [accountAdd, accountEdit, accountList, entryPost, entryList];
