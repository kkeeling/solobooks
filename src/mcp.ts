#!/usr/bin/env bun
import {
  createRequestStateCodec,
  fromJsonSchema,
  inputRequired,
  inputResponse,
  type JsonSchemaType,
  type JsonSchemaValidator,
  type jsonSchemaValidator,
  McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { booksDir, booksFile, now, pageUrl, type Env } from "./config.ts";
import { approvePending } from "./core/approve.ts";
import { type Books, openForRun } from "./core/db.ts";
import { dollars } from "./core/format.ts";
import { getPending, type PendingAction, waiting } from "./core/gate.ts";
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
    case "ids":
      return { ...base, type: "array", items: { type: "integer", minimum: 1 }, uniqueItems: true };
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

/** Marks a tool whose call may need the person, so the agent app asks them instead of running it unattended. */
export const REQUIRES_USER = "anthropic/requiresUserInteraction";

// Carries the pending action's id through the person's answer in chat. Signed, so a client can't swap in another id.
const approvals = createRequestStateCodec<{ pending_id: number }>({
  key: crypto.getRandomValues(new Uint8Array(32)),
  ttlSeconds: 3600,
  bind: (ctx) => ctx.mcpReq.method,
});

type Reply = { content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown>; isError: boolean };
const reply = (result: Record<string, unknown>, isError = false): Reply => ({
  content: [{ type: "text", text: JSON.stringify(result) }],
  structuredContent: result,
  isError,
});

/** The approval prompt the agent app shows the person. A batch lists each invoice so one can be pulled out. */
function approvalForm(p: PendingAction) {
  const batch = Array.isArray(p.input.ids);
  const properties = batch
    ? Object.fromEntries(
        p.items.map((it: any) => [
          `include_${it.invoice_id}`,
          { type: "boolean", title: `${it.client}, ${dollars(it.total_cents)}`, description: "Untick to keep this invoice a draft.", default: true },
        ]),
      )
    : {};
  const message = batch ? `${p.title} Untick any invoice to keep it a draft.` : p.title;
  return inputRequired.elicit({ mode: "form", message, requestedSchema: { type: "object", properties } } as any);
}

export function createServer(env: Env, books?: string): McpServer {
  const server = new McpServer(
    { name: "solobooks", version: VERSION },
    { capabilities: { tools: {} }, requestState: { verify: approvals.verify } },
  );
  const page = () => pageUrl(env);

  /** Whether this agent app can show the person a form and hand back their answer. */
  const asksPerson = () => {
    const e = server.server.getClientCapabilities()?.elicitation as Record<string, unknown> | undefined;
    return e !== undefined && (Object.keys(e).length === 0 || "form" in e);
  };

  /** The person answered the approval prompt: accept approves inside this same call; anything else leaves it waiting. */
  function answered(db: Books, id: number, ctx: ServerContext): Reply {
    const p = getPending(db, id);
    if (!p) return reply({ reason: `There is no pending action with id ${id}.`, field: "pending_id" }, true);
    const view = inputResponse(ctx.mcpReq.inputResponses, "approval");
    if (p.status === "pending" && view.kind === "elicit" && view.action === "accept") {
      const ids: number[] = Array.isArray(p.input.ids) ? p.input.ids : [];
      const exclude = ids.filter((x) => view.content?.[`include_${x}`] === false);
      if (ids.length === 0 || exclude.length < ids.length) {
        const r = approvePending(db, id, { via: "elicitation", exclude }, { now: now(env), page: page() });
        return r.ok ? reply(r.result) : reply(r.refusal, true);
      }
    }
    return reply({ ...waiting(p, page()), message: `The person didn't approve this in chat, so it is still waiting; they can approve it on the approval page at ${page()}.` });
  }

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
        ...(op.gate && { _meta: { [REQUIRES_USER]: true } }),
      },
      async (args: any, ctx: ServerContext) => {
        const { source, idempotency_key, dry_run, ...input } = args ?? {};
        try {
          const dryRun = dry_run === true;
          const db = openForRun(booksFile(booksDir(books, env)), dryRun);
          try {
            const state = op.gate ? ctx.mcpReq.requestState<{ pending_id: number }>() : undefined;
            if (state !== undefined && Number.isInteger(state?.pending_id)) return answered(db, state.pending_id, ctx);

            const r = await performAsync(db, op.name, input, { source, idempotency_key, dry_run: dryRun, now: now(env), page: page() });
            if (!r.ok) return reply(r.refusal, true);
            // Click level: ask the person right here when the app can. Passkey level only ever goes to the page.
            const asked = r.result;
            if (asked.status === "pending" && asked.level === "click" && !dryRun && asksPerson()) {
              const p = getPending(db, asked.pending_id as number);
              if (p?.status === "pending") {
                return inputRequired({ inputRequests: { approval: approvalForm(p) }, requestState: await approvals.mint({ pending_id: p.id }, ctx) });
              }
            }
            return reply(asked);
          } finally {
            db.close();
          }
        } catch (e) {
          if (!(e instanceof Refusal)) throw e;
          return reply(e.toJSON(), true);
        }
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
