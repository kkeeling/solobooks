import { describe, expect, test } from "bun:test";
import { OPS } from "../src/core/perform.ts";
import { cli, tempDir } from "./support/books.ts";
import { inProcessMcp } from "./support/mcp-client.ts";
import { trapNetwork } from "./support/network-trap.ts";
import { cliArgs, SCENARIO } from "./support/scenario.ts";

describe("ISC-1", () => {
  test("no network: the trap itself catches an outbound connection", async () => {
    const trap = trapNetwork();
    try {
      await fetch("https://example.com");
    } catch {
      // expected: the trap refuses the call
    } finally {
      trap.release();
    }
    expect(trap.nonLoopback().length).toBe(1);
  });

  test("no network: every CLI command and MCP tool runs with zero outbound connections", async () => {
    expect(new Set(SCENARIO.map((s) => s.op))).toEqual(new Set(OPS.map((o) => o.name)));
    const trap = trapNetwork();
    try {
      const cliDir = tempDir();
      for (const step of SCENARIO) {
        expect((await cli(cliDir, [...cliArgs(step), "--dry-run"])).code).toBe(0);
        expect((await cli(cliDir, cliArgs(step))).code).toBe(0);
      }
      expect((await cli(cliDir, ["help"])).code).toBe(0);

      const mcp = await inProcessMcp(tempDir());
      await mcp.request("tools/list");
      for (const step of SCENARIO) {
        const r = await mcp.call(step.op, { ...step.input, source: "test:scenario" });
        expect(r.isError).toBe(false);
      }
      await mcp.close();
    } finally {
      trap.release();
    }
    expect(trap.attempts).toEqual([]);
  });
});
