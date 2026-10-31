#!/usr/bin/env bun
// Drives one throwaway solobooks: a scratch home, scratch books and its own approval page, so nothing reaches the
// person's real books or agent configs. Every command it runs gets a bare environment built here, and every drive
// leaves a transcript under .verify/evidence/<run>/, which outlives `down`. See SKILL.md.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const EVIDENCE = join(ROOT, ".verify", "evidence");
const BROWSER_CONTEXT = "interceptor-test";
/** The same clock the test suite pins, so figures and overdue days come out the same on every run. */
const DEFAULT_NOW = "2026-10-22T12:00:00.000Z";
const SEEDS = ["empty", "billing", "full"] as const;
const SOURCE = "agent:verify";

type Run = {
  id: string;
  url: string;
  port: number;
  pid: number;
  scratch: string;
  home: string;
  books: string;
  evidence: string;
  seed: string;
  now: string;
  delayMs: number;
  commit: string;
  srcHash: string;
  realBooksHash: string | null;
  stoppedAt?: string;
};

const die = (message: string, code = 2): never => {
  console.error(`verify-solobooks: ${message}`);
  process.exit(code);
};

const sha = (data: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");

function srcHash(): string {
  const dir = join(ROOT, "src");
  const files = (readdirSync(dir, { recursive: true }) as string[]).sort();
  const h = new Bun.CryptoHasher("sha256");
  for (const f of files) {
    const p = join(dir, f);
    if (statSync(p).isFile()) h.update(f).update(readFileSync(p));
  }
  return h.digest("hex");
}

/** A fingerprint of the person's real books file, to show a run left it alone. Nothing from inside it is kept. */
function realBooksHash(): string | null {
  const home = process.env.HOME;
  if (!home) return null;
  const settings = join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "solobooks", "config.json");
  let dir = join(home, "solobooks");
  try {
    dir = JSON.parse(readFileSync(settings, "utf8")).books ?? dir;
  } catch {
    // no settings here: the default folder is the one to watch
  }
  const file = join(dir, "solobooks.sqlite");
  return existsSync(file) ? sha(readFileSync(file)) : null;
}

/** The only environment solobooks sees: nothing of the person's, so CLAUDE_CONFIG_DIR, CODEX_HOME and the rest can't leak in. */
function scratchEnv(r: Pick<Run, "home" | "books" | "port" | "now" | "delayMs">): Record<string, string> {
  return {
    PATH: process.env.PATH!,
    HOME: r.home,
    XDG_CONFIG_HOME: join(r.home, ".config"),
    TMPDIR: join(r.home, "tmp"),
    SOLOBOOKS_DIR: r.books,
    SOLOBOOKS_PORT: String(r.port),
    SOLOBOOKS_NOW: r.now,
    ...(r.delayMs > 0 && { SOLOBOOKS_PAGE_DELAY_MS: String(r.delayMs) }),
  };
}

const solobooks = (args: string[]) => [process.execPath, "src/cli.ts", ...args];

/** Runs to the end with output going to files: `solobooks` cuts anything past 64 KB when its stdout is a pipe. */
function capture(argv: string[], env: Record<string, string> | undefined, cwd: string) {
  const dir = mkdtempSync(join(tmpdir(), "verify-solobooks-out-"));
  const [o, e] = [join(dir, "out"), join(dir, "err")];
  const [ofd, efd] = [openSync(o, "w"), openSync(e, "w")];
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd, env, stdio: ["ignore", ofd, efd] });
  closeSync(ofd);
  closeSync(efd);
  const out = { code: r.status ?? 1, stdout: readFileSync(o, "utf8"), stderr: readFileSync(e, "utf8") };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

function nextFile(r: Run, label: string, ext: string): string {
  const n = readdirSync(r.evidence).filter((f) => /^\d{3}-/.test(f)).length + 1;
  return join(r.evidence, `${String(n).padStart(3, "0")}-${label.replace(/[^\w.-]+/g, "_")}.${ext}`);
}

function record(r: Run, label: string, kind: string, shown: string, res: { code: number; stdout: string; stderr: string }) {
  writeFileSync(nextFile(r, label, `${kind}.txt`), `$ ${shown}\n--- stdout\n${res.stdout}\n--- stderr\n${res.stderr}\n--- exit ${res.code}\n`);
}

