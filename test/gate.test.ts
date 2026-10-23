import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { approvePending, rejectPending } from "../src/core/approve.ts";
import type { Books } from "../src/core/db.ts";
import { ACTIONS, LEVELS } from "../src/core/gate.ts";
import { OPS } from "../src/core/perform.ts";
import { clickAcme, draftOctober, json, ok, S, SELLER } from "./support/billing.ts";
import { cli, dbPath, dumpDb, fileHash, memBooks, ROOT, tempDir } from "./support/books.ts";
import { must, write } from "./support/gen.ts";
import { inProcessMcp } from "./support/mcp-client.ts";
import { approveOnPage, approveWithPasskey, asPerson, letAgentDecide, registerTestPasskey, WHEN } from "./support/person.ts";
import { cliArgs, SCENARIO } from "./support/scenario.ts";

const ALL = (level: string) => Object.fromEntries(ACTIONS.map((a) => [a, level]));


/** Every table but the gate's own record of the request and the history log. */
function books(db: Books) {
  const { pending_actions, history, ...rest } = dumpDb(db);
  return rest;
}

/** In-memory books with a seller and one client, for core-level checks. */
function coreBooks() {
  const db = memBooks();
  letAgentDecide(db);
  must(db, "profile_set", SELLER);
  must(db, "client_add", { name: "Acme Corp", address: "500 Market St" });
  must(db, "client_add", { name: "Beta LLC", address: "9 Elm Rd" });
  must(db, "client_add", { name: "Gamma Inc", address: "1 Oak Ave" });
  return db;
}
const draft = (db: Books, client = 1, cents = 10000) =>
  must(db, "invoice_draft", { client_id: client, period_start: "2026-10-01", period_end: "2026-10-31", lines: [{ description: "Work", amount_cents: cents }] }).invoice
    .id as number;
const setLevels = (db: Books, levels: Record<string, string>) => approveOnPage(db, must(db, "gate_set", levels).pending_id);
const status = (db: Books, id: number) => (db.query("SELECT status FROM invoices WHERE id = ?").get(id) as { status: string }).status;
const pendingStatus = (db: Books, id: number) => (db.query("SELECT status FROM pending_actions WHERE id = ?").get(id) as { status: string }).status;

test("ISC-63 parks: a gated action returns pending with an id and changes no ledger, invoice or number", async () => {
  const dir = await clickAcme();
  const d = await draftOctober(dir);
  const before = asPerson(dir, books);
  const nextBefore = (await ok(dir, ["profile", "get"])).next_invoice_number;

  const issue = await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S]);
  expect(issue).toMatchObject({ status: "pending", level: "click", title: `Issue invoice 7001 to Acme Corp for $${(d.total_cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}?` });
  expect(Number.isInteger(issue.pending_id)).toBe(true);
  expect(issue.approve_url).toBe(`http://localhost:7317/#pending-${issue.pending_id}`);
  expect(asPerson(dir, books)).toEqual(before); // no ledger line, invoice change or number taken
  expect((await ok(dir, ["profile", "get"])).next_invoice_number).toBe(nextBefore);
  expect((await ok(dir, ["invoice", "get", "--id", String(d.id)])).invoice).toMatchObject({ status: "draft", number: null });
  expect((await ok(dir, ["pending", "get", "--id", String(issue.pending_id)])).pending).toMatchObject({ status: "pending", op: "invoice_issue", input: { id: d.id } });

  // The same through MCP, and for voiding and crediting an issued invoice.
  const mcp = await inProcessMcp(dir, { SOLOBOOKS_NOW: WHEN.now });
  const viaMcp = (await mcp.call("invoice_issue", { id: d.id, source: "agent:mcp" })).structuredContent;
  expect(viaMcp).toMatchObject({ status: "pending", level: "click" });
  await mcp.close();
  asPerson(dir, (db) => approveOnPage(db, issue.pending_id));
  const issued = asPerson(dir, books);
  for (const args of [
    ["invoice", "void", "--id", String(d.id), "--reason", "Wrong period"],
    ["invoice", "credit", "--invoice-id", String(d.id), "--amount-cents", "1000", "--reason", "Discount", "--line-kind", "time"],
  ]) {
    expect(await ok(dir, [...args, ...S])).toMatchObject({ status: "pending", level: "click" });
    expect(asPerson(dir, books)).toEqual(issued);
  }

  // A dry run parks nothing; a replayed key returns the same pending action.
  const hash = fileHash(dbPath(dir));
  expect((await ok(dir, ["invoice", "void", "--id", String(d.id), "--reason", "x", "--dry-run", ...S])).result.status).toBe("pending");
  expect(fileHash(dbPath(dir))).toBe(hash);
  const keyed = ["invoice", "void", "--id", String(d.id), "--reason", "x", "--idempotency-key", "void-1", ...S];
  const first = await ok(dir, keyed);
  expect(await ok(dir, keyed)).toEqual(first);
  expect((await ok(dir, ["pending", "list"])).pending.filter((p: any) => p.idempotency_key === "void-1").length).toBe(1);
}, 30_000);

