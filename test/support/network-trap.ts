import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

/** Records every outbound connection attempt made through the runtime's network entry points. */
export function trapNetwork() {
  const attempts: string[] = [];
  const restore: (() => void)[] = [];
  const patch = (obj: any, key: string, label: string) => {
    const orig = obj[key];
    obj[key] = function (...args: any[]) {
      attempts.push(`${label} ${describe(args)}`);
      throw new Error(`network trapped: ${label}`);
    };
    restore.push(() => (obj[key] = orig));
  };
  patch(globalThis, "fetch", "fetch");
  patch(Bun, "connect", "Bun.connect");
  patch(Bun, "udpSocket", "Bun.udpSocket");
  patch(net, "connect", "net.connect");
  patch(net, "createConnection", "net.createConnection");
  patch(net.Socket.prototype, "connect", "net.Socket.connect");
  patch(tls, "connect", "tls.connect");
  patch(http, "request", "http.request");
  patch(http, "get", "http.get");
  patch(https, "request", "https.request");
  patch(https, "get", "https.get");
  patch(dgram, "createSocket", "dgram.createSocket");
  patch(dns, "lookup", "dns.lookup");
  patch(dns, "resolve", "dns.resolve");
  patch(globalThis, "WebSocket", "WebSocket");
  return {
    attempts,
    /** Attempts that aren't to loopback. */
    nonLoopback: () => attempts.filter((a) => !/\b(127\.0\.0\.1|localhost|::1)\b/.test(a)),
    release: () => restore.reverse().forEach((r) => r()),
  };
}

function describe(args: any[]): string {
  try {
    return JSON.stringify(args.map((a) => (typeof a === "function" ? "fn" : a instanceof URL ? a.href : a)));
  } catch {
    return String(args[0]);
  }
}