const save = (r: Run) => writeFileSync(join(r.evidence, "run.json"), JSON.stringify(r, null, 2) + "\n");

function runs(): Run[] {
  if (!existsSync(EVIDENCE)) return [];
  return readdirSync(EVIDENCE)
    .map((d) => join(EVIDENCE, d, "run.json"))
    .filter(existsSync)
    .map((f) => JSON.parse(readFileSync(f, "utf8")) as Run);
}

/** The run to drive: the one named, or the only live one. Several live and none named is refused, never guessed. */
function findRun(id: string | undefined): Run {
  const all = runs();
  if (id) return all.find((r) => r.id === id) ?? die(`there is no run ${id}.`);
  const live = all.filter((r) => !r.stoppedAt);
  if (live.length === 1) return live[0]!;
  if (live.length === 0) return die("no run is up. Start one with: control.ts up");
  return die(`${live.length} runs are up (${live.map((r) => r.id).join(", ")}), so name one with --run <id>.`);
}

/** The process holding the page, only if it really is this run's server. Never matches by name alone. */
function isOurServer(r: Run): boolean {
  const ps = capture(["ps", "-o", "command=", "-p", String(r.pid)], undefined, ROOT);
  return ps.code === 0 && ps.stdout.includes("src/cli.ts serve") && ps.stdout.includes(r.books);
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
}

async function pageData(r: Run): Promise<any> {
  const res = await fetch(`${r.url}data`, { signal: AbortSignal.timeout(5000 + r.delayMs) });
  return res.json();
}

// ---------------------------------------------------------------- seeds

function seed(r: Run, name: string) {
  const env = scratchEnv(r);
  const log: string[] = [];
  const step = (argv: string[]) => {
    const res = capture(argv, env, ROOT);
    log.push(`$ ${argv.slice(1).join(" ")}\n${res.stdout}${res.stderr}`);
    if (res.code !== 0) die(`seed ${name} failed, so run down. It stopped at: ${argv.slice(1).join(" ")}\n${res.stdout}${res.stderr}`, 1);
  };
  const cli = (...args: string[]) => step(solobooks([...args, "--source", SOURCE]));
  if (name === "billing") {
    // Everything up to the two things only the person can do: approve the payment instructions (pending 1), and later
    // the invoice the journey asks to issue. All names and numbers are made up.
    cli("profile", "set", "--legal-name", "Jane Doe Consulting LLC", "--address", "1 Main St, Springfield, IL 62701", "--ein", "12-3456789", "--email", "jane@example.com", "--next-invoice-number", "1001");
    cli("profile", "payment", "instructions", "set", "--payment-instructions", "ACH to First Bank, routing 011000015, account 1234567");
    cli("client", "add", "--name", "Acme Robotics", "--email", "ap@acme.example", "--address", "500 Market St, San Francisco, CA 94105");
    cli("engagement", "add", "--client-id", "1", "--name", "Build", "--rate-cents-per-hour", "15000");
    cli("time", "add", "--client-id", "1", "--engagement-id", "1", "--date", "2026-10-03", "--minutes", "90", "--note", "API design");
    cli("charge", "add", "--client-id", "1", "--date", "2026-10-10", "--amount-cents", "4812", "--line-text", "OpenAI API usage, Oct 2026");
    cli("invoice", "draft", "--client-id", "1", "--period-start", "2026-10-01", "--period-end", "2026-10-31");
  } else if (name === "full") {
    // One pass through every operation, with a passkey registered and the gate left to the agent.
    step([process.execPath, "scripts/scenario-books.ts", r.books]);
  }
  writeFileSync(join(r.evidence, "seed.log"), log.join("\n"));
}

// ---------------------------------------------------------------- commands

