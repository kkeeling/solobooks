// Reads Claude Code and Codex session logs into the person's own actions: when they acted, in which session and which
// project folder. Only structure is read (record kinds, flags, timestamps, folders); the words of any message are
// never kept, printed or returned. Nothing here depends on the order of lines or files.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Action } from "./rule.ts";

type Rec = Record<string, any>;
export type Skipped = { agent: string; session: string; why: string };

function readJsonl(file: string): Rec[] {
  const out: Rec[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === "object" && !Array.isArray(r)) out.push(r);
    } catch {
      // a torn or partial line: skip it
    }
  }
  return out;
}

const time = (r: Rec): number | null => {
  const t = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
  return Number.isFinite(t) ? t : null;
};

const sortedDir = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

/** The folder in effect at a moment: the latest known one at or before it, else the earliest known. */
function folderAt(known: [number, string][], at: number): string | null {
  let best: [number, string] | null = null;
  let first: [number, string] | null = null;
  for (const k of known) {
    if (first === null || k[0] < first[0] || (k[0] === first[0] && k[1] < first[1])) first = k;
    if (k[0] <= at && (best === null || k[0] > best[0] || (k[0] === best[0] && k[1] < best[1]))) best = k;
  }
  return (best ?? first)?.[1] ?? null;
}

// ---- Claude Code: ~/.claude/projects/<project>/<session>.jsonl ----

/** Prompts that came from the person, not from a program, the harness or another agent. */
const HUMAN_PROMPT_SOURCES = new Set(["typed", "suggestion_accepted"]);
/** Bracketed text the harness writes for something the person typed: a slash command or a shell escape. */
const PERSON_TAGS = /^<(command-name|command-message|bash-input)>/;

function claudeText(c: unknown): boolean {
  if (typeof c === "string") {
    const t = c.trimStart();
    if (!t) return false;
    return t.startsWith("<") ? PERSON_TAGS.test(t) : true;
  }
  if (!Array.isArray(c)) return false;
  if (c.some((b) => b?.type === "tool_result")) return false;
  return c.some((b) => b?.type === "image" || (b?.type === "text" && typeof b.text === "string" && claudeText(b.text)));
}

/** A message the person sent: typed, a picked suggestion, a slash command, a shell escape or an interrupt. */
function claudeMessage(r: Rec): boolean {
  if (r.type !== "user" || r.isSidechain === true || r.isMeta === true || r.isCompactSummary === true) return false;
  if (r.toolUseResult !== undefined) return false;
  if (r.promptSource !== undefined && !HUMAN_PROMPT_SOURCES.has(r.promptSource)) return false;
  if (r.origin !== undefined && r.origin?.kind !== "human") return false;
  return claudeText(r.message?.content);
}

