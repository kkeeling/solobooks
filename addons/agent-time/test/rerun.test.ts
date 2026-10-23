import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { run } from "../../../src/cli.ts";
import { trapNetwork } from "../../../test/support/network-trap.ts";
import { main } from "../skills/bill-agent-time/scripts/count-time.ts";
import { claudeFile, claudeLines, codexFile, codexLines, put, tempDir } from "./support/logs.ts";

// ISC-99: the counter writes through solobooks' own `time add`, and re-running it for the same period adds nothing.

const NOW = "2026-10-22T12:00:00.000Z";

async function person() {
  const home = tempDir();
  const books = join(home, "books");
  const env = { HOME: home, SOLOBOOKS_NOW: NOW };
  const solobooks = (argv: string[]) => run(argv, env);
  const sb = async (...argv: string[]) => {
    const r = await solobooks([...argv, "--books", books]);
    if (r.code !== 0) throw new Error(r.stdout);
    return JSON.parse(r.stdout);
  };
  await sb("client", "add", "--name", "Acme", "--source", "person");
  await sb("client", "add", "--name", "Beta", "--source", "person");
  const addon = async (...argv: string[]) => {
    const r = await main([...argv, "--books", books], solobooks, env);
    if (r.code !== 0) throw new Error(JSON.stringify(r.out));
    return r.out as any;
  };
  await addon("map", "--folder", "/work/acme", "--client-id", "1", "--timezone", "UTC");
  await addon("map", "--folder", "/work/beta", "--client-id", "2");
  // Two days of work in both folders, in both agents, partly at once.
  put(claudeFile(home, "-work-acme", "s1"), claudeLines("s1", "/work/acme", [[540, "typed"], [548, "typed"], [600, "approve"], [1980, "typed"]]));
  put(codexFile(home, "c1"), codexLines("c1", "/work/beta", [[545, "user_message"], [2000, "user_message"]]));
  const timeCount = async () => (await sb("time", "list")).time_entries.length as number;
  return { home, books, env, solobooks, sb, addon, timeCount };
}

describe("ISC-99", () => {
  test("re-running for the same period adds no new entries", async () => {
    const p = await person();
    const first = await p.addon("write", "--from", "2026-10-05", "--to", "2026-10-06");
    expect(first.written.map((w: any) => w.status)).toEqual(["added", "added", "added", "added"]);
    expect(await p.timeCount()).toBe(4);

    const again = await p.addon("write", "--from", "2026-10-05", "--to", "2026-10-06");
    expect(again.written.map((w: any) => w.status)).toEqual(["already written", "already written", "already written", "already written"]);
    expect(again.written.map((w: any) => w.time_entry_id)).toEqual(first.written.map((w: any) => w.time_entry_id));
    expect(await p.timeCount()).toBe(4);

    // An overlapping period re-writes nothing it already wrote.
    const wider = await p.addon("write", "--from", "2026-10-01", "--to", "2026-10-21");
    expect(wider.written.every((w: any) => w.status === "already written")).toBe(true);
    expect(await p.timeCount()).toBe(4);
  });

  test("a written day whose logs changed is refused as a conflict, never billed twice", async () => {
    const p = await person();
    await p.addon("write", "--from", "2026-10-05", "--to", "2026-10-06");
    // A late session for Acme on Oct 5 turns up after the day was written.
    put(claudeFile(p.home, "-work-acme", "s2"), claudeLines("s2", "/work/acme", [[900, "typed"]]));
    const after = await p.addon("write", "--from", "2026-10-05", "--to", "2026-10-06");
    expect(after.written.map((w: any) => `${w.date} ${w.client_id} ${w.status}`)).toEqual([
      "2026-10-05 1 conflict",
      "2026-10-05 2 already written",
      "2026-10-06 1 already written",
      "2026-10-06 2 already written",
    ]);
    expect(await p.timeCount()).toBe(4);
  });

  test("the entries carry the sessions as their source, and the write goes through time add", async () => {
    const p = await person();
    await p.addon("write", "--from", "2026-10-05", "--to", "2026-10-05");
    const list = (await p.sb("time", "list")).time_entries;
    expect(list.map((t: any) => [t.client_id, t.date, t.minutes, t.source])).toEqual([
      [1, "2026-10-05", 25, "agent-time: claude/s1"], // 9:00-9:05, 9:08-9:18 after Beta's 9:05, and 10:00-10:10
      [2, "2026-10-05", 3, "agent-time: codex/c1"], // 9:05-9:08, until the next Acme message
    ]);
  });

  test("no network: mapping, previewing and writing open no outbound connection", async () => {
    const trap = trapNetwork();
    try {
      const p = await person();
      await p.addon("preview", "--from", "2026-10-05", "--to", "2026-10-06");
      await p.addon("write", "--from", "2026-10-05", "--to", "2026-10-06");
    } finally {
      trap.release();
    }
    expect(trap.attempts).toEqual([]);
  });

  test("a dry run and a period reaching today write nothing", async () => {
    const p = await person();
    const dry = await p.addon("write", "--from", "2026-10-05", "--to", "2026-10-06", "--dry-run");
    expect(dry.written.every((w: any) => w.status === "would add")).toBe(true);
    expect(await p.timeCount()).toBe(0);
    const today = await main(["write", "--from", "2026-10-05", "--to", "2026-10-22", "--books", p.books], p.solobooks, p.env);
    expect(today.code).toBe(2);
    expect((today.out as any).field).toBe("to");
    expect(await p.timeCount()).toBe(0);
  });
});
