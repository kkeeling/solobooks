import { Database } from "bun:sqlite";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { hasBooks, isOtherDatabase } from "./core/db.ts";
import { join } from "node:path";
import { knownAgents, mcpCommand, readEntry } from "./agents.ts";
import { absolute, booksDir, booksFile, type Env, homeDir, readConfig } from "./config.ts";
import { backupFolder, flag, onlyFlags, syncedWarning } from "./durability.ts";
import { OPS } from "./core/perform.ts";
import { Refusal } from "./core/refusal.ts";
import { MIGRATIONS } from "./db/migrations.ts";
import { skillDirs } from "./setup.ts";
import { SKILL_FILES, SKILL_NAME } from "./skill.ts";
import { VERSION } from "./version.ts";

// `solobooks doctor`: proves the install works. It opens the books, and for every agent it finds, checks the MCP entry
// is there and really answers an MCP handshake, and that the agent guide is in place. Any failure says how to fix it.

type Check = { check: string; ok: boolean; detail: string; fix?: string };

const SETUP = "Run solobooks setup.";

/** The fix for settings solobooks refuses: damaged ones setup can write again once told the folder; unreadable ones it can't. */
const settingsFix = (field: unknown) =>
  field === "settings" ? "Check that you can open the settings file, then run solobooks doctor again." : "Run solobooks setup --books <folder>, naming the folder that holds your books.";

/** Damaged settings stop every command, even with the folder named by --books or SOLOBOOKS_DIR, which skip reading them for the folder. */
function checkSettings(env: Env): Check | null {
  try {
    readConfig(env);
    return null;
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    return { check: "settings", ok: false, detail: e.reason, fix: settingsFix(e.field) };
  }
}

function checkBooks(argv: string[], env: Env): Check {
  let dir: string;
  try {
    dir = booksDir(flag(argv, "books"), env);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    return { check: "books", ok: false, detail: e.reason, fix: e.field === "config" || e.field === "settings" ? settingsFix(e.field) : SETUP };
  }
  const file = booksFile(dir);
  if (!hasBooks(file)) {
    return { check: "books", ok: false, detail: `There are no books in "${dir}".`, fix: `If they moved or their drive is unplugged, put them back. To start new books there, run solobooks setup --books "${dir}".` };
  }
  try {
    const db = new Database(file, { readonly: true });
    try {
      const ok = (db.query("PRAGMA quick_check").get() as { quick_check: string }).quick_check;
      const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
      if (ok !== "ok") return { check: "books", ok: false, detail: `The books file ${file} is damaged: ${ok}.`, fix: "Restore the latest backup of the books folder." };
      if (user_version > MIGRATIONS.length) {
        return { check: "books", ok: false, detail: `The books in ${dir} were written by a newer solobooks.`, fix: "Install the latest solobooks." };
      }
      if (isOtherDatabase(db)) {
        return { check: "books", ok: false, detail: `The file ${file} is a database from something other than solobooks.`, fix: "Move that file out of the way, or run solobooks setup --books <folder>, naming the folder that holds your books." };
      }
      return { check: "books", ok: true, detail: file };
    } finally {
      db.close();
    }
  } catch (e) {
    return { check: "books", ok: false, detail: `The books file ${file} can't be opened: ${e instanceof Error ? e.message : e}.`, fix: "Check the file is readable, or restore a backup." };
  }
}

/**
 * Starts the MCP server the way an agent would and asks for its tools. Returns the tool names or what went wrong. A
 * server that answers but can't reach the books or settings says why in `refused`, for doctor to weigh.
 */
