#!/usr/bin/env bun
// The agent eval harness: runs a real agent (or a scripted fake) against solobooks in a throwaway home and prints
// one final line, `PASS <suite>` or `FAIL <suite>: <reason>`. Exits 0 only on PASS. Everything it makes lives under
// --work: the home, the agent's transcript, a summary, and the loopback mirror's files.
//
//   bun scripts/eval/run.ts <install|onboarding|prior-data|injection> --agent claude|codex|fake --work <dir>
//     [--fake-script <file>] [--release <dir>]
//
// --release reuses a finished release build (from scripts/build-release.sh) instead of building one for the run.
// Real agents authenticate from ~/.solobooks-eval: claude.env holds a CLAUDE_CODE_OAUTH_TOKEN line, codex/auth.json
// is Codex's login. A run has no time limit; its duration is logged.

import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Agent, Fail, log, runAgent, scrub, startMirror } from "./lib.ts";
import { type Ctx, SUITES } from "./suites.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const suiteName = process.argv[2] ?? "";

async function run(): Promise<string | null> {
  const suite = SUITES[suiteName];
  const agent = arg("agent") as Agent | undefined;
  const workArg = arg("work");
  if (!suite) throw new Fail(`unknown suite "${suiteName}" (use ${Object.keys(SUITES).join(", ")})`);
  if (agent !== "claude" && agent !== "codex" && agent !== "fake") throw new Fail("--agent must be claude, codex or fake");
  if (!workArg) throw new Fail("--work <dir> is required");

  const work = resolve(workArg);
  const home = join(work, "home");
  mkdirSync(work, { recursive: true });
  // Only the folders this harness makes are ever cleared, so a rerun starts from nothing.
  for (const d of ["home", "bin", "mirror"]) rmSync(join(work, d), { recursive: true, force: true });
  mkdirSync(home, { recursive: true });

  const summary = join(work, "summary.txt");
  writeFileSync(summary, "");
  const note = (s: string) => {
    log(s);
    appendFileSync(summary, s + "\n");
  };

  const mirror = await startMirror(work, arg("release") ? resolve(arg("release")!) : undefined);
  try {
    const ctx: Ctx = { work, home, agent, mirror, state: {} };
    await suite.prepare(ctx);
    note(`${suiteName} with ${agent}: home ${home}, mirror ${mirror.base}`);

    const res = await runAgent({ agent, prompt: suite.prompt(ctx), home, work, fakeScript: arg("fake-script"), mcp: suite.mcp });
    note(`agent run took ${res.seconds}s and exited ${res.code}`);
    const scrubbed = scrub(work, res.secrets);
    if (scrubbed > 0) note(`redacted a credential from ${scrubbed} files`);

    const reason = await suite.check(ctx);
    for (const line of (await suite.summary?.(ctx)) ?? []) note(line);
    note(`transcript: ${join(work, agent === "claude" ? "transcript.jsonl" : "transcript.txt")}`);
    return reason;
  } finally {
    mirror.stop();
  }
}

let reason: string | null;
try {
  reason = await run();
} catch (e) {
  reason = e instanceof Fail ? e.message : `harness error: ${e instanceof Error ? e.message : String(e)}`;
}
const oneLine = (reason ?? "").replace(/\s+/g, " ").trim();
console.log(reason === null ? `PASS ${suiteName}` : `FAIL ${suiteName}: ${oneLine}`);
process.exit(reason === null ? 0 : 1);