async function up(flags: Record<string, string>) {
  const seedName = flags.seed ?? "billing";
  if (!(SEEDS as readonly string[]).includes(seedName)) die(`--seed must be one of ${SEEDS.join(", ")}.`);
  const scratch = mkdtempSync(join(tmpdir(), "solobooks-verify-"));
  const id = scratch.slice(scratch.lastIndexOf("-") + 1).toLowerCase();
  const port = await freePort();
  const r: Run = {
    id,
    port,
    pid: 0,
    url: `http://localhost:${port}/`,
    scratch,
    home: join(scratch, "home"),
    books: join(scratch, "books"),
    evidence: join(EVIDENCE, id),
    seed: seedName,
    now: flags.now ?? DEFAULT_NOW,
    delayMs: Number(flags["hold-data-ms"] ?? 0),
    commit: capture(["git", "rev-parse", "--short", "HEAD"], undefined, ROOT).stdout.trim(),
    srcHash: srcHash(),
    realBooksHash: realBooksHash(),
  };
  mkdirSync(r.evidence, { recursive: true });
  // Saved before anything can fail, so `down` can always find this run's scratch folder.
  save(r);
  mkdirSync(join(r.home, "tmp"), { recursive: true });
  // A .claude folder makes the scratch home look like a person with Claude Code, so setup connects it and doctor can pass.
  mkdirSync(join(r.home, ".claude"), { recursive: true });
  const env = scratchEnv(r);

  const setup = capture(solobooks(["setup", "--books", r.books]), env, ROOT);
  record(r, "setup", "cli", "solobooks setup", setup);
  if (setup.code !== 0) die(`setup failed, so run down:\n${setup.stdout}${setup.stderr}`, 1);
  seed(r, seedName);

  const log = join(r.evidence, "serve.log");
  const fd = openSync(log, "a");
  const child: ChildProcess = spawn(process.execPath, ["src/cli.ts", "serve", "--books", r.books, "--port", String(port)], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  closeSync(fd);
  r.pid = child.pid!;
  save(r);

  // Ready means the books answer through the page, not just that the port is open.
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await pageData(r)).ok === true) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) die(`the page didn't answer in 20 seconds, so run down; see ${log}`, 1);
    await Bun.sleep(100);
  }
  console.log(JSON.stringify({ ready: true, run: r.id, url: r.url, seed: r.seed, now: r.now, books: r.books, evidence: relative(ROOT, r.evidence) }, null, 2));
}

async function doctor(r: Run) {
  const checks: { check: string; ok: boolean; detail: string; warnOnly?: boolean }[] = [];
  const add = (check: string, ok: boolean, detail: string, warnOnly = false) => checks.push({ check, ok, detail, ...(warnOnly && { warnOnly }) });
  add("run", !r.stoppedAt, r.stoppedAt ? `stopped at ${r.stoppedAt}` : `seed ${r.seed}, clock ${r.now}`);
  add("scratch", r.books.startsWith(r.scratch) && r.home.startsWith(r.scratch) && existsSync(join(r.books, "solobooks.sqlite")), r.books);
  const ours = isOurServer(r);
  add("process", ours, ours ? `pid ${r.pid} serves these books` : `pid ${r.pid} isn't this run's server`);
  const lsof = capture(["lsof", "-nP", `-iTCP:${r.port}`, "-sTCP:LISTEN", "-a", "-p", String(r.pid)], undefined, ROOT);
  const sockets = lsof.stdout.split("\n").filter((l) => l.includes("LISTEN"));
  add("port", sockets.length > 0 && sockets.every((l) => /127\.0\.0\.1|\[::1\]/.test(l)), sockets.length ? `${r.port}, loopback only` : `nothing of ours listens on ${r.port}`);
  try {
    const d = await pageData(r);
    add("page", d.ok === true, d.ok ? `${d.summary.waiting} waiting, ${d.summary.counts.invoices} invoices` : JSON.stringify(d));
  } catch (e) {
    add("page", false, `${r.url}data didn't answer: ${e}`);
  }
  const fresh = srcHash() === r.srcHash;
  add("build", fresh, fresh ? `src/ unchanged since up, commit ${r.commit}` : "src/ changed since up, so the page runs old code. Run down, then up.");
  const install = capture(solobooks(["doctor"]), scratchEnv(r), ROOT);
  let installOk = false;
  try {
    installOk = JSON.parse(install.stdout).ok === true;
  } catch {
    // unparsable output counts as failed
  }
  add("solobooks doctor", installOk, installOk ? "books open, MCP answers, skill in place" : install.stdout);
  add("real books", realBooksHash() === r.realBooksHash, realBooksHash() === r.realBooksHash ? "unchanged since up" : "changed since up. This run can't reach them, so check whether another session is working in them.", true);
  const contexts = capture(["interceptor", "contexts"], undefined, ROOT);
  add("browser", contexts.stdout.includes(BROWSER_CONTEXT), contexts.stdout.includes(BROWSER_CONTEXT) ? `context ${BROWSER_CONTEXT} connected` : "no interceptor-test context, so page drives will refuse. Run: interceptor reload", true);
  const ok = checks.every((c) => c.ok || c.warnOnly);
  console.log(JSON.stringify({ ok, run: r.id, url: r.url, checks }, null, 2));
  process.exit(ok ? 0 : 1);
}

