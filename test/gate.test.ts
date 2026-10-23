import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { approvePending, rejectPending } from "../src/core/approve.ts";
import type { Books } from "../src/core/db.ts";
import { ACTIONS, LEVELS, promptFields } from "../src/core/gate.ts";
import { authenticationOptions, verifyPasskey } from "../src/core/passkey.ts";
import { OPS } from "../src/core/perform.ts";
import { clickAcme, draftOctober, json, ok, S, SELLER } from "./support/billing.ts";
import { cli, dbPath, dumpDb, fileHash, memBooks, ROOT, tempDir } from "./support/books.ts";
import { must, write } from "./support/gen.ts";
import { inProcessMcp } from "./support/mcp-client.ts";
import { approveOnPage, approveWithPasskey, asPerson, letAgentDecide, ORIGIN, registerTestPasskey, WHEN } from "./support/person.ts";
import { cliArgs, SCENARIO } from "./support/scenario.ts";
import { startPage } from "../src/page.ts";

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
  const { payment_instructions, ...seller } = SELLER;
  must(db, "profile_set", seller);
  must(db, "profile_payment_instructions_set", { payment_instructions });
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
  expect(issue).toMatchObject({ status: "pending", level: "click", title: `Issue invoice 7001 for $${(d.total_cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}?` });
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

  // The agent asks to issue a $100 draft, then tries to raise it to $100,100 before the person clicks.
  const q = must(db, "invoice_issue", { id: a }).pending_id;
  expect(write(db, "invoice_edit", { id: a, add_lines: [{ description: "More", amount_cents: 10_000_000 }] })).toMatchObject({ ok: false, refusal: { field: "id" } });
  db.query("INSERT INTO invoice_lines (invoice_id, kind, description, amount_cents, source) VALUES (?, 'manual', 'More', 10000000, 'x')").run(a); // past the hold
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
      must(db, "profile_payment_instructions_set", { payment_instructions: "Zelle to jane@example.com" }),
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

  // Every command there is: the operations, plus serve, which only starts the page, and the install commands, which
  // connect agents and check the install but never open a pending action.
  const commands = (await ok(dir, ["help"])).commands.map((c: any) => c.command);
  expect(commands).toEqual([...OPS.map((o) => o.name.replaceAll("_", " ")), "serve", "setup", "doctor", "mcp", "version"]);
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
  const r = await ok(dir, json(["profile", "payment", "instructions", "set"], { payment_instructions: "ACH to Evil Bank, account 666" }));
  expect(r).toMatchObject({ status: "pending", level: "click", title: "Change the payment instructions printed on invoices?" });
  expect((await ok(dir, ["pending", "get", "--id", String(r.pending_id)])).pending.items).toEqual([{ from: null, to: "ACH to Evil Bank, account 666" }]);
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
  expect(p.items.map((i: any) => [i.invoice_id, i.number, i.client, i.total_cents, i.lines])).toEqual([
    [ids[0], "7001", "Acme Corp", 90500, [{ kind: "manual", description: "Work", amount_cents: 90500 }]],
    [ids[1], "7002", "Beta LLC", 20000, [{ kind: "manual", description: "Work", amount_cents: 20000 }]],
    [ids[2], "7003", "Gamma Inc", 1234, [{ kind: "manual", description: "Work", amount_cents: 1234 }]],
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

// ---------------------------------------------------------------- audit: what the person approves is what runs

const swapAndEdits = (id: number, line: { id: number; amount_cents: number }) => [
  ["invoice", "edit", "--id", String(id), "--note", "Pay only by wire to First Evil Bank 666666", ...S],
  json(["invoice", "edit"], { id, remove_lines: [{ line_id: line.id }], add_lines: [{ description: "Wire to First Evil Bank 666666", amount_cents: line.amount_cents }] }),
  ["invoice", "edit", "--id", String(id), "--terms-days", "0", ...S],
  ["invoice", "delete", "--id", String(id), ...S],
  ["time", "edit", "--id", "1", "--note", "Wire to First Evil Bank 666666", ...S],
  ["time", "delete", "--id", "1", ...S],
  ["client", "edit", "--id", "1", "--address", "1 Evil Way", ...S],
];

test("ISC-63 parks: a draft waiting for approval refuses every change to what would be issued, at click and passkey", async () => {
  for (const level of ["click", "passkey"]) {
    const dir = await clickAcme();
    if (level === "passkey") {
      const auth = await asPerson(dir, (db) => registerTestPasskey(db));
      const up = await ok(dir, ["gate", "set", "--invoice-issue", "passkey", ...S]);
      await asPerson(dir, (db) => approveWithPasskey(db, auth, up.pending_id));
    }
    const d = await draftOctober(dir);
    const p = await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S]);
    expect(p.level).toBe(level);
    const before = (await ok(dir, ["invoice", "get", "--id", String(d.id)])).invoice;
    for (const args of swapAndEdits(d.id, d.lines[0])) {
      const r = await cli(dir, args);
      expect([args.slice(0, 2).join(" "), r.code, r.out.field]).toEqual([args.slice(0, 2).join(" "), 2, "id"]);
      expect(r.out.reason).toContain("is waiting for approval");
    }
    expect((await ok(dir, ["invoice", "get", "--id", String(d.id)])).invoice).toEqual(before);
    // Work that doesn't touch the waiting draft goes on, and once the person decides, the draft is free again.
    await ok(dir, ["time", "add", "--client-id", "1", "--date", "2026-12-01", "--minutes", "30", "--note", "Later", ...S]);
    asPerson(dir, (db) => rejectPending(db, p.pending_id, "page", WHEN));
    await ok(dir, ["invoice", "edit", "--id", String(d.id), "--note", "Thanks", ...S]);
  }
}, 60_000);

