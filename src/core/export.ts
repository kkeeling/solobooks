import type { Books } from "./db.ts";
import type { Op } from "./op.ts";
import { lineOf } from "./schedule-c.ts";

// The books as a file for someone else's tools: every posted journal line as one CSV, or the whole ledger as an
// hledger journal. Both come straight from posted entries, so they balance exactly as the books do.

type Row = {
  entry_id: number;
  date: string;
  memo: string;
  entry_source: string;
  account_id: number;
  account: string;
  type: string;
  schedule_c: string | null;
  debit_cents: number;
  credit_cents: number;
};

function rows(db: Books, year: number | undefined): Row[] {
  const [from, to] = year === undefined ? ["0000-01-01", "9999-12-31"] : [`${year}-01-01`, `${year}-12-31`];
  return db
    .query(
      `SELECT e.id AS entry_id, e.date, e.memo, e.source AS entry_source, a.id AS account_id, a.name AS account, a.type, a.schedule_c,
              l.debit_cents, l.credit_cents
       FROM lines l JOIN entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
       WHERE e.date BETWEEN ? AND ? ORDER BY e.date, e.id, l.id`,
    )
    .all(from, to) as Row[];
}

/** 1234.56 from 123456 cents, exactly, with no thousands separator. */
const decimal = (cents: number) => `${cents < 0 ? "-" : ""}${Math.trunc(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;

/**
 * One CSV cell. Text that a spreadsheet would read as a formula gets a leading apostrophe, because memos and bank
 * descriptions come from outside; anything with a comma, quote or line break is quoted.
 */
function cell(v: string | number, text = false): string {
  let s = String(v);
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const CSV_HEADER = ["date", "entry_id", "memo", "account_id", "account", "account_type", "schedule_c_line", "debit", "credit", "source"];

function csv(rs: Row[]): string {
  const body = rs.map((r) =>
    [
      cell(r.date), cell(r.entry_id), cell(r.memo, true), cell(r.account_id), cell(r.account, true), cell(r.type),
      cell(lineOf({ name: r.account, type: r.type, schedule_c: r.schedule_c }) ?? ""),
      cell(r.debit_cents ? decimal(r.debit_cents) : ""), cell(r.credit_cents ? decimal(r.credit_cents) : ""), cell(r.entry_source, true),
    ].join(","),
  );
  return [CSV_HEADER.join(","), ...body].join("\r\n") + "\r\n";
}

const TOP = { asset: "assets", liability: "liabilities", equity: "equity", income: "income", expense: "expenses" } as Record<string, string>;
const TYPE_TAG = { asset: "A", liability: "L", equity: "E", income: "R", expense: "X" } as Record<string, string>;

/** Text on one line with single spaces, since a line break or a double space would change what hledger reads. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** An hledger account name: its type's top-level account, then the name with nothing hledger would split on. */
function accountNames(db: Books): Map<number, string> {
  const accounts = db.query("SELECT id, name, type FROM accounts ORDER BY id").all() as { id: number; name: string; type: string }[];
  const base = (a: (typeof accounts)[number]) => `${TOP[a.type]}:${oneLine(a.name.replace(/[:;]/g, "-")) || "unnamed"}`;
  const counts = new Map<string, number>();
  for (const a of accounts) counts.set(base(a), (counts.get(base(a)) ?? 0) + 1);
  // Two names that clean up the same keep their ids, so no two accounts merge.
  return new Map(accounts.map((a) => [a.id, counts.get(base(a))! > 1 ? `${base(a)} (${a.id})` : base(a)]));
}

function hledger(db: Books, rs: Row[], year: number | undefined): string {
  const names = accountNames(db);
  const types = new Map((db.query("SELECT id, type FROM accounts").all() as { id: number; type: string }[]).map((a) => [a.id, a.type]));
  const out = [
    `; solobooks ledger${year === undefined ? "" : ` for ${year}`}: every posted entry, amounts in US dollars.`,
    "commodity $1000.00",
    "",
    ...[...names].map(([id, name]) => `account ${name}  ; type: ${TYPE_TAG[types.get(id)!]}`),
    "",
  ];
  let current = -1;
  for (const r of rs) {
    if (r.entry_id !== current) {
      if (current !== -1) out.push("");
      out.push(`${r.date} ${oneLine(r.memo).replace(/[;|]/g, "-")}  ; solobooks_entry:${r.entry_id}`);
      current = r.entry_id;
    }
    const amount = r.debit_cents - r.credit_cents;
    out.push(`    ${names.get(r.account_id)}  $${decimal(amount)}`);
  }
  return out.join("\n") + "\n";
}

const exportOp: Op = {
  name: "export",
  kind: "read",
  text: "text",
  description:
    "Export the books for an accountant or another tool. csv: one file with every posted journal line of the year (date, entry, memo, account, type, Schedule C line, debit, credit, source), the transactions file accountants ask for. hledger: the ledger as an hledger journal that passes hledger check. The CLI prints the file itself, ready to redirect into a file; over MCP it is in text.",
  fields: {
    format: { type: "enum", required: true, values: ["csv", "hledger"], description: "csv or hledger." },
    year: { type: "int", min: 2000, max: 2100, description: "Only this calendar year's entries. Default: every entry." },
  },
  run(db, input) {
    const rs = rows(db, input.year);
    const text = input.format === "csv" ? csv(rs) : hledger(db, rs, input.year);
    return { format: input.format, year: input.year ?? null, lines: rs.length, entries: new Set(rs.map((r) => r.entry_id)).size, text };
  },
};

export const exportOps: Op[] = [exportOp];
