import { expect, test } from "bun:test";
import { cli, ok, tempDir } from "./support/books.ts";

const S = ["--source", "agent:test"];
const ENTRY = ["--client-id", "1", "--date", "2026-10-01", "--minutes", "45", "--note", "Schema review"];

async function books() {
  const dir = tempDir();
  await ok(dir, ["client", "add", "--name", "Acme", ...S]);
  await ok(dir, ["client", "add", "--name", "Beta", ...S]);
  return dir;
}

test("ISC-25 fields: a time entry carries client, date, duration and a note", async () => {
  const dir = await books();
  const { time_entry } = await ok(dir, ["time", "add", ...ENTRY, ...S]);
  expect(time_entry).toMatchObject({ client_id: 1, date: "2026-10-01", minutes: 45, note: "Schema review", source: "agent:test" });
  expect((await ok(dir, ["time", "list"])).time_entries[0]).toMatchObject(time_entry);

  // Each of the four is required.
  for (const [flag, field] of [["--client-id", "client_id"], ["--date", "date"], ["--minutes", "minutes"], ["--note", "note"]]) {
    const args = [...ENTRY];
    args.splice(args.indexOf(flag!), 2);
    const r = await cli(dir, ["time", "add", ...args, ...S]);
    expect(r.code).toBe(2);
    expect(r.out.field).toBe(field);
  }
  expect((await cli(dir, ["time", "add", ...ENTRY.slice(0, -1), " ", ...S])).out.field).toBe("note");
  expect((await cli(dir, ["time", "add", ...ENTRY.map((a) => (a === "1" ? "9" : a)), ...S])).out.field).toBe("client_id");
});

test("ISC-28 unbilled: unbilled time entries can be edited and deleted freely", async () => {
  const dir = await books();
  await ok(dir, ["time", "add", ...ENTRY, ...S]);
  await ok(dir, ["time", "add", ...ENTRY, ...S]);

  const edited = await ok(dir, ["time", "edit", "--id", "1", "--minutes", "50", "--note", "Schema review and fixes", "--client-id", "2", "--source", "person"]);
  expect(edited.time_entry).toMatchObject({ id: 1, client_id: 2, minutes: 50, note: "Schema review and fixes", date: "2026-10-01", source: "person" });
  const again = await ok(dir, ["time", "edit", "--id", "1", "--date", "2026-10-02", ...S]);
  expect(again.time_entry).toMatchObject({ minutes: 50, date: "2026-10-02" });

  expect(await ok(dir, ["time", "delete", "--id", "2", ...S])).toMatchObject({ deleted: { time_entry: { id: 2 } } });
  expect((await ok(dir, ["time", "list"])).time_entries.map((e: any) => e.id)).toEqual([1]);
  expect(await ok(dir, ["time", "delete", "--id", "1", ...S])).toMatchObject({ deleted: { time_entry: { id: 1 } } });
  expect((await ok(dir, ["time", "list"])).time_entries).toEqual([]);

  // Every change is in the history.
  const ops = (await ok(dir, ["history", "list"])).history.map((h: any) => h.op);
  expect(ops).toEqual(["client_add", "client_add", "time_add", "time_add", "time_edit", "time_edit", "time_delete", "time_delete"]);
  expect((await cli(dir, ["time", "delete", "--id", "1", ...S])).out.field).toBe("id");
});
