import { expect, test } from "bun:test";
import fc from "fast-check";
import { memBooks } from "./support/books.ts";
import { must, seedAccounts, write, writeCmd } from "./support/gen.ts";

const count = (db: any) => (db.query("SELECT COUNT(*) n FROM history").get() as { n: number }).n;

test("ISC-8: every write appends exactly one history row; refused writes and dry runs append none", () => {
  fc.assert(
    fc.property(fc.array(fc.tuple(writeCmd, fc.boolean()), { maxLength: 15 }), (cmds) => {
      const db = memBooks();
      seedAccounts(db);
      let expected = count(db);
      for (const [c, dry] of cmds) {
        const r = write(db, c.op, c.input, { dry_run: dry });
        if (r.ok && !dry) expected++;
        expect(count(db)).toBe(expected);
        if (r.ok && !dry) {
          const last = db.query("SELECT op, source FROM history ORDER BY id DESC LIMIT 1").get();
          expect(last).toEqual({ op: c.op, source: "test" });
        }
      }
      must(db, "report_pnl", {});
      expect(count(db)).toBe(expected); // reads write no history
      db.close();
    }),
    { numRuns: 1000 },
  );
});

test("ISC-8: history rows can't be changed or removed", () => {
  const db = memBooks();
  seedAccounts(db);
  expect(() => db.exec("UPDATE history SET op = 'x'")).toThrow(/append-only/);
  expect(() => db.exec("DELETE FROM history")).toThrow(/append-only/);
});
