import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { install } from "../src/cli.ts";
import { configFile } from "../src/config.ts";
import { dbPath, tempDir } from "./support/books.ts";

function scratch() {
  const home = tempDir();
  mkdirSync(join(home, ".claude"));
  return { home, env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: process.env.PATH } };
}

test("ISC-142: setup --books=<dir> uses that folder", async () => {
  const { home, env } = scratch();
  const r = await install("setup", [`--books=${join(home, "elsewhere")}`], env);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).books).toBe(join(home, "elsewhere"));
  expect(existsSync(dbPath(join(home, "elsewhere")))).toBe(true);
  expect(existsSync(join(home, "solobooks"))).toBe(false);
});

test("ISC-142: doctor --books=<dir> reads that folder", async () => {
  const { home, env } = scratch();
  await install("setup", ["--books", join(home, "a")], env);
  const r = await install("doctor", [`--books=${join(home, "missing")}`], env);
  const books = JSON.parse(r.stdout).checks.find((c: { check: string }) => c.check === "books");
  expect(books.detail).toContain(join(home, "missing"));
});

test("ISC-142: move --to=<dir> and backup set --folder=<dir> read their folders", async () => {
  const { home, env } = scratch();
  await install("setup", [], env);
  const backups = await install("backup", ["set", `--folder=${join(home, "bk")}`], env);
  expect(JSON.parse(backups.stdout).backups).toBe(join(home, "bk"));
  const moved = await install("move", [`--to=${join(home, "moved")}`], env);
  expect(moved.code).toBe(0);
  expect(JSON.parse(readFileSync(configFile(env)!, "utf8")).books).toBe(join(home, "moved"));
});

test("ISC-142: a flag with = and no value is refused", async () => {
  const { env } = scratch();
  const r = await install("setup", ["--books="], env);
  expect(r.code).toBe(2);
  expect(JSON.parse(r.stdout).field).toBe("books");
});

for (const [word, argv] of [
  ["setup", ["--book", "x"]],
  ["doctor", ["--book=x"]],
  ["move", ["--too", "x"]],
  ["backup", ["set", "--foldr", "x"]],
] as const) {
  test(`ISC-142: ${word} refuses a flag it doesn't know (${argv.join(" ")})`, async () => {
    const { home, env } = scratch();
    await install("setup", [], env);
    const r = await install(word, [...argv], env);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).reason).toContain("has no --");
    expect(existsSync(join(home, "x"))).toBe(false);
  });
}

test("ISC-142: mcp reads --books=<dir> and refuses a flag it doesn't know", async () => {
  const typo = Bun.spawn(["bun", "src/cli.ts", "mcp", "--book=x"], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  expect(await typo.exited).toBe(2);
  expect(await new Response(typo.stdout).text()).toBe(""); // stdout belongs to the protocol
  expect(await new Response(typo.stderr).text()).toContain("has no --book flag");
});