export async function handshake(command: string[], env: Env, timeoutMs = 20_000): Promise<{ tools: string[]; refused?: string; field?: string } | { error: string }> {
  // A registered command may be a bare name found through PATH, such as npx.
  if (!command[0] || !(existsSync(command[0]) || Bun.which(command[0], { PATH: env.PATH ?? "" }))) return { error: `${command[0] ?? "(no command)"} doesn't exist` };
  let proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
  try {
    proc = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: env as Record<string, string> });
  } catch (e) {
    return { error: `it couldn't start: ${e instanceof Error ? e.message : e}` };
  }
  const send = (m: unknown) => {
    proc.stdin.write(JSON.stringify(m) + "\n");
    proc.stdin.flush();
  };
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const next = async (id: number): Promise<any> => {
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.id === id) return m;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("it exited before answering");
      buf += dec.decode(value, { stream: true });
    }
  };
  const talk = async () => {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "solobooks-doctor", version: VERSION } } });
    const init = await next(1);
    if (init.error || init.result?.serverInfo?.name !== "solobooks") throw new Error("it didn't answer initialize as solobooks");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const list = await next(2);
    if (list.error) throw new Error(`tools/list failed: ${list.error.message}`);
    // One read through the server proves it finds the books on its own, as it will for the agent.
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "gate_list", arguments: {} } });
    const read = await next(3);
    const about = read.result?.structuredContent?.field;
    const why = read.result?.structuredContent?.reason ?? read.error?.message ?? "it refused";
    const found = about === "books" || about === "config" || about === "settings";
    if (read.error || (read.result?.isError && !found)) throw new Error(`it couldn't read the books: ${why}`);
    const tools = (list.result.tools as { name: string }[]).map((t) => t.name);
    return read.result?.isError ? { tools, refused: why as string, field: about as string } : { tools };
  };
  let timer: Timer | undefined;
  try {
    return await Promise.race([
      talk(),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`it didn't answer within ${timeoutMs / 1000} seconds`)), timeoutMs))),
    ]);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
    proc.stdin.end();
    proc.kill();
    await proc.exited;
  }
}

function checkSkill(folder: string): Check {
  const stale = Object.entries(SKILL_FILES).find(([rel, text]) => {
    const f = join(folder, rel);
    return !existsSync(f) || readFileSync(f, "utf8") !== text;
  });
  return stale
    ? { check: "skill", ok: false, detail: `${join(folder, stale[0])} is missing or out of date.`, fix: SETUP }
    : { check: "skill", ok: true, detail: folder };
}

/** The folder a server started with these arguments and this environment would use, or null when it can't tell. */
function serverFolder(args: string[], env: Env): string | null {
  try {
    return booksDir(flag(args, "books"), env);
  } catch {
    return null;
  }
}

