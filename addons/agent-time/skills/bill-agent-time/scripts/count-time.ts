// The agent-time counter. Run it through solobooks, which carries its own runtime:
//
//   solobooks addon run <this file> preview --from 2026-10-01 --to 2026-10-31
//   solobooks addon run <this file> map --folder ~/work/acme --client-id 3 [--engagement-id 5] | --not-billed
//   solobooks addon run <this file> write --from 2026-10-01 --to 2026-10-31 [--dry-run]
//
// It reads Claude Code and Codex session logs on this machine, applies the billing rule (references/billing-rule.md)
// and writes one time entry per client per day through `solobooks time add`. It opens no network connection and never
// prints what anyone wrote in a session.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { claudeActions, codexActions, type Skipped } from "./logs.ts";
import { Days, entries, type FolderRule } from "./rule.ts";

type Env = Record<string, string | undefined>;
type Solobooks = (argv: string[]) => Promise<{ code: number; stdout: string }>;
type Config = { timezone?: string; folders: FolderRule[] };

class Stop extends Error {
  constructor(
    readonly reason: string,
    readonly field: string,
  ) {
    super(reason);
  }
}

function parse(argv: string[]) {
  const [command, ...rest] = argv;
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) throw new Stop(`Unexpected argument ${JSON.stringify(a)}; flags start with --.`, "argv");
    const name = a.slice(2);
    if (name === "dry-run" || name === "not-billed") flags[name] = true;
    else {
      const v = rest[++i];
      if (v === undefined) throw new Stop(`--${name} needs a value after it.`, name);
      flags[name] = v;
    }
  }
  return { command, flags };
}

const str = (flags: Record<string, string | true>, k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);

const home = (env: Env) => env.HOME || env.USERPROFILE || "";
const expand = (p: string, env: Env) => resolve(p === "~" ? home(env) : p.startsWith("~/") ? join(home(env), p.slice(2)) : p);

/** The mapping file: next to solobooks' own settings, so the person finds it in one place. */
export function configPath(env: Env, flag?: string): string {
  if (flag) return expand(flag, env);
  const base = env.XDG_CONFIG_HOME || join(home(env), ".config");
  return join(base, "solobooks", "agent-time.json");
}

function readConfig(file: string): Config {
  if (!existsSync(file)) return { folders: [] };
  let c: any;
  try {
    c = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Stop(`${file} isn't valid JSON; fix it or remove it and map the folders again.`, "config");
  }
  if (!c || typeof c !== "object" || !Array.isArray(c.folders)) throw new Stop(`${file} must hold {"folders": [...]}.`, "config");
  for (const f of c.folders) {
    if (typeof f?.folder !== "string" || !(f.client_id === null || Number.isInteger(f.client_id))) {
      throw new Stop(`Every folder in ${file} needs "folder" and a whole-number "client_id" (or null for not billed).`, "config");
    }
  }
  return c as Config;
}

function writeConfig(file: string, c: Config) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n");
  renameSync(tmp, file);
}

