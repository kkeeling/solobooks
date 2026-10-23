import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAddon } from "../src/addon.ts";
import { run } from "../src/cli.ts";
import { Refusal } from "../src/core/refusal.ts";
import { tempDir } from "./support/books.ts";

// `solobooks addon run`: the core's only part in add-ons. It runs a script and hands it solobooks' own CLI.

const solobooks = (argv: string[]) => run(argv, {});

test("addon run: the script's default export gets its arguments and solobooks' CLI, and its exit code is the result", async () => {
  const dir = tempDir();
  const script = join(dir, "echo.ts");
  writeFileSync(
    script,
    `export default async (args: string[], solobooks: any) => {
       const help = JSON.parse((await solobooks(["help"])).stdout);
       (globalThis as any).seen = { args, commands: help.commands.length };
       return 3;
     };`,
  );
  expect(await runAddon(["run", script, "--from", "x"], {}, solobooks)).toBe(3);
  expect((globalThis as any).seen.args).toEqual(["--from", "x"]);
  expect((globalThis as any).seen.commands).toBeGreaterThan(10);
});

test("addon run: refuses anything that isn't a runnable script, with the field to fix", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "nodefault.ts"), "export const x = 1;");
  writeFileSync(join(dir, "notes.md"), "# hi");
  const field = async (argv: string[]) => {
    try {
      await runAddon(argv, {}, solobooks);
      return "ran";
    } catch (e) {
      return e instanceof Refusal ? e.field : String(e);
    }
  };
  expect(await field(["start", join(dir, "nodefault.ts")])).toBe("command");
  expect(await field(["run"])).toBe("script");
  expect(await field(["run", join(dir, "missing.ts")])).toBe("script");
  expect(await field(["run", join(dir, "notes.md")])).toBe("script");
  expect(await field(["run", join(dir, "nodefault.ts")])).toBe("script");
});
