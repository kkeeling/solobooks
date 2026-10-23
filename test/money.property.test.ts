import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import fc from "fast-check";
import { cli, dbPath, memBooks, tempDir } from "./support/books.ts";
import { cents, must, seedAccounts, write } from "./support/gen.ts";

test("ISC-5 cents: any amount round-trips through storage to the exact cent", () => {
  fc.assert(
    fc.property(cents, (amount) => {
      const db = memBooks();
      seedAccounts(db);
      const posted = must(db, "entry_post", {
        date: "2026-10-01",
        memo: "round trip",
        lines: [{ account_id: 1, debit_cents: amount }, { account_id: 4, credit_cents: amount }],
      });
      const stored = db.query("SELECT typeof(debit_cents) t, debit_cents v FROM lines WHERE entry_id = ? AND debit_cents > 0").get(posted.entry.id) as any;
      expect(stored).toEqual({ t: "integer", v: amount });
      const listed = must(db, "entry_list", {}).entries[0].lines[0].debit_cents;
      expect(listed).toBe(amount);
      db.close();
    }),
    { numRuns: 1000 },
  );
});

test("ISC-5 cents: fractional cents are refused, never rounded into storage", () => {
  fc.assert(
    fc.property(fc.double({ min: 0.001, max: 1e9, noNaN: true }).filter((x) => !Number.isInteger(x)), (amount) => {
      const db = memBooks();
      seedAccounts(db);
      const r = write(db, "entry_post", {
        date: "2026-10-01",
        memo: "fraction",
        lines: [{ account_id: 1, debit_cents: amount }, { account_id: 4, credit_cents: amount }],
      });
      expect(r.ok).toBe(false);
      expect(db.query("SELECT COUNT(*) n FROM lines").get()).toEqual({ n: 0 });
      db.close();
    }),
    { numRuns: 1000 },
  );
});

test("ISC-5 cents: the largest accepted amount survives the CLI's JSON in and out", async () => {
  const dir = tempDir();
  for (const [name, type] of [["Checking", "asset"], ["Income", "income"]] as const) {
    await cli(dir, ["account", "add", "--name", name, "--type", type, "--source", "test"]);
  }
  const amount = 1_000_000_000_000;
  const r = await cli(dir, [
    "entry", "post", "--source", "test",
    "--json", JSON.stringify({ date: "2026-10-01", memo: "big", lines: [{ account_id: 1, debit_cents: amount }, { account_id: 2, credit_cents: amount }] }),
  ]);
  expect(r.out.entry.lines[0].debit_cents).toBe(amount);
  const db = new Database(dbPath(dir), { readonly: true });
  expect(db.query("SELECT debit_cents v FROM lines WHERE debit_cents > 0").get()).toEqual({ v: amount });
  db.close();
});
