import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Books } from "./db.ts";
import { sha256 } from "./files.ts";
import { getAccount, requireOwnAccount } from "./ledger.ts";
import type { Ctx, Op } from "./op.ts";
import { Refusal } from "./refusal.ts";
import { MAX_CENTS } from "./validate.ts";

// Bank import. The agent reads the bank's file and declares which column is which; solobooks parses the CSV itself,
// so every amount comes from the file's own bytes, never from a retyped copy. solobooks owns what follows: dedupe,
// exact matches to posted entries, and the one list of lines still unmatched. The agent proposes the rest with
// bank match, a write the person can see.

const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const DATE_FORMATS = ["YYYY-MM-DD", "MM/DD/YYYY", "MM/DD/YY"] as const;

/** RFC 4180 CSV: commas, double-quoted cells with "" for a quote, CRLF or LF line ends, an optional byte-order mark. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (quoted) throw new Refusal("The file ends inside a quoted cell, so it isn't a complete CSV file.", "file_path");
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Whole cents from a bank's amount: 1,234.56, -45.00, (45.00), $45 and +45.5 all read exactly; null if it isn't one. */
export function parseCents(raw: string): number | null {
  let s = raw.trim().replace(/\s/g, "");
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-") || s.startsWith("+")) {
    negative = negative !== s.startsWith("-");
    s = s.slice(1);
  }
  if (s.startsWith("$")) s = s.slice(1);
  if (s.startsWith("-") && !negative) {
    negative = true; // $-45.00
    s = s.slice(1);
  }
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d{1,2}))?$/.exec(s);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  const cents = Number((m[1] ?? "0").replace(/,/g, "")) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) return null;
  return negative ? -cents : cents;
}

