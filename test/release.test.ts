import { spawnSync } from "bun";
import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, tempDir } from "./support/books.ts";

// The real probes are run by `bash scripts/release-probes.sh`, which takes minutes. Here: that it is wired in, that it
// misses no probe, and, against stand-in probes, that one failing stops it.

const SCRIPT = join(ROOT, "scripts", "release-probes.sh");
const text = readFileSync(SCRIPT, "utf8");
/** The scripts it runs, in order. */
const ran = [...text.matchAll(/^probe \S+ scripts\/(\S+)/gm)].map((m) => m[1]!);

test("ISC-184: the release runs the probes after installing dependencies and before it publishes", () => {
  const flow = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const at = (s: string) => flow.indexOf(s);
  expect(at("bash scripts/release-probes.sh")).toBeGreaterThan(at("bun install --frozen-lockfile"));
  expect(at("bash scripts/release-probes.sh")).toBeGreaterThan(at("bun test"));
  expect(at("bash scripts/release-probes.sh")).toBeLessThan(at("gh release create"));
  // A step that swallows its failure wouldn't stop anything.
  expect(flow).not.toContain("continue-on-error");
  expect(flow).not.toContain("release-probes.sh ||");
  expect(statSync(SCRIPT).mode & 0o111).toBeGreaterThan(0);
  expect(text).toContain("set -euo pipefail");
});

test("ISC-184: every probe script runs, except the two that need another app, and each of those says why", () => {
  const probes = readdirSync(join(ROOT, "scripts")).filter((f) => f.endsWith(".sh") && f !== "build-release.sh" && f !== "release-probes.sh");
  const out = ["export-check.sh", "plugin-install-check.sh"];
  expect([...ran.filter((f) => f.endsWith(".sh")), ...out].sort()).toEqual(probes.sort());
  expect(ran).toContain("check-skill-fields.ts");
  expect(text).toMatch(/export-check\.sh\s+hledger/);
  expect(text).toMatch(/plugin-install-check\.sh\s+the real claude CLI/);
});

test("ISC-184: no probe the release runs needs an app the runner lacks", () => {
  for (const f of ran) {
    const body = readFileSync(join(ROOT, "scripts", f), "utf8");
    for (const app of [/^\s*[^#\n]*\bhledger\b/m, /^\s*[^#\n]*\brg\b/m, /^\s*[^#\n]*\bclaude plugin\b/m]) expect(body).not.toMatch(app);
  }
});

/** A copy of the script among stand-ins: each leaves a mark, and the one named exits 1. */
function standIns(failing: string | null) {
  const root = tempDir();
  mkdirSync(join(root, "scripts"));
  copyFileSync(SCRIPT, join(root, "scripts", "release-probes.sh"));
  for (const f of ran) {
    const code = f === failing ? 1 : 0;
    const body = f.endsWith(".ts") ? `await Bun.write(${JSON.stringify(join(root, `${f}.ran`))}, ""); process.exit(${code});\n` : `touch ${JSON.stringify(join(root, `${f}.ran`))}\nexit ${code}\n`;
    writeFileSync(join(root, "scripts", f), body);
    chmodSync(join(root, "scripts", f), 0o755);
  }
  const r = spawnSync(["bash", join(root, "scripts", "release-probes.sh")], { env: { PATH: process.env.PATH! } });
  return { code: r.exitCode, didRun: (f: string) => existsSync(join(root, `${f}.ran`)) };
}

test("ISC-184: with every probe passing it exits zero, having run them all", () => {
  const r = standIns(null);
  expect(r.code).toBe(0);
  for (const f of ran) expect(r.didRun(f)).toBe(true);
});

for (const failing of ["check-skill-fields.ts", "doctor-negative.sh", "npm-check.sh"]) {
  test(`ISC-184: a failing probe, ${failing}, stops the rest and exits non-zero`, () => {
    const r = standIns(failing);
    expect(r.code).not.toBe(0);
    expect(r.didRun(failing)).toBe(true);
    for (const f of ran.slice(ran.indexOf(failing) + 1)) expect(r.didRun(f)).toBe(false);
  });
}
