import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import { configFile } from "../src/config.ts";
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
  const { env, settings, home } = person();
  writeFileSync(settings, "{ not json");
  expect(() => setup([], env)).toThrow("solobooks setup --books <folder>");
  expect(readFileSync(settings, "utf8")).toBe("{ not json");
  expect(existsSync(join(home, "solobooks.sqlite"))).toBe(false);
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

test("ISC-141: SOLOBOOKS_DIR counts as naming the folder", () => {
  const { env, settings, books } = person();
  writeFileSync(settings, "{ not json");
  expect(setup([], { ...env, SOLOBOOKS_DIR: books }).books).toBe(books);
  expect(existsSync(`${settings}.damaged`)).toBe(true);
  expect(existsSync(dbPath(books))).toBe(true);
});

