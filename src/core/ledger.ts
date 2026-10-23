import type { Books } from "./db.ts";
import type { Op } from "./op.ts";
import { Refusal } from "./refusal.ts";
import { currency, MAX_CENTS } from "./validate.ts";

export const ACCOUNT_TYPES = ["asset", "liability", "equity", "income", "expense"] as const;

/**
 * The accounts invoices post to. Only invoice issue, void and credit move them, all three gated, so no journal entry
 * or expense may touch them: otherwise an ungated write could quietly reverse an issued invoice.
 */
export const INVOICE_ACCOUNTS = {
  receivable: { name: "Accounts receivable", type: "asset" },
  services: { name: "Consulting income", type: "income" },
  reimbursed: { name: "Reimbursed expense income", type: "income" },
  salesTax: { name: "Sales tax payable", type: "liability" },
} as const;

/** Refuses an account invoices post to, naming the field that holds it. */
export function refuseInvoiceAccount(db: Books, id: number, field: string): void {
  const a = getAccount(db, id);
  if (a && Object.values(INVOICE_ACCOUNTS).some((x) => x.name.toLowerCase() === a.name.toLowerCase())) {
    throw new Refusal(`Account ${id} is one invoices post to, so change what an invoice owes with invoice void or invoice credit instead.`, field);
  }
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

const accountAdd: Op = {
  name: "account_add",
  kind: "write",
  description: "Add an account to the chart of accounts.",
  fields: {
    name: { type: "text", required: true, description: "Account name, unique." },
    type: { type: "enum", required: true, values: ACCOUNT_TYPES, description: "asset, liability, equity, income or expense." },
  },
  run(db, input, ctx) {
    if (db.query("SELECT 1 FROM accounts WHERE name = ?").get(input.name)) {
      throw new Refusal("An account with this name already exists.", "name");
    }
    const { id } = db
      .query("INSERT INTO accounts (name, type, source) VALUES (?, ?, ?) RETURNING id")
      .get(input.name, input.type, ctx.source) as { id: number };
    return { account: getAccount(db, id) };
  },
};

const accountList: Op = {
  name: "account_list",
  kind: "read",
  description: "List the chart of accounts.",
  fields: {},
  run(db) {
    return { accounts: db.query("SELECT id, name, type, source FROM accounts ORDER BY id").all() };
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

export const ledgerOps: Op[] = [accountAdd, accountList, entryPost, entryList];
