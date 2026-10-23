import { expect, test } from "bun:test";
import fc from "fast-check";
import { OPS } from "../src/core/perform.ts";
import { cli, memBooks, tempDir } from "./support/books.ts";
import { must, seedAccounts, write } from "./support/gen.ts";

const VALID: Record<string, Record<string, unknown>> = {
  account_add: { name: "New", type: "asset" },
  entry_post: { date: "2026-10-01", memo: "m", lines: [{ account_id: 1, debit_cents: 100 }, { account_id: 4, credit_cents: 100 }] },
  client_add: { name: "Zeta", increment_minutes: 6 },
  engagement_add: { client_id: 1, name: "E", rate_cents_per_hour: 15000 },
  time_add: { client_id: 1, date: "2026-10-01", minutes: 30, note: "n" },
  time_edit: { id: 1, minutes: 10 },
  time_delete: { id: 1 },
};
const ENVELOPE = ["source", "idempotency_key", "input", "command"];

function setup() {
  const db = memBooks();
  seedAccounts(db);
  must(db, "client_add", { name: "Acme" });
  must(db, "time_add", { client_id: 1, date: "2026-10-01", minutes: 30, note: "n" }, { idempotency_key: "used" });
  return db;
}

/** One sentence: text ending in a single full stop, with no sentence break inside. */
export function isOneSentence(s: string): boolean {
  return s.length > 0 && s.endsWith(".") && !/[.!?]\s/.test(s.slice(0, -1)) && !s.includes("\n");
}

const bad = fc.oneof(fc.constantFrom<unknown>(undefined, null, "", "  ", "abc", -5, 0, 1.5, 99, 1e20, true, [], {}, "2026-02-30", "EUR", [{}]), fc.string(), fc.constantFrom("Acme", "Checking", "x. Y", "toString", "__proto__"));

const corrupt = fc.constantFrom(...Object.keys(VALID)).chain((op) => {
  const top = Object.keys(OPS.find((o) => o.name === op)!.fields);
  const paths = op === "entry_post" ? [...top, "lines.0.account_id", "lines.0.debit_cents", "lines.1.currency", "extra", "toString"] : [...top, "extra", "toString"];
  return fc.record({
    op: fc.constant(op),
    changes: fc.array(fc.tuple(fc.constantFrom(...paths), bad), { minLength: 1, maxLength: 3 }),
    source: fc.constantFrom<unknown>("test", "test", "test", "", undefined, 7),
    key: fc.constantFrom<unknown>(undefined, undefined, "used", "", 3),
  });
});

function apply(base: Record<string, unknown>, changes: [string, unknown][]) {
  const input = structuredClone(base) as any;
  for (const [path, v] of changes) {
    const parts = path.split(".");
    let o = input;
    for (const p of parts.slice(0, -1)) o = o?.[p];
    if (o && typeof o === "object") {
      if (v === undefined) delete o[parts.at(-1)!];
      else o[parts.at(-1)!] = v;
    }
  }
  return input;
}

test("ISC-13: every refused write returns a one-sentence reason and the field to change", () => {
  let refused = 0;
  fc.assert(
    fc.property(corrupt, ({ op, changes, source, key }) => {
      const db = setup();
      const input = apply(VALID[op]!, changes);
      const r = write(db, op, input, { source, idempotency_key: key }); // must not throw: bad input is a refusal, not a crash
      if (!r.ok) {
        refused++;
        expect(Object.keys(r.refusal).sort()).toEqual(["field", "reason"]);
        expect(isOneSentence(r.refusal.reason)).toBe(true);
        const top = r.refusal.field.split(/[.[]/)[0]!;
        const known = [...Object.keys(OPS.find((o) => o.name === op)!.fields), ...ENVELOPE, ...Object.keys(input ?? {})];
        expect(known).toContain(top);
      }
      db.close();
    }),
    { numRuns: 1000 },
  );
  expect(refused).toBeGreaterThan(700);
});

test("ISC-13: the CLI prints exactly the reason and field for a refused write", async () => {
  const r = await cli(tempDir(), ["time", "add", "--client-id", "1", "--date", "2026-10-01", "--minutes", "ten", "--note", "x", "--source", "s"]);
  expect(r.code).toBe(2);
  expect(r.out).toEqual({ reason: "minutes must be a whole number of minutes.", field: "minutes" });
});

test("ISC-13: every business-rule refusal also gives one sentence and the field to change", () => {
  const db = setup();
  must(db, "engagement_add", { client_id: 1, name: "Build", rate_cents_per_hour: 100 });
  must(db, "client_add", { name: "Beta" });
  const lines = (a: number, b: number) => [{ account_id: 1, debit_cents: a }, { account_id: 4, credit_cents: b }];
  const cases: [string, unknown, Record<string, unknown>, string][] = [
    ["client_add", { name: "acme" }, {}, "name"],
    ["account_add", { name: "Checking", type: "asset" }, {}, "name"],
    ["engagement_add", { client_id: 1, name: "Build", rate_cents_per_hour: 1 }, {}, "name"],
    ["engagement_add", { client_id: 9, name: "X", rate_cents_per_hour: 1 }, {}, "client_id"],
    ["engagement_add", { client_id: 1, name: "X" }, {}, "rate_cents_per_hour"],
    ["engagement_add", { client_id: 1, name: "X", recurring_amount_cents: 5 }, {}, "recurring_interval"],
    ["engagement_add", { client_id: 1, name: "X", recurring_interval: "monthly" }, {}, "recurring_amount_cents"],
    ["entry_post", { date: "2026-10-01", memo: "m", lines: lines(5, 6) }, {}, "lines"],
    ["entry_post", { date: "2026-10-01", memo: "m", lines: [{ account_id: 99, debit_cents: 5 }, { account_id: 4, credit_cents: 5 }] }, {}, "lines[0].account_id"],
    ["entry_post", { date: "2026-10-01", memo: "m", lines: [{ account_id: 1, debit_cents: 5, credit_cents: 5 }, { account_id: 4, credit_cents: 5 }] }, {}, "lines[0].debit_cents"],
    ["time_add", { client_id: 9, date: "2026-10-01", minutes: 5, note: "n" }, {}, "client_id"],
    ["time_add", { client_id: 2, engagement_id: 1, date: "2026-10-01", minutes: 5, note: "n" }, {}, "engagement_id"],
    ["time_add", { client_id: 1, engagement_id: 7, date: "2026-10-01", minutes: 5, note: "n" }, {}, "engagement_id"],
    ["time_edit", { id: 99, minutes: 5 }, {}, "id"],
    ["time_delete", { id: 99 }, {}, "id"],
    ["time_delete", { id: 1 }, { idempotency_key: "used" }, "idempotency_key"],
    ["time_delete", { id: 1 }, { source: "" }, "source"],
    ["no_such_op", {}, {}, "command"],
  ];
  for (const [op, input, env, field] of cases) {
    const r = write(db, op, input, env);
    expect(r.ok).toBe(false);
    if (r.ok) continue;
    expect(r.refusal.field).toBe(field);
    expect(isOneSentence(r.refusal.reason)).toBe(true);
  }
});
