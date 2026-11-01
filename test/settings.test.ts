import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

for (const [text, says] of [['{"books":5}', "books"], ['{"books":""}', "books"], ['{"books":"  "}', "books"], ['{"books":"/x","backups":7}', "backups"], ["[]", "object"], ["null", "object"]] as const) {
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

const claudeCheck = (d: { checks: { check: string }[] }) => d.checks.find((c) => c.check === "Claude Code MCP") as { ok: boolean; detail: string; fix?: string };
const doctored = (argv: string[], env: Record<string, string | undefined>) => doctor(argv, { ...env, PATH: process.env.PATH });

test("ISC-155: a server refused for settings it can't open gets the settings fix, not setup --books", async () => {
  if (process.getuid?.() === 0) return; // root can open anything
  const { env, settings, books } = person();
  chmodSync(settings, 0o000);
  try {
    const d = await doctored(["--books", books], env);
    expect(d.checks[0]).toMatchObject({ check: "books", ok: true });
    expect(claudeCheck(d)).toMatchObject({ ok: false, fix: "Check that you can open the settings file, then run solobooks doctor again." });
  } finally {
    chmodSync(settings, 0o600);
  }
});

test("ISC-155: the handshake doesn't hand a server this shell's SOLOBOOKS_DIR, because an app started from the Dock doesn't have it", async () => {
  const { env, books, home } = person();
  saveConfig(env, { books: join(home, "nowhere") });
  const d = await doctored([], { ...env, SOLOBOOKS_DIR: books });
  expect(d.checks[0]).toMatchObject({ check: "books", ok: true });
  expect(claudeCheck(d).ok).toBe(false);
  expect(claudeCheck(d).detail).toContain("can't reach the books on its own");
  expect(claudeCheck(d).fix).toContain(`solobooks setup --books "${books}"`);
});

test("ISC-155: the handshake uses the entry's own env when it has one", async () => {
  const { env, books, home } = person();
  saveConfig(env, { books: join(home, "nowhere") });
  const file = join(home, ".claude.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  config.mcpServers.solobooks.env = { SOLOBOOKS_DIR: books };
  writeFileSync(file, JSON.stringify(config));
  const d = await doctored(["--books", books], env);
  expect(claudeCheck(d)).toMatchObject({ ok: true });
});

test("ISC-157: a null or bad port in the settings is ignored and never stops a command", async () => {
  for (const port of [null, "7317", 99999, 1.5, {}]) {
    const { env, settings, books } = person();
    writeFileSync(settings, JSON.stringify({ books, port }));
    expect(pagePort(env)).toBe(7317);
    const listed = await run(["client", "list"], env);
    expect(listed.code).toBe(0);
    expect(JSON.parse((await run(["client", "add", "--name", "Acme", "--source", "s"], env)).stdout).client.name).toBe("Acme");
    expect(setup([], env).books).toBe(books);
    expect((await doctored([], env)).ok).toBe(true);
  }
});

for (const [what, make] of [
  ["a file that isn't a database", (home: string) => {
    const dir = join(home, "not-books");
    mkdirSync(dir);
    writeFileSync(dbPath(dir), "a shopping list, not a database");
    return dir;
  }],
  ["a path it can't use", (home: string) => {
    writeFileSync(join(home, "a-file"), "");
    return join(home, "a-file", "books");
  }],
] as const) {
  test(`ISC-159: setup --books on ${what} refuses with a reason and a field, and changes nothing`, async () => {
    const { env, home, settings } = person();
    const before = readFileSync(settings, "utf8");
    const r = await install("setup", ["--books", make(home)], env);
    expect(r.code).toBe(2);
    const said = JSON.parse(r.stdout);
    expect(said.field).toBe("books");
    expect(said.reason).toContain("solobooks setup --books <folder>");
    expect(said.error).toBeUndefined();
    expect(readFileSync(settings, "utf8")).toBe(before);
  });
}

test("ISC-159: following INSTALL's synced-folder step on a new install leaves warnings empty", () => {
  const { env, home } = person();
  const synced = setup(["--books", join(home, "Dropbox", "books")], env);
  expect(synced.started_new_books).toBe(true);
  expect(synced.warnings).toHaveLength(1); // that it's in Dropbox, and nothing about books left behind
  expect(synced.warnings[0]).toContain("Dropbox");
  const moved = setup(["--books", join(home, "plain")], env);
  expect(moved.started_new_books).toBe(true);
  expect(moved.warnings).toEqual([]);
});

test("ISC-159: setup still warns about books left behind when they hold something", async () => {
  const { env, books, home } = person();
  expect((await run(["client", "add", "--name", "Acme", "--source", "s"], env)).code).toBe(0);
  expect(setup(["--books", join(home, "plain")], env).warnings.join(" ")).toContain(`your books are still in "${books}"`);
});

test("ISC-170: doctor fails the MCP check when the folder it checks isn't the one the agent's server would use, and its fix works", async () => {
  const { env, books: a, home } = person();
  const b = join(home, "other");
  setup(["--books", b], env); // real books there too, so the server answers without complaint
  const d = await doctored(["--books", a], env);
  expect(d.ok).toBe(false);
  expect(d.checks[0]).toMatchObject({ check: "books", ok: true });
  const c = claudeCheck(d);
  expect(c.ok).toBe(false);
  expect(c.detail).toContain(`it uses the books in "${b}", not the ones in "${a}"`);
  expect(c.fix).toContain(`solobooks setup --books "${a}"`);

  setup(["--books", a], env);
  expect((await doctored(["--books", a], env)).ok).toBe(true);
  expect((await doctored([], env)).ok).toBe(true);
});

test("ISC-174: doctor's fix names both ways out when its folder isn't the agent's, because either may be the right one", async () => {
  const { env, books: old, home } = person();
  const moved = join(home, "moved");
  setup(["--books", moved], env);
  const shell = claudeCheck(await doctored([], { ...env, SOLOBOOKS_DIR: old }));
  expect(shell.fix).toContain(`If "${moved}" holds your books, unset SOLOBOOKS_DIR`);
  expect(shell.fix).toContain(`If "${old}" does, run solobooks setup --books "${old}"`);
  const named = claudeCheck(await doctored(["--books", old], env));
  expect(named.fix).toContain(`If "${moved}" holds your books, check without --books`);
});

test("ISC-174: setup says so when it leaves books behind that have work in them, and not otherwise", async () => {
  const { env, books: first, home } = person();
  const second = join(home, "second");
  setup(["--books", second], env);
  expect(setup(["--books", first], env).warnings.join(" ")).not.toContain("still in"); // nothing in the second yet

  setup(["--books", second], env);
  expect((await run(["client", "add", "--name", "Zeta", "--source", "s"], env)).code).toBe(0);
  const back = setup(["--books", first], env);
  expect(back.warnings.join(" ")).toContain(`the books it was using are still in "${second}"`);
  expect(back.warnings.join(" ")).toContain(`solobooks setup --books "${second}"`);
  expect(setup(["--books", first], env).warnings.join(" ")).not.toContain("still in"); // already there
});

test("ISC-170: the same goes for SOLOBOOKS_DIR, and two names for one folder are one folder", async () => {
  const { env, books: a, home } = person();
  const b = join(home, "other");
  setup(["--books", b], env);
  expect(claudeCheck(await doctored([], { ...env, SOLOBOOKS_DIR: a })).ok).toBe(false);
  expect(claudeCheck(await doctored([], { ...env, SOLOBOOKS_DIR: b })).ok).toBe(true);
  const link = join(home, "link");
  symlinkSync(b, link);
  expect(claudeCheck(await doctored(["--books", link], env)).ok).toBe(true);
});

test("ISC-170: when doctor's own books check fails, only that check fails", async () => {
  const { env, home } = person();
  const d = await doctored(["--books", join(home, "missing")], env);
  expect(d.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { check: string }) => c.check)).toEqual(["books"]);
});
