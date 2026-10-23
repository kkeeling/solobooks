import type { Books } from "./db.ts";
import type { Op } from "./op.ts";
import { Refusal } from "./refusal.ts";

// The seller's own details, set once: what every issued invoice carries.

export type Profile = {
  legal_name: string | null;
  address: string | null;
  ein: string | null;
  email: string | null;
  payment_instructions: string | null;
  next_invoice_number: number;
  source: string | null;
};

const EMPTY: Profile = {
  legal_name: null,
  address: null,
  ein: null,
  email: null,
  payment_instructions: null,
  next_invoice_number: 1,
  source: null,
};

export function getProfile(db: Books): Profile {
  const row = db
    .query("SELECT legal_name, address, ein, email, payment_instructions, next_invoice_number, source FROM business_profile WHERE id = 1")
    .get() as Profile | null;
  return row ?? EMPTY;
}

/** The number the next issued invoice gets: one past the last solobooks issued, or the configured start before the first. Past invoices brought in keep their own numbers below it. */
export function nextInvoiceNumber(db: Books): number {
  const { n } = db.query("SELECT MAX(number) AS n FROM invoices WHERE kind = 'invoice' AND number IS NOT NULL AND historical = 0").get() as {
    n: number | null;
  };
  return n === null ? getProfile(db).next_invoice_number : n + 1;
}

const profileSet: Op = {
  name: "profile_set",
  kind: "write",
  description:
    "Set the business details issued invoices carry: legal name, address, EIN, the email invoices come from, payment instructions and the first invoice number. Only the fields given change. Changing payment_instructions is gated and goes in a request of its own: unless the person lets the agent decide, it waits as a pending action for them to approve.",
  gate: (input) => (input.payment_instructions !== undefined ? "payment_instructions" : null),
  fields: {
    legal_name: { type: "text", description: "The business's legal name." },
    address: { type: "text", description: "Postal address; separate lines with a newline." },
    ein: { type: "text", description: "Employer Identification Number, 12-3456789." },
    email: { type: "text", description: "The address invoices are emailed from." },
    payment_instructions: { type: "text", description: "How clients pay, printed on every invoice." },
    next_invoice_number: {
      type: "int", min: 1, max: 999_999_999,
      description: "The number the first issued invoice gets; numbers then continue with no gaps. Fixed once an invoice is issued.",
    },
  },
  run(db, input, ctx) {
    if (Object.keys(input).length === 0) throw new Refusal("Give at least one business detail to set.", "legal_name");
    // A gated change is approved on what the person is shown, so payment instructions travel alone.
    if (input.payment_instructions !== undefined && Object.keys(input).length > 1) {
      throw new Refusal("Change payment_instructions on its own, with no other business detail in the same request.", "payment_instructions");
    }
    const next: Profile = { ...getProfile(db), ...input, source: ctx.source };
    if (input.ein !== undefined) {
      const digits = String(input.ein).replace(/-/g, "");
      if (!/^\d{9}$/.test(digits)) throw new Refusal("ein must be nine digits written 12-3456789.", "ein");
      next.ein = `${digits.slice(0, 2)}-${digits.slice(2)}`;
    }
    if (input.next_invoice_number !== undefined) {
      const issued = db.query("SELECT 1 FROM invoices WHERE kind = 'invoice' AND number IS NOT NULL AND historical = 0 LIMIT 1").get();
      if (issued) {
        throw new Refusal(
          "Invoices have already been issued, so numbers continue from the last one and next_invoice_number can't change.",
          "next_invoice_number",
        );
      }
      const { past } = db.query("SELECT MAX(number) AS past FROM invoices WHERE kind = 'invoice' AND historical = 1").get() as { past: number | null };
      if (past !== null && input.next_invoice_number <= past) {
        throw new Refusal(`Past invoice ${past} is already in the books, so next_invoice_number must be above it.`, "next_invoice_number");
      }
    }
    db.query(
      `INSERT INTO business_profile (id, legal_name, address, ein, email, payment_instructions, next_invoice_number, source)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET legal_name = excluded.legal_name, address = excluded.address, ein = excluded.ein,
         email = excluded.email, payment_instructions = excluded.payment_instructions,
         next_invoice_number = excluded.next_invoice_number, source = excluded.source`,
    ).run(next.legal_name, next.address, next.ein, next.email, next.payment_instructions, next.next_invoice_number, next.source);
    return { profile: getProfile(db) };
  },
};

const profileGet: Op = {
  name: "profile_get",
  kind: "read",
  description: "Show the business details and the number the next issued invoice will get.",
  fields: {},
  run(db) {
    return { profile: getProfile(db), next_invoice_number: nextInvoiceNumber(db) };
  },
};

export const profileOps: Op[] = [profileSet, profileGet];
