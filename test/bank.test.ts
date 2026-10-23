import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promptFields } from "../src/core/gate.ts";
import { acmeBooks, cli, json, ok, S } from "./support/billing.ts";
import { dumpFile, dbPath, fileHash, tempDir } from "./support/books.ts";
import { approveOnPage, asPerson, setEveryLevel } from "./support/person.ts";

// Bank import through the CLI. acmeBooks() accounts: 1 Checking, 2 Printing; its expenses, both paid from checking,
// are $42.00 on 2026-10-05 and $9.99 on 2026-11-05.

/** Writes a statement file somewhere outside the books, as a bank download would be. */
function statement(text: string, name = "statement.csv"): string {
  const path = join(tempDir(), name);
  writeFileSync(path, text);
  return path;
}

const COLUMNS = { date_column: "Date", date_format: "MM/DD/YYYY", description_column: "Description", amount_column: "Amount" };
const importFile = (dir: string, path: string, body: Record<string, unknown> = {}) => ok(dir, json(["bank", "import"], { account_id: 1, file_path: path, ...COLUMNS, ...body }));
const lines = async (dir: string, status?: string) => (await ok(dir, ["bank", "list", ...(status ? ["--status", status] : [])])).lines;

const OCTOBER = `Date,Description,Amount
10/02/2026,COFFEE,-4.50
10/02/2026,COFFEE,-4.50
10/03/2026,"CLIENT, INC ACH",1500.00
10/05/2026,PRINT SHOP,-42.00
`;

test("ISC-46 dedupe: importing the same bank CSV twice adds zero lines, and identical lines in one file both import", async () => {
  const dir = await acmeBooks();
  const path = statement(OCTOBER, "october.csv");
  const first = await importFile(dir, path);
  // Two genuinely identical coffees on the same day are two lines.
  expect(first.import).toMatchObject({ file: "october.csv", rows: 4, new_lines: 4, already_in_books: 0 });
  expect(first.lines.map((l: any) => [l.row, l.date, l.description, l.amount_cents])).toEqual([
    [2, "2026-10-02", "COFFEE", -450],
    [3, "2026-10-02", "COFFEE", -450],
    [4, "2026-10-03", "CLIENT, INC ACH", 150000],
    [5, "2026-10-05", "PRINT SHOP", -4200],
  ]);

  const again = await importFile(dir, path);
  expect(again.import).toMatchObject({ rows: 4, new_lines: 0, already_in_books: 4 });
  expect(again.lines).toEqual([]);
  expect(await lines(dir)).toHaveLength(4);

  // An overlapping statement adds only what is new: the second coffee on 10/02 here is the third that day.
  const overlap = statement("Date,Description,Amount\n10/02/2026,COFFEE,-4.50\n10/02/2026,COFFEE,-4.50\n10/02/2026,COFFEE,-4.50\n10/05/2026,PRINT SHOP,-42.00\n10/09/2026,BOOKSTORE,-30.00\n", "overlap.csv");
  const third = await importFile(dir, overlap);
  expect(third.import).toMatchObject({ rows: 5, new_lines: 2, already_in_books: 3 });
  expect(third.lines.map((l: any) => [l.file, l.row, l.description])).toEqual([["overlap.csv", 4, "COFFEE"], ["overlap.csv", 6, "BOOKSTORE"]]);
  expect(await lines(dir)).toHaveLength(6);
  expect((await importFile(dir, overlap)).import.new_lines).toBe(0);

  // Each line says where it came from, and the file it came from is kept in the books folder.
  const all = await lines(dir);
  expect(all.every((l: any) => l.source === "agent:test" && typeof l.row === "number" && l.file && l.import_id)).toBe(true);
  expect(fileHash(join(dir, first.import.stored_file))).toBe(first.import.sha256);
  expect(first.import.stored_file).toBe(`statements/${first.import.sha256}.csv`);
  expect(readFileSync(join(dir, first.import.stored_file), "utf8")).toBe(OCTOBER);

  // The same file into another account is that account's lines, not a duplicate.
  await ok(dir, ["account", "add", "--name", "Savings", "--type", "asset", ...S]);
  expect((await importFile(dir, path, { account_id: 3 })).import.new_lines).toBe(4);
});

