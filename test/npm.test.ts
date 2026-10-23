import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../src/version.ts";
import { ROOT } from "./support/books.ts";

// ISC-88, the parts that hold without packing: the npm wrapper only runs the binary npm already installed.
// scripts/npm-check.sh packs it and runs it.

const pkg = JSON.parse(readFileSync(join(ROOT, "npm", "solobooks", "package.json"), "utf8"));
const shim = readFileSync(join(ROOT, "npm", "solobooks", "bin", "solobooks.js"), "utf8");

test("ISC-88: the npm wrapper downloads nothing: no install scripts, no network code, one binary package per platform", () => {
  expect(pkg.name).toBe("solobooks");
  expect(pkg.version).toBe(VERSION);
  expect(pkg.scripts).toBeUndefined(); // no postinstall that could fetch a binary
  expect(pkg.dependencies).toBeUndefined();
  expect(pkg.bin).toEqual({ solobooks: "bin/solobooks.js" });
  expect(pkg.optionalDependencies).toEqual(
    Object.fromEntries(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-x64"].map((p) => [`@solobooks/${p}`, VERSION])),
  );
  // The shim loads child_process to run the binary, and nothing else.
  expect([...shim.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1])).toEqual(["node:child_process"]);
  expect(shim).not.toMatch(/\b(fetch|https?:|XMLHttpRequest|WebSocket|import\()/);
});
