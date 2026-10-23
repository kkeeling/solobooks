import type { Database } from "bun:sqlite";
import m001 from "./001_init.sql" with { type: "text" };
import m002 from "./002_invoices.sql" with { type: "text" };
import m003 from "./003_tax_scope.sql" with { type: "text" };
import m004 from "./004_gate.sql" with { type: "text" };

/** Numbered migrations, applied in order. The file's PRAGMA user_version is the last one applied. */
export const MIGRATIONS: readonly string[] = [m001, m002, m003, m004];

export function migrate(db: Database): void {
  const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}