test("ISC-47 exact match: lines matching one recorded payment or expense match on import, and a line with two candidates never does", async () => {
  const dir = await acmeBooks();
  await ok(dir, json(["client", "add"], { name: "Beta LLC", address: "9 Elm Rd" }));
  const d = (await ok(dir, json(["invoice", "draft"], { client_id: 2, period_start: "2026-10-01", period_end: "2026-10-31", lines: [{ description: "Work", amount_cents: 100000 }] }))).invoice;
  await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S]);
  const payment = (await ok(dir, json(["payment", "add"], { invoice_id: d.id, date: "2026-10-25", amount_cents: 100000, fee_cents: 3000, deposit_account_id: 1 }))).payment;
  const expense = async (date: string, cents: number, vendor: string) =>
    (await ok(dir, json(["expense", "add"], { date, amount_cents: cents, vendor, account_id: 2, paid_from_account_id: 1 }))).expense;
  const [cafeA, cafeB] = [await expense("2026-10-12", 1500, "Cafe"), await expense("2026-10-12", 1500, "Cafe")]; // two look-alikes
  const ink = await expense("2026-10-14", 2500, "Ink");
  const [print, courier] = (await ok(dir, ["expense", "list"])).expenses.filter((e: any) => ["Print shop", "Courier"].includes(e.vendor));

  const path = statement(`Date,Description,Amount
10/05/2026,PRINT SHOP,-42.00
10/25/2026,STRIPE PAYOUT,970.00
10/12/2026,CAFE,-15.00
10/14/2026,INK SUPPLIES,-25.00
10/14/2026,INK SUPPLIES REFILL,-25.00
11/05/2026,COURIER,-9.99
10/30/2026,PARKING,-12.34
`);
  const r = await importFile(dir, path);
  const byRow = (n: number) => r.lines.find((l: any) => l.row === n);
  // Matched on import: the expense paid from checking, the payment's $970 deposit, and the courier a month later.
  expect(r.matched).toEqual([
    { line_id: byRow(2).id, entry_id: print.entry_id },
    { line_id: byRow(3).id, entry_id: payment.entry.id },
    { line_id: byRow(7).id, entry_id: courier.entry_id },
  ]);
  for (const n of [2, 3, 7]) expect(byRow(n).match).toMatchObject({ kind: "exact", source: "agent:test" });
  // Not matched: one line with two candidates, two lines both after one entry, and a line with none.
  expect(byRow(4)).toMatchObject({ match: null, candidates: [cafeA.entry_id, cafeB.entry_id] });
  expect(byRow(5)).toMatchObject({ match: null, candidates: [ink.entry_id] });
  expect(byRow(6)).toMatchObject({ match: null, candidates: [ink.entry_id] });
  expect(byRow(8)).toMatchObject({ match: null, candidates: [] });
  expect(r.unmatched_on_account).toBe(4);

  // An entry recorded since matches the next time the statement comes in, with nothing imported twice.
  const parking = await expense("2026-10-30", 1234, "City parking");
  const again = await importFile(dir, path);
  expect(again.import.new_lines).toBe(0);
  expect(again.matched).toEqual([{ line_id: byRow(8).id, entry_id: parking.entry_id }]);
});

