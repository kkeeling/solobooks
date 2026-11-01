import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { type Agent, knownAgents, mcpCommand, sharedSkillDir, writeEntry } from "./agents.ts";
import { absolute, booksFile, type Config, configFile, type Env, homeDir, now, readConfig, syncedFolder, writeIfChanged } from "./config.ts";
import { hasBooks, hasHistory, openBooks } from "./core/db.ts";
import { Refusal } from "./core/refusal.ts";
import { flag, onlyFlags } from "./durability.ts";
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
  const named = flag(argv, "books");
  const warnings: string[] = [];

  // Damaged settings can't say where the books are, so setup only rewrites them once told.
  let recorded: Config = {};
  let damaged = false;
  try {
    recorded = readConfig(env);
  } catch (e) {
    if (!(e instanceof Refusal) || e.field !== "config" || !(named || env.SOLOBOOKS_DIR)) throw e;
    damaged = true;
  }

  // The books folder: the one asked for, else the one already chosen, else ~/solobooks. Only --books, or a first
  // setup with nothing chosen yet, may start new books; a folder that was already chosen and has none is a problem.
  const chosen = env.SOLOBOOKS_DIR || recorded.books;
  const dir = absolute(named ?? chosen ?? join(home, "solobooks"), home);
  const fresh = !hasBooks(booksFile(dir));
  if (fresh && !named && chosen) {
    throw new Refusal(
      `There are no books in "${dir}", so setup changed nothing; if they moved or their drive is unplugged, put them back, and to start new books there run solobooks setup --books "${dir}".`,
      "books",
    );
  }
  const left = recorded.books ? absolute(recorded.books, home) : null;
  // Books never written to hold nothing to carry over, as when a new install moves off a synced folder.
  if (fresh && left && left !== dir && hasBooks(booksFile(left)) && hasHistory(booksFile(left))) {
    warnings.push(`solobooks now uses new, empty books in "${dir}", and your books are still in "${left}"; to carry them over, run solobooks setup --books "${left}", then solobooks move --to <empty folder>.`);
  }
  if (!fresh && left && left !== dir && hasBooks(booksFile(left)) && hasHistory(booksFile(left))) {
    warnings.push(`solobooks now uses the books in "${dir}", and the books it was using are still in "${left}" with work in them; to go back, run solobooks setup --books "${left}".`);
  }
  if (fresh && damaged) {
    warnings.push(`solobooks started new, empty books in "${dir}"; if your books are somewhere else, run solobooks setup --books <that folder>.`);
  }
  const synced = syncedFolder(dir, home);
  if (synced) {
    const how = fresh ? "solobooks setup --books <dir>" : "solobooks move --to <empty folder>, which carries the books with it";
    warnings.push(`The books folder ${dir} is inside ${synced}, and syncing a live books file can corrupt it, so choose a folder outside it, such as ${join(home, "solobooks")}, with ${how}.`);
  }
  try {
    openBooks(booksFile(dir), { backups: recorded.backups ?? null, now: now(env), create: true }).close();
  } catch (e) {
    if (e instanceof Refusal) throw e;
    throw new Refusal(`solobooks can't use "${dir}" for the books (${e instanceof Error ? e.message : e}), so setup changed nothing; check that folder, or choose another with solobooks setup --books <folder>.`, "books");
  }
  const settings = configFile(env)!;
  // The damaged copy stays, and only now, once the folder has proved it works.
  if (damaged) {
    let copy = `${settings}.damaged`;
    for (let n = 2; existsSync(copy); n++) copy = `${settings}.damaged-${n}`;
    renameSync(settings, copy);
    warnings.push(`The settings file was damaged, so it is saved as ${copy} and written again; if you had picked a backup folder, pick it again with solobooks backup set --folder <dir>, and if you had chosen a port for the approval page, choose it again with solobooks serve --port <n>.`);
  }
  writeIfChanged(settings, JSON.stringify({ ...recorded, books: dir }, null, 2) + "\n");
  if (named && env.SOLOBOOKS_DIR && absolute(env.SOLOBOOKS_DIR, home) !== dir) {
    warnings.push(`SOLOBOOKS_DIR says ${env.SOLOBOOKS_DIR}, which wins over the settings, so later commands in this shell use that folder, not ${dir}; point it at ${dir} or unset it.`);
  }

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
    ...(fresh && { started_new_books: true }),
    settings,
    mcp_command: command,
    agents: connected,
    skills,
    warnings,
    next: "Run solobooks doctor to check every connection. Set up your business details now, through the CLI, then restart your agent app so it loads the solobooks tools.",
  };
}
