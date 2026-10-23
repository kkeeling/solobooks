import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServer } from "../../src/mcp.ts";

/**
 * A bare JSON-RPC client wired to an in-process solobooks MCP server. `capabilities` are what it declares at
 * initialize; `answer` replies to requests the server sends it (an elicitation is the person answering in chat).
 */
export async function inProcessMcp(
  dir: string,
  env: Record<string, string> = {},
  o: { capabilities?: Record<string, unknown>; answer?: (req: { method: string; params: any }) => unknown } = {},
) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer(env, dir);
  await server.connect(serverSide);
  const pending = new Map<number, (m: any) => void>();
  const asked: { method: string; params: any }[] = [];
  clientSide.onmessage = (m: any) => {
    if (m.method !== undefined && m.id !== undefined) {
      asked.push({ method: m.method, params: m.params });
      const result = o.answer ? o.answer(m) : undefined;
      clientSide.send(
        (result === undefined
          ? { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not supported" } }
          : { jsonrpc: "2.0", id: m.id, result }) as any,
      );
      return;
    }
    pending.get(m.id)?.(m);
  };
  await clientSide.start();
  let nextId = 1;
  const request = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      clientSide.send({ jsonrpc: "2.0", id, method, params } as any);
    });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: o.capabilities ?? {}, clientInfo: { name: "test", version: "0" } });
  await clientSide.send({ jsonrpc: "2.0", method: "notifications/initialized" } as any);
  return {
    request,
    /** Requests the server sent this client, such as elicitation/create. */
    asked,
    call: async (name: string, args: Record<string, unknown>) => (await request("tools/call", { name, arguments: args })).result,
    close: () => server.close(),
  };
}

/** Speaks newline-delimited JSON-RPC to `bun src/mcp.ts` over real stdio. */
export async function stdioMcp(dir: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", "src/mcp.ts", "--books", dir], {
    cwd: `${import.meta.dir}/../..`,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH!, ...env },
  });
  const reader = proc.stdout.getReader();
  let buf = "";
  const waiting = new Map<number, (m: any) => void>();
  (async () => {
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value);
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        waiting.get(m.id)?.(m);
      }
    }
  })();
  let nextId = 1;
  const send = (m: unknown) => {
    proc.stdin.write(JSON.stringify(m) + "\n");
    proc.stdin.flush();
  };
  const request = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
    });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return {
    request,
    call: async (name: string, args: Record<string, unknown>) => (await request("tools/call", { name, arguments: args })).result,
    close: async () => {
      proc.stdin.end();
      await proc.exited;
      return new Response(proc.stderr).text();
    },
  };
}
