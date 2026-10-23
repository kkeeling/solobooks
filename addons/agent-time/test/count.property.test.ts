import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { join } from "node:path";
import { count } from "../skills/bill-agent-time/scripts/count-time.ts";
import { claudeFile, claudeLines, codexFile, codexLines, mapping, put, tempDir, type ClaudeEvent, type CodexEvent } from "./support/logs.ts";

const FOLDERS = ["/work/acme", "/work/acme/web", "/work/beta", "/home/me/blog", "/tmp/scratch"];
const RULES = [
  { folder: "/work/acme", client_id: 1, client: "Acme" },
  { folder: "/work/acme/web", client_id: 1, engagement_id: 2, client: "Acme" },
  { folder: "/work/beta", client_id: 3, client: "Beta" },
  { folder: "/home/me/blog", client_id: null, client: "not billed" },
];
const CLAUDE_KINDS: ClaudeEvent[] = ["typed", "suggestion", "enqueue", "approve", "answer", "assistant", "tool", "notification", "meta"];
const CODEX_KINDS: CodexEvent[] = ["user_message", "UserMessage", "agent", "command"];

/** Up to six sessions over two days, Claude Code and Codex mixed, often overlapping. */
const sessions = fc.array(
  fc.record({
    claude: fc.boolean(),
    folder: fc.constantFrom(...FOLDERS),
    move: fc.option(fc.record({ at: fc.integer({ min: 0, max: 2880 }), to: fc.constantFrom(...FOLDERS) }), { nil: undefined }),
    events: fc.array(fc.tuple(fc.integer({ min: 0, max: 2880 * 10 }).map((m) => m / 10), fc.nat(99)), { minLength: 1, maxLength: 40 }),
  }),
  { minLength: 1, maxLength: 6 },
);

type Sessions = typeof sessions extends fc.Arbitrary<infer T> ? T : never;

/** Two to eight sessions packed into three hours around midnight UTC, so they overlap hard. */
const crowded: fc.Arbitrary<Sessions> = fc.array(
  fc.record({
    claude: fc.boolean(),
    folder: fc.constantFrom(...FOLDERS),
    move: fc.constant(undefined),
    events: fc.array(fc.tuple(fc.integer({ min: 1340 * 10, max: 1520 * 10 }).map((m) => m / 10), fc.nat(99)), { minLength: 5, maxLength: 60 }),
  }),
  { minLength: 2, maxLength: 8 },
);

/** Writes the sessions' logs under a scratch home; returns each file's path and lines. */
function files(home: string, list: Sessions): [string, string[]][] {
  return list.map((s, i) => {
    const id = `${s.claude ? "s" : "c"}${i}`;
    if (s.claude) {
      const events = s.events.map(([m, k]) => [m, CLAUDE_KINDS[k % CLAUDE_KINDS.length]!] as [number, ClaudeEvent]);
      return [claudeFile(home, s.folder.replaceAll("/", "-"), id), claudeLines(id, s.folder, events)];
    }
    const events = s.events.map(([m, k]) => [m, CODEX_KINDS[k % CODEX_KINDS.length]!] as [number, CodexEvent]);
    return [codexFile(home, id), codexLines(id, s.folder, events, { source: "cli", start: -1, moveTo: s.move ? [s.move.at, s.move.to] : undefined })];
  });
}

/** A small seeded random source, so a failing case replays exactly. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32);
}

const PERIOD = { from: "2026-10-04", to: "2026-10-07" };
const result = (home: string) => {
  const { config, logs, ...rest } = count(PERIOD, { HOME: home });
  return rest;
};

describe("ISC-96", () => {
  test("same logs: shuffled and duplicated lines, files written in another order and archived copies give the same hours", () => {
    fc.assert(
      fc.property(sessions, fc.integer(), fc.constantFrom("UTC", "America/New_York"), (list, seed, tz) => {
        const a = tempDir();
        const b = tempDir();
        mapping(a, RULES, tz);
        mapping(b, RULES, tz);
        const written = files(a, list);
        for (const [file, lines] of written) put(file, lines);

        const r = rng(seed);
        for (const [file, lines] of [...written].reverse()) {
          const mixed = lines.flatMap((l) => (r() < 0.3 ? [l, l] : [l]));
          for (let i = mixed.length - 1; i > 0; i--) {
            const j = Math.floor(r() * (i + 1));
            [mixed[i], mixed[j]] = [mixed[j]!, mixed[i]!];
          }
          const there = file.replace(a, b);
          put(there, mixed);
          // Codex moves old sessions to archived_sessions; a copy left in both places must not count twice.
          if (there.includes("/.codex/sessions/") && r() < 0.5) put(join(b, ".codex", "archived_sessions", there.split("/").pop()!), lines);
        }
        expect(result(b)).toEqual(result(a));
      }),
      { numRuns: 60 },
    );
  }, 60_000); // writes logs to disk for every run: allow for a busy machine

  test("same logs: counting twice gives byte-identical output", () => {
    fc.assert(
      fc.property(sessions, (list) => {
        const home = tempDir();
        mapping(home, RULES);
        for (const [file, lines] of files(home, list)) put(file, lines);
        expect(JSON.stringify(result(home))).toBe(JSON.stringify(result(home)));
      }),
      { numRuns: 20 },
    );
  }, 60_000);
});

describe("ISC-98", () => {
  test("parallel: random parallel sessions across clients never bill more than 60 minutes in any clock hour", () => {
    const HOUR = 3_600_000;
    fc.assert(
      fc.property(fc.oneof(sessions, crowded), fc.constantFrom("UTC", "America/New_York"), (list, tz) => {
        const home = tempDir();
        mapping(home, RULES, tz);
        for (const [file, lines] of files(home, list)) put(file, lines);
        const { entries } = result(home);
        const perHour = new Map<number, number>();
        for (const e of entries) {
          let exact = 0;
          for (const s of e.spans) {
            const start = Date.parse(s.start);
            const end = Date.parse(s.end);
            exact += end - start;
            for (let h = Math.floor(start / HOUR) * HOUR; h < end; h += HOUR) {
              perHour.set(h, (perHour.get(h) ?? 0) + Math.min(end, h + HOUR) - Math.max(start, h));
            }
          }
          expect(exact).toBe(e.ms); // the spans are the whole entry
          expect(Math.abs(e.minutes * 60_000 - e.ms)).toBeLessThanOrEqual(30_000); // rounded once, to the nearest minute
        }
        for (const ms of perHour.values()) expect(ms).toBeLessThanOrEqual(HOUR);
        // Per day too, after rounding: no client-day can hold more than the day.
        const perDay = new Map<string, number>();
        for (const e of entries) perDay.set(e.date, (perDay.get(e.date) ?? 0) + e.minutes);
        for (const m of perDay.values()) expect(m).toBeLessThanOrEqual(25 * 60);
      }),
      { numRuns: 100 },
    );
  }, 60_000); // writes logs to disk for every run: allow for a busy machine

  test("parallel: ten sessions typing every minute for two hours bill from the first message to ten minutes after the last", () => {
    const home = tempDir();
    mapping(home, RULES);
    for (let i = 0; i < 10; i++) {
      const events = Array.from({ length: 120 }, (_, m) => [600 + m + i / 10, "typed"] as [number, ClaudeEvent]);
      const folder = FOLDERS[i % 3]!;
      put(claudeFile(home, folder.replaceAll("/", "-"), `p${i}`), claudeLines(`p${i}`, folder, events));
    }
    const { entries } = result(home);
    expect(entries.reduce((s, e) => s + e.ms, 0)).toBe(7_794_000); // 10:00 to 11:59.9 plus the cap;
  });
});
