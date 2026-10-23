import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Books } from "./db.ts";
import { Refusal } from "./refusal.ts";

// WebAuthn for passkey-level approvals, checked with @simplewebauthn/server. The ceremonies happen only on the local
// approval page: a passkey assertion is never accepted through the CLI or MCP.

/** A passkey belongs to a domain, never an IP address, so the page is served as localhost. */
export const RP_ID = "localhost";

type PasskeyRow = { credential_id: string; public_key: Uint8Array; counter: number; transports: string | null };

function passkeys(db: Books): PasskeyRow[] {
  return db.query("SELECT credential_id, public_key, counter, transports FROM passkeys ORDER BY id").all() as PasskeyRow[];
}

const transportsOf = (r: PasskeyRow) => (r.transports ? (JSON.parse(r.transports) as any[]) : undefined);

export function registrationOptions() {
  return generateRegistrationOptions({
    rpName: "solobooks",
    rpID: RP_ID,
    userName: "solobooks",
    userDisplayName: "The person who keeps these books",
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
}

export type NewPasskey = { credential_id: string; public_key: Uint8Array; counter: number; transports: string | null; aaguid: string };

/** Checks a registration from the page against the challenge the page issued. */
export async function verifyRegistration(response: RegistrationResponseJSON, expectedChallenge: string, origin: string): Promise<NewPasskey> {
  let r;
  try {
    r = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: origin, expectedRPID: RP_ID, requireUserVerification: true });
  } catch {
    throw new Refusal("The passkey registration couldn't be checked, so start it again on the approval page.", "passkey");
  }
  if (!r.verified) throw new Refusal("The passkey registration couldn't be checked, so start it again on the approval page.", "passkey");
  const c = r.registrationInfo.credential;
  return {
    credential_id: c.id,
    public_key: c.publicKey,
    counter: c.counter,
    transports: c.transports ? JSON.stringify(c.transports) : null,
    aaguid: r.registrationInfo.aaguid,
  };
}

export function authenticationOptions(db: Books) {
  return generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: passkeys(db).map((r) => ({ id: r.credential_id, transports: transportsOf(r) })),
    userVerification: "required",
  });
}

/** Proof that the person's registered passkey signed this page's challenge for one pending action. */
export type VerifiedPasskey = { readonly credential_id: string; readonly new_counter: number; readonly pending_id: number };

// Only objects made here count, and each counts once, so a passkey approval can't be forged by building the shape.
const verified = new WeakSet<VerifiedPasskey>();

export async function verifyPasskey(
  db: Books,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  origin: string,
  pendingId: number,
): Promise<VerifiedPasskey> {
  const failed = new Refusal("The passkey check failed, so approve again with the passkey registered for these books.", "passkey");
  const row = passkeys(db).find((r) => r.credential_id === response?.id);
  if (!row) throw failed;
  let r;
  try {
    r = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: RP_ID,
      credential: { id: row.credential_id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: transportsOf(row) },
      requireUserVerification: true,
    });
  } catch {
    throw failed;
  }
  if (!r.verified) throw failed;
  const v: VerifiedPasskey = Object.freeze({ credential_id: row.credential_id, new_counter: r.authenticationInfo.newCounter, pending_id: pendingId });
  verified.add(v);
  return v;
}

/** Spends a verified passkey proof on the pending action it was made for. False if it is forged, spent or for another. */
export function spendPasskey(v: VerifiedPasskey | undefined, pendingId: number): boolean {
  if (!v || !verified.has(v) || v.pending_id !== pendingId) return false;
  verified.delete(v);
  return true;
}