function timezone(c: Config): Days {
  const tz = c.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    return new Days(tz);
  } catch {
    throw new Stop(`${JSON.stringify(tz)} isn't a time zone; use a name such as America/New_York.`, "timezone");
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
function period(flags: Record<string, string | true>) {
  const from = str(flags, "from");
  const to = str(flags, "to");
  if (!from || !DAY.test(from)) throw new Stop("Give the first day with --from YYYY-MM-DD.", "from");
  if (!to || !DAY.test(to)) throw new Stop("Give the last day with --to YYYY-MM-DD.", "to");
  if (to < from) throw new Stop("--to comes before --from.", "to");
  return { from, to };
}

/** Everything the counter found for a period. Same logs and folders in, same result out. */
export function count(flags: Record<string, string | true>, env: Env) {
  const { from, to } = period(flags);
  const file = configPath(env, str(flags, "config"));
  const config = readConfig(file);
  const days = timezone(config);
  const claudeDir = expand(str(flags, "claude-dir") ?? join(env.CLAUDE_CONFIG_DIR || join(home(env), ".claude"), "projects"), env);
  const codexHome = expand(str(flags, "codex-home") ?? (env.CODEX_HOME || join(home(env), ".codex")), env);
  const claude = claudeActions(claudeDir);
  const codex = codexActions(codexHome);
  const { entries: list, unbilled } = entries([...claude.actions, ...codex.actions], config.folders, days, from, to);
  const seen = new Set<string>();
  const skipped: Skipped[] = [];
  for (const s of [...claude.skipped, ...codex.skipped].sort((a, b) => (a.agent + a.session < b.agent + b.session ? -1 : 1))) {
    if (!seen.has(s.agent + s.session)) skipped.push(s);
    seen.add(s.agent + s.session);
  }
  const perDay = new Map<string, { date: string; client_id: number; client: string | null; hours: number; minutes: number }>();
  for (const e of list) {
    const k = `${e.date}\0${e.client_id}`;
    const d = perDay.get(k) ?? { date: e.date, client_id: e.client_id, client: e.client, hours: 0, minutes: 0 };
    d.minutes += e.minutes;
    d.hours = Math.round((d.minutes / 60) * 100) / 100;
    perDay.set(k, d);
  }
  return {
    period: { from, to, timezone: days.timezone },
    rule: "Billable from each of your own messages, approvals and answers until 10 minutes after your last one; parallel sessions merge, so no hour bills more than 60 minutes. See references/billing-rule.md.",
    config: file,
    logs: { claude: claudeDir, codex: codexHome },
    total_hours: Math.round((list.reduce((s, e) => s + e.minutes, 0) / 60) * 100) / 100,
    per_client_day: [...perDay.values()],
    entries: list,
    unbilled,
    skipped_sessions: skipped,
  };
}

/** Today in the person's time zone, from SOLOBOOKS_NOW when it pins the clock. */
function today(days: Days, env: Env): string {
  const now = env.SOLOBOOKS_NOW ? Date.parse(env.SOLOBOOKS_NOW) : Date.now();
  return days.date(now);
}

async function map(flags: Record<string, string | true>, env: Env, solobooks: Solobooks) {
  const folderFlag = str(flags, "folder");
  if (!folderFlag) throw new Stop("Name the project folder with --folder <dir>.", "folder");
  const folder = expand(folderFlag, env).replace(/\/+$/, "") || "/";
  const file = configPath(env, str(flags, "config"));
  const config = readConfig(file);
  let rule: FolderRule;
  if (flags["not-billed"] === true) {
    rule = { folder, client_id: null, client: "not billed" };
  } else {
    const raw = str(flags, "client-id");
    const id = Number(raw);
    if (!raw || !Number.isInteger(id) || id < 1) throw new Stop("Give the client with --client-id <id>, or --not-billed.", "client-id");
    const books = str(flags, "books");
    const r = await solobooks(["client", "list", ...(books ? ["--books", books] : [])]);
    if (r.code !== 0) throw new Stop(`solobooks couldn't list clients: ${r.stdout}`, "books");
    const client = (JSON.parse(r.stdout).clients as { id: number; name: string }[]).find((c) => c.id === id);
    if (!client) throw new Stop(`solobooks has no client with id ${id}; run solobooks client list.`, "client-id");
    const eng = str(flags, "engagement-id");
    const engagement_id = eng === undefined ? null : Number(eng);
    if (engagement_id !== null && (!Number.isInteger(engagement_id) || engagement_id < 1)) throw new Stop("--engagement-id must be a whole number.", "engagement-id");
    rule = { folder, client_id: id, client: client.name, ...(engagement_id !== null ? { engagement_id } : {}) };
  }
  const folders = [...config.folders.filter((f) => f.folder !== folder), rule].sort((a, b) => (a.folder < b.folder ? -1 : 1));
  const next: Config = { timezone: str(flags, "timezone") ?? config.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, folders };
  timezone(next);
  writeConfig(file, next);
  return { config: file, mapped: rule, timezone: next.timezone };
}

async function write(flags: Record<string, string | true>, env: Env, solobooks: Solobooks) {
  const plan = count(flags, env);
  const days = timezone(readConfig(configPath(env, str(flags, "config"))));
  if (plan.period.to >= today(days, env)) {
    throw new Stop("Only finished days can be billed, so end --to before today; a day still in progress would change after it was written.", "to");
  }
  const books = str(flags, "books");
  const base = books ? ["--books", books] : [];
  const dry = flags["dry-run"] === true ? ["--dry-run"] : [];
  const before = new Set<number>();
  const listed = await solobooks(["time", "list", ...base]);
  if (listed.code !== 0) throw new Stop(`solobooks couldn't list time: ${listed.stdout}`, "books");
  for (const t of JSON.parse(listed.stdout).time_entries as { id: number }[]) before.add(t.id);

  const results = [];
  for (const e of plan.entries) {
    const argv = ["time", "add", "--client-id", String(e.client_id), "--date", e.date, "--minutes", String(e.minutes), "--note", e.note];
    if (e.engagement_id !== null) argv.push("--engagement-id", String(e.engagement_id));
    argv.push("--source", e.source, "--idempotency-key", e.idempotency_key, ...base, ...dry);
    const r = await solobooks(argv);
    const out = JSON.parse(r.stdout);
    const row = { date: e.date, client_id: e.client_id, minutes: e.minutes, idempotency_key: e.idempotency_key };
    if (r.code !== 0) {
      const changed = /idempotency_key/.test(out.field ?? "");
      results.push({
        ...row,
        status: changed ? "conflict" : "refused",
        reason: changed
          ? "This day was already written with different hours (its logs or folder mapping changed since), so nothing was added; compare it with solobooks time list and edit that entry if the new hours are right."
          : (out.reason ?? out.error),
      });
      continue;
    }
    const entry = out.dry_run ? out.result.time_entry : out.time_entry;
    results.push({ ...row, status: out.dry_run ? "would add" : before.has(entry.id) ? "already written" : "added", time_entry_id: entry.id });
  }
  return { period: plan.period, dry_run: dry.length > 0, written: results, unbilled: plan.unbilled };
}

export async function main(argv: string[], solobooks: Solobooks, env: Env): Promise<{ code: number; out: unknown }> {
  try {
    const { command, flags } = parse(argv);
    if (command === "preview") return { code: 0, out: count(flags, env) };
    if (command === "map") return { code: 0, out: await map(flags, env, solobooks) };
    if (command === "write") return { code: 0, out: await write(flags, env, solobooks) };
    throw new Stop("Say preview, map or write; see the bill-agent-time skill.", "command");
  } catch (e) {
    if (e instanceof Stop) return { code: 2, out: { reason: e.reason, field: e.field } };
    return { code: 1, out: { error: e instanceof Error ? e.message : String(e) } };
  }
}

/** What `solobooks addon run` calls. */
export default async function (argv: string[], solobooks: Solobooks, env: Env = process.env): Promise<number> {
  const r = await main(argv, solobooks, env);
  process.stdout.write(JSON.stringify(r.out, null, 2) + "\n");
  return r.code;
}