test("ISC-74 passkey: approval refuses anything issue would freeze that changed after the person was asked, apart from the number", async () => {
  for (const level of ["click", "passkey"]) {
    const db = coreBooks();
    const auth = await registerTestPasskey(db);
    const up = must(db, "gate_set", { invoice_issue: level });
    if (level === "passkey") await approveWithPasskey(db, auth, up.pending_id);
    else approveOnPage(db, up.pending_id);
    const tryApprove = async (id: number) => {
      if (level === "click") return approvePending(db, id, { via: "page" }, WHEN);
      try {
        return { ok: true, result: await approveWithPasskey(db, auth, id) };
      } catch (e) {
        return { ok: false, refusal: JSON.parse(String(e).replace(/^.*refused: /, "")) };
      }
    };
    // Each change slips past the draft hold, straight into the file, or is an ordinary write the hold doesn't cover.
    const changes: ((id: number) => unknown)[] = [
      (id) => db.query("UPDATE invoices SET note = 'Pay only by wire to First Evil Bank 666666' WHERE id = ?").run(id),
      (id) => db.query("UPDATE invoice_lines SET description = 'Wire to First Evil Bank 666666' WHERE invoice_id = ?").run(id), // same total
      (id) => db.query("UPDATE invoices SET terms_days = 0 WHERE id = ?").run(id),
      () => must(db, "profile_set", { legal_name: "Evil Twin LLC" }),
    ];
    for (const change of changes) {
      const a = draft(db);
      const pid = must(db, "invoice_issue", { id: a }).pending_id;
      change(a);
      expect(await tryApprove(pid)).toMatchObject({ ok: false, refusal: { field: "pending_id" } });
      expect(status(db, a)).toBe("draft");
      rejectPending(db, pid, "page", WHEN);
    }
    // Only the number may move: another invoice issued first takes the number this one was shown.
    const [a, b] = [draft(db), draft(db, 2)];
    const [pa, pb] = [must(db, "invoice_issue", { id: a }).pending_id, must(db, "invoice_issue", { id: b }).pending_id];
    expect(await tryApprove(pb)).toMatchObject({ ok: true });
    expect(await tryApprove(pa)).toMatchObject({ ok: true, result: { result: { invoice: { number: "7002" } } } });
    db.close();
  }
});

