import { base64url, fromBase64url } from "@proofline/core";

/**
 * A minimal software WebAuthn authenticator (ES256, "none" attestation) so the
 * passkey rung can be tested end to end without a browser.
 */

type Cbor = number | Uint8Array | string | CborMap | CborRecord;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- needed to break the recursive alias
interface CborMap extends Map<Cbor, Cbor> {}
interface CborRecord {
  [key: string]: Cbor;
}

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
  return [(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function cbor(v: Cbor): number[] {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const b = new TextEncoder().encode(v);
    return [...head(3, b.length), ...b];
  }
  if (v instanceof Uint8Array) return [...head(2, v.length), ...v];
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return [...head(5, entries.length), ...entries.flatMap(([k, val]) => [...cbor(k), ...cbor(val)])];
}

const sha256 = async (b: Uint8Array | string) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", typeof b === "string" ? new TextEncoder().encode(b) : (b as Uint8Array<ArrayBuffer>)));

function derSignature(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.slice(i);
    return v[0]! & 0x80 ? [0x02, v.length + 1, 0, ...v] : [0x02, v.length, ...v];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

export class SoftAuthenticator {
  #keys?: CryptoKeyPair;
  credentialId = crypto.getRandomValues(new Uint8Array(16));
  counter = 0;

  constructor(readonly origin: string) {}

  get rpId() {
    return new URL(this.origin).hostname;
  }

  async register(options: { challenge: string }) {
    this.#keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", this.#keys.publicKey);
    const cose = new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, fromBase64url(jwk.x!)],
      [-3, fromBase64url(jwk.y!)],
    ]);
    const authData = new Uint8Array([
      ...(await sha256(this.rpId)),
      0x45, // UP | UV | AT
      0, 0, 0, 0,
      ...new Uint8Array(16), // aaguid
      0, this.credentialId.length,
      ...this.credentialId,
      ...cbor(cose),
    ]);
    const clientDataJSON = JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.origin, crossOrigin: false });
    const id = base64url(this.credentialId);
    return {
      id,
      rawId: id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: base64url(new TextEncoder().encode(clientDataJSON)),
        attestationObject: base64url(new Uint8Array(cbor({ fmt: "none", attStmt: {}, authData }))),
        transports: ["internal"],
      },
    };
  }

  async assert(options: { challenge: string }, overrides: { origin?: string } = {}) {
    if (!this.#keys) throw new Error("register first");
    this.counter++;
    const c = this.counter;
    const authData = new Uint8Array([...(await sha256(this.rpId)), 0x05, (c >>> 24) & 255, (c >> 16) & 255, (c >> 8) & 255, c & 255]);
    const clientDataJSON = new TextEncoder().encode(
      JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: overrides.origin ?? this.origin, crossOrigin: false }),
    );
    const signed = new Uint8Array([...authData, ...(await sha256(clientDataJSON))]);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.#keys.privateKey, signed));
    const id = base64url(this.credentialId);
    return {
      id,
      rawId: id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: base64url(clientDataJSON),
        authenticatorData: base64url(authData),
        signature: base64url(derSignature(raw)),
      },
    };
  }
}
