import { expect, test } from "bun:test";
import fc from "fast-check";
import { billableMinutes, lineAmountCents } from "../src/core/billing.ts";
import { ok, tempDir } from "./support/books.ts";

/** A client with one hourly engagement and one time entry; returns that entry as solobooks prices it. */
async function bill(client: string[], minutes: number, rate = 15000) {
  const dir = tempDir();
  const s = ["--source", "agent:test"];
  await ok(dir, ["client", "add", "--name", "Acme", ...client, ...s]);
  await ok(dir, ["engagement", "add", "--client-id", "1", "--name", "Build", "--rate-cents-per-hour", String(rate), ...s]);
  await ok(dir, ["time", "add", "--client-id", "1", "--date", "2026-10-01", "--minutes", String(minutes), "--note", "work", ...s]);
  return (await ok(dir, ["time", "list", "--client-id", "1"])).time_entries[0];
}

test("ISC-17 exact minutes: 37 minutes at $150/hr bills exactly $92.50 by default", async () => {
  const e = await bill([], 37);
  expect(e).toMatchObject({ minutes: 37, billable_minutes: 37, rate_cents_per_hour: 15000, amount_cents: 9250 });
});

test("ISC-17 exact minutes: line amounts round half-up once, in integer cents", () => {
  expect(lineAmountCents(1, 15000)).toBe(250); // exact
  expect(lineAmountCents(1, 10001)).toBe(167); // 166.68 -> 167
  expect(lineAmountCents(1, 9030)).toBe(151); // 150.5 -> 151, half rounds up
  expect(lineAmountCents(1, 9029)).toBe(150); // 150.48 -> 150
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 1440 }), fc.integer({ min: 1, max: 10_000_000 }), (m, r) => {
      const exact = (m * r) / 60;
      const got = lineAmountCents(m, r);
      expect(Number.isInteger(got)).toBe(true);
      expect(got - exact).toBeLessThanOrEqual(0.5);
      expect(exact - got).toBeLessThan(0.5);
    }),
    { numRuns: 1000 },
  );
}, 60_000); // 1000 runs: allow for a busy machine

test("ISC-18 increment: a client's 6-minute increment bills a 7-minute entry as 12 minutes", async () => {
  const e = await bill(["--increment-minutes", "6"], 7);
  expect(e).toMatchObject({ minutes: 7, billable_minutes: 12, amount_cents: 3000 });
  expect(billableMinutes(6, 6, 0)).toBe(6);
  expect(billableMinutes(13, 6, 0)).toBe(18);
});

test("ISC-19 minimum: a client's 15-minute minimum bills a 5-minute entry as 15 minutes", async () => {
  const e = await bill(["--minimum-minutes", "15"], 5);
  expect(e).toMatchObject({ minutes: 5, billable_minutes: 15, amount_cents: 3750 });
  expect(billableMinutes(20, 1, 15)).toBe(20);
  expect(billableMinutes(5, 6, 15)).toBe(18); // minimum first, then the increment
});
