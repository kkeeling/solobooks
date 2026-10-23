#!/usr/bin/env bun
import { fromJsonSchema, type JsonSchemaType, type JsonSchemaValidator, type jsonSchemaValidator, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { booksDir, booksFile, now, type Env } from "./config.ts";
import { openForRun } from "./core/db.ts";
import type { Op } from "./core/op.ts";
import { OPS, performAsync } from "./core/perform.ts";
import { Refusal } from "./core/refusal.ts";
import type { Field, Fields } from "./core/validate.ts";

// Thin adapter: one MCP tool per core operation, over stdio. Logs go to stderr only.

const VERSION = "0.0.0";

function jsonSchema(f: Field): Record<string, unknown> {
  const base = { description: f.description };
  switch (f.type) {
    case "text":
      return { ...base, type: "string" };
    case "int":
      return { ...base, type: "integer", ...(f.min !== undefined && { minimum: f.min }), ...(f.max !== undefined && { maximum: f.max }) };
    case "date":
      return { ...base, type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
    case "enum":
      return { ...base, type: "string", enum: [...f.values] };
    case "list":
      return { ...base, type: "array", items: objectSchema(f.of) };
    case "set":
      return { ...base, type: "array", items: { type: "string", enum: [...f.values] }, uniqueItems: true };
  }
}

/**
 * Advertises the fields, but leaves checking to the core (no `required`, open properties), so a bad call gets
 * the same one-sentence reason and field from MCP as from the CLI.
 */
function objectSchema(fields: Fields): Record<string, unknown> {
  return { type: "object", properties: Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, jsonSchema(f)])) };
}

const ENVELOPE_FIELDS: Fields = {
  source: { type: "text", required: true, description: "Where this write came from, such as agent:claude-code or person." },
  idempotency_key: { type: "text", description: "Retrying with the same key is a no-op; reusing it for a different write is refused." },
};

/** Passes every call through to the core, which returns the reason and field when it refuses. */
const coreValidates: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input) => ({ valid: true, data: input as T, errorMessage: undefined });
  },
};

function toolSchema(op: Op) {
  const s = objectSchema(op.kind === "write" ? { ...op.fields, ...ENVELOPE_FIELDS } : op.fields) as any;
  if (op.kind === "write") s.properties.dry_run = { type: "boolean", description: "Check the write and return what it would do, changing nothing." };
  return s;
}

export function createServer(env: Env, books?: string): McpServer {
  const server = new McpServer({ name: "solobooks", version: VERSION }, { capabilities: { tools: {} } });
  for (const op of OPS) {
    server.registerTool(
      op.name,
      {
        description: op.description,
        inputSchema: fromJsonSchema(toolSchema(op) as JsonSchemaType, coreValidates),
        annotations: {
          readOnlyHint: op.kind === "read" && !op.savesFile,
          destructiveHint: op.destructive === true,
          idempotentHint: op.kind === "read",
          openWorldHint: false,
        },
      },
      async (args: any) => {
        const { source, idempotency_key, dry_run, ...input } = args ?? {};
        let result: Record<string, unknown>;
        let isError = false;
        try {
          const dryRun = dry_run === true;
          const db = openForRun(booksFile(booksDir(books, env)), dryRun);
          try {
            const r = await performAsync(db, op.name, input, { source, idempotency_key, dry_run: dryRun, now: now(env) });
            result = r.ok ? r.result : r.refusal;
            isError = !r.ok;
          } finally {
            db.close();
          }
        } catch (e) {
          if (!(e instanceof Refusal)) throw e;
          result = e.toJSON();
          isError = true;
        }
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError };
      },
    );
  }
  return server;
}

if (import.meta.main) {
  const i = process.argv.indexOf("--books");
  const books = i === -1 ? undefined : process.argv[i + 1];
  serveStdio(() => createServer(process.env, books), {
    onerror: (e) => console.error("solobooks mcp:", e),
  });
  console.error(`solobooks mcp ${VERSION} on stdio`);
}
