import { approvePending, registerPasskey } from "../../src/core/approve.ts";
import { openBooks, type Books } from "../../src/core/db.ts";
import { DEFAULT_PAGE } from "../../src/core/gate.ts";
import { perform } from "../../src/core/perform.ts";
import { authenticationOptions, registrationOptions, verifyPasskey, verifyRegistration } from "../../src/core/passkey.ts";
import { SoftAuthenticator } from "./authenticator.ts";
import { dbPath } from "./books.ts";

// What the person does on the approval page, done in-process: tests stand in for the person here, never the agent.

export const NOW = "2026-10-22T12:00:00.000Z";
export const WHEN = { now: NOW, page: DEFAULT_PAGE };
export const ORIGIN = "http://localhost:7317";

const OPEN = { invoice_issue: "agent_decides", invoice_void: "agent_decides", invoice_credit: "agent_decides", payment_instructions: "agent_decides" };

/** The person approves pending action `id` on the page, at click level. */
export function approveOnPage(db: Books, id: number, exclude?: number[]) {
  const r = approvePending(db, id, { via: "page", exclude }, WHEN);
  if (!r.ok) throw new Error(`approval refused: ${JSON.stringify(r.refusal)}`);
  return r.result as any;
}

/** The person approves pending action `id` on the page with their passkey (Touch ID, here a software authenticator). */
export async function approveWithPasskey(db: Books, auth: SoftAuthenticator, id: number, exclude?: number[]) {
  const options = await authenticationOptions(db);
  const passkey = await verifyPasskey(db, (await auth.assert(options, ORIGIN)) as any, options.challenge, ORIGIN, id);
  const r = approvePending(db, id, { via: "page", exclude, passkey }, WHEN);
  if (!r.ok) throw new Error(`passkey approval refused: ${JSON.stringify(r.refusal)}`);
  return r.result as any;
}

/** The person lets the agent decide every gated action, as books from before the gate behaved. */
export function letAgentDecide(db: Books): void {
  const r = perform(db, "gate_set", OPEN, { source: "agent:test", now: NOW });
  if (!r.ok) throw new Error(`gate_set refused: ${JSON.stringify(r.refusal)}`);
  approveOnPage(db, r.result.pending_id as number);
}

/** The person registers the test passkey on the page. */
export async function registerTestPasskey(db: Books, auth?: SoftAuthenticator): Promise<SoftAuthenticator> {
  const a = auth ?? (await SoftAuthenticator.create());
  const options = await registrationOptions();
  const k = await verifyRegistration((await a.register(options, ORIGIN)) as any, options.challenge, ORIGIN);
  const r = registerPasskey(db, k, WHEN);
  if (!r.ok) throw new Error(`passkey registration refused: ${JSON.stringify(r.refusal)}`);
  return a;
}

/** Books in a folder where the person registered a passkey and let the agent decide everything. */
export async function setUpPerson(dir: string): Promise<void> {
  const db = openBooks(dbPath(dir));
  try {
    await registerTestPasskey(db);
    letAgentDecide(db);
  } finally {
    db.close();
  }
}

/** Opens a books folder for the person's side, then closes it, after the work finishes when it is async. */
export function asPerson<T>(dir: string, f: (db: Books) => T): T {
  const db = openBooks(dbPath(dir));
  let r: T;
  try {
    r = f(db);
  } catch (e) {
    db.close();
    throw e;
  }
  if (r instanceof Promise) return r.finally(() => db.close()) as T;
  db.close();
  return r;
}

/** Every gated action at one level. */
export const ALL_AT = (level: string) => Object.fromEntries(Object.keys(OPEN).map((a) => [a, level]));

/** The person sets every gated action to `level` on the page (any level but passkey). */
export function setEveryLevel(db: Books, level: string): void {
  const r = perform(db, "gate_set", ALL_AT(level), { source: "agent:test", now: NOW });
  if (!r.ok) throw new Error(`gate_set refused: ${JSON.stringify(r.refusal)}`);
  approveOnPage(db, r.result.pending_id as number);
}

/** Books in a folder where the person let the agent decide everything. */
export function letAgentDecideIn(dir: string): void {
  const db = openBooks(dbPath(dir));
  try {
    letAgentDecide(db);
  } finally {
    db.close();
  }
}
