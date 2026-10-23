import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { knownAgents, mcpCommand, readEntry } from "./agents.ts";
import { booksDir, booksFile, type Env } from "./config.ts";
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

function checkBooks(argv: string[], env: Env): Check {
  const i = argv.indexOf("--books");
  let dir: string;
  try {
    dir = booksDir(i === -1 ? undefined : argv[i + 1], env);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    return { check: "books", ok: false, detail: e.reason, fix: SETUP };
  }
  const file = booksFile(dir);
  if (!existsSync(file)) return { check: "books", ok: false, detail: `There are no books in ${dir} yet.`, fix: SETUP };
  try {
    const db = new Database(file, { readonly: true });
    try {
      const ok = (db.query("PRAGMA quick_check").get() as { quick_check: string }).quick_check;
      const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
      if (ok !== "ok") return { check: "books", ok: false, detail: `The books file ${file} is damaged: ${ok}.`, fix: "Restore the latest backup of the books folder." };
      if (user_version > MIGRATIONS.length) {
        return { check: "books", ok: false, detail: `The books in ${dir} were written by a newer solobooks.`, fix: "Install the latest solobooks." };
      }
      return { check: "books", ok: true, detail: file };
    } finally {
      db.close();
    }
  } catch (e) {
    return { check: "books", ok: false, detail: `The books file ${file} can't be opened: ${e instanceof Error ? e.message : e}.`, fix: "Check the file is readable, or restore a backup." };
  }
}

/** Starts the MCP server the way an agent would and asks for its tools. Returns the tool names or what went wrong. */
export async function handshake(command: string[], env: Env, timeoutMs = 20_000): Promise<{ tools: string[] } | { error: string }> {
  if (!command[0] || !existsSync(command[0])) return { error: `${command[0] ?? "(no command)"} doesn't exist` };
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
    if (read.error || read.result?.isError) {
      const why = read.result?.structuredContent?.reason ?? read.error?.message ?? "it refused";
      throw new Error(`it couldn't read the books: ${why}`);
    }
    return (list.result.tools as { name: string }[]).map((t) => t.name);
  };
  let timer: Timer | undefined;
  try {
    const tools = await Promise.race([
      talk(),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`it didn't answer within ${timeoutMs / 1000} seconds`)), timeoutMs))),
    ]);
    return { tools };
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

export async function doctor(argv: string[], env: Env) {
  const checks: Check[] = [checkBooks(argv, env)];
  const agents = knownAgents(env);
  const detected = agents.filter((a) => a.detected);
  if (detected.length === 0) {
    checks.push({ check: "agents", ok: false, detail: "No agent app was found.", fix: "Install Claude Code or Codex, then run solobooks setup." });
  }
  const answers = new Map<string, Awaited<ReturnType<typeof handshake>>>();
  const ask = async (command: string[]) => {
    const key = JSON.stringify(command);
    if (!answers.has(key)) answers.set(key, await handshake(command, env));
    return answers.get(key)!;
  };
  const want = OPS.map((o) => o.name).sort().join(",");
  const answered = (r: Awaited<ReturnType<typeof handshake>>) =>
    "error" in r ? r.error : r.tools.slice().sort().join(",") === want ? null : `it answered with ${r.tools.length} tools, not the ${OPS.length} this solobooks has`;

  for (const a of detected) {
    const check = `${a.name} MCP`;
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
    const problem = answered(await ask([e.command, ...args]));
    checks.push(
      problem === null
        ? { check, ok: true, detail: `${a.config}: the server answered with all ${OPS.length} tools` }
        : { check, ok: false, detail: `The solobooks server registered in ${a.config} doesn't work: ${problem}.`, fix: SETUP },
    );
  }
  if (detected.length === 0) {
    // Still prove this binary serves MCP, so the person knows the install itself works.
    const problem = answered(await ask(mcpCommand()));
    checks.push(problem === null ? { check: "MCP server", ok: true, detail: `answered with all ${OPS.length} tools` } : { check: "MCP server", ok: false, detail: problem, fix: "Reinstall solobooks." });
  }
  for (const folder of skillDirs(env, agents)) checks.push(checkSkill(join(folder, SKILL_NAME)));

  const ok = checks.every((c) => c.ok);
  return { ok, version: VERSION, checks, ...(ok ? {} : { next: "Fix each failed check as its fix says, then run solobooks doctor again." }) };
}