test("ISC-69 payment details: the page card and the chat prompt show every line, the note, terms, due date, payment instructions and reasons", async () => {
  const dir = await clickAcme();
  const d = await draftOctober(dir);
  const note = "Pay only by wire to First Evil Bank 666666";
  await ok(dir, ["invoice", "edit", "--id", String(d.id), "--note", note, ...S]);
  const pid = (await ok(dir, ["invoice", "issue", "--id", String(d.id), ...S])).pending_id;
  const expected = [
    note,
    "Acme Corp",
    SELLER.payment_instructions,
    "Net 30",
    "2026-11-21",
    ...d.lines.map((l: any) => l.description),
    ...d.lines.map((l: any) => `$${(l.amount_cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`),
  ];
  const page = startPage({ books: dir, port: 0, env: { SOLOBOOKS_NOW: WHEN.now } });
  const cardText = async (id: number) => {
    const html = await (await fetch(page.url)).text();
    const card = html.match(new RegExp(`<article class="card" id="pending-${id}">[\\s\\S]*?</article>`))![0];
    return card.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  };
  try {
    const card = await cardText(pid);
    for (const s of expected) expect(card).toContain(s);

    const mcp = await inProcessMcp(dir, { SOLOBOOKS_NOW: WHEN.now }, { capabilities: { elicitation: {} }, answer: () => ({ action: "decline" }) });
    await mcp.call("invoice_issue", { id: d.id, source: "agent:x" });
    for (const s of expected) expect(mcp.asked[0]!.params.message).toContain(s);

    // Voids and credit notes show their reason, the other text that reaches the client.
    asPerson(dir, (db) => approveOnPage(db, pid));
    const reason = "Client moved banks; resend to First Evil Bank 666666";
    const v = (await ok(dir, ["invoice", "void", "--id", String(d.id), "--reason", reason, ...S])).pending_id;
    const c = (await ok(dir, ["invoice", "credit", "--invoice-id", String(d.id), "--amount-cents", "1000", "--reason", reason, "--line-kind", "time", ...S])).pending_id;
    expect(await cardText(v)).toContain(reason);
    expect(await cardText(c)).toContain(reason);
    await mcp.call("invoice_credit", { invoice_id: d.id, amount_cents: 1000, reason, line_kind: "time", source: "agent:x" });
    expect(mcp.asked[1]!.params.message).toContain(reason);
    await mcp.close();
  } finally {
    page.stop();
  }
}, 30_000);

test("ISC-69 payment details: a change to the payment instructions can't carry other business details along with it", async () => {
  const dir = tempDir();
  const r = await cli(dir, json(["profile", "payment", "instructions", "set"], { payment_instructions: "Wire to account 42", legal_name: "Jane Doe LLC" }));
  expect([r.code, r.out.field]).toEqual([2, "legal_name"]);
  const db = coreBooks();
  expect(write(db, "profile_payment_instructions_set", { payment_instructions: "x", email: "evil@example.com" })).toMatchObject({ ok: false, refusal: { field: "email" } });
  expect(write(db, "profile_payment_instructions_set", {})).toMatchObject({ ok: false, refusal: { field: "payment_instructions" } });
  expect(asPerson(dir, (b) => b.query("SELECT COUNT(*) n FROM pending_actions").get())).toEqual({ n: 0 });
});

test("ISC-69 payment details: profile set refuses payment instructions in one sentence naming the gated command, and its other edits need no one", async () => {
  const dir = tempDir();
  const reason = "Change payment_instructions with profile_payment_instructions_set (solobooks profile payment instructions set), which waits for the person's approval.";
  for (const body of [{ payment_instructions: "Wire to account 42" }, { payment_instructions: "Wire to account 42", legal_name: "Jane Doe LLC" }]) {
    const r = await cli(dir, json(["profile", "set"], body));
    expect([r.code, r.out]).toEqual([2, { reason, field: "payment_instructions" }]);
  }
  const mcp = await inProcessMcp(dir, { SOLOBOOKS_NOW: WHEN.now }, { capabilities: { elicitation: { form: {} } }, answer: () => ({ action: "accept", content: {} }) });
  const refused = await mcp.call("profile_set", { payment_instructions: "Wire to account 42", source: "agent:x" });
  expect([refused.isError, refused.structuredContent]).toEqual([true, { reason, field: "payment_instructions" }]);
  // The eval's case: setting the next number to bring in past invoices just runs, with no prompt and nothing parked.
  const set = await mcp.call("profile_set", { next_invoice_number: 1043, legal_name: "Jane Doe LLC", source: "agent:x" });
  await mcp.close();
  expect(mcp.asked).toHaveLength(0);
  expect(set.structuredContent).toMatchObject({ profile: { legal_name: "Jane Doe LLC", next_invoice_number: 1043, payment_instructions: null } });
  expect(asPerson(dir, (db) => db.query("SELECT COUNT(*) n FROM pending_actions").get())).toEqual({ n: 0 });
}, 30_000);

