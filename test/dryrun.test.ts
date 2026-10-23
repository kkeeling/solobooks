import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { OPS } from "../src/core/perform.ts";
import { cli, dbPath, fileHash, tempDir } from "./support/books.ts";
import { setUpPerson } from "./support/person.ts";
import { cliArgs, SCENARIO } from "./support/scenario.ts";

/** Every file under a folder, so a dry run that leaves anything behind (a journal, a receipt) shows up. */
function listing(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort().map((f) => join(dir, f));
}

test("ISC-11: --dry-run on every write leaves the database file byte-identical", async () => {
  const dir = tempDir();
  await setUpPerson(dir);
  const writes = SCENARIO.filter((s) => OPS.find((o) => o.name === s.op)!.kind === "write");
  expect(new Set(writes.map((w) => w.op))).toEqual(new Set(OPS.filter((o) => o.kind === "write").map((o) => o.name)));

  for (const step of writes) {
    if (existsSync(dbPath(dir))) {
      const before = fileHash(dbPath(dir));
      const files = listing(dir);
      const dry = await cli(dir, [...cliArgs(step), "--dry-run"]);
      expect(dry.code).toBe(0);
      expect(dry.out.dry_run).toBe(true);
      expect(fileHash(dbPath(dir))).toBe(before);
      expect(listing(dir)).toEqual(files); // no journal, -wal, -shm or receipt left behind
      expect(readdirSync(dir).filter((f) => f.startsWith("solobooks"))).toEqual(["solobooks.sqlite"]);
    }
    expect((await cli(dir, cliArgs(step))).code).toBe(0);
  }
});

test("ISC-11: a dry run that the real write would do shows the same result", async () => {
  const dir = tempDir();
  await cli(dir, ["client", "add", "--name", "Acme", "--source", "s"]);
  const step = ["time", "add", "--client-id", "1", "--date", "2026-10-01", "--minutes", "37", "--note", "x", "--source", "s"];
  const dry = await cli(dir, [...step, "--dry-run"]);
  const real = await cli(dir, step);
  expect(dry.out.result).toEqual(real.out);
});

test("ISC-11: a dry run against a folder with no books creates no file", async () => {
  const dir = tempDir();
  const r = await cli(dir, ["client", "add", "--name", "Acme", "--source", "s", "--dry-run"]);
  expect(r.code).toBe(0);
  expect(readdirSync(dir)).toEqual([]);
});
