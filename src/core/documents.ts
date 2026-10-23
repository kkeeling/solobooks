import { requireClient } from "./clients.ts";
import type { Books } from "./db.ts";
import { sha256 } from "./files.ts";
import { daysBetween, dollars, longDate, termsText, today } from "./format.ts";
import { amounts, displayNumber, getInvoiceRow, openBalance, requireInvoice, type InvoiceRow } from "./invoices.ts";
import type { Op } from "./op.ts";
import { renderPdf } from "./pdf.ts";
import { getProfile } from "./profile.ts";
import { Refusal } from "./refusal.ts";

// Client documents solobooks makes: the invoice or credit note PDF, the invoice email and the overdue reminder.
// It makes them; the agent delivers them.

/** Everything a client document shows, and nothing it doesn't. Drafts show live details and no number. */
export interface InvoiceDocument {
  kind: "invoice" | "credit";
  draft: boolean;
  number: string | null;
  credits_number: string | null;
  seller: { legal_name: string | null; address: string | null; ein: string | null; email: string | null };
  client: { name: string; address: string | null };
  invoice_date: string | null;
  due_date: string | null;
  period_start: string;
  period_end: string;
  terms: string | null;
  lines: { description: string; amount_cents: number }[];
  subtotal_cents: number;
  tax: { label: string; rate_ppm: number; taxable_cents: number; amount_cents: number } | null;
  total_cents: number;
  payment_instructions: string | null;
  note: string | null;
}

export function invoiceDocument(db: Books, r: InvoiceRow): InvoiceDocument {
  const a = amounts(db, r);
  const draft = r.status === "draft";
  const p = getProfile(db);
  const c = requireClient(db, r.client_id);
  const original = r.credits_invoice_id === null ? null : getInvoiceRow(db, r.credits_invoice_id);
  return {
    kind: r.kind,
    draft,
    number: displayNumber(r),
    credits_number: original ? displayNumber(original) : null,
    seller: draft
      ? { legal_name: p.legal_name, address: p.address, ein: p.ein, email: p.email }
      : { legal_name: r.seller_legal_name, address: r.seller_address, ein: r.seller_ein, email: r.seller_email },
    client: draft ? { name: c.name, address: c.address } : { name: r.client_name!, address: r.client_address },
    invoice_date: r.invoice_date,
    due_date: r.due_date,
    period_start: r.period_start,
    period_end: r.period_end,
    terms: r.kind === "invoice" ? termsText(r.terms_days) : null,
    lines: a.lines.map((l) => ({ description: l.description, amount_cents: l.amount_cents })),
    subtotal_cents: a.subtotal,
    tax: a.tax,
    total_cents: a.total,
    payment_instructions: draft ? p.payment_instructions : r.payment_instructions,
    note: r.note,
  };
}

/** A document someone outside will read must have been issued: a draft has no number to quote. */
function requireIssued(db: Books, id: number): InvoiceRow {
  const r = requireInvoice(db, id);
  if (r.status === "draft") throw new Refusal(`Draft invoice ${r.id} has no number yet, so issue it first.`, "id");
  if (r.status === "void") throw new Refusal(`${r.kind === "credit" ? "Credit note" : "Invoice"} ${displayNumber(r)} is void.`, "id");
  return r;
}

const fileName = (r: InvoiceRow) => `invoices/${r.number === null ? `draft-${r.id}` : displayNumber(r)}.pdf`;

const invoicePdf: Op = {
  name: "invoice_pdf",
  kind: "read",
  savesFile: true,
  description:
    "Make the PDF of an invoice or credit note and save it in the books folder under invoices/. A draft's PDF is stamped DRAFT and has no number. Returns the file's path inside the books folder.",
  fields: { id: { type: "int", required: true, min: 1, description: "Invoice or credit note id." } },
  async run(db, input, ctx) {
    const r = requireInvoice(db, input.id);
    const bytes = await renderPdf(invoiceDocument(db, r), r.issued_at ?? ctx.now);
    const file = fileName(r);
    ctx.files.push({ path: file, bytes, field: "id" });
    return { file, sha256: sha256(bytes), bytes: bytes.length };
  },
};

