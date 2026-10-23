import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { install, run } from "../src/cli.ts";
import { readConfig } from "../src/config.ts";
import { OPS } from "../src/core/perform.ts";
import { cli, dbPath, dumpFile, fileHash, tempDir } from "./support/books.ts";
import { setUpPerson } from "./support/person.ts";
import { cliArgs, SCENARIO } from "./support/scenario.ts";

const NOW = "2026-10-22T12:00:00.000Z";

/** Every file under a folder, with its sha256. */
function files(dir: string): Record<string, string> {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  return Object.fromEntries(walk(dir).map((f) => [relative(dir, f), fileHash(f)]));
}

/** Every read solobooks has, from the scenario, run the way the person's agent runs them: through the settings. */
async function everyReport(env: Record<string, string>): Promise<Record<string, string>> {
  const reads = SCENARIO.filter((s) => OPS.find((o) => o.name === s.op)!.kind === "read");
  const out: Record<string, string> = {};
  for (const [i, step] of reads.entries()) {
    const r = await run(cliArgs(step).slice(0, -2), env); // reads take no --source
    expect(r.code).toBe(0);
    out[`${i} ${step.op}`] = r.stdout;
  }
  return out;
}

test("ISC-95: solobooks move into a fresh folder reproduces identical reports, and the settings point at it", async () => {
  const home = tempDir();
  const env = { HOME: home, SOLOBOOKS_NOW: NOW };
  const from = join(home, "solobooks");
  expect((await install("setup", ["--books", from], env)).code).toBe(0);
  await setUpPerson(from);
  for (const step of SCENARIO) expect((await cli(from, cliArgs(step))).code).toBe(0);

  const reports = await everyReport(env);
  // Every read there is, reports and exports included.
  expect(new Set(Object.keys(reports).map((k) => k.split(" ")[1]))).toEqual(new Set(OPS.filter((o) => o.kind === "read").map((o) => o.name)));
  const before = { rows: dumpFile(dbPath(from)), files: files(from) };
  // The books folder holds more than the books file: receipts, invoice PDFs and statements.
  expect(Object.keys(before.files).sort()).toEqual(expect.arrayContaining(["solobooks.sqlite", expect.stringMatching(/^receipts\//), expect.stringMatching(/^invoices\//), expect.stringMatching(/^statements\//)]));

  const to = join(home, "elsewhere", "books");
  const r = await install("move", ["--to", to], env);
  expect(r.code).toBe(0);
  const moved = JSON.parse(r.stdout);
  expect(moved).toMatchObject({ from, to, books: dbPath(to), warnings: [] });
  expect(readConfig(env).books).toBe(to);

  // The new folder holds the same books and every other file, byte for byte; the old folder is left as it was.
  expect(dumpFile(dbPath(to))).toEqual(before.rows);
  const { "solobooks.sqlite": _, ...others } = before.files;
  const after = files(to);
  expect(Object.keys(after).sort()).toEqual(Object.keys(before.files).sort());
  for (const [rel, hash] of Object.entries(others)) expect(after[rel]).toBe(hash);
  expect(moved.files).toBe(Object.keys(others).length);
  expect(files(from)).toEqual(before.files);

  // Every report comes out identical, now from the new folder.
  expect(await everyReport(env)).toEqual(reports);
  // And writes land there.
  const w = await run(["client", "add", "--name", "After the move", "--source", "person"], env);
  expect(w.code).toBe(0);
  expect(dumpFile(dbPath(to)).clients).toHaveLength(before.rows.clients!.length + 1);
  expect(dumpFile(dbPath(from)).clients).toHaveLength(before.rows.clients!.length);
}, 60_000);

test("ISC-95: move refuses a folder that isn't empty, one inside the books, and books that aren't there, changing nothing", async () => {
  const home = tempDir();
  const env = { HOME: home, SOLOBOOKS_NOW: NOW };
  const from = join(home, "solobooks");
  await install("setup", ["--books", from], env);
  const busy = join(home, "busy");
  mkdirSync(busy);
  writeFileSync(join(busy, "notes.txt"), "mine");

  const refusal = async (argv: string[], e: Record<string, string> = env) => JSON.parse((await install("move", argv, e)).stdout);
  expect(await refusal(["--to", busy])).toEqual({ reason: `The folder ${busy} isn't empty, so choose an empty or new folder for the books.`, field: "to" });
  expect(await refusal(["--to", join(from, "inner")])).toMatchObject({ field: "to" });
  expect(await refusal([])).toEqual({ reason: "Say which empty folder the books move to with --to <dir>.", field: "to" });
  expect(await refusal(["--to", join(home, "new")], { ...env, SOLOBOOKS_DIR: join(home, "nothing-here") })).toMatchObject({ field: "books" });
  expect(readdirSync(busy)).toEqual(["notes.txt"]);
  expect(existsSync(join(home, "new"))).toBe(false);
  expect(existsSync(join(from, "inner"))).toBe(false);
  expect(readConfig(env).books).toBe(from);
  expect(readFileSync(join(busy, "notes.txt"), "utf8")).toBe("mine");
}, 30_000);
