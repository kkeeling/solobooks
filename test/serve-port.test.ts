import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { run, serve } from "../src/cli.ts";
import { pagePort } from "../src/config.ts";
import { setup } from "../src/setup.ts";
import { tempDir } from "./support/books.ts";
import { inProcessMcp } from "./support/mcp-client.ts";

function person() {
  const home = tempDir();
  mkdirSync(join(home, ".claude"));
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
  const { books } = setup([], env);
  return { env, books };
}

/** A port nothing is using just now. */
function freePort(): number {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = s.port!;
  s.stop(true);
  return port;
}

const gated = ["gate", "set", "--invoice-issue", "agent_decides", "--source", "s"];

test("ISC-143: after serve --port, approve_url opens that page, from the CLI and from MCP", async () => {
  const { env, books } = person();
  const port = freePort();
  const page = await serve(["serve", "--port", String(port)], env);
  try {
    const r = JSON.parse((await run(gated, env)).stdout);
    expect(r.status).toBe("pending");
    expect(r.approve_url).toBe(`http://localhost:${port}/#pending-${r.pending_id}`);
    expect((await fetch(r.approve_url)).status).toBe(200);

    const mcp = await inProcessMcp(books, env);
    try {
      const m = JSON.parse((await mcp.call("gate_set", { invoice_void: "agent_decides", source: "s" })).content[0].text);
      expect(m.approve_url).toBe(`http://localhost:${port}/#pending-${m.pending_id}`);
    } finally {
      await mcp.close();
    }
  } finally {
    page.stop();
  }
  expect(pagePort(env)).toBe(port); // a later plain serve uses the same port
});

test("ISC-143: SOLOBOOKS_PORT still outranks the remembered port, and with neither it's 7317", async () => {
  const { env } = person();
  expect(pagePort(env)).toBe(7317);
  const port = freePort();
  const page = await serve(["serve", "--port", String(port)], env);
  page.stop();
  expect(pagePort({ ...env, SOLOBOOKS_PORT: "45000" })).toBe(45000);
});

test("ISC-144: a second serve on a port already in use refuses in plain words, and leaves the settings alone", async () => {
  const { env } = person();
  const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  try {
    const port = blocker.port!;
    await expect(serve(["serve", "--port", String(port)], env)).rejects.toThrow(`Port ${port} is already in use`);
    expect(pagePort(env)).toBe(7317);
  } finally {
    blocker.stop(true);
  }
});
