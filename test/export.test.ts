import { expect, test } from "bun:test";
import { join } from "node:path";
import { acmeBooks, issueOctober, json, ok, S } from "./support/billing.ts";
import { tempDir } from "./support/books.ts";
import { asPerson } from "./support/person.ts";

// ISC-59 and ISC-61's bash probes live in scripts/export-check.sh; these check what the files hold.

/** Splits one CSV line, honoring quotes. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted && ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
    else if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) out.push(cur), (cur = "");
    else cur += ch;
  }
  return [...out, cur];
}

async function books() {
  const dir = await acmeBooks();
  const inv = await issueOctober(dir);
  await ok(dir, json(["payment", "add"], { invoice_id: inv.id, date: "2026-10-25", amount_cents: inv.total_cents, fee_cents: 1234, deposit_account_id: 1 }));
  // Text from outside: a memo with a comma, a quote, a line break and a spreadsheet formula.
  await ok(dir, json(["expense", "add"], { date: "2026-12-31", amount_cents: 101, vendor: '=HYPERLINK("x")', memo: 'Line one,\nline "two"', account_id: 2, paid_from_account_id: 1 }));
  await ok(dir, json(["expense", "add"], { date: "2027-01-02", amount_cents: 500, vendor: "Next year", account_id: 2, paid_from_account_id: 1 }));
  return dir;
}

test("ISC-59 csv: one file holds every posted line of the year, each with its account, Schedule C line and amount", async () => {
  const dir = await books();
  const text = (await ok(dir, ["export", "--year", "2026", "--format", "csv"])) as string;
  expect(typeof text).toBe("string");
  const rows = text.trimEnd().split("\r\n");
  expect(rows[0]).toBe("date,entry_id,memo,account_id,account,account_type,schedule_c_line,debit,credit,source");
  // A quoted line break stays inside its cell, so count records by parsing rather than by newline.
  const records = text.trimEnd().replace(/"(?:[^"]|"")*"/g, (q) => q.replaceAll("\r\n", " ").replaceAll("\n", " ")).split("\r\n").slice(1).map(cells);
  const posted = asPerson(dir, (db) =>
    db.query("SELECT COUNT(*) AS n FROM lines l JOIN entries e ON e.id = l.entry_id WHERE e.date BETWEEN '2026-01-01' AND '2026-12-31'").get(),
  ) as { n: number };
  expect(records.length).toBe(posted.n);
  expect(records.every((r) => r[0]!.startsWith("2026-"))).toBe(true);
  // Debits equal credits in the file, exactly as in the books.
  const cents = (s: string) => (s ? Math.round(Number(s) * 100) : 0);
  expect(records.reduce((s, r) => s + cents(r[7]!), 0)).toBe(records.reduce((s, r) => s + cents(r[8]!), 0));
  expect(records.find((r) => r[4] === "Consulting income")![6]).toBe("1");
  expect(records.find((r) => r[4] === "Payment processing fees")).toMatchObject({ 6: "10", 7: "12.34" });
  // Outside text is quoted whole, line break and all, and text that starts like a formula can't run as one.
  expect(text).toContain(`"Printing: =HYPERLINK(""x""): Line one,\nline ""two"""`);
  const viaMcpShape = await asPerson(dir, async (db) => (await import("../src/core/perform.ts")).perform(db, "export", { format: "csv", year: 2026 }, { now: "2026-10-22T12:00:00.000Z" }));
  expect(viaMcpShape).toMatchObject({ ok: true, result: { format: "csv", year: 2026, lines: posted.n, text } });
  const interest = (await ok(dir, ["account", "add", "--name", "Interest", "--type", "income", ...S])).account.id;
  await ok(dir, json(["entry", "post"], { date: "2026-12-31", memo: "=1+1", lines: [{ account_id: 1, debit_cents: 1 }, { account_id: interest, credit_cents: 1 }] }));
  expect((await ok(dir, ["export", "--year", "2026", "--format", "csv"])) as string).toContain(",'=1+1,");

  // An empty year is still one file: just the header.
  expect(await ok(tempDir(), ["export", "--year", "2026", "--format", "csv"])).toBe(`${rows[0]}\r\n`);
});

test("ISC-61 hledger: the journal holds every entry with explicit balanced amounts, and hledger check passes", async () => {
  const dir = await books();
  const text = (await ok(dir, ["export", "--format", "hledger"])) as string;
  expect(text).toContain("commodity $1000.00");
  expect(text).toContain("account income:Consulting income  ; type: R");
  // A memo can't add a line: its line break and spacing are flattened into the description.
  expect(text).toMatch(/^2026-12-31 Printing: =HYPERLINK\("x"\): Line one, line "two"  ; solobooks_entry:\d+$/m);
  const entries = asPerson(dir, (db) => (db.query("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n);
  expect(text.match(/^\d{4}-\d\d-\d\d /gm)!.length).toBe(entries);

  const hledger = Bun.which("hledger");
  if (!hledger) return; // the bash probe needs it; this test checks what it can without
  const file = join(tempDir(), "books.journal");
  await Bun.write(file, text);
  for (const args of [["check"], ["check", "--strict"]]) {
    const p = Bun.spawnSync([hledger, "-f", file, ...args]);
    expect({ args, code: p.exitCode, err: p.stderr.toString() }).toEqual({ args, code: 0, err: "" });
  }
  // A year's journal checks too.
  const y = join(tempDir(), "2026.journal");
  await Bun.write(y, (await ok(dir, ["export", "--format", "hledger", "--year", "2026"])) as string);
  expect(Bun.spawnSync([hledger, "-f", y, "check", "--strict"]).exitCode).toBe(0);
});
