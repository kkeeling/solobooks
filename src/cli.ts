#!/usr/bin/env bun
import { booksDir, booksFile, now, pagePort, pageUrl, type Env } from "./config.ts";
import { openForRun } from "./core/db.ts";
import { findOp, OPS, performAsync } from "./core/perform.ts";
import { Refusal } from "./core/refusal.ts";
import { coerceFlags } from "./core/validate.ts";
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
      "Run the local approval page on localhost (default port 7317, or --port / SOLOBOOKS_PORT) until stopped. The person approves or rejects pending actions there, and registers a passkey.",
  },
  {
    command: "setup",
    kind: "install",
    description:
      "Connect solobooks to every agent app found here: registers its MCP server, copies the solobooks skill where agents read skills, and settles the books folder (--books <dir>, default ~/solobooks), which later commands then use. Safe to run again.",
  },
  {
    command: "doctor",
    kind: "install",
    description:
      "Check the install: opens the books, and for each agent app found, checks the MCP server is registered and answers, and the skill is in place. Exits non-zero, saying how to fix it, when something is wrong.",
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
        command: o.name.replace("_", " "),
        kind: o.kind,
        description: o.description,
        fields: o.fields,
      })),
      ...COMMANDS,
    ],
  };
}

export async function run(argv: string[], env: Env = process.env): Promise<{ code: number; stdout: string }> {
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

    const db = openForRun(booksFile(booksDir(flags.books, env)), dryRun);
    try {
      const r = await performAsync(db, op.name, input, {
        source: flags.source,
        idempotency_key: flags["idempotency-key"],
        dry_run: dryRun,
        now: now(env),
        page: pageUrl(env),
      });
      return r.ok ? out(0, r.result) : out(2, r.refusal);
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
  const { flags } = parse(argv.slice(1));
  const port = flags.port !== undefined ? pagePort({ SOLOBOOKS_PORT: flags.port }) : pagePort(env);
  return startPage({ books: booksDir(flags.books, env), port, env });
}

/** Runs setup or doctor and prints its JSON; doctor exits 1 when a check failed. */
export async function install(word: string, argv: string[], env: Env = process.env): Promise<{ code: number; stdout: string }> {
  const out = (code: number, v: unknown) => ({ code, stdout: JSON.stringify(v, null, 2) });
  try {
    if (word === "setup") return out(0, (await import("./setup.ts")).setup(argv, env));
    const r = await (await import("./doctor.ts")).doctor(argv, env);
    return out(r.ok ? 0 : 1, r);
  } catch (e) {
    if (e instanceof Refusal) return out(2, e.toJSON());
    return out(1, { error: e instanceof Error ? e.message : String(e) });
  }
}
const word = process.argv[2];
if (import.meta.main && (word === "--version" || word === "version")) {
  process.stdout.write(`solobooks ${VERSION}\n`);
} else if (import.meta.main && word === "mcp") {
  (await import("./mcp.ts")).serveMcp(process.argv.slice(3));
} else if (import.meta.main && (word === "setup" || word === "doctor")) {
  const r = await install(word, process.argv.slice(3));
  process.stdout.write(r.stdout + "\n");
  process.exit(r.code);
} else if (import.meta.main && word === "serve") {
  try {
    const page = await serve(process.argv.slice(2));
    process.stdout.write(JSON.stringify({ serving: page.url }) + "\n");
  } catch (e) {
    process.stdout.write(JSON.stringify(e instanceof Refusal ? e.toJSON() : { error: String(e) }) + "\n");
    process.exit(e instanceof Refusal ? 2 : 1);
  }
} else if (import.meta.main) {
  const r = await run(process.argv.slice(2));
  process.stdout.write(r.stdout + "\n");
  process.exit(r.code);
}