/** YYYY-MM-DD from a bank's date in the declared format, or null when it isn't a real date in that format. */
export function parseDate(raw: string, format: (typeof DATE_FORMATS)[number]): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  const us = format === "YYYY-MM-DD" ? null : /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/.exec(s);
  if (format === "YYYY-MM-DD") {
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!iso) return null;
    [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else {
    if (!us || us[3]!.length !== (format === "MM/DD/YYYY" ? 4 : 2)) return null;
    [m, d, y] = [Number(us[1]), Number(us[2]), Number(us[3])];
    if (format === "MM/DD/YY") y += 2000;
  }
  const out = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const t = new Date(`${out}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === out ? out : null;
}

type Line = { file_row: number; date: string; description: string; amount_cents: number };

/** Which cell holds a field: a header name, or a column number counting from 1 when the file has no header row. */
function columnIndex(header: string[] | null, given: string, field: string): number {
  if (header === null) {
    const n = /^\d+$/.test(given) ? Number(given) : 0;
    if (n < 1) throw new Refusal(`With header_row 0 the file has no header, so ${field} must be a column number counting from 1.`, field);
    return n - 1;
  }
  const want = given.trim().toLowerCase();
  const hits = header.flatMap((h, i) => (h.trim().toLowerCase() === want ? [i] : []));
  if (hits.length === 0) throw new Refusal(`The header row has no column named ${given}; its columns are ${header.map((h) => h.trim()).join(", ")}.`, field);
  if (hits.length > 1) throw new Refusal(`The header row has more than one column named ${given}, so name a column it has once.`, field);
  return hits[0]!;
}

/** The statement's lines, read with the declared column map. Any row it can't read is refused by number. */
export function readStatement(text: string, map: Record<string, any>): { lines: Line[]; dataRows: number } {
  const rows = parseCsv(text);
  const headerRow: number = map.header_row ?? 1;
  if (headerRow > rows.length) throw new Refusal(`The file has only ${rows.length} rows, so header_row ${headerRow} isn't in it.`, "header_row");
  const header = headerRow === 0 ? null : rows[headerRow - 1]!;
  const signed = map.amount_column !== undefined;
  if (signed === (map.debit_column !== undefined || map.credit_column !== undefined)) {
    throw new Refusal("Name the amounts as amount_column, or as debit_column and credit_column, but not both.", "amount_column");
  }
  if (!signed && (map.debit_column === undefined || map.credit_column === undefined)) {
    throw new Refusal("Money out and money in need both debit_column and credit_column.", map.debit_column === undefined ? "debit_column" : "credit_column");
  }
  if (!signed && map.sign !== undefined) throw new Refusal("sign applies only to amount_column; debit_column is always money out.", "sign");
  const col = {
    date: columnIndex(header, map.date_column, "date_column"),
    description: columnIndex(header, map.description_column, "description_column"),
    amount: signed ? columnIndex(header, map.amount_column, "amount_column") : -1,
    debit: signed ? -1 : columnIndex(header, map.debit_column, "debit_column"),
    credit: signed ? -1 : columnIndex(header, map.credit_column, "credit_column"),
  };
  const flip = map.sign === "out_positive" ? -1 : 1;
  const lines: Line[] = [];
  let dataRows = 0;
  for (let r = headerRow; r < rows.length; r++) {
    const cells = rows[r]!;
    const n = r + 1;
    if (cells.every((c) => c.trim() === "")) continue; // a blank row
    dataRows++;
    const cell = (i: number) => cells[i] ?? "";
    const date = parseDate(cell(col.date), map.date_format);
    if (date === null) throw new Refusal(`Row ${n} has ${JSON.stringify(cell(col.date))} in the date column, which isn't a ${map.date_format} date.`, "date_column");
    let amount: number;
    if (signed) {
      const v = parseCents(cell(col.amount));
      if (v === null) throw new Refusal(`Row ${n} has ${JSON.stringify(cell(col.amount))} in the amount column, which isn't an amount in dollars.`, "amount_column");
      amount = v * flip;
    } else {
      const read = (i: number, field: string) => {
        if (cell(i).trim() === "") return 0;
        const v = parseCents(cell(i));
        if (v === null) throw new Refusal(`Row ${n} has ${JSON.stringify(cell(i))} in ${field}, which isn't an amount in dollars.`, field);
        return Math.abs(v);
      };
      const out = read(col.debit, "debit_column");
      const into = read(col.credit, "credit_column");
      if ((out > 0) === (into > 0)) {
        throw new Refusal(`Row ${n} needs an amount in exactly one of the debit and credit columns.`, out > 0 ? "credit_column" : "debit_column");
      }
      amount = into - out;
    }
    if (amount === 0) throw new Refusal(`Row ${n} has an amount of zero, so take it out of the file and import that copy.`, signed ? "amount_column" : "debit_column");
    lines.push({ file_row: n, date, description: cell(col.description).replace(/\s+/g, " ").trim(), amount_cents: amount });
  }
  return { lines, dataRows };
}

// ---------------------------------------------------------------- matching

/** Posted entries that move exactly this amount through this account on this day, and aren't matched there yet. */
function candidates(db: Books, accountId: number, date: string | null, amount: number): number[] {
  return (
    db
      .query(
        `SELECT l.entry_id AS id FROM lines l JOIN entries e ON e.id = l.entry_id
         WHERE l.account_id = ?1 AND (?2 IS NULL OR e.date = ?2)
           AND NOT EXISTS (SELECT 1 FROM bank_matches m WHERE m.entry_id = l.entry_id AND m.account_id = l.account_id)
         GROUP BY l.entry_id HAVING SUM(l.debit_cents) - SUM(l.credit_cents) = ?3 ORDER BY l.entry_id`,
      )
      .all(accountId, date, amount) as { id: number }[]
  ).map((r) => r.id);
}

type LineRow = { id: number; account_id: number; date: string; amount_cents: number };

function unmatchedLines(db: Books, accountId: number): LineRow[] {
  return db
    .query(
      `SELECT b.id, b.account_id, b.date, b.amount_cents FROM bank_lines b
       WHERE b.account_id = ? AND NOT EXISTS (SELECT 1 FROM bank_matches m WHERE m.line_id = b.id) ORDER BY b.date, b.id`,
    )
    .all(accountId) as LineRow[];
}

function insertMatch(db: Books, lineId: number, entryId: number, accountId: number, kind: string, ctx: Ctx): void {
  db.query("INSERT INTO bank_matches (line_id, entry_id, account_id, kind, matched_at, source) VALUES (?, ?, ?, ?, ?, ?)").run(
    lineId, entryId, accountId, kind, ctx.now, ctx.source,
  );
}

/**
 * Exact matching for one account: a line and an entry match when each is the other's only candidate, with the same
 * account, day and amount. A line with two candidates, or an entry two lines could claim, is left for the agent.
 */
function matchExact(db: Books, accountId: number, ctx: Ctx): { line_id: number; entry_id: number }[] {
  const lines = unmatchedLines(db, accountId);
  const options = new Map(lines.map((l) => [l.id, candidates(db, accountId, l.date, l.amount_cents)]));
  const claims = new Map<number, number>();
  for (const ids of options.values()) for (const e of ids) claims.set(e, (claims.get(e) ?? 0) + 1);
  const made: { line_id: number; entry_id: number }[] = [];
  for (const l of lines) {
    const ids = options.get(l.id)!;
    if (ids.length === 1 && claims.get(ids[0]!) === 1) {
      insertMatch(db, l.id, ids[0]!, accountId, "exact", ctx);
      made.push({ line_id: l.id, entry_id: ids[0]! });
    }
  }
  return made;
}

export function bankLineView(db: Books, id: number) {
  const b = db
    .query(
      `SELECT b.*, i.file_name, i.stored_file, m.entry_id, m.kind AS match_kind, m.source AS match_source, m.matched_at
       FROM bank_lines b JOIN bank_imports i ON i.id = b.import_id LEFT JOIN bank_matches m ON m.line_id = b.id WHERE b.id = ?`,
    )
    .get(id) as Record<string, any>;
  return {
    id: b.id,
    account_id: b.account_id,
    date: b.date,
    description: b.description,
    amount_cents: b.amount_cents,
    // Where it came from: the file as the agent named it, its kept copy, and the row in it.
    import_id: b.import_id,
    file: b.file_name,
    stored_file: b.stored_file,
    row: b.file_row,
    match: b.entry_id === null ? null : { entry_id: b.entry_id, kind: b.match_kind, source: b.match_source, matched_at: b.matched_at },
    // For a line still unmatched: entries with its amount on this account, any day, that aren't matched there yet.
    candidates: b.entry_id === null ? candidates(db, b.account_id, null, b.amount_cents) : [],
    source: b.source,
  };
}

export function requireUnmatchedLine(db: Books, id: number, field: string): LineRow {
  const l = db.query("SELECT id, account_id, date, amount_cents FROM bank_lines WHERE id = ?").get(id) as LineRow | null;
  if (!l) throw new Refusal(`There is no bank line with id ${id}.`, field);
  const m = db.query("SELECT entry_id FROM bank_matches WHERE line_id = ?").get(id) as { entry_id: number } | null;
  if (m) throw new Refusal(`Bank line ${id} is already matched to entry ${m.entry_id}.`, field);
  return l;
}

/** Ties a bank line to the entry it is: they must move the same amount through the same account. */
export function linkLine(db: Books, line: LineRow, entryId: number, kind: "agent" | "payment", ctx: Ctx, field: string): void {
  const net = db
    .query("SELECT COUNT(*) AS n, COALESCE(SUM(debit_cents) - SUM(credit_cents), 0) AS cents FROM lines WHERE entry_id = ? AND account_id = ?")
    .get(entryId, line.account_id) as { n: number; cents: number };
  if (net.n === 0) throw new Refusal(`Entry ${entryId} doesn't touch account ${line.account_id}, the account bank line ${line.id} is on.`, field);
  if (net.cents !== line.amount_cents) {
    throw new Refusal(`Entry ${entryId} moves ${net.cents} cents through account ${line.account_id}, but bank line ${line.id} is ${line.amount_cents} cents.`, field);
  }
  const taken = db.query("SELECT line_id FROM bank_matches WHERE entry_id = ? AND account_id = ?").get(entryId, line.account_id) as { line_id: number } | null;
  if (taken) throw new Refusal(`Entry ${entryId} is already matched to bank line ${taken.line_id} on this account.`, field);
  insertMatch(db, line.id, entryId, line.account_id, kind, ctx);
}

// ---------------------------------------------------------------- operations

const bankImport: Op = {
  name: "bank_import",
  kind: "write",
  description:
    "Import a bank or card statement CSV for one of the person's accounts. You read the file and say which column is which; solobooks parses it, keeps a copy in the books folder, and records each line with its file and row. Lines already in the books are skipped, so importing the same or an overlapping statement again adds nothing twice. Each new line is then matched to the one posted entry with the same account, day and amount, if there is exactly one; the rest wait on bank list --status unmatched.",
  fields: {
    account_id: { type: "int", required: true, min: 1, description: "The bank, card or processor account the statement is for." },
    file_path: { type: "text", required: true, description: "Path to the CSV file on this machine." },
    date_column: { type: "text", required: true, description: "The column holding each line's date: its header, or its number from 1 when header_row is 0." },
    date_format: { type: "enum", required: true, values: DATE_FORMATS, description: "How the dates are written; MM and DD may be one digit." },
    description_column: { type: "text", required: true, description: "The column holding what each line is." },
    amount_column: { type: "text", description: "The column holding one signed amount per line; or give debit_column and credit_column." },
    sign: {
      type: "enum", values: ["in_positive", "out_positive"],
      description: "For amount_column: in_positive (the default) when money into the account is positive, out_positive when charges are positive, as on many card statements.",
    },
    debit_column: { type: "text", description: "The column holding money out of the account, when out and in are separate columns." },
    credit_column: { type: "text", description: "The column holding money into the account, when out and in are separate columns." },
    header_row: { type: "int", min: 0, max: 1000, description: "The row holding the column names, counting from 1. Default 1; 0 when the file has no header row." },
  },
  run(db, input, ctx) {
    requireOwnAccount(db, input.account_id, "account_id");
    const path = resolve(input.file_path);
    let bytes: Uint8Array;
    try {
      if (!statSync(path).isFile()) throw new Error("not a file");
      if (statSync(path).size > MAX_FILE_BYTES) throw new Refusal("The file is larger than 10 MB, so split it by month first.", "file_path");
      bytes = readFileSync(path);
    } catch (e) {
      if (e instanceof Refusal) throw e;
      throw new Refusal("There is no readable file at file_path.", "file_path");
    }
    const { lines, dataRows } = readStatement(new TextDecoder().decode(bytes), input);
    const sha = sha256(bytes);
    const stored = `statements/${sha}.csv`;
    ctx.files.push({ path: stored, bytes, field: "file_path" });

    // A line is new only past the number of identical lines (same account, day, amount, description) already in the
    // books, so the same file twice adds nothing, and two identical lines in one file are both kept.
    const already = db.query("SELECT COUNT(*) AS n FROM bank_lines WHERE account_id = ? AND date = ? AND amount_cents = ? AND description = ?");
    const seen = new Map<string, number>();
    const fresh = lines.filter((l) => {
      const key = JSON.stringify([l.date, l.amount_cents, l.description]);
      const k = (seen.get(key) ?? 0) + 1;
      seen.set(key, k);
      return k > (already.get(input.account_id, l.date, l.amount_cents, l.description) as { n: number }).n;
    });
    const { id: importId } = db
      .query(
        `INSERT INTO bank_imports (account_id, file_name, file_sha256, stored_file, row_count, new_lines, imported_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(input.account_id, basename(path), sha, stored, dataRows, fresh.length, ctx.now, ctx.source) as { id: number };
    const ins = db.query(
      "INSERT INTO bank_lines (import_id, account_id, file_row, date, description, amount_cents, source) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    );
    const ids = fresh.map((l) => (ins.get(importId, input.account_id, l.file_row, l.date, l.description, l.amount_cents, ctx.source) as { id: number }).id);
    const matched = matchExact(db, input.account_id, ctx);
    const unmatched = unmatchedLines(db, input.account_id).length;
    return {
      import: { id: importId, account_id: input.account_id, file: basename(path), sha256: sha, stored_file: stored, rows: dataRows, new_lines: fresh.length, already_in_books: dataRows - fresh.length },
      lines: ids.map((id) => bankLineView(db, id)),
      matched,
      unmatched_on_account: unmatched,
    };
  },
};

const bankMatch: Op = {
  name: "bank_match",
  kind: "write",
  description:
    "Match an unmatched bank line to the posted entry it is, when solobooks couldn't: the same amount through the same account, on a different day, or one of several look-alikes. Use bank list's candidates. The match is recorded as yours, with your source, for the person to see.",
  fields: {
    line_id: { type: "int", required: true, min: 1, description: "The unmatched bank line." },
    entry_id: { type: "int", required: true, min: 1, description: "The posted entry it is, such as an expense's or a transfer's entry." },
  },
  run(db, input, ctx) {
    const line = requireUnmatchedLine(db, input.line_id, "line_id");
    if (!db.query("SELECT 1 FROM entries WHERE id = ?").get(input.entry_id)) throw new Refusal(`There is no entry with id ${input.entry_id}.`, "entry_id");
    linkLine(db, line, input.entry_id, "agent", ctx, "entry_id");
    return { line: bankLineView(db, line.id) };
  },
};

const bankList: Op = {
  name: "bank_list",
  kind: "read",
  description:
    "List imported bank lines with the file and row each came from and what it matched. With status unmatched this is the one list of every line still needing a match, across every account and import, each with its candidate entries.",
  fields: {
    status: { type: "enum", values: ["matched", "unmatched"], description: "Only matched or only unmatched lines." },
    account_id: { type: "int", min: 1, description: "Only this account's lines." },
  },
  run(db, input) {
    if (input.account_id !== undefined && !getAccount(db, input.account_id)) throw new Refusal(`There is no account with id ${input.account_id}.`, "account_id");
    const rows = db
      .query(
        `SELECT b.id FROM bank_lines b LEFT JOIN bank_matches m ON m.line_id = b.id
         WHERE (?1 IS NULL OR b.account_id = ?1) AND (?2 IS NULL OR (?2 = 'matched') = (m.id IS NOT NULL)) ORDER BY b.date, b.id`,
      )
      .all(input.account_id ?? null, input.status ?? null) as { id: number }[];
    return { lines: rows.map((r) => bankLineView(db, r.id)) };
  },
};

export const bankOps: Op[] = [bankImport, bankMatch, bankList];
