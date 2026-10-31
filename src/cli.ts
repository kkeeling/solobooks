#!/usr/bin/env bun
// First, before anything that loads the passkey library: in a compiled binary its dependency injection would otherwise
// start before this polyfill and crash.
import "reflect-metadata";
import { resolve } from "node:path";
import { booksDir, booksFile, now, pagePort, pageUrl, readConfig, saveConfig, type Env } from "./config.ts";
import { openForRun } from "./core/db.ts";
import { findOp, OPS, performAsync } from "./core/perform.ts";
import { Refusal } from "./core/refusal.ts";
import { coerceFlags } from "./core/validate.ts";
import { beforeWrite, onlyFlags, openOptions, withWarnings } from "./durability.ts";
import { startPage } from "./page.ts";
import { VERSION } from "./version.ts";

// Thin adapter: argv in, JSON out. All logic lives in src/core.

const ENVELOPE = new Set(["books", "json", "dry-run", "idempotency-key", "source"]);

/** Commands that aren't operations on the books. None of them approves anything. */
const COMMANDS = [
  {
    command: "serve",
    kind: "page",
    description:
      "Run the local approval page on localhost until stopped. It uses port 7317, or SOLOBOOKS_PORT, or --port, which solobooks remembers so approval links open the right page. The person approves or rejects pending actions there, and registers a passkey.",
  },
  {
    command: "setup",
    kind: "install",
    description:
      "Connect solobooks to every agent app found here: registers its MCP server, copies the solobooks skill where agents read skills, and settles the books folder (--books <dir>, default ~/solobooks), which later commands then use. It is the only command that starts new books. Safe to run again.",
  },
  {
    command: "doctor",
    kind: "install",
    description:
      "Check the install: opens the books, and for each agent app found, checks the MCP server is registered and answers, and the skill is in place. Exits non-zero, saying how to fix it, when something is wrong.",
  },
  {
    command: "backup set",
    kind: "install",
    description:
      "Pick the folder backups go to (--folder <dir>). solobooks then writes a dated copy of the books there once a day, the first time they change that day, and keeps every one; it writes today's at once.",
  },
  {
    command: "move",
    kind: "install",
    description:
      "Copy the books to a new, empty folder (--to <dir>): the books file, receipts, invoice PDFs and statements, each checked, and point the settings at it. The old folder is left as it was.",
  },
  {
    command: "addon run",
    kind: "addon",
    description:
      "Run an add-on's script with the runtime solobooks carries, so nothing else needs installing: solobooks addon run <script> [args...]. The add-on's skill names its script; it changes the books only through these same commands.",
  },
  { command: "mcp", kind: "install", description: "Serve the MCP tools over stdio. Agent apps start this; you don't run it by hand." },
  { command: "version", kind: "install", description: "Print the solobooks version (also --version)." },
];

function parse(argv: string[]) {
  const words: string[] = [];
  const flags: Record<string, string> = {};
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      words.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (name === "dry-run") {
      dryRun = true;
      continue;
    }
    const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (value === undefined) throw new Refusal("That flag needs a value after it.", name.replaceAll("-", "_"));
    flags[name] = value;
  }
  return { words, flags, dryRun };
}

function help() {
  return {
    usage: "solobooks <noun> <verb> [--field value ...] [--json '{...}'] --books <dir> [--source s] [--idempotency-key k] [--dry-run]",
    commands: [
      ...OPS.map((o) => ({
        command: o.name.replaceAll("_", " "),
        kind: o.kind,
        description: o.description,
        fields: o.fields,
      })),
      ...COMMANDS,
    ],
  };
}

export async function run(argv: string[], env: Env = process.env): Promise<{ code: number; stdout: string; text?: true }> {
  const out = (code: number, v: unknown) => ({ code, stdout: JSON.stringify(v, null, 2) });
  try {
    const { words, flags, dryRun } = parse(argv);
    if (words.length === 0 || words[0] === "help") return out(0, help());
    const op = findOp(words.join("_"));
    if (!op) throw new Refusal("There is no such command; run solobooks help for the list.", "command");

    let json: unknown = {};
    if (flags.json !== undefined) {
      try {
        json = JSON.parse(flags.json);
      } catch {
        throw new Refusal("The --json value is not valid JSON.", "json");
      }
      if (typeof json !== "object" || json === null || Array.isArray(json)) {
        throw new Refusal("The --json value must be a JSON object.", "json");
      }
    }
    const fieldFlags: Record<string, string> = {};
    for (const [k, v] of Object.entries(flags)) if (!ENVELOPE.has(k)) fieldFlags[k.replaceAll("-", "_")] = v;
    const input = { ...(json as object), ...coerceFlags(fieldFlags, op.fields) };

    const dir = booksDir(flags.books, env);
    const db = openForRun(booksFile(dir), dryRun, openOptions(env));
    try {
      const warnings = op.kind === "write" ? beforeWrite(db, dir, env, dryRun) : [];
      const r = await performAsync(db, op.name, input, {
        source: flags.source,
        idempotency_key: flags["idempotency-key"],
        dry_run: dryRun,
        now: now(env),
        page: pageUrl(env),
      });
      // A file, such as an export, prints as itself so it can be redirected into a file; everything else is JSON.
      if (r.ok && op.text !== undefined && typeof r.result[op.text] === "string") return { code: 0, stdout: r.result[op.text] as string, text: true };
      return r.ok ? out(0, withWarnings(r.result, warnings)) : out(2, r.refusal);
    } finally {
      db.close();
    }
  } catch (e) {
    if (e instanceof Refusal) return out(2, e.toJSON());
    return out(1, { error: e instanceof Error ? e.message : String(e) });
  }
}

