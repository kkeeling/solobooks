// Shared pieces of the agent eval harness: the loopback mirror, the throwaway home, the agent runners, the secret
// scrub, and the books side of the person (who installs, sets up and approves; the agent never can).

import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { approvePending } from "../../src/core/approve.ts";
import { openBooks } from "../../src/core/db.ts";
import { DEFAULT_PAGE } from "../../src/core/gate.ts";

export const ROOT = resolve(import.meta.dir, "..", "..");
export const EVAL_DIR = join(process.env.HOME ?? "", ".solobooks-eval");
export const RAW = "https://raw.githubusercontent.com/kkeeling/solobooks/main/";
export const SAFE_PATH = "/usr/bin:/bin";

export type Agent = "claude" | "codex" | "fake";

/** A failed eval, with the one-line reason that goes after `FAIL <suite>:`. */
export class Fail extends Error {}

export const log = (s: string) => console.log(s);

// ---------------------------------------------------------------- the machine

export function platform(): { os: string; arch: string; asset: string } {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "";
  if (!os) throw new Fail("run the eval on macOS or Linux");
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return { os, arch, asset: `solobooks-${os}-${arch}` };
}

/** `command -v name` in the real shell environment, or null. */
export function which(name: string): string | null {
  const r = Bun.spawnSync(["sh", "-c", `command -v ${name}`]);
  const out = r.stdout.toString().trim();
  return r.exitCode === 0 && out.startsWith("/") ? out : null;
}

// ---------------------------------------------------------------- the loopback mirror

export interface Mirror {
  dir: string;
  base: string;
  /** The README's opening install prompt, pointed at the mirror's INSTALL.md. */
  prompt: string;
  stop(): void;
}

/**
 * Serves a release build for this machine, copies of install.sh and INSTALL.md, and the README prompt from
 * 127.0.0.1. The repo is private for now, so every raw.githubusercontent.com URL and the installer's default
 * download base in the served copies point at the mirror. `release` reuses a finished build instead of making one.
 */
