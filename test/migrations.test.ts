import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { openBooks } from "../src/core/db.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";
import { dbPath, tempDir } from "./support/books.ts";

test("migrations: books saved before the payment gate open with every gate level and pending action kept, still locked", () => {
  const path = dbPath(tempDir());
  const old = new Database(path, { create: true, strict: true });
  for (const [v, sql] of MIGRATIONS.slice(0, 5).entries()) {
    old.exec(sql);
    old.exec(`PRAGMA user_version = ${v + 1}`);
  }
  old.exec("INSERT INTO gate_levels (action, level, source) VALUES ('invoice_issue', 'passkey', 'person:page')");
  old.exec(`INSERT INTO pending_actions (id, created_at, action, op, input, level, prompt, source) VALUES
    (7, '2026-10-01T00:00:00Z', 'invoice_void', 'invoice_void', '{"id":1}', 'click', '{"title":"t","items":[]}', 'agent:old')`);
  old.close();

  const db = openBooks(path);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
  expect(db.query("SELECT action, level, source FROM gate_levels").all()).toEqual([{ action: "invoice_issue", level: "passkey", source: "person:page" }]);
  expect(db.query("SELECT id, action, status, source FROM pending_actions").all()).toEqual([{ id: 7, action: "invoice_void", status: "pending", source: "agent:old" }]);
  // The rules came back with the rebuilt tables, and the new action is allowed.
  expect(() => db.exec("DELETE FROM pending_actions")).toThrow(/kept/);
  expect(() => db.exec("UPDATE pending_actions SET input = '{}'")).toThrow(/never changes/);
  db.exec("INSERT INTO gate_levels (action, level, source) VALUES ('payment_unmatched', 'agent_decides', 'person:page')");
  // Ids keep counting up from the old ones.
  db.exec(`INSERT INTO pending_actions (created_at, action, op, input, level, prompt, source) VALUES ('t', 'payment_unmatched', 'payment_add', '{}', 'click', '{}', 's')`);
  expect(db.query("SELECT MAX(id) AS n FROM pending_actions").get()).toEqual({ n: 8 });
  db.close();
});
