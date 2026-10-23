import { expect, test } from "bun:test";
import fc from "fast-check";
import { dumpDb, memBooks } from "./support/books.ts";
import { seedAccounts, write, writeCmd } from "./support/gen.ts";

test("ISC-9 same key: a write repeated with the same idempotency key changes nothing", () => {
  let replays = 0;
  fc.assert(
    fc.property(fc.array(writeCmd, { maxLength: 8 }), writeCmd, fc.string({ minLength: 1 }).filter((s) => s.trim() !== ""), (before, cmd, key) => {
      const db = memBooks();
      seedAccounts(db);
      for (const c of before) write(db, c.op, c.input);
      const first = write(db, cmd.op, cmd.input, { idempotency_key: key });
      const snapshot = dumpDb(db);
      for (let i = 0; i < 3; i++) {
        const again = write(db, cmd.op, cmd.input, { idempotency_key: key });
        expect(dumpDb(db)).toEqual(snapshot);
        // A retry of an accepted write gets the original answer back.
        if (first.ok) {
          expect(again).toEqual(first);
          replays++;
        }
      }
      db.close();
    }),
    { numRuns: 1000 },
  );
  expect(replays).toBeGreaterThan(500);
}, 60_000); // 1000 runs: allow for a busy machine
