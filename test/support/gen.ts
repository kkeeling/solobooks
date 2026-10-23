import fc from "fast-check";
import type { Books } from "../../src/core/db.ts";
import { perform, type Outcome } from "../../src/core/perform.ts";
import { MAX_CENTS } from "../../src/core/validate.ts";
import { acct } from "./books.ts";

export const NOW = "2026-10-22T12:00:00.000Z";

export function write(db: Books, op: string, input: unknown, env: Record<string, unknown> = {}): Outcome {
  return perform(db, op, input, { source: "test", now: NOW, ...env });
}

export function must(db: Books, op: string, input: unknown, env: Record<string, unknown> = {}): any {
  const r = write(db, op, input, env);
  if (!r.ok) throw new Error(`${op} refused: ${JSON.stringify(r.refusal)}`);
  return r.result;
}

const TYPES = ["asset", "liability", "equity", "income", "expense"] as const;
export const cents = fc.integer({ min: 1, max: MAX_CENTS });
const date = fc.integer({ min: 0, max: 364 }).map((d) => new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10));

/** Lines that balance: random debits and credits, with the last line closing the gap. */
const balancedLines = fc
  .array(fc.record({ account_id: fc.integer({ min: 1, max: 6 }).map(acct), amount: fc.integer({ min: 1, max: 10_000_000 }), debit: fc.boolean() }), {
    minLength: 1,
    maxLength: 4,
  })
  .chain((ls) => {
    const net = ls.reduce((s, l) => s + (l.debit ? l.amount : -l.amount), 0);
    const lines: any[] = ls.map((l) => ({ account_id: l.account_id, [l.debit ? "debit_cents" : "credit_cents"]: l.amount }));
    return fc.integer({ min: 1, max: 6 }).map(acct).map((account_id) => {
      if (net > 0) lines.push({ account_id, credit_cents: net });
      else if (net < 0) lines.push({ account_id, debit_cents: -net });
      else lines.push({ account_id, debit_cents: 1 }, { account_id, credit_cents: 1 });
      return lines;
    });
  });

const unbalancedLines = fc
  .tuple(fc.integer({ min: 1, max: 6 }).map(acct), fc.integer({ min: 1, max: 6 }).map(acct), cents, cents)
  .filter(([, , a, b]) => a !== b)
  .map(([x, y, a, b]) => [{ account_id: x, debit_cents: a }, { account_id: y, credit_cents: b }]);

/** A random write, sometimes one that solobooks should refuse. */
export const writeCmd = fc.oneof(
  fc.record({ op: fc.constant("account_add"), input: fc.record({ name: fc.constantFrom("A", "B", "C", "D", "E", "F", "G"), type: fc.constantFrom(...TYPES) }) }),
  fc.record({ op: fc.constant("entry_post"), input: fc.record({ date, memo: fc.constant("m"), lines: balancedLines }) }),
  fc.record({ op: fc.constant("entry_post"), input: fc.record({ date, memo: fc.constant("m"), lines: unbalancedLines }) }),
  fc.record({ op: fc.constant("client_add"), input: fc.record({ name: fc.constantFrom("Acme", "Beta", "Gamma"), increment_minutes: fc.integer({ min: 1, max: 60 }) }) }),
  fc.record({
    op: fc.constant("time_add"),
    input: fc.record({ client_id: fc.integer({ min: 1, max: 3 }), date, minutes: fc.integer({ min: 1, max: 600 }), note: fc.constant("work") }),
  }),
  fc.record({ op: fc.constant("time_delete"), input: fc.record({ id: fc.integer({ min: 1, max: 5 }) }) }),
);

/** Six accounts so random entries usually reference real ones. */
export function seedAccounts(db: Books): void {
  for (const [name, type] of [
    ["Checking", "asset"],
    ["Card", "liability"],
    ["Owner", "equity"],
    ["Income", "income"],
    ["Software", "expense"],
    ["Trips", "expense"],
  ]) must(db, "account_add", { name, type });
}
