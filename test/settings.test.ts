import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { install, run, serve } from "../src/cli.ts";
import { configFile, pagePort, saveConfig } from "../src/config.ts";
import { doctor } from "../src/doctor.ts";
import { setup } from "../src/setup.ts";
import { dbPath, tempDir } from "./support/books.ts";

function person() {
  const home = tempDir();
  mkdirSync(join(home, ".claude"));
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
  const { books } = setup([], env);
  return { home, env, books, settings: configFile(env)! };
}

test("ISC-141: a bare setup with damaged settings refuses, because it can't know where the books are", () => {
  const { env, settings, books } = person();
  rmSync(dbPath(books));
  writeFileSync(settings, "{ not json");
  expect(() => setup([], env)).toThrow("solobooks setup --books <folder>");
  expect(readFileSync(settings, "utf8")).toBe("{ not json");
  expect(existsSync(dbPath(books))).toBe(false);
});

test("ISC-141: a repair that can't use the folder leaves the settings as they were", () => {
  const { env, settings, home } = person();
  writeFileSync(settings, "{ not json");
  writeFileSync(join(home, "a-file"), "");
  expect(() => setup(["--books", join(home, "a-file", "books")], env)).toThrow();
  expect(readFileSync(settings, "utf8")).toBe("{ not json");
  expect(existsSync(`${settings}.damaged`)).toBe(false);
});

test("ISC-141: a second repair keeps the first damaged copy", () => {
  const { env, settings, books } = person();
  writeFileSync(settings, "first");
  setup(["--books", books], env);
  writeFileSync(settings, "second");
  setup(["--books", books], env);
  expect(readFileSync(`${settings}.damaged`, "utf8")).toBe("first");
  expect(readFileSync(`${settings}.damaged-2`, "utf8")).toBe("second");
});

test("ISC-141: a repair that starts new books says so, in case the folder was a typo", () => {
  const { env, settings, home } = person();
  writeFileSync(settings, "{ not json");
  const r = setup(["--books", join(home, "solobook")], env);
  expect(r.started_new_books).toBe(true);
  expect(r.warnings.join(" ")).toContain("started new, empty books");
});

test("ISC-141: doctor --books with damaged settings still reports on those books", async () => {
  const { env, settings, books } = person();
  writeFileSync(settings, "{ not json");
  const d = await doctor(["--books", books], { ...env, PATH: process.env.PATH });
  expect(d.checks.find((c: { check: string }) => c.check === "books")!.ok).toBe(true);
});

for (const damage of ["{ not json", "[1, 2]"]) {
  test(`ISC-141: the fix solobooks names repairs damaged settings (${damage})`, async () => {
    const { env, settings, books } = person();
    expect((await run(["client", "add", "--name", "Acme", "--source", "s"], env)).code).toBe(0);
    writeFileSync(settings, damage);

    const refusal = await run(["client", "list"], env);
    expect(JSON.parse(refusal.stdout).reason).toContain("solobooks setup --books <folder>");
    const d = await doctor([], { ...env, PATH: process.env.PATH });
    expect(d.checks.find((c: { check: string }) => c.check === "books")!.fix).toContain("solobooks setup --books <folder>");

    const r = setup(["--books", books], env);
    expect(r.warnings.join(" ")).toContain(`${settings}.damaged`);
    expect(readFileSync(`${settings}.damaged`, "utf8")).toBe(damage);
    expect(JSON.parse(readFileSync(settings, "utf8")).books).toBe(books);

    const after = await run(["client", "list"], env);
    expect(JSON.parse(after.stdout).clients).toHaveLength(1); // the same books, found again
  });
}

test("ISC-141: SOLOBOOKS_DIR counts as naming a folder that has books", () => {
  const { env, settings, books } = person();
  writeFileSync(settings, "{ not json");
  expect(setup([], { ...env, SOLOBOOKS_DIR: books }).books).toBe(books);
  expect(existsSync(`${settings}.damaged`)).toBe(true);
  expect(existsSync(dbPath(books))).toBe(true);
});


for (const [name, extra] of [["--books", true], ["SOLOBOOKS_DIR", false]] as const) {
  test(`ISC-154: doctor fails and names the fix when the settings file is damaged, with ${name} set, because commands refuse there`, async () => {
    const { env, settings, books } = person();
    writeFileSync(settings, "{ not json");
    const asked = extra ? { argv: ["--books", books], env } : { argv: [], env: { ...env, SOLOBOOKS_DIR: books } };
    expect((await run(["client", "list", ...asked.argv], asked.env)).code).toBe(2); // why doctor has to fail

    const r = await install("doctor", asked.argv, { ...asked.env, PATH: process.env.PATH });
    expect(r.code).toBe(1);
    const d = JSON.parse(r.stdout);
    const failed = d.checks.find((c: { check: string }) => c.check === "settings");
    expect(failed).toMatchObject({ ok: false });
    expect(failed.detail).toContain("isn't valid JSON");
    expect(failed.fix).toContain("solobooks setup --books <folder>");

    setup(["--books", books], env); // the fix it names
    expect((await install("doctor", asked.argv, { ...asked.env, PATH: process.env.PATH })).code).toBe(0);
  });
}

