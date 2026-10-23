import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { type Agent, knownAgents, mcpCommand, sharedSkillDir, writeEntry } from "./agents.ts";
import { booksFile, configFile, type Env, homeDir, readConfig } from "./config.ts";
import { openBooks } from "./core/db.ts";
import { Refusal } from "./core/refusal.ts";
import { SKILL_FILES, SKILL_NAME } from "./skill.ts";

// `solobooks setup`: settles the books folder, registers the MCP server with every agent it finds, and copies the
// agent guide where agents read skills. Safe to run again: a second run changes nothing.

/** Expands a leading ~ and makes the path absolute. */
function absolute(p: string, home: string): string {
  return resolve(p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);
}

/** Folders that sync files while solobooks writes them, which can corrupt a live SQLite file. */
function syncedFolder(dir: string, home: string): string | null {
  const real = (p: string) => {
    let at = p;
    while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
    try {
      return join(realpathSync(at), p.slice(at.length));
    } catch {
      return p;
    }
  };
  const under = (p: string, base: string) => p === base || p.startsWith(base + sep);
  const h = (...parts: string[]) => join(home, ...parts);
  const named: [string, string][] = [
    [h("Library", "Mobile Documents"), "iCloud Drive"],
    [h("Library", "CloudStorage"), "a cloud drive (Dropbox, OneDrive or Google Drive)"],
    [h("Dropbox"), "Dropbox"],
    [h("Google Drive"), "Google Drive"],
    [h("My Drive"), "Google Drive"],
    [h("iCloudDrive"), "iCloud Drive"],
  ];
  // iCloud's Desktop & Documents option on a Mac, and OneDrive's folder backup on Windows, sync these two.
  if (process.platform !== "linux") named.push([h("Documents"), "Documents, which iCloud or OneDrive may sync"], [h("Desktop"), "Desktop, which iCloud or OneDrive may sync"]);
  for (const p of new Set([dir, real(dir)])) {
    for (const [base, what] of named) if (under(p, base)) return what;
    const rel = p.startsWith(home + sep) ? p.slice(home.length + 1) : "";
    if (/^OneDrive( |-|$)/.test(rel.split(sep)[0] ?? "")) return "OneDrive";
  }
  return null;
}

function writeIfChanged(file: string, text: string): boolean {
  if (existsSync(file) && readFileSync(file, "utf8") === text) return false;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.solobooks-${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
  return true;
}

/** Copies the agent guide into one skills folder; returns whether anything changed. */
export function installSkill(skillsDir: string): boolean {
  let changed = false;
  for (const [rel, text] of Object.entries(SKILL_FILES)) changed = writeIfChanged(join(skillsDir, SKILL_NAME, rel), text) || changed;
  return changed;
}

/** Where the guide goes: the shared folder, plus each detected agent's own. */
export function skillDirs(env: Env, agents: Agent[]): string[] {
  return [sharedSkillDir(env), ...agents.filter((a) => a.detected && !a.plugin).flatMap((a) => a.skillDirs)];
}

export function setup(argv: string[], env: Env) {
  const home = homeDir(env);
  if (!home) throw new Refusal("solobooks can't tell where your home folder is, because HOME isn't set.", "HOME");
  const i = argv.indexOf("--books");
  const flag = i === -1 ? undefined : argv[i + 1];
  if (i !== -1 && !flag) throw new Refusal("That flag needs a value after it.", "books");

  // The books folder: the one asked for, else the one already chosen, else ~/solobooks.
  const dir = absolute(flag ?? env.SOLOBOOKS_DIR ?? readConfig(env).books ?? join(home, "solobooks"), home);
  const warnings: string[] = [];
  const synced = syncedFolder(dir, home);
  if (synced) {
    warnings.push(
      `The books folder ${dir} is inside ${synced}, and syncing a live books file can corrupt it, so choose a folder outside it, such as ${join(home, "solobooks")}, with solobooks setup --books <dir>.`,
    );
  }
  openBooks(booksFile(dir)).close();
  const settings = configFile(env)!;
  writeIfChanged(settings, JSON.stringify({ ...readConfig(env), books: dir }, null, 2) + "\n");

  const agents = knownAgents(env);
  const command = mcpCommand();
  const connected = agents.map((a) => {
    if (!a.detected) return { agent: a.name, detected: false };
    if (a.plugin) return { agent: a.name, detected: true, mcp: "plugin", plugin: a.plugin };
    try {
      return { agent: a.name, detected: true, config: a.config, mcp: writeEntry(a, command) };
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      warnings.push(e.reason);
      return { agent: a.name, detected: true, config: a.config, mcp: "failed" };
    }
  });
  if (!agents.some((a) => a.detected)) {
    warnings.push("No agent app was found for this person, so install Claude Code or Codex, then run solobooks setup again.");
  }
  const skills = skillDirs(env, agents).map((d) => ({ folder: join(d, SKILL_NAME), changed: installSkill(d) }));

  return {
    books: dir,
    settings,
    mcp_command: command,
    agents: connected,
    skills,
    warnings,
    next: "Run solobooks doctor to check every connection, then restart your agent app so it loads the solobooks tools.",
  };
}