test("ISC-63 parks: rejection closes a pending action with no effect, and a draft changed after the request can't be approved", () => {
  const db = coreBooks();
  setLevels(db, ALL("click"));
  const a = draft(db);
  const p = must(db, "invoice_issue", { id: a }).pending_id;
  const before = books(db);
  expect(rejectPending(db, p, "page", WHEN)).toMatchObject({ ok: true, result: { status: "rejected" } });
  expect(books(db)).toEqual(before);
  expect(approvePending(db, p, { via: "page" }, WHEN)).toMatchObject({ ok: false, refusal: { field: "pending_id" } });

  // The agent asks to issue a $100 draft, then raises it to $100,100 before the person clicks.
  const q = must(db, "invoice_issue", { id: a }).pending_id;
  must(db, "invoice_edit", { id: a, add_lines: [{ description: "More", amount_cents: 10_000_000 }] });
  const r = approvePending(db, q, { via: "page" }, WHEN);
  expect(r).toMatchObject({ ok: false, refusal: { field: "pending_id" } });
  expect(status(db, a)).toBe("draft");
  expect(pendingStatus(db, q)).toBe("pending");
});

test("ISC-64 levels: each gated action offers agent_decides, click and passkey, and each level behaves as named", async () => {
  for (const level of LEVELS) {
    const db = coreBooks();
    const auth = await registerTestPasskey(db);
    const [toIssue, toVoid, toCredit] = [draft(db), draft(db, 2), draft(db, 3)];
    must(db, "invoice_issue", { ids: [toVoid, toCredit] }); // issued while the agent still decides
    if (level !== "agent_decides") {
      const p = must(db, "gate_set", ALL(level));
      expect(p.level).toBe(level);
      if (level === "passkey") await approveWithPasskey(db, auth, p.pending_id);
      else approveOnPage(db, p.pending_id);
    }
    const gate = must(db, "gate_list", {}).gate;
    expect(gate.map((g: any) => g.action)).toEqual([...ACTIONS]);
    for (const g of gate) expect(g).toMatchObject({ level, levels: ["agent_decides", "click", "passkey"] });

    const attempts = [
      must(db, "invoice_issue", { id: toIssue }),
      must(db, "invoice_void", { id: toVoid, reason: "Wrong client" }),
      must(db, "invoice_credit", { invoice_id: toCredit, reason: "Discount", amount_cents: 500, line_kind: "manual" }),
      must(db, "profile_set", { payment_instructions: "Zelle to jane@example.com" }),
    ];
    for (const r of attempts) {
      if (level === "agent_decides") {
        expect(r.status).toBeUndefined(); // it ran
      } else {
        expect(r).toMatchObject({ status: "pending", level });
        const click = approvePending(db, r.pending_id, { via: "page" }, WHEN);
        if (level === "click") expect(click.ok).toBe(true);
        else {
          expect(click).toMatchObject({ ok: false, refusal: { field: "passkey" } });
          await approveWithPasskey(db, auth, r.pending_id);
        }
      }
    }
    // Whichever way it got there, every action ran exactly once.
    expect([status(db, toIssue), status(db, toVoid)]).toEqual(["issued", "void"]);
    expect(must(db, "invoice_list", { status: "issued" }).invoices.filter((i: any) => i.kind === "credit").length).toBe(1);
    expect(must(db, "profile_get", {}).profile.payment_instructions).toBe("Zelle to jane@example.com");
    db.close();
  }
});

test("ISC-65 defaults: a fresh install sets every client-reaching action to click", async () => {
  const dir = tempDir();
  expect((await ok(dir, ["gate", "list"])).gate).toEqual(
    ACTIONS.map((a) => expect.objectContaining({ action: a, level: "click", default: "click" })),
  );
  expect(asPerson(dir, (db) => db.query("SELECT COUNT(*) n FROM gate_levels").get())).toEqual({ n: 0 });

  // On fresh books, the first issue waits for the person.
  await ok(dir, json(["profile", "set"], { legal_name: "Jane Doe LLC", address: "1 Main St", ein: "12-3456789" }));
  await ok(dir, json(["client", "add"], { name: "Acme Corp", address: "500 Market St" }));
  const d = (await ok(dir, json(["invoice", "draft"], { client_id: 1, period_start: "2026-10-01", period_end: "2026-10-31", lines: [{ description: "Work", amount_cents: 100 }] }))).invoice;
  expect(await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S])).toMatchObject({ status: "pending", level: "click" });
});