/** A folder's real path, so two names for one folder compare equal. */
function real(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

export async function doctor(argv: string[], env: Env) {
  onlyFlags(argv, "books");
  flag(argv, "books"); // an empty value is refused outright, not reported as a failed check
  const books = checkBooks(argv, env);
  const checks: Check[] = [books];
  if (books.ok) {
    const settings = checkSettings(env);
    if (settings) checks.push(settings);
  }
  const agents = knownAgents(env);
  const detected = agents.filter((a) => a.detected);
  if (detected.length === 0) {
    checks.push({ check: "agents", ok: false, detail: "No agent app was found.", fix: "Install Claude Code or Codex, then run solobooks setup." });
  }
  const answers = new Map<string, Awaited<ReturnType<typeof handshake>>>();
  const ask = async (command: string[], serverEnv: Env) => {
    const key = JSON.stringify([command, serverEnv]);
    if (!answers.has(key)) answers.set(key, await handshake(command, serverEnv));
    return answers.get(key)!;
  };
  const want = OPS.map((o) => o.name).sort().join(",");
  const here = (dir: string) => absolute(dir, homeDir(env) ?? "");
  const point = () => `Run solobooks setup --books "${here(booksDir(flag(argv, "books"), env))}", so the server finds these books from the settings.`;
  /**
   * What an agent's server does, started as that agent starts it: with the entry's own env and not this shell's
   * SOLOBOOKS_DIR, which an app started from the Dock doesn't have. A server that can't find the books, or uses other
   * ones, fails only when doctor's own books check passed, as with doctor --books: the agent's server doesn't get that
   * flag. When the books check failed too, that check's one fix covers both.
   */
  const probe = async (command: string[], own?: unknown): Promise<{ problem: string | null; fix?: string }> => {
    const { SOLOBOOKS_DIR: _shell, ...inherited } = env;
    const entryEnv = own && typeof own === "object" ? Object.fromEntries(Object.entries(own).map(([k, v]) => [k, String(v)])) : {};
    const serverEnv: Env = { ...inherited, ...entryEnv };
    const r = await ask(command, serverEnv);
    if ("error" in r) return { problem: r.error };
    if (r.tools.slice().sort().join(",") !== want) return { problem: `it answered with ${r.tools.length} tools, not the ${OPS.length} this solobooks has` };
    if (!books.ok) return { problem: null };
    if (r.refused !== undefined) {
      return { problem: `it can't reach the books on its own: ${r.refused}`, fix: r.field === "settings" ? settingsFix(r.field) : point() };
    }
    const theirs = serverFolder(command.slice(1), serverEnv);
    const ours = here(booksDir(flag(argv, "books"), env));
    if (theirs && real(here(theirs)) !== real(ours)) return { problem: `it uses the books in "${here(theirs)}", not the ones in "${ours}"`, fix: point() };
    return { problem: null };
  };

  for (const a of detected) {
    const check = `${a.name} MCP`;
    if (a.plugin) {
      const { problem, fix } = await probe([join(a.plugin, "plugin", "mcp.sh")]);
      checks.push(
        problem === null
          ? { check, ok: true, detail: `the solobooks plugin's server answered with all ${OPS.length} tools` }
          : { check, ok: false, detail: `The solobooks plugin's server doesn't work: ${problem}.`, fix: fix ?? "Run claude plugin update solobooks@solobooks, and install the solobooks app if it's missing." },
      );
      continue;
    }
    let e: Record<string, unknown> | null;
    try {
      e = readEntry(a);
    } catch (err) {
      if (!(err instanceof Refusal)) throw err;
      checks.push({ check, ok: false, detail: err.reason, fix: `Fix ${a.config}, then run solobooks setup.` });
      continue;
    }
    if (e === null || typeof e.command !== "string") {
      checks.push({ check, ok: false, detail: `${a.config} has no solobooks MCP server.`, fix: SETUP });
      continue;
    }
    const args = Array.isArray(e.args) ? e.args.map(String) : [];
    const { problem, fix } = await probe([e.command, ...args], e.env);
    checks.push(
      problem === null
        ? { check, ok: true, detail: `${a.config}: the server answered with all ${OPS.length} tools` }
        : { check, ok: false, detail: `The solobooks server registered in ${a.config} doesn't work: ${problem}.`, fix: fix ?? SETUP },
    );
  }
  if (detected.length === 0) {
    // Still prove this binary serves MCP, so the person knows the install itself works.
    const { problem, fix } = await probe(mcpCommand());
    checks.push(problem === null ? { check: "MCP server", ok: true, detail: `answered with all ${OPS.length} tools` } : { check: "MCP server", ok: false, detail: problem, fix: fix ?? "Reinstall solobooks." });
  }
  for (const folder of skillDirs(env, agents)) checks.push(checkSkill(join(folder, SKILL_NAME)));

  const ok = checks.every((c) => c.ok);
  const warnings = durabilityWarnings(argv, env);
  return {
    ok,
    version: VERSION,
    checks,
    ...(warnings.length > 0 && { warnings }),
    ...(ok ? {} : { next: "Fix each failed check as its fix says, then run solobooks doctor again." }),
  };
}

/** What doctor warns about without failing: live books in a synced folder, and books with no backup folder. */
function durabilityWarnings(argv: string[], env: Env): string[] {
  let dir: string;
  try {
    dir = booksDir(flag(argv, "books"), env);
  } catch {
    return []; // the books check already says so
  }
  const out: string[] = [];
  const synced = syncedWarning(dir, env);
  if (synced) out.push(synced);
  let folder: string | null;
  try {
    folder = backupFolder(env);
  } catch {
    return out; // the settings are damaged, and the MCP or books check says what to do
  }
  if (!folder) out.push("No backup folder is chosen, so solobooks writes no daily backups; pick one with solobooks backup set --folder <dir>.");
  else if (!existsSync(folder)) out.push(`The backup folder ${folder} isn't there, so today's backup can't be written; plug in its drive or pick another with solobooks backup set --folder <dir>.`);
  return out;
}
