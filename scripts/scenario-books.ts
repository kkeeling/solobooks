#!/usr/bin/env bun
// Fills a books folder with one pass through every operation (the test scenario), for checks that run the real
// `solobooks` command against books with something in them.
//
//   bun scripts/scenario-books.ts <books dir>
import { cli } from "../test/support/books.ts";
import { setUpPerson } from "../test/support/person.ts";
import { cliArgs, SCENARIO } from "../test/support/scenario.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: bun scripts/scenario-books.ts <books dir>");
  process.exit(2);
}
await setUpPerson(dir);
for (const step of SCENARIO) {
  const r = await cli(dir, cliArgs(step, "test:scenario-books"));
  if (r.code !== 0) {
    console.error(`${step.op} failed: ${JSON.stringify(r.out)}`);
    process.exit(1);
  }
}