test("ISC-66 no self approval: no CLI command or MCP tool approves a pending action", async () => {
  const dir = await clickAcme();
  const d = await draftOctober(dir);
  const pid = (await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S])).pending_id;

  // Every command there is: the operations, plus serve, which only starts the page.
  const commands = (await ok(dir, ["help"])).commands.map((c: any) => c.command);
  expect(commands).toEqual([...OPS.map((o) => o.name.replace("_", " ")), "serve"]);
  const mcp = await inProcessMcp(dir, { SOLOBOOKS_NOW: WHEN.now });
  const tools = (await mcp.request("tools/list")).result.tools.map((t: any) => t.name);
  expect(tools).toEqual(OPS.map((o) => o.name));
  expect([...commands, ...tools].filter((n: string) => /approv|reject|decide|confirm|passkey/.test(n))).toEqual([]);

  // Throw every operation at the pending action, with its normal input and with inputs that name the pending action.
  const scenario = new Map(SCENARIO.map((s) => [s.op, s.input]));
  const tries = (op: string) => [
    scenario.get(op) ?? {},
    {},
    { id: pid },
    { pending_id: pid },
    { id: pid, pending_id: pid, approve: true, status: "approved", level: "agent_decides" },
    { invoice_issue: "agent_decides", invoice_void: "agent_decides", invoice_credit: "agent_decides", payment_instructions: "agent_decides" },
  ];
  for (const op of OPS) {
    for (const input of tries(op.name)) {
      await cli(dir, cliArgs({ op: op.name, input }, "agent:attacker"));
      await mcp.call(op.name, { ...input, source: "agent:attacker" });
    }
  }
  for (const words of [["pending", "approve"], ["approve"], ["gate", "approve"], ["pending", "reject"]]) {
    expect((await cli(dir, [...words, "--id", String(pid), ...S])).out.field).toBe("command");
  }
  expect((await mcp.request("tools/call", { name: "pending_approve", arguments: { id: pid, source: "x" } })).error ?? (await mcp.call("pending_approve", { id: pid })).isError).toBeTruthy();
  await mcp.close();

  asPerson(dir, (db) => {
    expect(pendingStatus(db, pid)).toBe("pending");
    // Only the person's own two gate changes (agent decides, then click) were ever decided.
    expect(db.query("SELECT COUNT(*) n FROM pending_actions WHERE status <> 'pending'").get()).toEqual({ n: 2 });
    // The attempts really ran: the attacker's ordinary writes landed and its gated ones were parked.
    expect((db.query("SELECT COUNT(*) n FROM history WHERE source = 'agent:attacker'").get() as { n: number }).n).toBeGreaterThan(10);
    expect((db.query("SELECT COUNT(*) n FROM pending_actions WHERE source = 'agent:attacker'").get() as { n: number }).n).toBeGreaterThan(2);
    expect(db.query("SELECT COUNT(*) n FROM history WHERE op IN ('pending_approve', 'pending_reject') AND source <> 'person:page'").get()).toEqual({ n: 0 });
    expect(db.query("SELECT level FROM gate_levels WHERE action = 'invoice_issue'").get()).toEqual({ level: "click" });
  });

  // And nothing an operation can reach calls the approval: only the page and the MCP approval prompt do.
  const callers = readdirSync(join(ROOT, "src"), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts") && /approvePending\(/.test(readFileSync(join(ROOT, "src", f), "utf8")));
  expect(callers.sort()).toEqual(["core/approve.ts", "mcp.ts", "page.ts"]);
}, 120_000); // every operation, six inputs each, through both adapters

test("ISC-68 setting gated: changing a gate level creates a pending approval at the stricter of old and new", async () => {
  const dir = tempDir();
  const asked = await ok(dir, ["gate", "set", "--invoice-issue", "agent_decides", ...S]);
  expect(asked).toMatchObject({ status: "pending", level: "click" });
  expect((await ok(dir, ["gate", "list"])).gate[0].level).toBe("click"); // unchanged until the person approves
  const mcp = await inProcessMcp(dir, { SOLOBOOKS_NOW: WHEN.now });
  expect((await mcp.call("gate_set", { invoice_void: "agent_decides", source: "agent:mcp" })).structuredContent).toMatchObject({ status: "pending" });
  await mcp.close();
  asPerson(dir, (db) => approveOnPage(db, asked.pending_id));
  expect((await ok(dir, ["gate", "list"])).gate[0].level).toBe("agent_decides");

  // Loosening never skips the gate, even from agent_decides; and the stricter level is what must approve.
  const db = coreBooks();
  expect(must(db, "gate_set", { invoice_issue: "click" })).toMatchObject({ status: "pending", level: "click" });
  expect(write(db, "gate_set", { invoice_issue: "passkey" })).toMatchObject({ ok: false, refusal: { field: "invoice_issue" } }); // no passkey yet
  const auth = await registerTestPasskey(db);
  await approveWithPasskey(db, auth, must(db, "gate_set", { invoice_issue: "passkey" }).pending_id);
  const down = must(db, "gate_set", { invoice_issue: "agent_decides" });
  expect(down.level).toBe("passkey");
  expect(approvePending(db, down.pending_id, { via: "page" }, WHEN)).toMatchObject({ ok: false, refusal: { field: "passkey" } });
  expect(must(db, "gate_list", {}).gate[0].level).toBe("passkey");
  await approveWithPasskey(db, auth, down.pending_id);
  expect(must(db, "gate_list", {}).gate[0].level).toBe("agent_decides");
  expect(write(db, "gate_set", { invoice_issue: "agent_decides" })).toMatchObject({ ok: false, refusal: { field: "invoice_issue" } }); // nothing to change
});

