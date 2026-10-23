import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { requireClient } from "./clients.ts";
import type { Books } from "./db.ts";
import { sha256 } from "./files.ts";
import { getAccount, refuseInvoiceAccount } from "./ledger.ts";
import type { Op } from "./op.ts";
import { contributionAccount, recordPersonalCost } from "./owner.ts";
import { Refusal } from "./refusal.ts";
import { currency, MAX_CENTS } from "./validate.ts";

// Expenses, each posted to the ledger when recorded, with an optional receipt kept in the books folder.

const MAX_RECEIPT_BYTES = 25 * 1024 * 1024;

/** How an expense was paid. */
export const PAYMENT_METHODS = ["ach", "wire", "check", "cash", "zelle", "card", "paypal", "other"] as const;

export function expenseView(db: Books, id: number) {
  const e = db.query("SELECT * FROM expenses WHERE id = ?").get(id) as Record<string, any>;
  const recovered = db
    .query(
      `SELECT i.id, i.number, i.status FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
       WHERE l.expense_id = ? AND i.status <> 'void'`,
    )
    .get(id) as { id: number; number: number | null; status: string } | null;
  return {
    id: e.id,
    date: e.date,
    amount_cents: e.amount_cents,
    vendor: e.vendor,
    memo: e.memo,
    account_id: e.account_id,
    paid_from_account_id: e.paid_from_account_id,
    entry_id: e.entry_id,
    pass_through_client_id: e.pass_through_client_id,
    contractor_id: e.contractor_id,
    payment_method: e.payment_method,
    receipt: e.receipt_file ? { file: e.receipt_file, sha256: e.receipt_sha256, bytes: e.receipt_bytes } : null,
    // The invoice that bills this cost on to the client, if any.
    recovered_by_invoice: recovered
      ? { invoice_id: recovered.id, number: recovered.number === null ? null : String(recovered.number), status: recovered.status }
      : null,
    source: e.source,
  };
}

function requireAccount(db: Books, id: number, field: string, types: string[], what: string) {
  const a = getAccount(db, id);
  if (!a) throw new Refusal(`There is no account with id ${id}.`, field);
  if (!types.includes(a.type)) throw new Refusal(`Account ${id} is ${a.type}, but ${field} must be ${what}.`, field);
  return a;
}

