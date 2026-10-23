import { expect, test } from "bun:test";
import { cli, dumpFile, dbPath, tempDir } from "./support/books.ts";

test("ISC-10 conflict: the same idempotency key with a different payload is refused", async () => {
  const dir = tempDir();
  const base = ["client", "add", "--source", "agent:test", "--idempotency-key", "k-1"];
  expect((await cli(dir, [...base, "--name", "Acme"])).code).toBe(0);
  const before = dumpFile(dbPath(dir));

  const r = await cli(dir, [...base, "--name", "Beta"]);
  expect(r.code).toBe(2);
  expect(r.out).toEqual({
    reason: "This idempotency_key was already used for a different write, so use a new key.",
    field: "idempotency_key",
  });
  expect(dumpFile(dbPath(dir))).toEqual(before);

  // A different operation under the same key is a different payload too.
  const other = await cli(dir, ["account", "add", "--name", "Acme", "--type", "asset", "--source", "agent:test", "--idempotency-key", "k-1"]);
  expect(other.out.field).toBe("idempotency_key");
});
