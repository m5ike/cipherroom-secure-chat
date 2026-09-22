// A synthetic WebAuthn authenticator for the server tests: it produces the
// same CBOR / COSE / signature structures a real passkey does, so
// server/accounts/webauthn.ts can be exercised (and made to fail) without a
// browser. ES256 by default; Ed25519 and RS256 for the other code paths.

import { createHash, createSign, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";

export type AuthAlg = "ES256" | "EdDSA" | "RS256";

const b64url = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const sha256 = (d: Uint8Array | string) => createHash("sha256").update(d).digest();

/* ------------------------------------------------------------------ CBOR */

function cborHead(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  if (length < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(length, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(length, 1);
  return b;
}

export type CborInput = number | string | Buffer | Uint8Array | Map<CborInput, CborInput> | CborInput[];

export function encodeCbor(value: CborInput): Buffer {
  if (typeof value === "number") {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -value - 1);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    return Buffer.concat([cborHead(2, bytes.length), bytes]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([cborHead(4, value.length), ...value.map(encodeCbor)]);
  }
  const parts = [cborHead(5, value.size)];
  for (const [k, v] of value) parts.push(encodeCbor(k), encodeCbor(v));
  return Buffer.concat(parts);
}

/* --------------------------------------------------------------- key pair */

function keyPair(alg: AuthAlg) {
  if (alg === "ES256") return generateKeyPairSync("ec", { namedCurve: "P-256" });
  if (alg === "EdDSA") return generateKeyPairSync("ed25519");
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

function coseKey(alg: AuthAlg, publicKey: KeyObject): Map<CborInput, CborInput> {
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, string>;
  const dec = (v: string) => Buffer.from(v, "base64url");
  if (alg === "ES256") {
    return new Map<CborInput, CborInput>([[1, 2], [3, -7], [-1, 1], [-2, dec(jwk.x)], [-3, dec(jwk.y)]]);
  }
  if (alg === "EdDSA") {
    return new Map<CborInput, CborInput>([[1, 1], [3, -8], [-1, 6], [-2, dec(jwk.x)]]);
  }
  return new Map<CborInput, CborInput>([[1, 3], [3, -257], [-1, dec(jwk.n)], [-2, dec(jwk.e)]]);
}

/* --------------------------------------------------------- authenticator */

export type CeremonyOptions = {
  /** Sign the ceremony against a different rpId than the one claimed. */
  rpId?: string;
  origin?: string;
  /** Omit the user-verified flag (a device that only checked presence). */
  uv?: boolean;
  /** Omit the user-present flag. */
  up?: boolean;
  crossOrigin?: boolean;
  /** Force a signature counter value instead of the increment. */
  signCount?: number;
  /** Corrupt the signature (replay / forgery tests). */
  tamperSignature?: boolean;
};

export class FakeAuthenticator {
  readonly credentialId: Buffer;
  private readonly keys: { publicKey: KeyObject; privateKey: KeyObject };
  private counter = 0;

  constructor(
    readonly rpId = "localhost",
    readonly origin = "http://localhost",
    readonly alg: AuthAlg = "ES256",
    credentialId?: Buffer,
  ) {
    this.credentialId = credentialId ?? Buffer.from(sha256(`${rpId}:${Math.random()}`)).subarray(0, 20);
    this.keys = keyPair(alg);
  }

  private clientData(type: string, challenge: string, o: CeremonyOptions): Buffer {
    return Buffer.from(JSON.stringify({
      type,
      challenge: challenge.replace(/=+$/, ""),
      origin: o.origin ?? this.origin,
      ...(o.crossOrigin === undefined ? {} : { crossOrigin: o.crossOrigin }),
    }), "utf8");
  }

  private authData(o: CeremonyOptions, attested: boolean): Buffer {
    const flags = (o.up === false ? 0 : 0x01) | (o.uv === false ? 0 : 0x04) | (attested ? 0x40 : 0);
    const head = Buffer.concat([sha256(o.rpId ?? this.rpId), Buffer.from([flags]), Buffer.alloc(4)]);
    this.counter = o.signCount ?? this.counter + 1;
    head.writeUInt32BE(this.counter, 33);
    if (!attested) return head;
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    return Buffer.concat([
      head,
      Buffer.alloc(16), // AAGUID
      idLen,
      this.credentialId,
      encodeCbor(coseKey(this.alg, this.keys.publicKey)),
    ]);
  }

  /** navigator.credentials.create() — registration response JSON. */
  register(challenge: string, o: CeremonyOptions = {}) {
    const clientDataJSON = this.clientData("webauthn.create", challenge, o);
    const authData = this.authData(o, true);
    const attestationObject = encodeCbor(new Map<CborInput, CborInput>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ]));
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key",
      response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject) },
    };
  }

  /** navigator.credentials.get() — assertion response JSON. */
  assert(challenge: string, o: CeremonyOptions = {}) {
    const clientDataJSON = this.clientData("webauthn.get", challenge, o);
    const authData = this.authData(o, false);
    const signed = Buffer.concat([authData, sha256(clientDataJSON)]);
    let signature = this.sign(signed);
    if (o.tamperSignature) signature = Buffer.concat([signature.subarray(0, signature.length - 1), Buffer.from([signature[signature.length - 1] ^ 0xff])]);
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
      },
    };
  }

  private sign(data: Buffer): Buffer {
    if (this.alg === "EdDSA") return cryptoSign(null, data, this.keys.privateKey);
    if (this.alg === "ES256") return createSign("sha256").update(data).sign(this.keys.privateKey);
    return createSign("sha256").update(data).sign(this.keys.privateKey);
  }
}
