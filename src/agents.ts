import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Env, homeDir } from "./config.ts";
import { Refusal } from "./core/refusal.ts";

// The local agent apps solobooks connects to, and how each one records an MCP server. setup writes these entries and
// doctor reads them back. Every path comes from the environment, so a run can be pointed at a scratch home.
//
// The entries are edited in place rather than through each agent's own CLI: those CLIs refuse a server that already
// exists or rewrite the whole file, so a second run wouldn't leave the config byte-identical, and an agent CLI may
// not be on PATH when setup runs.

export const SERVER = "solobooks";

export interface Agent {
  name: string;
  /** Whether this agent seems to be installed for this person. */
  detected: boolean;
  /** The file holding its MCP servers. */
  config: string;
  format: "json" | "toml";
  /** The entry for solobooks, given the command that starts the server. */
  entry(command: string[]): Record<string, unknown>;
  /** Skill folders this agent reads, besides the shared ~/.agents/skills. */
  skillDirs: string[];
  /**
   * Where the solobooks Claude Code plugin is installed, when it is. The plugin carries its own MCP server and skill,
   * so setup adds no second entry beside it.
   */
  plugin?: string;
}

/** The install folder of the solobooks plugin in Claude Code's plugin list, or undefined. */
function pluginInstall(claudeDir: string): string | undefined {
  const file = join(claudeDir, "plugins", "installed_plugins.json");
  if (!existsSync(file)) return undefined;
  try {
    const list = JSON.parse(readFileSync(file, "utf8")).plugins ?? {};
    for (const [key, installs] of Object.entries(list)) {
      if (!key.startsWith(`${SERVER}@`) || !Array.isArray(installs)) continue;
      const path = installs.find((i: any) => typeof i?.installPath === "string")?.installPath;
      if (path) return path;
    }
  } catch {
    // An unreadable plugin list means no plugin solobooks can rely on.
  }
  return undefined;
}

const exists = (p: string) => existsSync(p);

/** The agents solobooks knows, detected or not. */
export function knownAgents(env: Env): Agent[] {
  const home = homeDir(env);
  if (!home) throw new Refusal("solobooks can't tell where your home folder is, because HOME isn't set.", "HOME");
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const claudeJson = env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(home, ".claude.json");
  const codexDir = env.CODEX_HOME || join(home, ".codex");
  const desktopDir =
    process.platform === "darwin" ? join(home, "Library", "Application Support", "Claude") : join(env.XDG_CONFIG_HOME || join(home, ".config"), "Claude");
  return [
    {
      name: "Claude Code",
      detected: exists(claudeDir) || exists(claudeJson),
      config: claudeJson,
      format: "json",
      entry: ([command, ...args]) => ({ type: "stdio", command, args, env: {} }),
      skillDirs: [join(claudeDir, "skills")],
      plugin: pluginInstall(claudeDir),
    },
    {
      name: "Codex",
      detected: exists(codexDir),
      config: join(codexDir, "config.toml"),
      format: "toml",
      entry: ([command, ...args]) => ({ command, args }),
      skillDirs: [], // Codex reads the shared ~/.agents/skills
    },
    {
      name: "Claude Desktop",
      detected: exists(desktopDir),
      config: join(desktopDir, "claude_desktop_config.json"),
      format: "json",
      entry: ([command, ...args]) => ({ command, args }),
      skillDirs: [], // Claude Desktop takes skills as uploads, not from a folder
    },
  ];
}

/** The shared skill folder that most agents read. */
export function sharedSkillDir(env: Env): string {
  return join(homeDir(env)!, ".agents", "skills");
}

/** The command that starts this same solobooks as an MCP server: the binary itself, or bun running this source. */
export function mcpCommand(): string[] {
  const compiled = Bun.main.startsWith("/$bunfs/") || /^[A-Za-z]:\\~BUN\\/.test(Bun.main);
  return compiled ? [process.execPath, "mcp"] : [process.execPath, resolve(import.meta.dir, "cli.ts"), "mcp"];
}

// ---------------------------------------------------------------- reading and writing entries

