import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Env } from "./config.ts";
import { Refusal } from "./core/refusal.ts";

// `solobooks addon run <script> [args...]`: runs an add-on's own TypeScript or JavaScript with the runtime this binary
// already carries, so the person needs no bun or Node. solobooks knows nothing about what an add-on does. The script's
// default export gets its arguments and solobooks' own CLI as a function, so it changes the books only through the
// same commands, refusals and gate as everyone else.

/** solobooks' CLI, in-process: argv in, exit code and printed output back. */
export type Solobooks = (argv: string[]) => Promise<{ code: number; stdout: string }>;
export type Addon = (args: string[], solobooks: Solobooks, env: Env) => number | Promise<number>;

const SCRIPT = /\.(ts|js|mjs)$/;

export async function runAddon(argv: string[], env: Env, solobooks: Solobooks): Promise<number> {
  const [verb, script, ...args] = argv;
  if (verb !== "run") throw new Refusal("Say solobooks addon run <script> [args...].", "command");
  if (!script) throw new Refusal("Give the add-on's script, the path its skill names.", "script");
  const file = resolve(script);
  if (!SCRIPT.test(file) || !existsSync(file) || !statSync(file).isFile()) {
    throw new Refusal(`There is no add-on script at ${file}; give the .ts or .js file its skill names.`, "script");
  }
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.default !== "function") throw new Refusal(`${file} has no default export for solobooks to run.`, "script");
  const code = await (mod.default as Addon)(args, solobooks, env);
  return Number.isInteger(code) ? code : 0;
}
