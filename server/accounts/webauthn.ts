// WebAuthn (passkey) verification — registration and sign-in — with
// node:crypto only.
//
// Registration: the authenticator's attestation object carries the new
// credential's public key (COSE). We check the client data (type,
// challenge, origin), the authenticator data (rpId hash, user presence +
// user verification) and keep the public key. Attestation statements are not
// validated ("none" is requested): we do not need to know the device model,
// only that later sign-ins are made with the same key.
//
// Sign-in: the authenticator signs authenticatorData ‖ SHA-256(clientDataJSON)
// with that key. A valid signature over a fresh, single-use server challenge
// proves possession of the passkey. Supported: ES256 (-7), RS256 (-257),
// EdDSA / Ed25519 (-8). A signature counter that goes backwards is refused
// (cloned authenticator).

import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { decodeCbor, type CborValue } from "./cbor";

export const ALG = { ES256: -7, RS256: -257, EdDSA: -8 } as const;
export const SUPPORTED_ALGS: number[] = [ALG.ES256, ALG.EdDSA, ALG.RS256];

export type StoredCredential = {
  credentialId: string; // base64url
  publicKeyJwk: JsonWebKey;
  alg: number;
  signCount: number;
};

export type RpPolicy = {
  rpId: string;
  /** Exact allowed origins; when empty, any https origin on rpId (or a
   *  subdomain) is accepted, plus http://localhost for development. */
  origins?: string[];
};

export type RegistrationResponseJSON = {
  id: string;
  rawId: string;
  type: string;
  response: { clientDataJSON: string; attestationObject: string };
};

export type AssertionResponseJSON = {
  id: string;
  rawId: string;
  type: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null };
};

/* --------------------------------------------------------------- helpers */

export function b64urlToBuffer(value: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(value)) throw new Error("not base64url");
  return Buffer.from(value.replace(/=+$/, ""), "base64url");
}

export function bufferToB64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

export function isAllowedOrigin(origin: string, policy: RpPolicy): boolean {
  if (policy.origins && policy.origins.length > 0) return policy.origins.includes(origin);
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  const host = url.hostname;
  const onRp = host === policy.rpId || host.endsWith(`.${policy.rpId}`);
  if (!onRp) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && isLocalhost(host));
}

type ClientData = { type: string; challenge: string; origin: string; crossOrigin?: boolean };

function parseClientData(b64: string): { data: ClientData; raw: Buffer } {
  const raw = b64urlToBuffer(b64);
  let data: ClientData;
  try { data = JSON.parse(raw.toString("utf8")) as ClientData; } catch { throw new Error("clientDataJSON is not JSON"); }
  if (!data || typeof data.type !== "string" || typeof data.challenge !== "string" || typeof data.origin !== "string") {
    throw new Error("clientDataJSON is incomplete");
  }
  return { data, raw };
}

function checkClientData(data: ClientData, type: string, expectedChallenge: string, policy: RpPolicy): void {
  if (data.type !== type) throw new Error(`clientData.type must be ${type}`);
  if (data.challenge.replace(/=+$/, "") !== expectedChallenge.replace(/=+$/, "")) throw new Error("challenge mismatch");
  if (!isAllowedOrigin(data.origin, policy)) throw new Error(`origin ${data.origin} not allowed for ${policy.rpId}`);
  if (data.crossOrigin === true) throw new Error("cross-origin ceremonies are not allowed");
}

export type AuthData = {
  rpIdHash: Buffer;
  flags: { up: boolean; uv: boolean; be: boolean; bs: boolean; at: boolean; ed: boolean };
  signCount: number;
  credentialId?: Buffer;
  publicKey?: Map<CborValue, CborValue>;
};

export function parseAuthData(buf: Buffer): AuthData {
  if (buf.length < 37) throw new Error("authenticatorData too short");
  const rpIdHash = buf.subarray(0, 32);
  const f = buf[32];
  const flags = { up: !!(f & 0x01), uv: !!(f & 0x04), be: !!(f & 0x08), bs: !!(f & 0x10), at: !!(f & 0x40), ed: !!(f & 0x80) };
  const signCount = buf.readUInt32BE(33);
  const out: AuthData = { rpIdHash, flags, signCount };
  if (flags.at) {
    if (buf.length < 55) throw new Error("attested credential data truncated");
    const idLen = buf.readUInt16BE(53);
    const idStart = 55;
    if (buf.length < idStart + idLen) throw new Error("credential id truncated");
    out.credentialId = buf.subarray(idStart, idStart + idLen);
    const { value } = decodeCbor(buf.subarray(idStart + idLen));
    if (!(value instanceof Map)) throw new Error("credential public key is not a COSE map");
    out.publicKey = value;
  }
  return out;
}

const bytes = (v: CborValue | undefined, what: string): Buffer => {
  if (!(v instanceof Uint8Array)) throw new Error(`COSE key: ${what} missing`);
  return Buffer.from(v);
};

