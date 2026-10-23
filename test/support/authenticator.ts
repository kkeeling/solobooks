// A software WebAuthn authenticator for tests: it makes the same registration and assertion responses a browser
// passkey does (fmt "none", ES256), so passkey-level approval is tested end to end without a person or Touch ID.

/** Test-only signing key, fixed so two books set up the same way hold byte-identical passkey rows. */
const TEST_KEY: JsonWebKey = {
  crv: "P-256",
  d: "Pktezrcl1Q-Ls3jUL6Ne8QOe_DBQVMU6ZOKOViAfIbA",
  ext: true,
  key_ops: ["sign"],
  kty: "EC",
  x: "sfnu1wDwTOwbrYL9ptJzYhvBAupi5O7RYNK3ENi-gOs",
  y: "Npa0XJSnLZuRnwGYtuhFxSR2FqZjipTeFujzRoi4xjg",
};

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const utf8 = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) out.set(p, (i += p.length) - p.length);
  return out;
};
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>));
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

/** Just enough CBOR for an attestation object and a COSE key: ints, byte strings, text and maps. */
function cbor(v: unknown): Uint8Array {
  const head = (major: number, n: number) =>
    n < 24 ? new Uint8Array([(major << 5) | n])
    : n < 256 ? new Uint8Array([(major << 5) | 24, n])
    : n < 65536 ? new Uint8Array([(major << 5) | 25, n >> 8, n & 255])
    : cat(new Uint8Array([(major << 5) | 26]), u32(n));
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (v instanceof Uint8Array) return cat(head(2, v.length), v);
  if (typeof v === "string") return cat(head(3, utf8(v).length), utf8(v));
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v as object);
  return cat(head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)]));
}

/** WebCrypto signs ECDSA as r||s; WebAuthn carries it DER-encoded. */
function der(raw: Uint8Array): Uint8Array {
  const int = (x: Uint8Array) => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    const t = x.slice(i);
    const body = t[0]! & 0x80 ? cat(new Uint8Array([0]), t) : t;
    return cat(new Uint8Array([2, body.length]), body);
  };
  const seq = cat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return cat(new Uint8Array([0x30, seq.length]), seq);
}

export class SoftAuthenticator {
  private counter = 0;
  readonly credentialId = new Uint8Array(16).fill(7);

  private constructor(private readonly key: CryptoKey) {}

  /** The fixed test passkey, or with `impostor`, one with the same credential id but a different private key. */
  static async create(o: { impostor?: boolean } = {}): Promise<SoftAuthenticator> {
    if (o.impostor) {
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
      return new SoftAuthenticator(pair.privateKey);
    }
    return new SoftAuthenticator(await crypto.subtle.importKey("jwk", TEST_KEY, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]));
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  private clientData(type: string, challenge: string, origin: string) {
    return utf8(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** Answers navigator.credentials.create() for registration options from the page. */
  async register(options: { challenge: string; rp: { id?: string } }, origin: string) {
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, unb64u(TEST_KEY.x!)], [-3, unb64u(TEST_KEY.y!)]]));
    const credLen = new Uint8Array([this.credentialId.length >> 8, this.credentialId.length & 255]);
    const authData = cat(await sha256(utf8(options.rp.id ?? "localhost")), new Uint8Array([0x45]), u32(0), new Uint8Array(16), credLen, this.credentialId, cose);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(this.clientData("webauthn.create", options.challenge, origin)),
        attestationObject: b64u(cbor({ fmt: "none", attStmt: {}, authData })),
        transports: ["internal" as const],
      },
    };
  }

  /** Answers navigator.credentials.get(). `verified: false` is a tap with no fingerprint or PIN. */
  async assert(options: { challenge: string; rpId?: string }, origin: string, o: { verified?: boolean } = {}) {
    const flags = o.verified === false ? 0x01 : 0x05;
    const authData = cat(await sha256(utf8(options.rpId ?? "localhost")), new Uint8Array([flags]), u32(++this.counter));
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, origin);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.key, cat(authData, await sha256(clientDataJSON)) as Uint8Array<ArrayBuffer>));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key" as const,
      clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(der(raw)) },
    };
  }
}
