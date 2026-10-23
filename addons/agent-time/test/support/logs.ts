// Synthetic session logs shaped like Claude Code's and Codex's, with made-up text. Never real logs.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const tempDir = () => mkdtempSync(join(tmpdir(), "agent-time-test-"));

/** Minutes after 2026-10-05 00:00 UTC, as an ISO timestamp. */
export const at = (min: number, base = Date.UTC(2026, 9, 5)) => new Date(base + Math.round(min * 60_000)).toISOString();

export type ClaudeEvent =
  | "typed" // the person typed a message
  | "suggestion" // the person accepted a suggested prompt
  | "slash" // the person ran a slash command
  | "enqueue" // the person typed while the agent was busy
  | "approve" // the person approved a tool the agent asked for at this minute
  | "answer" // the person answered the agent's question
  | "assistant" // the agent replied
  | "tool" // a tool ran and returned, approved by the person's settings
  | "notification" // a background task reported back
  | "meta" // the harness added context
  | "sdk"; // a program sent the prompt

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

/** One Claude Code session's lines. */
export function claudeLines(session: string, cwd: string, events: [number, ClaudeEvent][], entrypoint = "cli"): string[] {
  const base = { sessionId: session, cwd, entrypoint, userType: "external", isSidechain: false, version: "2.1.300", gitBranch: "main" };
  const lines: object[] = [];
  for (const [min, kind] of events) {
    const timestamp = at(min);
    const user = (extra: object) => ({ ...base, type: "user", uuid: uuid(), timestamp, ...extra });
    if (kind === "typed") lines.push(user({ promptSource: "typed", origin: { kind: "human" }, message: { role: "user", content: "please fix the thing" } }));
    if (kind === "suggestion") lines.push(user({ promptSource: "suggestion_accepted", origin: { kind: "human" }, message: { role: "user", content: "run the tests" } }));
    if (kind === "slash") lines.push(user({ message: { role: "user", content: "<command-name>/review</command-name>" } }));
    if (kind === "enqueue") lines.push({ type: "queue-operation", operation: "enqueue", sessionId: session, timestamp, content: "also check the docs" });
    if (kind === "notification") {
      lines.push({ type: "queue-operation", operation: "enqueue", sessionId: session, timestamp, content: "<task-notification>done</task-notification>" });
      lines.push(user({ promptSource: "system", origin: { kind: "task-notification" }, message: { role: "user", content: "<task-notification>done</task-notification>" } }));
    }
    if (kind === "meta") lines.push(user({ isMeta: true, message: { role: "user", content: [{ type: "text", text: "context" }] } }));
    if (kind === "sdk") lines.push(user({ promptSource: "sdk", message: { role: "user", content: "do the job" } }));
    if (kind === "assistant") lines.push({ ...base, type: "assistant", uuid: uuid(), timestamp, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
    if (kind === "tool" || kind === "approve" || kind === "answer") {
      const ask = uuid();
      lines.push({ ...base, type: "assistant", uuid: ask, timestamp, message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } });
      // The result lands a few minutes later: the tool ran (or waited for the person) in between.
      const result = {
        sourceToolAssistantUUID: ask,
        timestamp: at(min + 3),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "out" }] },
        toolUseResult: kind === "answer" ? { questions: [], answers: {}, annotations: {} } : { stdout: "out" },
        permissionDecision: kind === "approve" ? { decision: "accept", source: "user_temporary", grantScope: "once" } : { decision: "accept", source: "config", reasonType: "rule" },
      };
      lines.push(user(result));
    }
  }
  return lines.map((l) => JSON.stringify(l));
}

export type CodexEvent = "user_message" | "UserMessage" | "agent" | "command";

/** One Codex session's lines. A later `cwd` change arrives as a turn_context. */
export function codexLines(
  id: string,
  cwd: string,
  events: [number, CodexEvent][],
  meta: { source?: unknown; thread_source?: string; start?: number; moveTo?: [number, string] } = { source: "cli" },
): string[] {
  const start = meta.start ?? (events[0]?.[0] ?? 0) - 1;
  const lines: object[] = [
    { type: "session_meta", timestamp: at(start), payload: { id, cwd, source: meta.source, thread_source: meta.thread_source, originator: "codex_cli_rs", cli_version: "0.150.0", timestamp: at(start) } },
    { type: "turn_context", timestamp: at(start), payload: { cwd, model: "m" } },
  ];
  if (meta.moveTo) lines.push({ type: "turn_context", timestamp: at(meta.moveTo[0]), payload: { cwd: meta.moveTo[1], model: "m" } });
  for (const [min, kind] of events) {
    const timestamp = at(min);
    if (kind === "user_message") lines.push({ type: "event_msg", timestamp, payload: { type: "user_message", message: "make it faster" } });
    if (kind === "UserMessage") lines.push({ type: "event_msg", timestamp, payload: { type: "item_completed", item: { type: "UserMessage", id: "u", content: [{ type: "text", text: "hi" }] } } });
    if (kind === "agent") lines.push({ type: "event_msg", timestamp, payload: { type: "item_completed", item: { type: "AgentMessage", id: "a", content: [] } } });
    if (kind === "command") lines.push({ type: "response_item", timestamp, payload: { type: "function_call", name: "shell", arguments: "{}" } });
  }
  return lines.map((l) => JSON.stringify(l));
}

/** Where a session's lines go under a scratch home. */
export function claudeFile(home: string, project: string, session: string) {
  return join(home, ".claude", "projects", project, `${session}.jsonl`);
}
export function codexFile(home: string, id: string, day = "2026/10/05") {
  return join(home, ".codex", "sessions", day, `rollout-2026-10-05T00-00-00-${id}.jsonl`);
}

export function put(file: string, lines: string[]) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, lines.join("\n") + "\n");
}

/** A mapping file for the counter. */
export function mapping(home: string, folders: object[], timezone = "UTC"): string {
  const file = join(home, ".config", "solobooks", "agent-time.json");
  put(file, [JSON.stringify({ timezone, folders }, null, 2)]);
  return file;
}
