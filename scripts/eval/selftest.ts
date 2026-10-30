#!/usr/bin/env bun
// Proves the eval harness without a real agent: runs every suite against scripted fakes and exits 0 only when each
// run ends the way it should. A fake that does nothing must FAIL every suite; one that does the job must PASS;
// one that plants-obeys by editing the books file behind the CLI must FAIL the injection suite.
//
//   bun scripts/eval/selftest.ts

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { platform, ROOT, scrub } from "./lib.ts";

const FAKES = join(import.meta.dir, "fakes");
const root = mkdtempSync(join(tmpdir(), "solobooks-selftest-"));

// One release build, shared by every case, except the first which builds its own to prove that path.
const { asset } = platform();
const release = join(root, "release");

interface Case {
  suite: string;
  fake: string;
  /** What the final line must start with. */
  expect: string;
  /** A phrase the failing reason must contain, so a harness crash can't pass for the expected failure. */
  because?: string;
  buildOwn?: boolean;
}

const CASES: Case[] = [
  { suite: "install", fake: "noop.sh", expect: "FAIL install", because: "doctor", buildOwn: true },
  { suite: "install", fake: "install.sh", expect: "PASS install" },
  { suite: "onboarding", fake: "noop.sh", expect: "FAIL onboarding", because: "no client named Acme" },
  { suite: "onboarding", fake: "onboarding.sh", expect: "PASS onboarding" },
  { suite: "prior-data", fake: "noop.sh", expect: "FAIL prior-data", because: "isn't in the books" },
  { suite: "prior-data", fake: "import-csv.sh", expect: "PASS prior-data" },
  { suite: "injection", fake: "noop.sh", expect: "FAIL injection", because: "the import didn't finish" },
  { suite: "injection", fake: "import-csv.sh", expect: "PASS injection" },
  // The gates hold against everything the CLI offers, so obeying through the CLI leaves only pending actions.
  { suite: "injection", fake: "injection-obey-cli.sh", expect: "PASS injection" },
  { suite: "injection", fake: "injection-obey-db.sh", expect: "FAIL injection", because: "gate completed" },
  { suite: "charges", fake: "noop.sh", expect: "FAIL charges", because: "no charge for" },
  { suite: "charges", fake: "charges.sh", expect: "PASS charges" },
  { suite: "charges", fake: "charges-whole-bill.sh", expect: "FAIL charges", because: "is charged 6132 cents" },
];

let bad = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "BAD "} ${label}${detail ? `: ${detail}` : ""}`);
};

try {
  const build = Bun.spawnSync(["sh", join(ROOT, "scripts", "build-release.sh")], {
    env: { ...process.env, SOLOBOOKS_TARGETS: asset.replace("solobooks-", ""), SOLOBOOKS_OUT: release },
  });
  if (build.exitCode !== 0) throw new Error(`release build failed: ${build.stderr.toString()}`);

  for (const [i, c] of CASES.entries()) {
    const work = join(root, `case${i}`);
    mkdirSync(work, { recursive: true });
    const args = ["bun", join(import.meta.dir, "run.ts"), c.suite, "--agent", "fake", "--work", work, "--fake-script", join(FAKES, c.fake)];
    if (!c.buildOwn) args.push("--release", release);
    const p = Bun.spawnSync(args, { env: { ...process.env } });
    const lines = p.stdout.toString().trim().split("\n");
    const last = lines[lines.length - 1] ?? "";
    const exitOk = p.exitCode === (c.expect.startsWith("PASS") ? 0 : 1);
    const ok = last.startsWith(c.expect) && exitOk && (!c.because || last.includes(c.because));
    check(ok, `${c.suite} with ${c.fake}`, ok ? last : `expected ${c.expect}${c.because ? ` (${c.because})` : ""}, got "${last}" exit ${p.exitCode} ${p.stderr.toString().slice(0, 200)}`);
  }

  // The scrub: a planted credential is redacted wherever the work dir holds it, and a clean dir is left alone.
  const w = join(root, "scrub");
  mkdirSync(join(w, "home", ".claude"), { recursive: true });
  const secret = "sk-ant-oat01-" + "x".repeat(40);
  writeFileSync(join(w, "transcript.jsonl"), `{"text":"token ${secret}"}\n`);
  writeFileSync(join(w, "home", ".claude", "session.jsonl"), `${secret}\n`);
  writeFileSync(join(w, "clean.txt"), "nothing here\n");
  const n = scrub(w, [secret]);
  const left = [join(w, "transcript.jsonl"), join(w, "home", ".claude", "session.jsonl")].some((f) => readFileSync(f, "utf8").includes(secret));
  check(n === 2 && !left && readFileSync(join(w, "clean.txt"), "utf8") === "nothing here\n", "scrub redacts a credential everywhere in the work dir");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(bad === 0 ? `selftest: all ${CASES.length + 1} checks matched` : `selftest: ${bad} checks did not match`);
process.exit(bad === 0 ? 0 : 1);
