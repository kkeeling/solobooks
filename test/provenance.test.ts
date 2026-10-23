import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cli, dbPath, tempDir } from "./support/books.ts";
import { setUpPerson } from "./support/person.ts";
import { cliArgs, SCENARIO } from "./support/scenario.ts";

test("ISC-12: every record carries a non-empty source", async () => {
  const dir = tempDir();
  await setUpPerson(dir);
  for (const step of SCENARIO) await cli(dir, cliArgs(step, "agent:claude-code"));

  const db = new Database(dbPath(dir));
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(
    (t) => t.name,
  );
  let rows = 0;
  for (const t of tables) {
    const cols = (db.query(`SELECT name FROM pragma_table_info('${t}')`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("source");
    rows += (db.query(`SELECT COUNT(*) n FROM "${t}"`).get() as { n: number }).n;
    expect(db.query(`SELECT COUNT(*) n FROM "${t}" WHERE source IS NULL OR trim(source) = ''`).get()).toEqual({ n: 0 });
    // The database itself refuses a blank source.
    expect(() => db.exec(`UPDATE "${t}" SET source = ' '`)).toThrow();
  }
  expect(rows).toBeGreaterThan(20);
  db.close();
});

test("ISC-12: a write without a source is refused", async () => {
  const dir = tempDir();
  for (const source of [[], ["--source", "  "]]) {
    const r = await cli(dir, ["client", "add", "--name", "Acme", ...source]);
    expect(r.code).toBe(2);
    expect(r.out.field).toBe("source");
  }
});
