import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { withTomlTable } from "../src/agents.ts";
import { install } from "../src/cli.ts";
import { booksDir } from "../src/config.ts";
import { SKILL_FILES } from "../src/skill.ts";
import { VERSION } from "../src/version.ts";
import { ROOT, tempDir } from "./support/books.ts";

const setupIn = async (home: string, ...argv: string[]) => {
  const r = await install("setup", argv, { HOME: home });
  if (r.code !== 0) throw new Error(r.stdout);
  return JSON.parse(r.stdout);
};

test("the version is one number: package.json, --version and the MCP server agree", async () => {
  expect(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version).toBe(VERSION);
  const out = Bun.spawnSync(["bun", "src/cli.ts", "--version"], { cwd: ROOT }).stdout.toString();
  expect(out).toBe(`solobooks ${VERSION}\n`);
});

test("the skill built into the binary is skills/solobooks/, file for file", () => {
  const dir = join(ROOT, "skills", "solobooks");
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  const onDisk = Object.fromEntries(walk(dir).map((f) => [relative(dir, f), readFileSync(f, "utf8")]));
  expect(Object.keys(SKILL_FILES).sort()).toEqual(Object.keys(onDisk).sort());
  for (const [rel, text] of Object.entries(SKILL_FILES)) expect(text).toBe(onDisk[rel]!);
});

test("the books folder: --books, then SOLOBOOKS_DIR, then the folder setup recorded, else a refusal", async () => {
  const home = tempDir();
  expect(() => booksDir(undefined, { HOME: home })).toThrow("run solobooks setup to pick one");
  const r = await setupIn(home);
  expect(r.books).toBe(join(home, "solobooks")); // the default
  expect(booksDir(undefined, { HOME: home })).toBe(join(home, "solobooks"));
  expect(booksDir(undefined, { HOME: home, SOLOBOOKS_DIR: "/env" })).toBe("/env");
  expect(booksDir("/flag", { HOME: home, SOLOBOOKS_DIR: "/env" })).toBe("/flag");

  // Choosing another folder records it, and a later setup keeps it.
  await setupIn(home, "--books", "~/books-elsewhere");
  expect(booksDir(undefined, { HOME: home })).toBe(join(home, "books-elsewhere"));
  expect((await setupIn(home)).books).toBe(join(home, "books-elsewhere"));
});

test("setup warns when the books folder sits in a synced folder, and suggests another", async () => {
  const home = tempDir();
  mkdirSync(join(home, ".claude")); // an agent is here, so the only warning is about the folder
  const cases: [string, RegExp][] = [
    ["Library/Mobile Documents/com~apple~CloudDocs/books", /inside iCloud Drive/],
    ["Library/CloudStorage/Dropbox/books", /inside a cloud drive/],
    ["Dropbox/books", /inside Dropbox/],
    ["OneDrive - Acme/books", /inside OneDrive/],
    ["Google Drive/books", /inside Google Drive/],
  ];
  if (process.platform === "darwin") cases.push(["Documents/books", /inside Documents, which iCloud or OneDrive may sync/]);
  for (const [dir, says] of cases) {
    const { warnings } = await setupIn(home, "--books", join(home, dir));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(says);
    expect(warnings[0]).toContain(`such as ${join(home, "solobooks")}, with solobooks setup --books <dir>`);
  }
  expect((await setupIn(home, "--books", join(home, "solobooks"))).warnings).toEqual([]);
});

test("setup edits a Codex config table by table, and leaves a config it can't read alone", async () => {
  const before = 'model = "o3"\n\n[mcp_servers.solobooks]\ncommand = "/old/solobooks"\nargs = ["mcp"]\n\n[mcp_servers.solobooks.env]\nX = "1"\n\n[mcp_servers.other]\ncommand = "other"\n';
  const after = withTomlTable(before, { command: "/new/solobooks", args: ["mcp"] });
  expect(after).toBe('model = "o3"\n\n[mcp_servers.solobooks]\ncommand = "/new/solobooks"\nargs = ["mcp"]\n\n[mcp_servers.other]\ncommand = "other"\n');
  expect(withTomlTable('model = "o3"\n', { command: "/s", args: ["mcp"] })).toBe('model = "o3"\n\n[mcp_servers.solobooks]\ncommand = "/s"\nargs = ["mcp"]\n');

  const home = tempDir();
  mkdirSync(join(home, ".codex"));
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude.json"), "{ not json");
  writeFileSync(join(home, ".codex", "config.toml"), 'mcp_servers = { solobooks = { command = "x" } }\n'); // inline: not safe to edit
  const r = await setupIn(home);
  expect(r.agents.filter((a: any) => a.detected).map((a: any) => a.mcp)).toEqual(["failed", "failed"]);
  expect(r.warnings).toEqual([
    `${join(home, ".claude.json")} isn't valid JSON, so solobooks left it alone; fix it, then run solobooks setup again.`,
    expect.stringContaining("defines mcp_servers in a way solobooks can't safely edit, so it left the file alone"),
  ]);
  expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe("{ not json");
  expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe('mcp_servers = { solobooks = { command = "x" } }\n');
});

test("with the solobooks plugin in Claude Code, setup adds no second entry, and doctor checks the plugin's server", async () => {
  const home = tempDir();
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  // This checkout stands in for the plugin's install folder; a wrapper stands in for the installed binary.
  writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "solobooks@solobooks": [{ scope: "user", installPath: ROOT }] } }));
  const bin = join(home, "solobooks-bin");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, "src", "cli.ts")}" "$@"\n`, { mode: 0o755 });

  const r = await setupIn(home);
  expect(r.agents[0]).toEqual({ agent: "Claude Code", detected: true, mcp: "plugin", plugin: ROOT });
  expect(r.skills.map((s: any) => s.folder)).toEqual([join(home, ".agents", "skills", "solobooks")]);
  expect(statSync(join(home, ".claude.json"), { throwIfNoEntry: false })).toBeUndefined();

  const env = { HOME: home, SOLOBOOKS_BIN: bin, PATH: "/usr/bin:/bin" };
  const ok = JSON.parse((await install("doctor", [], env)).stdout);
  expect(ok.ok).toBe(true);
  expect(ok.checks.find((c: any) => c.check === "Claude Code MCP").detail).toContain("the solobooks plugin's server answered");
  const broken = await install("doctor", [], { ...env, SOLOBOOKS_BIN: "/nonexistent" });
  expect(broken.code).toBe(1); // the launcher finds no binary, so the plugin's server can't answer
}, 30_000);