test("ISC-48 unmatched: every unmatched line, from every account and import, lands on one list", async () => {
  const dir = await acmeBooks();
  await ok(dir, ["account", "add", "--name", "Card", "--type", "liability", ...S]);
  await ok(dir, json(["expense", "add"], { date: "2026-10-07", amount_cents: 6000, vendor: "Hosting", account_id: 2, paid_from_account_id: 3 }));
  await importFile(dir, statement(OCTOBER, "checking-oct.csv")); // the print shop matches; three lines don't
  // A card statement with charges positive and payments negative, in its own columns.
  const card = statement("Transaction Date,Merchant,Charge\n2026-10-07,HOSTING CO,60.00\n2026-10-08,TRAIN,12.50\n2026-10-20,PAYMENT THANK YOU,-500.00\n", "card-oct.csv");
  const c = await ok(dir, json(["bank", "import"], { account_id: 3, file_path: card, date_column: "Transaction Date", date_format: "YYYY-MM-DD", description_column: "Merchant", amount_column: "Charge", sign: "out_positive" }));
  expect(c.lines.map((l: any) => [l.description, l.amount_cents])).toEqual([["HOSTING CO", -6000], ["TRAIN", -1250], ["PAYMENT THANK YOU", 50000]]);
  expect(c.matched).toHaveLength(1);

  const list = await lines(dir, "unmatched");
  expect(list.map((l: any) => [l.file, l.row, l.account_id, l.description])).toEqual([
    ["checking-oct.csv", 2, 1, "COFFEE"],
    ["checking-oct.csv", 3, 1, "COFFEE"],
    ["checking-oct.csv", 4, 1, "CLIENT, INC ACH"],
    ["card-oct.csv", 3, 3, "TRAIN"],
    ["card-oct.csv", 4, 3, "PAYMENT THANK YOU"],
  ]);
  // Nothing is on neither list, and nothing on both.
  const matched = await lines(dir, "matched");
  expect(matched.map((l: any) => l.description).sort()).toEqual(["HOSTING CO", "PRINT SHOP"]);
  expect(list.length + matched.length).toBe((await lines(dir)).length);

  // The card payment is a transfer from checking; once recorded, the agent proposes the match and it leaves the list.
  const t = (await ok(dir, json(["transfer", "add"], { date: "2026-10-19", legs: [{ account_id: 1, amount_cents: -50000 }, { account_id: 3, amount_cents: 50000 }] }))).transfer;
  const payment = list.find((l: any) => l.description === "PAYMENT THANK YOU");
  expect((await lines(dir, "unmatched")).find((l: any) => l.id === payment.id).candidates).toEqual([t.entry.id]);
  const m = await ok(dir, json(["bank", "match"], { line_id: payment.id, entry_id: t.entry.id }));
  expect(m.line.match).toMatchObject({ entry_id: t.entry.id, kind: "agent", source: "agent:test" });
  expect((await lines(dir, "unmatched")).map((l: any) => l.id)).not.toContain(payment.id);
  expect(await lines(dir, "unmatched")).toHaveLength(4);

  // A proposal must be the same money through the same account, and each side is matched once.
  const train = list.find((l: any) => l.description === "TRAIN");
  const coffee = list.find((l: any) => l.description === "COFFEE");
  for (const [body, field] of [
    [{ line_id: train.id, entry_id: t.entry.id }, "entry_id"], // already matched on the card
    [{ line_id: coffee.id, entry_id: t.entry.id }, "entry_id"], // -50000 through checking, not -450
    [{ line_id: payment.id, entry_id: t.entry.id }, "line_id"], // already matched
    [{ line_id: 999, entry_id: t.entry.id }, "line_id"],
    [{ line_id: train.id, entry_id: 999 }, "entry_id"],
  ] as const) {
    expect(await cli(dir, json(["bank", "match"], body))).toMatchObject({ code: 2, out: { field } });
  }
});