const expenseAdd: Op = {
  name: "expense_add",
  kind: "write",
  description:
    "Record a business expense and post it to the books, optionally with its receipt file (copied into the books folder) and as a pass-through cost to bill on to a client. When the person paid it with their own money, such as a personal card, set paid_personally instead of paid_from_account_id: it is recorded as the expense plus an owner contribution of the same amount. A payment to a contractor names them with contractor_id and says how it was paid with payment_method.",
  fields: {
    date: { type: "date", required: true, description: "Day of the expense, YYYY-MM-DD." },
    amount_cents: { type: "int", required: true, min: 1, max: MAX_CENTS, unit: "cents", description: "Amount in cents." },
    vendor: { type: "text", required: true, description: "Who was paid." },
    memo: { type: "text", description: "What it was for." },
    account_id: { type: "int", required: true, min: 1, description: "The expense account it belongs to." },
    paid_from_account_id: { type: "int", min: 1, description: "The business bank or card account it was paid from; give this or paid_personally." },
    paid_personally: {
      type: "bool",
      description: "true when the person paid it with their own money, such as a personal card: the books then record an owner contribution for it.",
    },
    receipt_path: { type: "text", description: "Path to the receipt file on this machine; it is copied into the books folder." },
    pass_through_client_id: { type: "int", min: 1, description: "Client this cost is billed on to at cost; their next draft for its date picks it up." },
    contractor_id: { type: "int", min: 1, description: "The contractor paid, when this is a payment for someone's work (see contractor add); needs payment_method." },
    payment_method: {
      type: "enum", values: PAYMENT_METHODS,
      description: "How it was paid: ach, wire, check, cash, zelle, card, paypal or other. Required with contractor_id, because card and PayPal payments to a contractor are reported on 1099-K, not 1099-NEC.",
    },
    currency,
  },
  run(db, input, ctx) {
    const expense = requireAccount(db, input.account_id, "account_id", ["expense"], "an expense account");
    const personal = input.paid_personally === true;
    if (personal === (input.paid_from_account_id !== undefined)) {
      throw new Refusal(
        "Say how it was paid with paid_from_account_id, or set paid_personally to true when the person paid it with their own money, but not both.",
        "paid_from_account_id",
      );
    }
    if (!personal) {
      requireAccount(db, input.paid_from_account_id, "paid_from_account_id", ["asset", "liability", "equity"], "a bank, card or owner account");
      refuseInvoiceAccount(db, input.paid_from_account_id, "paid_from_account_id");
    }
    // Paid personally: the cost is the business's, and the money is the person's contribution to it.
    const paidFrom: number = personal ? contributionAccount(db, ctx, "paid_personally") : input.paid_from_account_id;
    if (input.pass_through_client_id !== undefined) requireClient(db, input.pass_through_client_id, "pass_through_client_id");
    if (input.contractor_id !== undefined) {
      if (!db.query("SELECT 1 FROM contractors WHERE id = ?").get(input.contractor_id)) {
        throw new Refusal(`There is no contractor with id ${input.contractor_id}.`, "contractor_id");
      }
      if (input.payment_method === undefined) {
        throw new Refusal("A payment to a contractor needs payment_method, since card and PayPal payments are reported on 1099-K instead of 1099-NEC.", "payment_method");
      }
    }

    let receipt: { file: string; sha: string; size: number } | null = null;
    if (input.receipt_path !== undefined) {
      const path = resolve(input.receipt_path);
      let bytes: Uint8Array;
      try {
        if (!statSync(path).isFile()) throw new Error("not a file");
        if (statSync(path).size > MAX_RECEIPT_BYTES) throw new Refusal("The receipt is larger than 25 MB, so shrink it first.", "receipt_path");
        bytes = readFileSync(path);
      } catch (e) {
        if (e instanceof Refusal) throw e;
        throw new Refusal("There is no readable file at receipt_path.", "receipt_path");
      }
      const sha = sha256(bytes);
      const ext = extname(path).toLowerCase();
      const file = `receipts/${sha}${/^\.[a-z0-9]{1,5}$/.test(ext) ? ext : ""}`;
      ctx.files.push({ path: file, bytes, field: "receipt_path" });
      receipt = { file, sha, size: bytes.length };
    }

    const memo = input.memo ? `${input.vendor}: ${input.memo}` : input.vendor;
    const { id: entryId } = db
      .query("INSERT INTO entries (date, memo, source) VALUES (?, ?, ?) RETURNING id")
      .get(input.date, `${expense.name}: ${memo}`, ctx.source) as { id: number };
    const line = db.query("INSERT INTO lines (entry_id, account_id, debit_cents, credit_cents, source) VALUES (?, ?, ?, ?, ?)");
    line.run(entryId, input.account_id, input.amount_cents, 0, ctx.source);
    line.run(entryId, paidFrom, 0, input.amount_cents, ctx.source);

    const { id } = db
      .query(
        `INSERT INTO expenses (date, amount_cents, vendor, memo, account_id, paid_from_account_id, entry_id, pass_through_client_id,
           receipt_file, receipt_sha256, receipt_bytes, contractor_id, payment_method, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        input.date,
        input.amount_cents,
        input.vendor,
        input.memo ?? null,
        input.account_id,
        paidFrom,
        entryId,
        input.pass_through_client_id ?? null,
        receipt?.file ?? null,
        receipt?.sha ?? null,
        receipt?.size ?? null,
        input.contractor_id ?? null,
        input.payment_method ?? null,
        ctx.source,
      ) as { id: number };
    if (!personal) return { expense: expenseView(db, id) };
    return { expense: expenseView(db, id), owner_contribution: recordPersonalCost(db, input.date, input.amount_cents, `Paid personally: ${memo}`, entryId, id, ctx) };
  },
};

const expenseList: Op = {
  name: "expense_list",
  kind: "read",
  description: "List expenses with their receipt file (inside the books folder) and, for pass-through costs, the invoice that recovers them.",
  fields: { pass_through_client_id: { type: "int", min: 1, description: "Only pass-through costs for this client." } },
  run(db, input) {
    const rows = db
      .query("SELECT id FROM expenses WHERE ?1 IS NULL OR pass_through_client_id = ?1 ORDER BY date, id")
      .all(input.pass_through_client_id ?? null) as { id: number }[];
    return { expenses: rows.map((r) => expenseView(db, r.id)) };
  },
};

export const expenseOps: Op[] = [expenseAdd, expenseList];
