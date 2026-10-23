import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { requireClient } from "./clients.ts";
import type { Books } from "./db.ts";
import { sha256 } from "./files.ts";
import { getAccount, refuseInvoiceAccount } from "./ledger.ts";
import type { Op } from "./op.ts";
import { Refusal } from "./refusal.ts";
import { currency, MAX_CENTS } from "./validate.ts";

// Expenses, each posted to the ledger when recorded, with an optional receipt kept in the books folder.

const MAX_RECEIPT_BYTES = 25 * 1024 * 1024;

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
    "Record a business expense and post it to the books, optionally with its receipt file (copied into the books folder) and as a pass-through cost to bill on to a client.",
  fields: {
    date: { type: "date", required: true, description: "Day of the expense, YYYY-MM-DD." },
    amount_cents: { type: "int", required: true, min: 1, max: MAX_CENTS, unit: "cents", description: "Amount in cents." },
    vendor: { type: "text", required: true, description: "Who was paid." },
    memo: { type: "text", description: "What it was for." },
    account_id: { type: "int", required: true, min: 1, description: "The expense account it belongs to." },
    paid_from_account_id: { type: "int", required: true, min: 1, description: "The bank, card or owner account it was paid from." },
    receipt_path: { type: "text", description: "Path to the receipt file on this machine; it is copied into the books folder." },
    pass_through_client_id: { type: "int", min: 1, description: "Client this cost is billed on to at cost; their next draft for its date picks it up." },
    currency,
  },
  run(db, input, ctx) {
    const expense = requireAccount(db, input.account_id, "account_id", ["expense"], "an expense account");
    requireAccount(db, input.paid_from_account_id, "paid_from_account_id", ["asset", "liability", "equity"], "a bank, card or owner account");
    refuseInvoiceAccount(db, input.paid_from_account_id, "paid_from_account_id");
    if (input.pass_through_client_id !== undefined) requireClient(db, input.pass_through_client_id, "pass_through_client_id");

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
    line.run(entryId, input.paid_from_account_id, 0, input.amount_cents, ctx.source);

    const { id } = db
      .query(
        `INSERT INTO expenses (date, amount_cents, vendor, memo, account_id, paid_from_account_id, entry_id, pass_through_client_id,
           receipt_file, receipt_sha256, receipt_bytes, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        input.date,
        input.amount_cents,
        input.vendor,
        input.memo ?? null,
        input.account_id,
        input.paid_from_account_id,
        entryId,
        input.pass_through_client_id ?? null,
        receipt?.file ?? null,
        receipt?.sha ?? null,
        receipt?.size ?? null,
        ctx.source,
      ) as { id: number };
    return { expense: expenseView(db, id) };
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