function signOff(r: InvoiceRow, doc: InvoiceDocument): string {
  const pay = doc.payment_instructions ? `\n\nHow to pay:\n${doc.payment_instructions}` : "";
  return `${pay}\n\nThank you,\n${doc.seller.legal_name ?? ""}`;
}

const invoiceEmail: Op = {
  name: "invoice_email",
  kind: "read",
  description:
    "Write the email that goes with an issued invoice or credit note: from, to, subject and body, with the number, amount and due date. solobooks never sends it; the agent does, then reports it with invoice sent.",
  fields: { id: { type: "int", required: true, min: 1, description: "Invoice or credit note id." } },
  run(db, input) {
    const r = requireIssued(db, input.id);
    const doc = invoiceDocument(db, r);
    const amount = dollars(doc.total_cents);
    const head =
      r.kind === "invoice"
        ? {
            subject: `Invoice ${doc.number} from ${doc.seller.legal_name}: ${amount} due ${longDate(doc.due_date!)}`,
            body: `Hi ${doc.client.name},\n\nAttached is invoice ${doc.number} for ${amount}, due ${longDate(doc.due_date!)}, for services from ${longDate(doc.period_start)} to ${longDate(doc.period_end)}.`,
          }
        : {
            subject: `Credit note ${doc.number} from ${doc.seller.legal_name}: ${amount} against invoice ${doc.credits_number}`,
            body: `Hi ${doc.client.name},\n\nAttached is credit note ${doc.number} for ${amount}, which reduces what you owe on invoice ${doc.credits_number}.`,
          };
    return {
      from: doc.seller.email,
      to: r.client_email,
      subject: head.subject,
      body: head.body + (r.kind === "invoice" ? signOff(r, doc) : `\n\nThank you,\n${doc.seller.legal_name ?? ""}`),
      attachment: fileName(r),
    };
  },
};

const invoiceReminder: Op = {
  name: "invoice_reminder",
  kind: "read",
  description:
    "Write the overdue reminder for an issued invoice: from, to, subject and body, with the unpaid balance and how many days late it is. solobooks never sends it.",
  fields: {
    id: { type: "int", required: true, min: 1, description: "Invoice id." },
    as_of: { type: "date", description: "The day the reminder is for, YYYY-MM-DD. Default today." },
  },
  run(db, input, ctx) {
    const r = requireIssued(db, input.id);
    if (r.kind !== "invoice") throw new Refusal(`Credit note ${displayNumber(r)} is owed to the client, so it gets no reminder.`, "id");
    const asOf = input.as_of ?? today(ctx.now);
    const days = daysBetween(r.due_date!, asOf);
    if (days <= 0) throw new Refusal(`Invoice ${r.number} isn't overdue until after ${longDate(r.due_date!)}.`, "as_of");
    const balance = openBalance(db, r);
    if (balance <= 0) throw new Refusal(`Invoice ${r.number} has nothing left to pay.`, "id");
    const doc = invoiceDocument(db, r);
    const late = `${days} day${days === 1 ? "" : "s"}`;
    return {
      from: doc.seller.email,
      to: r.client_email,
      subject: `Overdue: invoice ${doc.number}, ${dollars(balance)} unpaid, ${late} late`,
      body:
        `Hi ${doc.client.name},\n\nInvoice ${doc.number} was due ${longDate(r.due_date!)} and is now ${late} late. ` +
        `The unpaid balance is ${dollars(balance)}.` +
        signOff(r, doc),
      balance_cents: balance,
      days_late: days,
      attachment: fileName(r),
    };
  },
};

export const documentOps: Op[] = [invoicePdf, invoiceEmail, invoiceReminder];
