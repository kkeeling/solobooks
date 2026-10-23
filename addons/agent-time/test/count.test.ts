import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { count } from "../skills/bill-agent-time/scripts/count-time.ts";
import { claudeFile, claudeLines, codexFile, codexLines, mapping, put, tempDir, type ClaudeEvent } from "./support/logs.ts";

const DAY = { from: "2026-10-05", to: "2026-10-05" };
const ACME = { folder: "/work/acme", client_id: 1, client: "Acme" };

function run(home: string, flags: Record<string, string> = DAY) {
  return count(flags, { HOME: home });
}

/** Busy agent records every minute from `from` to `to`, none of them the person. */
const busy = (from: number, to: number): [number, ClaudeEvent][] =>
  Array.from({ length: to - from + 1 }, (_, i) => [from + i, i % 2 ? "assistant" : "tool"] as [number, ClaudeEvent]);

describe("ISC-97", () => {
  test("cap: agent time past 10 minutes after the person's last action counts zero (Claude Code)", () => {
    const home = tempDir();
    mapping(home, [ACME]);
    // One message at 9:00, then the agent works alone for two hours; one approval at 9:30 the agent asked for.
    const events: [number, ClaudeEvent][] = [[540, "typed"], ...busy(541, 660), [570, "approve"]];
    put(claudeFile(home, "-work-acme", "s1"), claudeLines("s1", "/work/acme", events));
    const r = run(home);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.minutes).toBe(20);
    expect(r.entries[0]!.spans.map((s) => s.local)).toEqual(["09:00-09:10", "09:30-09:40"]);
  });

  test("cap: a next action inside the cap keeps billing without a break, past it nothing", () => {
    const home = tempDir();
    mapping(home, [ACME]);
    put(claudeFile(home, "-work-acme", "s1"), claudeLines("s1", "/work/acme", [[540, "typed"], [546, "typed"], [600, "typed"], ...busy(601, 700)]));
    const r = run(home);
    expect(r.entries[0]!.spans.map((s) => s.local)).toEqual(["09:00-09:16", "10:00-10:10"]);
    expect(r.entries[0]!.minutes).toBe(26);
  });

  test("cap: agent time past the cap counts zero (Codex)", () => {
    const home = tempDir();
    mapping(home, [ACME]);
    const agent = Array.from({ length: 90 }, (_, i) => [541 + i, i % 2 ? "agent" : "command"] as [number, "agent" | "command"]);
    put(codexFile(home, "c1"), codexLines("c1", "/work/acme", [[540, "user_message"], ...agent]));
    put(codexFile(home, "c2"), codexLines("c2", "/work/acme", [[700, "UserMessage"]], { source: "vscode", thread_source: "user" }));
    const r = run(home);
    expect(r.entries[0]!.spans.map((s) => s.local)).toEqual(["09:00-09:10", "11:40-11:50"]);
    expect(r.entries[0]!.minutes).toBe(20);
  });
});