/** Starts the approval page for `solobooks serve`; returns a refusal instead when it can't. */
export async function serve(argv: string[], env: Env = process.env) {
  onlyFlags(argv.slice(1), "books", "port");
  const { flags } = parse(argv.slice(1));
  if (flags.port === "") throw new Refusal("That flag needs a value after it.", "port");
  if (flags.port !== undefined && env.SOLOBOOKS_PORT && env.SOLOBOOKS_PORT !== flags.port) {
    throw new Refusal(`SOLOBOOKS_PORT says ${env.SOLOBOOKS_PORT} and --port says ${flags.port}, and approval links would follow the variable, so use one or the other.`, "port");
  }
  const port = flags.port !== undefined ? pagePort({ SOLOBOOKS_PORT: flags.port }) : pagePort(env);
  // A test seam: holds the page's data back this many milliseconds, so its loading state can be seen and captured.
  const delay = env.SOLOBOOKS_PAGE_DELAY_MS ? Number(env.SOLOBOOKS_PAGE_DELAY_MS) : 0;
  if (!Number.isInteger(delay) || delay < 0 || delay > 600_000) {
    throw new Refusal("SOLOBOOKS_PAGE_DELAY_MS must be a whole number of milliseconds from 0 to 600000.", "SOLOBOOKS_PAGE_DELAY_MS");
  }
  const books = booksDir(flags.books, env);
  let page;
  try {
    page = startPage({ books, port, env, dataDelayMs: delay });
  } catch (e) {
    if ((e as { code?: string }).code !== "EADDRINUSE") throw e;
    throw new Refusal(`Port ${port} is already in use, so solobooks serve may already be running at http://localhost:${port}/; open that, or choose another port with solobooks serve --port <n>.`, "port");
  }
  // Pending actions are made by other processes, so they learn the port from the settings. Books other than the
  // recorded ones are a one-off, and don't move the page for the person's real books.
  if (flags.port !== undefined) rememberPort(port, books, env);
  return page;
}

function rememberPort(port: number, books: string, env: Env): void {
  try {
    const recorded = readConfig(env).books;
    if (!recorded || resolve(recorded) === resolve(books)) saveConfig(env, { port });
  } catch (e) {
    console.error(`solobooks serve: couldn't record port ${port} in the settings, so approval links may point elsewhere: ${e instanceof Error ? e.message : e}`);
  }
}

/** Runs setup, doctor, backup set or move and prints its JSON; doctor exits 1 when a check failed. */
export async function install(word: string, argv: string[], env: Env = process.env): Promise<{ code: number; stdout: string }> {
  const out = (code: number, v: unknown) => ({ code, stdout: JSON.stringify(v, null, 2) });
  try {
    if (word === "setup") return out(0, (await import("./setup.ts")).setup(argv, env));
    if (word === "move") return out(0, (await import("./move.ts")).move(argv, env));
    if (word === "backup") {
      if (argv[0] !== "set") throw new Refusal("There is no such command; run solobooks help for the list.", "command");
      return out(0, (await import("./durability.ts")).backupSet(argv.slice(1), env));
    }
    const r = await (await import("./doctor.ts")).doctor(argv, env);
    return out(r.ok ? 0 : 1, r);
  } catch (e) {
    if (e instanceof Refusal) return out(2, e.toJSON());
    return out(1, { error: e instanceof Error ? e.message : String(e) });
  }
}
/** Prints everything, then exits. Exiting straight after a write loses whatever a pipe hasn't taken yet. */
function finish(text: string, code: number): void {
  process.stdout.on("error", () => process.exit(code)); // the reader went away, as in solobooks help | head -1
  // A full disk is a failure: exit 0 would make a cut-off export look complete.
  process.stdout.write(text, (e) => process.exit(e && (e as { code?: string }).code !== "EPIPE" ? 1 : code));
}

const word = process.argv[2];
if (import.meta.main && (word === "--version" || word === "version")) {
  process.stdout.write(`solobooks ${VERSION}\n`);
} else if (import.meta.main && word === "mcp") {
  try {
    (await import("./mcp.ts")).serveMcp(process.argv.slice(3));
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    console.error(`solobooks mcp: ${e.reason}`); // stdout belongs to the MCP protocol
    process.exit(2);
  }
} else if (import.meta.main && (word === "setup" || word === "doctor" || word === "backup" || word === "move")) {
  const r = await install(word, process.argv.slice(3));
  finish(r.stdout + "\n", r.code);
} else if (import.meta.main && word === "addon") {
  try {
    process.exitCode = await (await import("./addon.ts")).runAddon(process.argv.slice(3), process.env, (argv) => run(argv));
  } catch (e) {
    process.stdout.write(JSON.stringify(e instanceof Refusal ? e.toJSON() : { error: e instanceof Error ? e.message : String(e) }, null, 2) + "\n");
    process.exitCode = e instanceof Refusal ? 2 : 1;
  }
} else if (import.meta.main && word === "serve") {
  try {
    const page = await serve(process.argv.slice(2));
    process.stdout.write(JSON.stringify({ serving: page.url }) + "\n");
  } catch (e) {
    finish(JSON.stringify(e instanceof Refusal ? e.toJSON() : { error: String(e) }) + "\n", e instanceof Refusal ? 2 : 1);
  }
} else if (import.meta.main) {
  const r = await run(process.argv.slice(2));
  finish(r.text ? r.stdout : r.stdout + "\n", r.code);
}