export function claudeActions(projectsDir: string): { actions: Action[]; skipped: Skipped[] } {
  const actions: Action[] = [];
  const skipped: Skipped[] = [];
  for (const project of sortedDir(projectsDir)) {
    const dir = join(projectsDir, project);
    if (!statSync(dir).isDirectory()) continue;
    // Only top-level session files: subagent logs under <session>/subagents/ are agents, never the person.
    for (const name of sortedDir(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(dir, name);
      if (!statSync(file).isFile()) continue;
      const recs = readJsonl(file);
      const fileSession = basename(name, ".jsonl");
      const entrypoints = new Set(recs.map((r) => r.entrypoint).filter((e) => typeof e === "string"));
      // A session started by a program (claude -p, the Agent SDK) has no person typing in it.
      if (entrypoints.size > 0 && [...entrypoints].every((e) => e.startsWith("sdk"))) {
        skipped.push({ agent: "claude", session: fileSession, why: "started by a program, not typed in" });
        continue;
      }
      const known: [number, string][] = [];
      const at = new Map<string, number>();
      for (const r of recs) {
        const t = time(r);
        if (t === null) continue;
        if (typeof r.cwd === "string" && r.cwd) known.push([t, r.cwd]);
        if (typeof r.uuid === "string") at.set(r.uuid, Math.min(at.get(r.uuid) ?? t, t));
      }
      for (const r of recs) {
        let t = time(r);
        if (t === null || r.isSidechain === true) continue;
        let acted = claudeMessage(r);
        // Typed while the agent was busy: the moment it was queued is when the person acted.
        if (!acted && r.type === "queue-operation" && r.operation === "enqueue") acted = claudeText(r.content);
        // The person answered the agent's question.
        if (!acted && r.type === "user" && r.toolUseResult && typeof r.toolUseResult === "object" && "answers" in r.toolUseResult) acted = true;
        // The person approved or refused a tool. The approval came after the agent asked, so the asking moment is
        // used: it may be early, never late.
        if (!acted && r.type === "user" && typeof r.permissionDecision?.source === "string" && r.permissionDecision.source.startsWith("user")) {
          const asked = typeof r.sourceToolAssistantUUID === "string" ? at.get(r.sourceToolAssistantUUID) : undefined;
          if (asked !== undefined) {
            t = Math.min(t, asked);
            acted = true;
          }
        }
        if (!acted) continue;
        const folder = (typeof r.cwd === "string" && r.cwd) || folderAt(known, t);
        if (!folder) continue;
        const session = typeof r.sessionId === "string" && r.sessionId ? r.sessionId : fileSession;
        actions.push({ at: t, agent: "claude", session, folder });
      }
    }
  }
  return { actions, skipped };
}

// ---- Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl and ~/.codex/archived_sessions/ ----

function jsonlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of sortedDir(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...jsonlFiles(p));
    else if (s.isFile() && name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** Surfaces where a person types: the Codex CLI and the IDE or desktop app. `exec`, `mcp` and subagents are programs. */
const CODEX_PEOPLE = new Set(["cli", "vscode"]);

function codexMessage(r: Rec): boolean {
  if (r.type !== "event_msg") return false;
  const p = r.payload;
  return p?.type === "user_message" || (p?.type === "item_completed" && p.item?.type === "UserMessage");
}

export function codexActions(codexHome: string): { actions: Action[]; skipped: Skipped[] } {
  const actions: Action[] = [];
  const skipped: Skipped[] = [];
  const files = [...jsonlFiles(join(codexHome, "sessions")), ...jsonlFiles(join(codexHome, "archived_sessions"))];
  for (const file of files) {
    const recs = readJsonl(file);
    // A forked session can carry its parent's header too; its own is the one whose id is in the file name.
    const metas = recs
      .filter((r) => r.type === "session_meta" && r.payload && typeof r.payload === "object")
      .sort((a, b) => (time(a) ?? 0) - (time(b) ?? 0) || (String(a.payload.id) < String(b.payload.id) ? -1 : 1));
    const meta = (metas.find((m) => typeof m.payload.id === "string" && basename(file).includes(m.payload.id)) ?? metas[0])?.payload;
    const session = typeof meta?.id === "string" ? meta.id : basename(file, ".jsonl");
    const source = meta?.source;
    if (source !== undefined && !(typeof source === "string" && CODEX_PEOPLE.has(source))) {
      skipped.push({ agent: "codex", session, why: "started by a program or another agent" });
      continue;
    }
    if (meta?.thread_source !== undefined && meta.thread_source !== "user") {
      skipped.push({ agent: "codex", session, why: "started by an automation or a reviewer, not the person" });
      continue;
    }
    const known: [number, string][] = [];
    for (const r of recs) {
      const t = time(r);
      const cwd = (r.type === "session_meta" && r.payload === meta) || r.type === "turn_context" ? r.payload?.cwd : undefined;
      if (t !== null && typeof cwd === "string" && cwd) known.push([t, cwd]);
    }
    for (const r of recs) {
      const t = time(r);
      if (t === null || !codexMessage(r)) continue;
      const folder = folderAt(known, t) ?? (typeof meta?.cwd === "string" ? meta.cwd : null);
      if (!folder) continue;
      actions.push({ at: t, agent: "codex", session, folder });
    }
  }
  return { actions, skipped };
}
