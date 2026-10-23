import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkSkill } from "../scripts/check-skill-fields.ts";
import { VERSION } from "../src/version.ts";
import { ROOT, tempDir } from "./support/books.ts";

// ISC-87, checked without the claude CLI: the repo is a Claude Code marketplace whose one plugin carries the solobooks
// MCP server and skill. scripts/plugin-install-check.sh runs the real `claude plugin install`.

const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const kebab = /^[a-z0-9]+(-[a-z0-9]+)*$/;

test("ISC-87 manifests: the marketplace lists the solobooks plugin, and the plugin carries the MCP server and skill", () => {
  const market = read(".claude-plugin/marketplace.json");
  expect(market.name).toMatch(kebab);
  expect(typeof market.owner?.name).toBe("string");
  // solobooks first; its optional add-ons after it, each its own plugin (see the add-on test below).
  expect(market.plugins.map((p: { name: string }) => p.name)).toEqual(["solobooks", "solobooks-agent-time"]);
  const entry = market.plugins[0];
  expect(entry.name).toBe("solobooks");
  expect(entry.source).toMatch(/^\.\//); // a path inside this repo
  expect(entry.version).toBe(VERSION);

  const pluginRoot = resolve(ROOT, entry.source);
  const plugin = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
  expect(plugin.name).toBe(entry.name);
  expect(plugin.version).toBe(VERSION);
  expect(plugin.license).toBe("MIT");
  expect(Object.keys(plugin.mcpServers)).toEqual(["solobooks"]);
  const server = plugin.mcpServers.solobooks;
  expect(server.command).toStartWith("${CLAUDE_PLUGIN_ROOT}/");
  const launcher = join(pluginRoot, server.command.slice("${CLAUDE_PLUGIN_ROOT}/".length));
  expect(existsSync(launcher)).toBe(true);
  expect(statSync(launcher).mode & 0o111).not.toBe(0);
  // No .mcp.json at the root: here it would also be this repo's project config for anyone working in it.
  expect(existsSync(join(pluginRoot, ".mcp.json"))).toBe(false);
  // The skill is found where Claude Code looks, and passes the Agent Skills check.
  expect(checkSkill(join(pluginRoot, "skills", "solobooks", "SKILL.md"))).toEqual([]);
});

test("add-on plugin: agent time is its own plugin, carrying only its skill and no MCP server", () => {
  const market = read(".claude-plugin/marketplace.json");
  const entry = market.plugins.find((p: { name: string }) => p.name === "solobooks-agent-time");
  expect(entry.source).toBe("./addons/agent-time");
  const pluginRoot = resolve(ROOT, entry.source);
  const plugin = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
  expect(plugin.name).toBe(entry.name);
  expect(plugin.version).toBe(entry.version);
  expect(plugin.license).toBe("MIT");
  expect(plugin.mcpServers).toBeUndefined();
  const skill = join(pluginRoot, "skills", "bill-agent-time");
  expect(checkSkill(join(skill, "SKILL.md"))).toEqual([]);
  for (const f of ["scripts/count-time.ts", "references/billing-rule.md"]) expect(existsSync(join(skill, f))).toBe(true);
});

test("ISC-87 launcher: it starts the installed solobooks as an MCP server, or says how to install it", () => {
  const launcher = join(ROOT, "plugin", "mcp.sh");
  const home = tempDir();
  const missing = Bun.spawnSync(["/bin/sh", launcher], { env: { HOME: home, PATH: "/usr/bin:/bin" } });
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr.toString()).toContain("solobooks isn't installed. Install it with: curl -fsSL");

  // A stand-in binary at ~/.local/bin/solobooks shows what the launcher runs.
  const bin = join(home, ".local", "bin");
  Bun.spawnSync(["mkdir", "-p", bin]);
  writeFileSync(join(bin, "solobooks"), '#!/bin/sh\necho "ran: $*"\n');
  chmodSync(join(bin, "solobooks"), 0o755);
  const found = Bun.spawnSync(["/bin/sh", launcher], { env: { HOME: home, PATH: "/usr/bin:/bin" } });
  expect(found.exitCode).toBe(0);
  expect(found.stdout.toString()).toBe("ran: mcp\n");
});
