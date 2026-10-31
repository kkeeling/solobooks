import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { type Agent, knownAgents, mcpCommand, sharedSkillDir, writeEntry } from "./agents.ts";
import { absolute, booksFile, type Config, configFile, type Env, homeDir, readConfig, syncedFolder, writeIfChanged } from "./config.ts";
import { openBooks } from "./core/db.ts";
import { Refusal } from "./core/refusal.ts";
import { flag, onlyFlags, openOptions } from "./durability.ts";
import { SKILL_FILES, SKILL_NAME } from "./skill.ts";

// `solobooks setup`: settles the books folder, registers the MCP server with every agent it finds, and copies the
// agent guide where agents read skills. Safe to run again: a second run changes nothing.

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
  onlyFlags(argv, "books");
  const asked = flag(argv, "books") ?? env.SOLOBOOKS_DIR;
  const warnings: string[] = [];

  // Damaged settings can't say where the books are, so setup only rewrites them once told. The damaged copy stays.
  let recorded: Config = {};
  try {
    recorded = readConfig(env);
  } catch (e) {
    if (!(e instanceof Refusal) || !asked) throw e;
    const settings = configFile(env)!;
    renameSync(settings, `${settings}.damaged`);
    warnings.push(`The settings file was damaged, so it is saved as ${settings}.damaged and written again; if you had picked a backup folder, pick it again with solobooks backup set --folder <dir>.`);
  }

  // The books folder: the one asked for, else the one already chosen, else ~/solobooks.
  const dir = absolute(asked ?? recorded.books ?? join(home, "solobooks"), home);
  if (!asked && recorded.books && !existsSync(booksFile(dir))) {
    throw new Refusal(
      `Your books were in ${dir} and aren't there now, so setup changed nothing; if they moved or their drive is unplugged, put them back, and to start new books there run solobooks setup --books ${dir}.`,
      "books",
    );
  }
  const synced = syncedFolder(dir, home);
  if (synced) {
    warnings.push(
      `The books folder ${dir} is inside ${synced}, and syncing a live books file can corrupt it, so choose a folder outside it, such as ${join(home, "solobooks")}, with solobooks setup --books <dir>.`,
    );
  }
  openBooks(booksFile(dir), { ...openOptions(env), create: true }).close();
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
    next: "Run solobooks doctor to check every connection. Set up your business details now, through the CLI, then restart your agent app so it loads the solobooks tools.",
  };
}