test("ISC-69 payment details: changing the payment instructions printed on invoices is gated by default", async () => {
  const dir = tempDir();
  await ok(dir, json(["profile", "set"], { legal_name: "Jane Doe LLC" })); // not gated
  const r = await ok(dir, json(["profile", "set"], { payment_instructions: "ACH to Evil Bank, account 666" }));
  expect(r).toMatchObject({ status: "pending", level: "click", title: 'Change the payment instructions printed on invoices to "ACH to Evil Bank, account 666"?' });
  expect((await ok(dir, ["profile", "get"])).profile).toMatchObject({ legal_name: "Jane Doe LLC", payment_instructions: null });
  asPerson(dir, (db) => approveOnPage(db, r.pending_id));
  expect((await ok(dir, ["profile", "get"])).profile.payment_instructions).toBe("ACH to Evil Bank, account 666");
});

test("ISC-71 batch: one approval issues every invoice in the batch", () => {
  const db = coreBooks();
  setLevels(db, ALL("click"));
  const ids = [draft(db, 1, 90500), draft(db, 2, 20000), draft(db, 3, 1234)];
  const asked = must(db, "invoice_issue", { ids });
  expect(asked).toMatchObject({ status: "pending", title: "Issue 3 invoices totalling $1,117.34?" });
  const p = must(db, "pending_get", { id: asked.pending_id }).pending;
  expect(p.items).toEqual([
    { invoice_id: ids[0], number: "7001", client: "Acme Corp", total_cents: 90500 },
    { invoice_id: ids[1], number: "7002", client: "Beta LLC", total_cents: 20000 },
    { invoice_id: ids[2], number: "7003", client: "Gamma Inc", total_cents: 1234 },
  ]);
  expect(db.query("SELECT COUNT(*) n FROM pending_actions WHERE status = 'pending'").get()).toEqual({ n: 1 });
  const history = (db.query("SELECT COUNT(*) n FROM history").get() as { n: number }).n;

  const done = approveOnPage(db, asked.pending_id);
  expect(done.result.invoices.map((i: any) => [i.id, i.status, i.number])).toEqual([
    [ids[0], "issued", "7001"],
    [ids[1], "issued", "7002"],
    [ids[2], "issued", "7003"],
  ]);
  expect(db.query("SELECT COUNT(*) n FROM history").get()).toEqual({ n: history + 1 }); // one approval, one write
});

test("ISC-72 batch exclude: an invoice pulled from a batch before approval stays a draft", () => {
  const db = coreBooks();
  setLevels(db, ALL("click"));
  const ids = [draft(db, 1), draft(db, 2), draft(db, 3)];
  const pid = must(db, "invoice_issue", { ids }).pending_id;
  expect(approvePending(db, pid, { via: "page", exclude: [99] }, WHEN)).toMatchObject({ ok: false, refusal: { field: "exclude" } });
  expect(approvePending(db, pid, { via: "page", exclude: ids }, WHEN)).toMatchObject({ ok: false, refusal: { field: "exclude" } });
  const linesBefore = db.query("SELECT * FROM invoice_lines WHERE invoice_id = ?").all(ids[1]!);

  const done = approveOnPage(db, pid, [ids[1]!]);
  expect(done.result.invoices.map((i: any) => [i.id, i.number])).toEqual([[ids[0], "7001"], [ids[2], "7002"]]); // still no gap
  expect(status(db, ids[1]!)).toBe("draft");
  expect(db.query("SELECT number FROM invoices WHERE id = ?").get(ids[1]!)).toEqual({ number: null });
  expect(db.query("SELECT * FROM invoice_lines WHERE invoice_id = ?").all(ids[1]!)).toEqual(linesBefore);
  expect(must(db, "pending_get", { id: pid }).pending).toMatchObject({ status: "approved", excluded: [ids[1]] });
  // The pulled draft can be edited and issued later on its own.
  must(db, "invoice_edit", { id: ids[1]!, note: "Adjusted" });
});