describe("what counts as the person", () => {
  test("typed, suggested, slash commands, queued messages and answers count; the agent and the harness don't", () => {
    const home = tempDir();
    mapping(home, [ACME]);
    const kinds: ClaudeEvent[] = ["typed", "suggestion", "slash", "enqueue", "answer", "tool", "assistant", "notification", "meta", "sdk"];
    // Each kind alone, an hour apart, beside an agent record that says where the session ran: only the person's own
    // actions open a window.
    kinds.forEach((k, i) => put(claudeFile(home, "-work-acme", `k${i}`), claudeLines(`k${i}`, "/work/acme", [[i * 60, "assistant"], [i * 60, k]])));
    const r = run(home);
    const opened = r.entries[0]!.sessions.map((s) => s.session);
    expect(opened).toEqual(["k0", "k1", "k2", "k3", "k4"]);
    // The answer lands when the person gave it, three minutes after the agent asked.
    expect(r.entries[0]!.spans.map((s) => s.local)).toContain("04:03-04:13");
    expect(r.entries[0]!.minutes).toBe(50);
  });

  test("sessions a program started are skipped, and so are Claude Code subagent logs", () => {
    const home = tempDir();
    mapping(home, [ACME]);
    put(claudeFile(home, "-work-acme", "sdk1"), claudeLines("sdk1", "/work/acme", [[60, "typed"]], "sdk-cli"));
    put(join(home, ".claude", "projects", "-work-acme", "s1", "subagents", "agent-a.jsonl"), claudeLines("s1", "/work/acme", [[120, "typed"]]));
    put(codexFile(home, "exec1"), codexLines("exec1", "/work/acme", [[180, "user_message"]], { source: "exec" }));
    put(codexFile(home, "sub1"), codexLines("sub1", "/work/acme", [[240, "user_message"]], { source: { subagent: { other: "x" } } }));
    put(codexFile(home, "auto1"), codexLines("auto1", "/work/acme", [[300, "UserMessage"]], { source: "vscode", thread_source: "automation" }));
    const r = run(home);
    expect(r.entries).toEqual([]);
    expect(r.skipped_sessions.map((s) => `${s.agent}/${s.session}`)).toEqual(["claude/sdk1", "codex/auto1", "codex/exec1", "codex/sub1"]);
  });

  test("scope: the scripts import only each other and the fs and path modules, so they need no packages and no network", async () => {
    const dir = join(import.meta.dir, "..", "skills", "bill-agent-time", "scripts");
    for (const name of ["count-time.ts", "logs.ts", "rule.ts"]) {
      const text = await Bun.file(join(dir, name)).text();
      const imports = [...text.matchAll(/^import[^"]*"([^"]+)"/gm)].map((m) => m[1]);
      for (const i of imports) expect(["node:fs", "node:path", "./logs.ts", "./rule.ts"]).toContain(i);
      expect(text).not.toMatch(/\bfetch\(|Bun\.(connect|listen|serve|spawn)|require\(|import\(/);
    }
  });

  test("the output never carries what anyone wrote", () => {
    const home = tempDir();
    mapping(home, [ACME]);
    put(claudeFile(home, "-work-acme", "s1"), claudeLines("s1", "/work/acme", [[60, "typed"], [61, "assistant"]]));
    put(codexFile(home, "c1"), codexLines("c1", "/work/other", [[90, "user_message"]]));
    const text = JSON.stringify(run(home));
    for (const said of ["please fix the thing", "make it faster", "ok"]) expect(text).not.toContain(`"${said}"`);
    expect(text).not.toContain("please fix");
  });
});

describe("folders and clients", () => {
  test("the deepest mapped folder wins, unmapped and not-billed folders bill no one, and attention goes to the latest action", () => {
    const home = tempDir();
    mapping(home, [ACME, { folder: "/work/acme/side", client_id: 2, client: "Beta" }, { folder: "/home/me/blog", client_id: null, client: "not billed" }]);
    put(claudeFile(home, "-work-acme-api", "a"), claudeLines("a", "/work/acme/api", [[0, "typed"]]));
    put(claudeFile(home, "-work-acme-side", "b"), claudeLines("b", "/work/acme/side/x", [[5, "typed"]])); // takes over at :05
    put(claudeFile(home, "-home-me-blog", "c"), claudeLines("c", "/home/me/blog", [[30, "typed"]]));
    put(claudeFile(home, "-tmp-scratch", "d"), claudeLines("d", "/tmp/scratch", [[60, "typed"]]));
    const r = run(home);
    expect(r.entries.map((e) => [e.client, e.minutes, e.note])).toEqual([
      ["Acme", 5, "Directed coding agents in api"],
      ["Beta", 10, "Directed coding agents in x"],
    ]);
    expect(r.unbilled).toEqual([
      { date: "2026-10-05", folder: "/home/me/blog", minutes: 10, why: "not billed" },
      { date: "2026-10-05", folder: "/tmp/scratch", minutes: 10, why: "not mapped" },
    ]);
  });

  test("a Codex session that moves folder bills the new folder from the move", () => {
    const home = tempDir();
    mapping(home, [ACME, { folder: "/work/beta", client_id: 2, client: "Beta" }]);
    put(codexFile(home, "c1"), codexLines("c1", "/work/acme", [[0, "user_message"], [60, "user_message"]], { source: "cli", moveTo: [30, "/work/beta"] }));
    expect(run(home).entries.map((e) => [e.client, e.minutes])).toEqual([["Acme", 10], ["Beta", 10]]);
  });

  test("days are cut at midnight in the mapping's time zone", () => {
    const home = tempDir();
    mapping(home, [ACME], "America/New_York");
    // 2026-10-05 03:55 UTC is 23:55 on Oct 4 in New York.
    put(claudeFile(home, "-work-acme", "s1"), claudeLines("s1", "/work/acme", [[235, "typed"]]));
    const r = run(home, { from: "2026-10-04", to: "2026-10-05" });
    expect(r.entries.map((e) => [e.date, e.minutes])).toEqual([["2026-10-04", 5], ["2026-10-05", 5]]);
    expect(r.period.timezone).toBe("America/New_York");
  });
});