for (const [text, says] of [['{"books":5}', "books"], ['{"books":"/x","backups":7}', "backups"], ['{"books":"/x","port":"7317"}', "port"], ["[]", "object"], ["null", "object"]] as const) {
  test(`ISC-157: settings holding ${text} get the same refusal and repair as invalid JSON, never a raw error`, async () => {
    const { env, settings, books } = person();
    expect((await run(["client", "add", "--name", "Acme", "--source", "s"], env)).code).toBe(0);
    writeFileSync(settings, text);

    const refused = await run(["client", "list"], env);
    expect(refused.code).toBe(2);
    const reason = JSON.parse(refused.stdout);
    expect(reason.field).toBe("config");
    expect(reason.reason).toContain("solobooks setup --books <folder>");
    expect(reason.reason).toContain(says);
    expect(() => setup([], env)).toThrow("solobooks setup --books <folder>");
    const d = await install("doctor", [], { ...env, PATH: process.env.PATH });
    expect(d.code).toBe(1);
    expect(JSON.parse(d.stdout).checks.find((c: { check: string }) => c.check === "books").fix).toContain("solobooks setup --books <folder>");

    expect(setup(["--books", books], env).warnings.join(" ")).toContain(`${settings}.damaged`);
    expect(JSON.parse((await run(["client", "list"], env)).stdout).clients).toHaveLength(1);
  });
}

test("ISC-158: an empty SOLOBOOKS_PORT counts as unset", () => {
  const { env } = person();
  saveConfig(env, { port: 45123 });
  expect(pagePort({ ...env, SOLOBOOKS_PORT: "" })).toBe(45123);
  expect(pagePort({ ...env, SOLOBOOKS_PORT: "45000" })).toBe(45000);
  expect(pagePort({ HOME: env.HOME, XDG_CONFIG_HOME: join(env.HOME, "elsewhere"), SOLOBOOKS_PORT: "" })).toBe(7317);
});

test("ISC-158: serve --port abc blames --port, and a bad variable still blames the variable", async () => {
  const { env } = person();
  await expect(serve(["serve", "--port", "abc"], env)).rejects.toThrow("--port must be a whole number from 1 to 65535.");
  await expect(serve(["serve"], { ...env, SOLOBOOKS_PORT: "abc" })).rejects.toThrow("SOLOBOOKS_PORT must be a whole number from 1 to 65535.");
});

test("ISC-158: repairing damaged settings says the port must be chosen again", () => {
  const { env, settings, books } = person();
  writeFileSync(settings, "{ not json");
  expect(setup(["--books", books], env).warnings.join(" ")).toContain("choose it again with solobooks serve --port <n>");
});

test("ISC-158: setup --books that differs from SOLOBOOKS_DIR says which one later commands use", () => {
  const { env, books, home } = person();
  const elsewhere = join(home, "elsewhere");
  const said = setup(["--books", elsewhere], { ...env, SOLOBOOKS_DIR: books }).warnings.join(" ");
  expect(said).toContain(`SOLOBOOKS_DIR says ${books}`);
  expect(said).toContain("later commands in this shell use that folder");
  expect(setup(["--books", books], { ...env, SOLOBOOKS_DIR: books }).warnings.join(" ")).not.toContain("SOLOBOOKS_DIR says"); // they agree
});

test("billing-waj: doctor's fix for a settings file it can't open is one that works, not setup, which refuses too", async () => {
  if (process.getuid?.() === 0) return; // root can open anything
  const { env, settings } = person();
  chmodSync(settings, 0o000);
  try {
    expect(() => setup([], env)).toThrow("can't read the settings file");
    const d = await doctor([], { ...env, PATH: process.env.PATH });
    const bad = d.checks.filter((c: { ok: boolean }) => !c.ok);
    expect(bad.map((c: { check: string }) => c.check)).toEqual(["books"]);
    expect(bad[0]!.fix).toBe("Check that you can open the settings file, then run solobooks doctor again.");
  } finally {
    chmodSync(settings, 0o600);
  }
});

test("billing-waj: doctor accepts a registered command found through PATH, and still fails one that isn't anywhere", async () => {
  const { env, home } = person();
  const file = join(home, ".claude.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  const { command, args } = config.mcpServers.solobooks;
  const entry = (c: string, a: string[]) => {
    config.mcpServers.solobooks = { type: "stdio", command: c, args: a, env: {} };
    writeFileSync(file, JSON.stringify(config));
  };
  const name = command.split("/").pop();
  const claude = async (PATH: string) => (await doctor([], { ...env, PATH })).checks.find((c: { check: string }) => c.check === "Claude Code MCP")!;
  entry(name, args);
  expect((await claude(dirname(command))).ok).toBe(true);
  expect(await claude("/nowhere")).toMatchObject({ ok: false });
});
