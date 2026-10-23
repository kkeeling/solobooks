// The Schedule C (Form 1040) lines an income or expense account can report on, named as the form names them.
// Source: IRS, Schedule C (Form 1040), https://www.irs.gov/pub/irs-pdf/f1040sc.pdf. Lines for inventory, payroll and
// depletion are left out, because solobooks doesn't keep books for any of those.

export const SCHEDULE_C = {
  "1": "Gross receipts or sales",
  "2": "Returns and allowances",
  "6": "Other income",
  "8": "Advertising",
  "9": "Car and truck expenses",
  "10": "Commissions and fees",
  "11": "Contract labor",
  "13": "Depreciation and section 179 expense",
  "15": "Insurance (other than health)",
  "16a": "Interest: mortgage",
  "16b": "Interest: other",
  "17": "Legal and professional services",
  "18": "Office expense",
  "20a": "Rent or lease: vehicles, machinery, and equipment",
  "20b": "Rent or lease: other business property",
  "21": "Repairs and maintenance",
  "22": "Supplies",
  "23": "Taxes and licenses",
  "24a": "Travel",
  "24b": "Deductible meals",
  "25": "Utilities",
  "27b": "Other expenses",
  "30": "Expenses for business use of your home",
} as const;

export type ScheduleCLine = keyof typeof SCHEDULE_C;
export const SCHEDULE_C_LINES = Object.keys(SCHEDULE_C) as ScheduleCLine[];
/** Lines in Part I, where income goes. Every other line is an expense line. */
export const INCOME_LINES: readonly ScheduleCLine[] = ["1", "2", "6"];

/**
 * solobooks' own accounts and the line they report on unless the person sets another: what clients paid for work
 * and for costs billed on at cost are gross receipts, and a payment processor's fee is a fee.
 */
const OWN_LINES: Record<string, ScheduleCLine> = {
  "consulting income": "1",
  "reimbursed expense income": "1",
  "payment processing fees": "10",
};

/** The line an account reports on: the one set on it, else solobooks' standard one for its own accounts, else none. */
export function lineOf(a: { name: string; type: string; schedule_c: string | null }): ScheduleCLine | null {
  if (a.type !== "income" && a.type !== "expense") return null;
  return (a.schedule_c as ScheduleCLine | null) ?? OWN_LINES[a.name.toLowerCase()] ?? null;
}

/** Lines in the form's order, for listing. */
export const lineOrder = (l: string) => SCHEDULE_C_LINES.indexOf(l as ScheduleCLine);