test("bank import: reads each bank's own layout, and refuses a row it can't read by its number", async () => {
  const dir = await acmeBooks();
  // A preamble before the header, separate debit and credit columns, $ signs and thousands separators.
  const split = statement('Account,1234\nStatement period,October\n\nPosted,Memo,Debit,Credit\n10/1/26,FEE,$5.00,\n10/2/26,"DEPOSIT ""A""",,"$1,250.75"\n10/3/26,REVERSAL,(2.00),\n');
  const a = await ok(dir, json(["bank", "import"], { account_id: 1, file_path: split, date_column: "Posted", date_format: "MM/DD/YY", description_column: "Memo", debit_column: "Debit", credit_column: "Credit", header_row: 4 }));
  expect(a.lines.map((l: any) => [l.row, l.date, l.description, l.amount_cents])).toEqual([
    [5, "2026-10-01", "FEE", -500],
    [6, "2026-10-02", 'DEPOSIT "A"', 125075],
    [7, "2026-10-03", "REVERSAL", -200],
  ]);
  // No header row at all: columns by number.
  const bare = statement('"10/04/2026","-7.25","*","","CORNER STORE"\n');
  const b = await ok(dir, json(["bank", "import"], { account_id: 1, file_path: bare, date_column: "1", date_format: "MM/DD/YYYY", description_column: "5", amount_column: "2", header_row: 0 }));
  expect(b.lines.map((l: any) => [l.row, l.description, l.amount_cents])).toEqual([[1, "CORNER STORE", -725]]);

  const before = await lines(dir);
  for (const [text, body, field, reason] of [
    ["Date,Description,Amount\n10/32/2026,X,1.00\n", {}, "date_column", 'Row 2 has "10/32/2026" in the date column, which isn\'t a MM/DD/YYYY date.'],
    ["Date,Description,Amount\n10/01/2026,X,1.00\n10/02/2026,Y,12.3.4\n", {}, "amount_column", 'Row 3 has "12.3.4" in the amount column, which isn\'t an amount in dollars.'],
    ["Date,Description,Amount\n10/01/2026,X,0.00\n", {}, "amount_column", "Row 2 has an amount of zero, so take it out of the file and import that copy."],
    ["Date,Memo,Amount\n10/01/2026,X,1.00\n", {}, "description_column", "The header row has no column named Description; its columns are Date, Memo, Amount."],
    ["Date,Description,Amount\n10/01/2026,X,1.00\n", { debit_column: "Amount" }, "amount_column", "Name the amounts as amount_column, or as debit_column and credit_column, but not both."],
    ['Date,Description,Amount\n10/01/2026,"X,1.00\n', {}, "file_path", "The file ends inside a quoted cell, so it isn't a complete CSV file."],
  ] as const) {
    expect(await cli(dir, json(["bank", "import"], { account_id: 1, file_path: statement(text), ...COLUMNS, ...body }))).toEqual({ code: 2, out: { reason, field } });
  }
  // Nothing from a refused file got in, and only the person's own accounts take statements.
  expect(await lines(dir)).toEqual(before);
  expect(await cli(dir, json(["bank", "import"], { account_id: 2, file_path: statement(OCTOBER), ...COLUMNS }))).toMatchObject({ code: 2, out: { field: "account_id" } });
  expect(await cli(dir, json(["bank", "import"], { account_id: 1, file_path: join(tempDir(), "missing.csv"), ...COLUMNS }))).toMatchObject({ code: 2, out: { field: "file_path" } });
  expect(existsSync(join(dir, "statements"))).toBe(true);
});

