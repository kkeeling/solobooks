import { expect, test } from "bun:test";
import RATES from "../src/core/mileage-rates.json" with { type: "json" };
import { cli, json, ok, S } from "./support/billing.ts";
import { tempDir } from "./support/books.ts";

test("ISC-53: a trip uses the IRS rate for its date, 72.5¢ a mile on 2026-06-30 and 76¢ on 2026-07-01", async () => {
  const dir = tempDir();
  const trip = async (date: string, miles_tenths: number) =>
    (await ok(dir, json(["mileage", "add"], { date, miles_tenths, destination: "Acme HQ", purpose: "Client workshop" }))).trip;

  const june = await trip("2026-06-30", 100);
  const july = await trip("2026-07-01", 100);
  expect(june).toMatchObject({ date: "2026-06-30", miles: "10.0", rate_mills_per_mile: 725, rate: "72.5¢ a mile", standard_mileage_cents: 725 });
  expect(july).toMatchObject({ date: "2026-07-01", miles: "10.0", rate_mills_per_mile: 760, rate: "76¢ a mile", standard_mileage_cents: 760 });
  // Every trip names the public source of its rate.
  expect(june.rate_source).toStartWith("https://www.irs.gov/");
  expect(july.rate_source).toStartWith("https://www.irs.gov/");

  // Other years use their own rates, and miles in tenths round once, half-up, to the cent: 12.5 x 72.5¢ = $9.0625.
  expect(await trip("2025-12-31", 10)).toMatchObject({ rate_mills_per_mile: 700, standard_mileage_cents: 70 });
  expect(await trip("2026-01-01", 125)).toMatchObject({ miles: "12.5", rate_mills_per_mile: 725, standard_mileage_cents: 906 });
  // A day the table doesn't cover yet has no rate rather than a guessed one.
  const later = await trip("2027-01-04", 50);
  expect(later).toMatchObject({ rate_mills_per_mile: null, standard_mileage_cents: null });
  expect(later.note).toContain("no IRS rate for 2027-01-04");

  // The log totals miles and the standard mileage figure; a mistaken trip can be removed.
  await ok(dir, ["mileage", "delete", "--id", String(later.id), ...S]);
  const log = await ok(dir, ["mileage", "list", "--from", "2026-01-01", "--to", "2026-12-31"]);
  expect(log).toMatchObject({ miles_tenths: 325, miles: "32.5", standard_mileage_cents: 725 + 760 + 906, trips_without_rate: 0 });
  expect(log.trips.map((t: any) => t.date)).toEqual(["2026-01-01", "2026-06-30", "2026-07-01"]);

  // The rate table is data, each rate with its source, and runs in date order.
  expect(RATES.rates.map((r) => r.from)).toEqual([...RATES.rates.map((r) => r.from)].sort());
  for (const r of RATES.rates) expect(r.source).toStartWith("https://www.irs.gov/");
  // A trip needs its purpose and miles.
  expect((await cli(dir, json(["mileage", "add"], { date: "2026-07-01", miles_tenths: 0, destination: "x", purpose: "y" }))).out.field).toBe("miles_tenths");
  expect((await cli(dir, json(["mileage", "add"], { date: "2026-07-01", miles_tenths: 5, destination: "x" }))).out.field).toBe("purpose");
}, 30_000); // many CLI runs: allow for a busy machine