test("ISC-66 no self approval: a journal entry or expense can't move the accounts invoices post to", () => {
  const db = coreBooks();
  must(db, "account_add", { name: "Checking", type: "asset" });
  must(db, "account_add", { name: "Software", type: "expense" });
  must(db, "invoice_issue", { id: draft(db) }); // creates the accounts invoices post to
  const id = (name: string) => (db.query("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
  const checking = id("Checking");
  for (const name of ["Accounts receivable", "Consulting income", "Reimbursed expense income", "Sales tax payable"]) {
    const lines = [{ account_id: id(name), debit_cents: 10000 }, { account_id: checking, credit_cents: 10000 }];
    const r = write(db, "entry_post", { date: "2026-10-23", memo: "Reverse it quietly", lines });
    expect(r).toMatchObject({ ok: false, refusal: { field: "lines[0].account_id" } });
    if (!r.ok) expect(r.refusal.reason).toContain("invoice void or invoice credit");
  }
  const paid = write(db, "expense_add", { date: "2026-10-23", amount_cents: 10000, vendor: "V", account_id: id("Software"), paid_from_account_id: id("Accounts receivable") });
  expect(paid).toMatchObject({ ok: false, refusal: { field: "paid_from_account_id" } });
  must(db, "entry_post", { date: "2026-10-23", memo: "Fine", lines: [{ account_id: id("Software"), debit_cents: 1 }, { account_id: checking, credit_cents: 1 }] });
});

test("ISC-68 setting gated: a gate change parked earlier is approved at the level in force now", async () => {
  const db = coreBooks();
  setLevels(db, ALL("click"));
  const auth = await registerTestPasskey(db);
  const stale = must(db, "gate_set", { invoice_issue: "agent_decides" }); // asked while issuing was click
  await approveWithPasskey(db, auth, must(db, "gate_set", { invoice_issue: "passkey" }).pending_id);
  for (const via of ["page", "elicitation"] as const) {
    expect(approvePending(db, stale.pending_id, { via }, WHEN)).toMatchObject({ ok: false, refusal: { field: "passkey" } });
  }
  expect(must(db, "gate_list", {}).gate[0].level).toBe("passkey");
});

test("ISC-63 parks: a request parked in the evening is approved the next morning, dated the day it is approved", async () => {
  const DAY2 = { ...WHEN, now: "2026-10-23T12:00:00.000Z" };
  for (const level of ["click", "passkey"]) {
    const db = coreBooks();
    const auth = await registerTestPasskey(db);
    const up = must(db, "gate_set", { invoice_issue: level });
    if (level === "passkey") await approveWithPasskey(db, auth, up.pending_id);
    else approveOnPage(db, up.pending_id);
    const a = draft(db);
    const pid = must(db, "invoice_issue", { id: a }).pending_id; // day 1, 2026-10-22
    const shown = must(db, "pending_get", { id: pid }).pending;
    expect(shown.items[0]).toMatchObject({ terms_days: 30 });
    let passkey;
    if (level === "passkey") {
      const o = await authenticationOptions(db);
      passkey = await verifyPasskey(db, (await auth.assert(o, ORIGIN)) as any, o.challenge, ORIGIN, pid);
    }
    const r = approvePending(db, pid, { via: "page", passkey }, DAY2); // day 2
    expect(r).toMatchObject({ ok: true, result: { result: { invoice: { status: "issued", invoice_date: "2026-10-23", due_date: "2026-11-22" } } } });
    db.close();
  }
});

test("ISC-69 payment details: the prompt says the invoice is dated the day it is approved, with the due date if approved today", async () => {
  const db = coreBooks();
  setLevels(db, ALL("click"));
  const pid = must(db, "invoice_issue", { id: draft(db) }).pending_id;
  const p = must(db, "pending_get", { id: pid }).pending;
  expect(promptFields(p)[0]).toContainEqual(["Terms", "Net 30; dated the day it is approved, so due 2026-11-21 if approved today"]);
});