export async function startMirror(work: string, release?: string): Promise<Mirror> {
  const dir = join(work, "mirror");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const { os, arch, asset } = platform();

  if (release) {
    for (const f of [asset, "SHA256SUMS"]) {
      if (!existsSync(join(release, f))) throw new Fail(`--release ${release} has no ${f}`);
      copyFileSync(join(release, f), join(dir, f));
    }
  } else {
    const build = Bun.spawn(["sh", join(ROOT, "scripts", "build-release.sh")], {
      env: { ...process.env, SOLOBOOKS_TARGETS: `${os}-${arch}`, SOLOBOOKS_OUT: dir },
      stdout: Bun.file(join(work, "build.log")),
      stderr: Bun.file(join(work, "build.log")),
    });
    if ((await build.exited) !== 0) throw new Fail(`the release build failed; see ${join(work, "build.log")}`);
  }
  chmodSync(join(dir, asset), 0o755);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const name = new URL(req.url).pathname.slice(1);
      if (!/^[\w.-]+$/.test(name)) return new Response("not found", { status: 404 });
      const f = Bun.file(join(dir, name));
      return f.size ? new Response(f) : new Response("not found", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;

  const installer = readFileSync(join(ROOT, "install.sh"), "utf8")
    .replaceAll(RAW, `${base}/`)
    .replace(/https:\/\/github\.com\/kkeeling\/solobooks\/releases\/(latest\/download|download\/v\$\{SOLOBOOKS_VERSION#v\})/g, base);
  const guide = readFileSync(join(ROOT, "INSTALL.md"), "utf8").replaceAll(RAW, `${base}/`);
  // Nothing the agent follows may still reach for the private repo.
  if (/raw\.githubusercontent|kkeeling\/solobooks/.test(installer)) throw new Fail("the served install.sh still points at GitHub");
  if (/raw\.githubusercontent/.test(guide) || !guide.includes(`${base}/install.sh`)) throw new Fail("the served INSTALL.md isn't rewritten to the mirror");
  writeFileSync(join(dir, "install.sh"), installer);
  writeFileSync(join(dir, "INSTALL.md"), guide);

  const opening = readFileSync(join(ROOT, "README.md"), "utf8").match(/Paste this into your agent:\s*```text\n([\s\S]*?)\n```/)?.[1];
  if (!opening?.includes(`${RAW}INSTALL.md`)) throw new Fail("couldn't find the install prompt in README.md");
  const prompt = opening.replaceAll(RAW, `${base}/`);
  writeFileSync(join(dir, "prompt.txt"), prompt + "\n");

  return { dir, base, prompt, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------- the throwaway home and the books

export const solobooksBin = (home: string) => join(home, ".local", "bin", "solobooks");
export const booksDb = (home: string) => join(home, "solobooks", "solobooks.sqlite");

export interface Ran {
  code: number;
  out: string;
  json: any;
}

/** Runs the installed solobooks in a bare environment with `home` as HOME, as the person's machine would. */
export async function sb(home: string, args: string[]): Promise<Ran> {
  if (!existsSync(solobooksBin(home))) return { code: 127, out: `${solobooksBin(home)} isn't installed`, json: null };
  const p = Bun.spawn([solobooksBin(home), ...args], { env: { HOME: home, PATH: SAFE_PATH }, cwd: home, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  let json: any = null;
  try {
    json = JSON.parse(out);
  } catch {
    // Not JSON; the caller sees the raw text.
  }
  return { code, out: out + err, json };
}

/** Like sb, but a non-zero exit or a refusal is a harness failure. */
export async function sbOk(home: string, args: string[]): Promise<any> {
  const r = await sb(home, args);
  if (r.code !== 0 || !r.json) throw new Fail(`harness setup: solobooks ${args.join(" ")} failed: ${r.out.slice(0, 300)}`);
  return r.json;
}

/** The person approves a pending action on the approval page, done in-process as the page does it. */
export function approveAsPerson(home: string, pendingId: number): void {
  const db = openBooks(booksDb(home));
  try {
    const r = approvePending(db, pendingId, { via: "page" }, { now: new Date().toISOString(), page: DEFAULT_PAGE });
    if (!r.ok) throw new Fail(`harness setup: approving pending action ${pendingId} was refused: ${JSON.stringify(r.refusal)}`);
  } finally {
    db.close();
  }
}

/** A write that is gated at the default level: the person approves it at once. */
export async function sbApproved(home: string, args: string[]): Promise<void> {
  const r = await sbOk(home, args);
  if (r.status === "pending") approveAsPerson(home, r.pending_id);
}

/** Installs solobooks from the mirror into `home` the way install.sh does for a person, then runs setup. */
export async function installAndSetup(home: string, mirror: Mirror, agent: Agent): Promise<void> {
  const env = { HOME: home, PATH: SAFE_PATH };
  const run = async (cmd: string[]) => {
    const p = Bun.spawn(cmd, { env, cwd: home, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Fail(`harness setup: ${cmd.join(" ")} failed: ${(out + err).slice(0, 300)}`);
  };
  await run(["sh", join(mirror.dir, "install.sh")]);
  // A real Claude Code or Codex has made its own folder by the time it works; setup registers with the agent it finds.
  if (agent === "claude") mkdirSync(join(home, ".claude"), { recursive: true });
  if (agent === "codex") mkdirSync(join(home, ".codex"), { recursive: true });
  await run([solobooksBin(home), "setup"]);
}

// ---------------------------------------------------------------- dates

export const day = (offset = 0): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------- the agents

/** `name`'s binary linked into work/bin, so PATH holds only that binary and nothing else from the real machine. */
function linkedBin(work: string, name: string, extra: string[] = []): string {
  const dir = join(work, "bin");
  mkdirSync(dir, { recursive: true });
  for (const n of [name, ...extra]) {
    const found = which(n);
    if (!found) throw new Fail(`couldn't find ${n} with command -v`);
    const link = join(dir, n);
    rmSync(link, { force: true });
    symlinkSync(realpathSync(found), link);
  }
  return dir;
}

function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) throw new Fail(`${file} is missing`);
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]!] = m[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

export interface AgentRun {
  agent: Agent;
  prompt: string;
  home: string;
  work: string;
  fakeScript?: string;
  /** Whether setup already registered the solobooks MCP server for this agent. */
  mcp: boolean;
}

export interface AgentResult {
  code: number;
  seconds: number;
  /** Strings that must not appear anywhere in the work dir. */
  secrets: string[];
}

/** Every string value in a JSON document, longer than a few characters. */
function jsonStrings(v: unknown): string[] {
  if (typeof v === "string") return v.length >= 16 ? [v] : [];
  if (v && typeof v === "object") return Object.values(v).flatMap(jsonStrings);
  return [];
}

export async function runAgent(r: AgentRun): Promise<AgentResult> {
  const transcript = join(r.work, r.agent === "claude" ? "transcript.jsonl" : "transcript.txt");
  const stderr = join(r.work, "transcript.stderr.txt");
  const secrets: string[] = [];
  let cmd: string[];
  let env: Record<string, string>;
  let codexAuth: { saved: string; inHome: string } | null = null;

  if (r.agent === "claude") {
    const token = readEnvFile(join(EVAL_DIR, "claude.env")).CLAUDE_CODE_OAUTH_TOKEN;
    if (!token) throw new Fail(`${join(EVAL_DIR, "claude.env")} has no CLAUDE_CODE_OAUTH_TOKEN line`);
    secrets.push(token);
    const bin = linkedBin(r.work, "claude");
    const tools = "Bash,Read,Write,Edit,Glob,Grep" + (r.mcp ? ",mcp__solobooks" : "");
    cmd = [join(bin, "claude"), "-p", r.prompt, "--output-format", "stream-json", "--verbose", "--allowedTools", tools];
    // Handed over in the process environment only, never on a command line.
    env = { HOME: r.home, PATH: `${SAFE_PATH}:${bin}`, CLAUDE_CODE_OAUTH_TOKEN: token };
  } else if (r.agent === "codex") {
    const saved = join(EVAL_DIR, "codex", "auth.json");
    if (!existsSync(saved)) throw new Fail(`${saved} is missing`);
    secrets.push(...jsonStrings(JSON.parse(readFileSync(saved, "utf8"))));
    const inHome = join(r.home, ".codex", "auth.json");
    mkdirSync(dirname(inHome), { recursive: true });
    copyFileSync(saved, inHome);
    chmodSync(inHome, 0o600);
    codexAuth = { saved, inHome };
    // codex is a node script, so node has to be on PATH beside it.
    const bin = linkedBin(r.work, "codex", ["node"]);
    cmd = [join(bin, "codex"), "exec", "--skip-git-repo-check", "--full-auto", "-c", "sandbox_workspace_write.network_access=true", r.prompt];
    env = { HOME: r.home, PATH: `${SAFE_PATH}:${bin}` };
  } else {
    if (!r.fakeScript || !existsSync(r.fakeScript)) throw new Fail("--agent fake needs --fake-script <file>");
    cmd = ["/bin/sh", resolve(r.fakeScript), r.prompt];
    env = { HOME: r.home, PATH: SAFE_PATH };
  }

  const started = performance.now();
  const p = Bun.spawn(cmd, { env, cwd: r.home, stdin: "ignore", stdout: Bun.file(transcript), stderr: Bun.file(stderr) });
  const code = await p.exited;
  const seconds = Math.round((performance.now() - started) / 100) / 10;

  if (codexAuth) {
    // A changed auth.json means the token refreshed during the run, so the refreshed copy is the good one.
    if (existsSync(codexAuth.inHome) && !readFileSync(codexAuth.inHome).equals(readFileSync(codexAuth.saved))) {
      copyFileSync(codexAuth.inHome, codexAuth.saved);
      chmodSync(codexAuth.saved, 0o600);
      secrets.push(...jsonStrings(JSON.parse(readFileSync(codexAuth.saved, "utf8"))));
      log("codex refreshed its token; the new auth.json was copied back");
    }
    rmSync(codexAuth.inHome, { force: true });
  }
  return { code, seconds, secrets };
}

// ---------------------------------------------------------------- the secret scrub

function* files(dir: string, skip: Set<string>): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (skip.has(p)) continue;
    const s = lstatSync(p);
    if (s.isSymbolicLink()) continue;
    if (s.isDirectory()) yield* files(p, skip);
    else if (s.size <= 64 * 1024 * 1024) yield p;
  }
}

/**
 * Replaces every secret found in the work dir's files (the transcript, the agent's own session logs and so on) and
 * then checks none is left. The mirror and the installed binary hold no agent output, so they are skipped.
 */
export function scrub(work: string, secrets: string[]): number {
  const found = secrets.filter((s) => s.length > 0);
  if (found.length === 0) return 0;
  const skip = new Set([join(work, "mirror"), join(work, "bin"), join(work, "home", ".local")]);
  let changed = 0;
  for (const f of files(work, skip)) {
    let text = readFileSync(f).toString("latin1");
    let touched = false;
    for (const s of found) {
      const needle = Buffer.from(s, "utf8").toString("latin1");
      if (text.includes(needle)) {
        text = text.replaceAll(needle, "[redacted]");
        touched = true;
      }
    }
    if (touched) {
      writeFileSync(f, Buffer.from(text, "latin1"));
      changed++;
    }
  }
  for (const f of files(work, skip)) {
    const text = readFileSync(f).toString("latin1");
    if (found.some((s) => text.includes(Buffer.from(s, "utf8").toString("latin1")))) throw new Fail(`a credential is still in ${f} after scrubbing`);
  }
  return changed;
}
