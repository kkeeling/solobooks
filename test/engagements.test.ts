import { expect, test } from "bun:test";
import { cli, ok, tempDir } from "./support/books.ts";

test("ISC-16 term types: hourly, fixed-milestone, recurring and mixed terms are each created through the CLI alone", async () => {
  const dir = tempDir();
  const s = ["--source", "agent:test"];
  await ok(dir, ["client", "add", "--name", "Acme", ...s]);

  const hourly = await ok(dir, ["engagement", "add", "--client-id", "1", "--name", "Build", "--rate-cents-per-hour", "15000", ...s]);
  const milestone = await ok(dir, [
    "engagement", "add", ...s,
    "--json", JSON.stringify({ client_id: 1, name: "Launch", milestones: [{ name: "Spec", amount_cents: 250000 }, { name: "Ship", amount_cents: 500000 }] }),
  ]);
  const recurring = await ok(dir, [
    "engagement", "add", "--client-id", "1", "--name", "Retainer", "--recurring-amount-cents", "300000", "--recurring-interval", "monthly", ...s,
  ]);
  const mixed = await ok(dir, [
    "engagement", "add", ...s,
    "--json", JSON.stringify({ client_id: 1, name: "Support", rate_cents_per_hour: 12000, milestones: [{ name: "Setup", amount_cents: 100000 }] }),
    "--recurring-amount-cents", "50000", "--recurring-interval", "monthly",
  ]);

  expect(hourly.engagement).toMatchObject({ type: "hourly", rate_cents_per_hour: 15000, milestones: [] });
  expect(milestone.engagement).toMatchObject({
    type: "fixed-milestone",
    rate_cents_per_hour: null,
    milestones: [{ name: "Spec", amount_cents: 250000 }, { name: "Ship", amount_cents: 500000 }],
  });
  expect(recurring.engagement).toMatchObject({ type: "recurring", recurring_amount_cents: 300000, recurring_interval: "monthly" });
  expect(mixed.engagement).toMatchObject({
    type: "mixed",
    rate_cents_per_hour: 12000,
    recurring_amount_cents: 50000,
    milestones: [{ name: "Setup", amount_cents: 100000 }],
  });

  // Any two kinds of term make an engagement mixed.
  const two = await ok(dir, ["engagement", "add", "--client-id", "1", "--name", "Care", "--rate-cents-per-hour", "9000", "--recurring-amount-cents", "1000", "--recurring-interval", "yearly", ...s]);
  expect(two.engagement.type).toBe("mixed");

  const listed = await ok(dir, ["engagement", "list", "--client-id", "1"]);
  expect(listed.engagements.map((e: any) => e.type)).toEqual(["hourly", "fixed-milestone", "recurring", "mixed", "mixed"]);
});

test("ISC-16 term types: an engagement with no terms is refused with the field to set", async () => {
  const dir = tempDir();
  await ok(dir, ["client", "add", "--name", "Acme", "--source", "s"]);
  const r = await cli(dir, ["engagement", "add", "--client-id", "1", "--name", "Nothing", "--source", "s"]);
  expect(r.code).toBe(2);
  expect(r.out.field).toBe("rate_cents_per_hour");
});