/** Hands over all output, then exits. A plain write followed by process.exit loses whatever a pipe hasn't taken yet. */
async function finish(code: number, stdout: string, stderr = ""): Promise<never> {
  await drain(process.stdout, stdout);
  await drain(process.stderr, stderr);
  process.exit(code);
}

function drain(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((done) => (text ? stream.write(text, () => done()) : done()));
}

async function cli(r: Run, label: string | undefined, args: string[]) {
  const res = capture(solobooks(args), scratchEnv(r), ROOT);
  record(r, label ?? args.slice(0, 2).join("-"), "cli", `solobooks ${args.join(" ")}`, res);
  await finish(res.code, res.stdout, res.stderr);
}

/** Speaks JSON-RPC over stdio to `solobooks mcp`, as an agent app does, declaring no way to ask the person in chat. */
async function mcp(r: Run, label: string | undefined, args: string[]) {
  const list = args[0] === "--list";
  const [tool, json] = args;
  if (!list && !tool) die("mcp needs a tool name and its JSON arguments, or --list.");
  let input: unknown = {};
  if (!list && json !== undefined) {
    try {
      input = JSON.parse(json);
    } catch {
      die("the tool arguments aren't valid JSON.");
    }
  }
  const proc = Bun.spawn(solobooks(["mcp"]), { cwd: ROOT, env: scratchEnv(r), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const send = (m: unknown) => {
    proc.stdin.write(JSON.stringify(m) + "\n");
    proc.stdin.flush();
  };
  const waiting = new Map<number, (m: any) => void>();
  (async () => {
    let buf = "";
    const dec = new TextDecoder();
    for await (const chunk of proc.stdout) {
      buf += dec.decode(chunk);
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          const m = JSON.parse(line);
          waiting.get(m.id)?.(m);
        }
      }
    }
  })();
  let id = 0;
  const request = (method: string, params: unknown) =>
    Promise.race([
      new Promise<any>((res) => {
        const n = ++id;
        waiting.set(n, res);
        send({ jsonrpc: "2.0", id: n, method, params });
      }),
      Bun.sleep(20_000).then(() => die(`${method} got no answer in 20 seconds.`, 1)),
    ]);
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify-solobooks", version: "0" } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const answer = list ? await request("tools/list", {}) : await request("tools/call", { name: tool, arguments: input });
  proc.stdin.end();
  proc.kill();
  await proc.exited;
  const stdout = list
    ? (answer.result?.tools ?? []).map((t: { name: string }) => t.name).join("\n") + "\n"
    : (answer.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n") + "\n";
  const code = answer.error || answer.result?.isError ? 2 : 0;
  record(r, label ?? (list ? "tools-list" : tool!), "mcp", list ? "tools/list" : `tools/call ${tool} ${json ?? "{}"}`, { code, stdout: answer.error ? JSON.stringify(answer.error) : stdout, stderr: "" });
  await finish(code, answer.error ? JSON.stringify(answer.error) + "\n" : stdout);
}

const group = (r: Run) => `verify-${r.id}`;

/** Every browser call goes to the test profile and this run's own tab group, or it doesn't go at all. */
async function page(r: Run, label: string | undefined, args: string[]) {
  const contexts = capture(["interceptor", "contexts"], undefined, ROOT);
  if (!contexts.stdout.includes(BROWSER_CONTEXT)) die(`the ${BROWSER_CONTEXT} browser profile isn't connected, so nothing was sent. Run: interceptor reload`, 1);
  const [verb, ...rest] = args;
  if (!verb) die("page needs an interceptor verb, such as: page open, page text, page click --selector <css>, page shot <name>.");
  const route = ["--context", BROWSER_CONTEXT, "--group", group(r)];
  if (verb === "shot") {
    const name = rest[0] ?? die("page shot needs a name.");
    const before = new Set(readdirSync(r.evidence));
    const res = capture(["interceptor", "screenshot", "--save", ...route, ...rest.slice(1)], undefined, r.evidence);
    const made = readdirSync(r.evidence).find((f) => !before.has(f));
    if (res.code !== 0 || !made) die(`the screenshot failed:\n${res.stdout}${res.stderr}`, 1);
    const to = nextFile(r, name, made.slice(made.lastIndexOf(".") + 1));
    renameSync(join(r.evidence, made), to);
    console.log(relative(ROOT, to));
    return;
  }
  // `page open` takes no address of its own: it can only reach this run's page, plus an optional #fragment.
  const argv = verb === "open" ? ["interceptor", "open", `${r.url}${rest[0]?.startsWith("#") ? rest.shift() : ""}`, ...rest, ...route] : ["interceptor", verb, ...rest, ...route];
  const res = capture(argv, undefined, ROOT);
  record(r, label ?? `page-${verb}`, "page", argv.join(" "), res);
  await finish(res.code, res.stdout, res.stderr.split("\n").filter((l) => !l.startsWith("hint: Interceptor skill packs")).join("\n"));
}

/** Stops only what this run started and removes its scratch folder. The evidence stays, with the final books beside it. */
function down(r: Run) {
  const report: Record<string, unknown> = { run: r.id };
  if (r.pid && isOurServer(r)) {
    process.kill(r.pid);
    report.server = `stopped pid ${r.pid}`;
  } else {
    report.server = "not running";
  }
  const closed = capture(["interceptor", "group", "close", group(r), "--context", BROWSER_CONTEXT], undefined, ROOT);
  report.tabs = closed.code === 0 ? `closed ${group(r)}` : "no tab group to close";
  if (existsSync(r.books)) cpSync(r.books, join(r.evidence, "books-final"), { recursive: true });
  rmSync(r.scratch, { recursive: true, force: true });
  report.scratch = `removed ${r.scratch}`;
  report.realBooks = realBooksHash() === r.realBooksHash ? "unchanged since up" : "changed since up; this run can't reach them, so check for another session working in them";
  r.stoppedAt = new Date().toISOString();
  save(r);
  report.evidence = relative(ROOT, r.evidence);
  console.log(JSON.stringify(report, null, 2));
}

// ---------------------------------------------------------------- argv

const argv = process.argv.slice(2);
const command = argv.shift();
const flags: Record<string, string> = {};
while (argv[0] && ["--run", "--as", "--seed", "--now", "--hold-data-ms"].includes(argv[0])) {
  const name = argv.shift()!.slice(2);
  flags[name] = argv.shift() ?? die(`--${name} needs a value.`);
}
if (argv[0] === "--") argv.shift();

switch (command) {
  case "up":
    await up(flags);
    break;
  case "doctor":
    await doctor(findRun(flags.run));
    break;
  case "cli":
    await cli(findRun(flags.run), flags.as, argv);
    break;
  case "mcp":
    await mcp(findRun(flags.run), flags.as, argv);
    break;
  case "page":
    await page(findRun(flags.run), flags.as, argv);
    break;
  case "down":
    down(findRun(flags.run));
    break;
  case "list":
    console.log(JSON.stringify(runs().map((r) => ({ run: r.id, url: r.url, seed: r.seed, stoppedAt: r.stoppedAt ?? null })), null, 2));
    break;
  default:
    die("usage: control.ts up [--seed empty|billing|full] [--now <iso>] [--hold-data-ms <n>] | doctor | cli [--as <label>] -- <args> | mcp [--as <label>] <tool> '<json>' | mcp --list | page [--as <label>] <verb> ... | down | list");
}