function readText(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

function parseJson(file: string, text: string): Record<string, any> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Refusal(`${file} isn't valid JSON, so solobooks left it alone; fix it, then run solobooks setup again.`, "config");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Refusal(`${file} doesn't hold a JSON object, so solobooks left it alone; fix it, then run solobooks setup again.`, "config");
  }
  return v as Record<string, any>;
}

function parseToml(file: string, text: string): Record<string, any> {
  try {
    return Bun.TOML.parse(text) as Record<string, any>;
  } catch {
    throw new Refusal(`${file} isn't valid TOML, so solobooks left it alone; fix it, then run solobooks setup again.`, "config");
  }
}

/** The solobooks entry an agent's config holds now, or null. */
export function readEntry(a: Agent): Record<string, unknown> | null {
  const text = readText(a.config);
  if (text === null) return null;
  const doc = a.format === "json" ? parseJson(a.config, text) : parseToml(a.config, text);
  const servers = a.format === "json" ? doc.mcpServers : doc.mcp_servers;
  const e = servers && typeof servers === "object" ? servers[SERVER] : undefined;
  return e && typeof e === "object" ? (e as Record<string, unknown>) : null;
}

/** Stable JSON, so two entries compare equal whatever order their keys were written in. */
function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(norm) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm((v as any)[k])])) : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

const tomlString = (s: string) => JSON.stringify(s); // a JSON string is a valid TOML basic string

/** The config text with the [mcp_servers.solobooks] table, and any of its sub-tables, replaced by this entry. */
export function withTomlTable(text: string, entry: { command: string; args: string[] }): string {
  const block = [`[mcp_servers.${SERVER}]`, `command = ${tomlString(entry.command)}`, `args = [${entry.args.map(tomlString).join(", ")}]`];
  const lines = text.split("\n");
  const ours = (l: string) => /^\s*\[\s*mcp_servers\s*\.\s*("solobooks"|solobooks)\s*(\]|\.)/.test(l);
  const header = (l: string) => /^\s*\[/.test(l);
  const out: string[] = [];
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    if (ours(lines[i]!)) {
      if (at === -1) at = out.length;
      i++;
      while (i < lines.length && !header(lines[i]!)) i++;
      i--;
      continue;
    }
    out.push(lines[i]!);
  }
  if (at === -1) {
    while (out.length && out.at(-1)!.trim() === "") out.pop();
    return [...out, ...(out.length ? [""] : []), ...block, ""].join("\n");
  }
  out.splice(at, 0, ...block, "");
  return out.join("\n");
}

function writeAtomically(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.solobooks-${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/**
 * Puts solobooks' entry into an agent's config, touching nothing else in the file. Writes nothing when the entry is
 * already right, so running it again leaves the file byte-identical.
 */
export function writeEntry(a: Agent, command: string[]): "added" | "updated" | "unchanged" {
  const wanted = a.entry(command);
  const before = readEntry(a);
  if (before !== null && same(before, wanted)) return "unchanged";
  const text = readText(a.config);
  let next: string;
  if (a.format === "json") {
    const doc = text === null ? {} : parseJson(a.config, text);
    const servers = doc.mcpServers && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers) ? doc.mcpServers : {};
    doc.mcpServers = { ...servers, [SERVER]: wanted };
    next = JSON.stringify(doc, null, 2) + (text === null || text.endsWith("\n") ? "\n" : "");
  } else {
    next = withTomlTable(text ?? "", wanted as { command: string; args: string[] });
    // Never leave a config the agent can't read: check the edit parses and holds exactly this entry.
    let check: Record<string, any> | null = null;
    try {
      check = Bun.TOML.parse(next) as Record<string, any>;
    } catch {
      check = null;
    }
    if (!check || !same(check.mcp_servers?.[SERVER], wanted)) {
      throw new Refusal(
        `${a.config} defines mcp_servers in a way solobooks can't safely edit, so it left the file alone; add a [mcp_servers.${SERVER}] table with command = ${tomlString(command[0]!)} by hand.`,
        "config",
      );
    }
  }
  writeAtomically(a.config, next);
  return before === null ? "added" : "updated";
}