/** COSE_Key → JWK + algorithm. */
export function coseToJwk(cose: Map<CborValue, CborValue>): { jwk: JsonWebKey; alg: number } {
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (typeof alg !== "number" || !SUPPORTED_ALGS.includes(alg)) throw new Error(`unsupported COSE alg ${String(alg)}`);
  if (kty === 2 && alg === ALG.ES256) {
    if (cose.get(-1) !== 1) throw new Error("ES256 key must be on P-256");
    const x = bytes(cose.get(-2), "x");
    const y = bytes(cose.get(-3), "y");
    if (x.length !== 32 || y.length !== 32) throw new Error("bad P-256 coordinates");
    return { alg, jwk: { kty: "EC", crv: "P-256", x: bufferToB64url(x), y: bufferToB64url(y) } };
  }
  if (kty === 1 && alg === ALG.EdDSA) {
    if (cose.get(-1) !== 6) throw new Error("EdDSA key must be Ed25519");
    const x = bytes(cose.get(-2), "x");
    if (x.length !== 32) throw new Error("bad Ed25519 key");
    return { alg, jwk: { kty: "OKP", crv: "Ed25519", x: bufferToB64url(x) } };
  }
  if (kty === 3 && alg === ALG.RS256) {
    const n = bytes(cose.get(-1), "n");
    const e = bytes(cose.get(-2), "e");
    if (n.length < 256) throw new Error("RSA key shorter than 2048 bits");
    return { alg, jwk: { kty: "RSA", n: bufferToB64url(n), e: bufferToB64url(e) } };
  }
  throw new Error(`unsupported COSE key type ${String(kty)} / alg ${alg}`);
}

function publicKeyOf(cred: Pick<StoredCredential, "publicKeyJwk">): KeyObject {
  return createPublicKey({ key: cred.publicKeyJwk as import("node:crypto").JsonWebKey, format: "jwk" });
}

function verifySignature(alg: number, key: KeyObject, data: Buffer, signature: Buffer): boolean {
  try {
    if (alg === ALG.ES256) return cryptoVerify("sha256", data, { key, dsaEncoding: "der" }, signature);
    if (alg === ALG.RS256) return cryptoVerify("sha256", data, key, signature);
    if (alg === ALG.EdDSA) return cryptoVerify(null, data, key, signature);
  } catch {
    return false;
  }
  return false;
}

/* ---------------------------------------------------------- registration */

export function verifyRegistration(input: {
  response: RegistrationResponseJSON;
  expectedChallenge: string;
  policy: RpPolicy;
}): { ok: true; credential: StoredCredential } | { ok: false; error: string } {
  try {
    const r = input.response;
    if (!r || r.type !== "public-key" || !r.response) throw new Error("not a public-key credential");
    const { data } = parseClientData(r.response.clientDataJSON);
    checkClientData(data, "webauthn.create", input.expectedChallenge, input.policy);
    const { value: att } = decodeCbor(b64urlToBuffer(r.response.attestationObject));
    if (!(att instanceof Map)) throw new Error("attestationObject is not a map");
    const authDataRaw = att.get("authData");
    if (!(authDataRaw instanceof Uint8Array)) throw new Error("attestationObject.authData missing");
    const auth = parseAuthData(Buffer.from(authDataRaw));
    if (!auth.rpIdHash.equals(sha256(input.policy.rpId))) throw new Error("rpId hash mismatch");
    if (!auth.flags.up) throw new Error("user presence not asserted");
    if (!auth.flags.uv) throw new Error("user verification required");
    if (!auth.flags.at || !auth.credentialId || !auth.publicKey) throw new Error("no attested credential data");
    const rawId = b64urlToBuffer(r.rawId || r.id);
    if (!rawId.equals(auth.credentialId)) throw new Error("credential id mismatch");
    if (rawId.length < 16 || rawId.length > 1023) throw new Error("credential id length out of range");
    const { jwk, alg } = coseToJwk(auth.publicKey);
    publicKeyOf({ publicKeyJwk: jwk }); // must be importable
    return { ok: true, credential: { credentialId: bufferToB64url(rawId), publicKeyJwk: jwk, alg, signCount: auth.signCount } };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/* --------------------------------------------------------------- sign-in */

export function verifyAssertion(input: {
  response: AssertionResponseJSON;
  expectedChallenge: string;
  policy: RpPolicy;
  stored: StoredCredential;
}): { ok: true; signCount: number } | { ok: false; error: string } {
  try {
    const r = input.response;
    if (!r || r.type !== "public-key" || !r.response) throw new Error("not a public-key credential");
    const rawId = bufferToB64url(b64urlToBuffer(r.rawId || r.id));
    if (rawId !== input.stored.credentialId) throw new Error("credential mismatch");
    const { data, raw } = parseClientData(r.response.clientDataJSON);
    checkClientData(data, "webauthn.get", input.expectedChallenge, input.policy);
    const authRaw = b64urlToBuffer(r.response.authenticatorData);
    const auth = parseAuthData(authRaw);
    if (!auth.rpIdHash.equals(sha256(input.policy.rpId))) throw new Error("rpId hash mismatch");
    if (!auth.flags.up) throw new Error("user presence not asserted");
    if (!auth.flags.uv) throw new Error("user verification required");
    const signed = Buffer.concat([authRaw, sha256(raw)]);
    const ok = verifySignature(input.stored.alg, publicKeyOf(input.stored), signed, b64urlToBuffer(r.response.signature));
    if (!ok) throw new Error("signature invalid");
    // Counter: 0/0 means "authenticator does not count" (common for passkeys).
    if ((auth.signCount !== 0 || input.stored.signCount !== 0) && auth.signCount <= input.stored.signCount) {
      throw new Error("signature counter did not increase (possible cloned authenticator)");
    }
    return { ok: true, signCount: auth.signCount };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