test("ISC-112 unmatch: a wrong match is undone with both rows kept, and undoing a payment's match waits like an unbacked payment", async () => {
  const dir = await acmeBooks();
  await ok(dir, json(["client", "add"], { name: "Beta LLC", address: "9 Elm Rd" }));
  const d = (await ok(dir, json(["invoice", "draft"], { client_id: 2, period_start: "2026-10-01", period_end: "2026-10-31", lines: [{ description: "Work", amount_cents: 100000 }] }))).invoice;
  const inv = (await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S])).invoice;
  const ink = (await ok(dir, json(["expense", "add"], { date: "2026-10-14", amount_cents: 2500, vendor: "Ink", account_id: 2, paid_from_account_id: 1 }))).expense;
  const path = statement(`Date,Description,Amount
10/07/2026,OFFICE DEPOT,-42.00
10/14/2026,INK REFILL,-25.00
10/25/2026,STRIPE PAYOUT,970.00
`);
  const imported = await importFile(dir, path);
  const [depot, refill, payout] = imported.lines.map((l: any) => l.id);
  // The ink line matched by itself; the agent matched the Office Depot charge to the print shop expense, wrongly.
  expect(imported.matched).toEqual([{ line_id: refill, entry_id: ink.entry_id }]);
  const [print] = (await ok(dir, ["expense", "list"])).expenses.filter((e: any) => e.vendor === "Print shop");
  await ok(dir, json(["bank", "match"], { line_id: depot, entry_id: print.entry_id }));
  const payment = (await ok(dir, json(["payment", "add"], { invoice_id: inv.id, date: "2026-10-25", amount_cents: 100000, fee_cents: 3000, deposit_account_id: 1, bank_line_id: payout }))).payment;
  expect(payment.bank_line_id).toBe(payout);
  expect(await lines(dir, "unmatched")).toEqual([]);

  // From here the person asks before anything gated; undoing a match that backs no payment still runs at once.
  asPerson(dir, (db) => setEveryLevel(db, "click"));
  const undo = (await ok(dir, json(["bank", "unmatch"], { line_id: depot, reason: "That was toner, not the print shop" }))).line;
  expect(undo).toMatchObject({ id: depot, match: null, candidates: [print.entry_id] });
  expect(undo.undone_matches).toEqual([
    expect.objectContaining({ entry_id: print.entry_id, kind: "agent", reason: "That was toner, not the print shop", unmatched_by: "agent:test" }),
  ]);
  expect((await lines(dir, "unmatched")).map((l: any) => l.id)).toEqual([depot]);
  // Append-only: the match row is still there, with an unmatch beside it, and neither can be edited or deleted.
  const rows = dumpFile(dbPath(dir));
  expect(rows.bank_matches).toHaveLength(3);
  expect(rows.bank_unmatches).toEqual([expect.objectContaining({ reason: "That was toner, not the print shop", source: "agent:test" })]);
  asPerson(dir, (db) => {
    expect(() => db.exec("DELETE FROM bank_matches")).toThrow(/kept/);
    expect(() => db.exec("DELETE FROM bank_unmatches")).toThrow(/kept/);
    expect(() => db.exec("UPDATE bank_unmatches SET reason = 'x'")).toThrow(/kept/);
  });
  // Only a standing match can be undone.
  expect(await cli(dir, json(["bank", "unmatch"], { line_id: depot, reason: "Again" }))).toMatchObject({ code: 2, out: { field: "line_id" } });
  expect(await cli(dir, json(["bank", "unmatch"], { line_id: 999, reason: "x" }))).toMatchObject({ code: 2, out: { field: "line_id" } });

  // A pairing undone as wrong is never made again by itself: the ink line, unmatched, stays so on the next import.
  await ok(dir, json(["bank", "unmatch"], { line_id: refill, reason: "Personal purchase" }));
  expect((await importFile(dir, path)).matched).toEqual([]);
  expect((await lines(dir, "unmatched")).map((l: any) => l.id)).toEqual([depot, refill]);

  // Undoing the match behind a payment leaves it with no bank line, so it waits for the person and changes nothing.
  const before = dumpFile(dbPath(dir));
  const asked = (await ok(dir, json(["bank", "unmatch"], { line_id: payout, reason: "Wrong deposit" })));
  expect(asked).toMatchObject({
    status: "pending",
    level: "click",
    title: `Undo the bank match behind the $1,000.00 payment on invoice ${inv.number}, leaving it with no bank line behind it?`,
  });
  const { pending_actions: _p, history: _h, ...unchanged } = dumpFile(dbPath(dir));
  const { pending_actions: _p0, history: _h0, ...was } = before;
  expect(unchanged).toEqual(was);
  expect((await lines(dir, "matched")).map((l: any) => l.id)).toEqual([payout]);
  const shown = (await ok(dir, ["pending", "get", "--id", String(asked.pending_id)])).pending;
  expect(shown).toMatchObject({ action: "payment_unmatched", op: "bank_unmatch" });
  expect(promptFields(shown)[0]).toEqual([
    ["Bank line", "2026-10-25 STRIPE PAYOUT: $970.00 on Checking"],
    ["Payment it backs", "$1,000.00 paid on 2026-10-25, deposit $970.00"],
    ["Invoice", inv.number],
    ["Client", "Beta LLC"],
    ["After", "the line goes back on the unmatched list, and this payment has no bank line behind it"],
    ["Reason", "Wrong deposit"],
  ]);

  // Approved, it runs: the line is back on the list and the payment shows no bank line behind it.
  const approved = asPerson(dir, (db) => approveOnPage(db, asked.pending_id));
  expect(approved.result.line).toMatchObject({ id: payout, match: null });
  expect((await lines(dir, "unmatched")).map((l: any) => l.id)).toEqual([depot, refill, payout]);
  expect((await ok(dir, ["payment", "list"])).payments[0]).toMatchObject({ id: payment.id, bank_line_id: null });

  // Re-backed with bank match it is matched again, and with payment_unmatched left to the agent the undo runs at once.
  await ok(dir, json(["bank", "match"], { line_id: payout, entry_id: payment.entry.id }));
  expect((await ok(dir, ["payment", "list"])).payments[0].bank_line_id).toBe(payout);
  asPerson(dir, (db) => setEveryLevel(db, "agent_decides"));
  const direct = await ok(dir, json(["bank", "unmatch"], { line_id: payout, reason: "Still wrong" }));
  expect(direct.status).toBeUndefined();
  expect(direct.line.undone_matches.map((m: any) => m.reason)).toEqual(["Wrong deposit", "Still wrong"]);
});
