import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { install, run, serve } from "../src/cli.ts";
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
    const { env } = scratch();
    await install("setup", [], env);
    const r = await install(word, [...argv], env);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).reason).toContain("has no --");
    expect(existsSync("x")).toBe(false); // a relative x would land in the current folder
  });
}

for (const argv of [["My", "Books"], ["-books", "x"], ["-h"], ["--books", "a", "stray"]]) {
  test(`ISC-142: setup refuses what it doesn't read (${argv.join(" ")})`, async () => {
    const { home, env } = scratch();
    const r = await install("setup", argv, env);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).reason).toContain("doesn't take");
    expect(existsSync(join(home, "solobooks"))).toBe(false);
  });
}

test("ISC-142: mcp reads --books=<dir>", async () => {
  const { home, env } = scratch();
  await install("setup", ["--books", join(home, "books")], env);
  await run(["client", "add", "--name", "Acme", "--source", "s", "--books", join(home, "books")], env);
  const { stdioMcpArgs } = await import("./support/mcp-client.ts");
  const mcp = await stdioMcpArgs([`--books=${join(home, "books")}`], { HOME: home });
  try {
    expect((await mcp.call("client_list", {})).content[0].text).toContain("Acme");
  } finally {
    await mcp.close();
  }
});

test("ISC-142: --books=~/x means the same folder everywhere", async () => {
  const { home, env } = scratch();
  await install("setup", ["--books=~/b1"], env);
  expect(existsSync(dbPath(join(home, "b1")))).toBe(true);
  expect((await run(["client", "list", "--books=~/b1"], env)).code).toBe(0);
});

test("ISC-142: mcp refuses a flag it doesn't know", async () => {
  const typo = Bun.spawn(["bun", "src/cli.ts", "mcp", "--book=x"], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  expect(await typo.exited).toBe(2);
  expect(await new Response(typo.stdout).text()).toBe(""); // stdout belongs to the protocol
  expect(await new Response(typo.stderr).text()).toContain("has no --book flag");
});

for (const value of ["", "   "]) {
  for (const [word, argv] of [
    ["setup", ["--books", value]],
    ["setup", [`--books=${value}`]],
    ["doctor", ["--books", value]],
    ["doctor", [`--books=${value}`]],
    ["move", ["--to", value]],
    ["move", ["--books", value, "--to", "somewhere"]],
    ["backup", ["set", "--folder", value]],
    ["backup", ["set", "--folder", "somewhere", "--books", value]],
  ] as const) {
    test(`ISC-156: ${word} ${JSON.stringify(argv)} is refused and creates nothing`, async () => {
      const { home, env } = scratch();
      await install("setup", [], env);
      const cwd = process.cwd();
      const here = join(home, "cwd");
      mkdirSync(here);
      process.chdir(here); // an empty value used to mean this folder
      try {
        const before = readFileSync(configFile(env)!, "utf8");
        const r = await install(word, [...argv], env);
        expect(r.code).toBe(2);
        expect(JSON.parse(r.stdout).reason).toBe("That flag needs a value after it.");
        expect(readdirSync(here)).toEqual([]);
        expect(readFileSync(configFile(env)!, "utf8")).toBe(before);
      } finally {
        process.chdir(cwd);
      }
    });
  }
}

test("ISC-156: mcp and serve refuse an empty --books too", async () => {
  const typo = Bun.spawn(["bun", "src/cli.ts", "mcp", "--books", ""], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  expect(await typo.exited).toBe(2);
  expect(await new Response(typo.stderr).text()).toContain("needs a value");
  const { env } = scratch();
  await expect(serve(["serve", "--books", ""], env)).rejects.toThrow("Say which folder");
});
