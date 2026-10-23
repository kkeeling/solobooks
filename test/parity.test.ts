import { expect, test } from "bun:test";
import { dbPath, dumpFile, ROOT, tempDir } from "./support/books.ts";
import { stdioMcp } from "./support/mcp-client.ts";
import { setUpPerson } from "./support/person.ts";
import { cliArgs, SCENARIO } from "./support/scenario.ts";

const ENV = { SOLOBOOKS_NOW: "2026-10-22T12:00:00.000Z" };

async function binCli(dir: string, args: string[]) {
  const p = Bun.spawn(["bun", "src/cli.ts", ...args, "--books", dir], { cwd: ROOT, env: { PATH: process.env.PATH!, ...ENV }, stdout: "pipe" });
  const out = await new Response(p.stdout).text();
  return { code: await p.exited, out: JSON.parse(out) };
}

test("ISC-14: the CLI and MCP produce identical records for the same operations", async () => {
  const viaCli = tempDir();
  const viaMcp = tempDir();
  await setUpPerson(viaCli);
  await setUpPerson(viaMcp);
  const mcp = await stdioMcp(viaMcp, ENV);

  const refusal = { op: "time_add", input: { client_id: 1, date: "2026-10-01", minutes: 0, note: "x" } };
  for (const step of [...SCENARIO, refusal]) {
    const c = await binCli(viaCli, cliArgs(step, "agent:parity"));
    const m = await mcp.call(step.op, { ...step.input, source: "agent:parity" });
    // Same answer back, refusals included.
    expect(m.structuredContent).toEqual(c.out);
    expect(m.isError).toBe(c.code !== 0);
  }
  const stderr = await mcp.close();
  expect(stderr).toContain("solobooks mcp"); // logs went to stderr, and stdout stayed pure JSON-RPC

  const a = dumpFile(dbPath(viaCli));
  const b = dumpFile(dbPath(viaMcp));
  expect(Object.values(a).flat().length).toBeGreaterThan(20);
  expect(b).toEqual(a);
}, 60_000); // one bun process per scenario step: allow for a busy machine
