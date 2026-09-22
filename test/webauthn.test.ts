// @vitest-environment node
//
// Passkey verification on the server (server/accounts/webauthn.ts + cbor.ts).
// A synthetic authenticator (test/helpers/authenticator.ts) produces real
// CBOR / COSE structures and real signatures, so both the happy path and
// every rejection path can be exercised: wrong challenge, wrong origin,
// wrong rpId, missing user verification, forged signature, replayed counter.

import { describe, it, expect } from "vitest";
import { decodeCbor, CborError } from "../server/accounts/cbor";
import {
  ALG, isAllowedOrigin, parseAuthData, verifyAssertion, verifyRegistration,
  type StoredCredential,
} from "../server/accounts/webauthn";
import { FakeAuthenticator, encodeCbor, type CborInput } from "./helpers/authenticator";

const RP = { rpId: "chat.example" };
const ORIGIN = "https://chat.example";
const CHALLENGE = "Y2hhbGxlbmdlLWZvci10ZXN0cy0wMDAwMDAw";

function register(auth: FakeAuthenticator, challenge = CHALLENGE, opts = {}) {
  return verifyRegistration({ response: auth.register(challenge, opts), expectedChallenge: challenge, policy: RP });
}

function stored(auth: FakeAuthenticator): StoredCredential {
  const r = register(auth);
  if (!r.ok) throw new Error(`registration failed: ${r.error}`);
  return r.credential;
}

describe("CBOR decoder", () => {
  it("round-trips the shapes WebAuthn uses", () => {
    const value = new Map<CborInput, CborInput>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", Buffer.from([1, 2, 3])],
      ["n", 300],
      ["neg", -7],
      ["arr", [1, 2, 3]],
    ]);
    const { value: back, length } = decodeCbor(encodeCbor(value));
    expect(length).toBe(encodeCbor(value).length);
    const map = back as Map<unknown, unknown>;
    expect(map.get("fmt")).toBe("none");
    expect(Buffer.from(map.get("authData") as Uint8Array)).toEqual(Buffer.from([1, 2, 3]));
    expect(map.get("n")).toBe(300);
    expect(map.get("neg")).toBe(-7);
    expect(map.get("arr")).toEqual([1, 2, 3]);
  });

  it("refuses truncated input, indefinite lengths and deep nesting", () => {
    expect(() => decodeCbor(Buffer.from([0x42, 0x01]))).toThrow(CborError); // 2-byte string, 1 byte there
    expect(() => decodeCbor(Buffer.from([0x5f, 0x41, 0x01, 0xff]))).toThrow(CborError); // indefinite bytes
    let deep: CborInput = 1;
    for (let i = 0; i < 20; i++) deep = [deep];
    expect(() => decodeCbor(encodeCbor(deep))).toThrow(CborError);
  });
});

describe("origin policy", () => {
  it("accepts https on the rpId and its subdomains, plus localhost over http", () => {
    expect(isAllowedOrigin("https://chat.example", RP)).toBe(true);
    expect(isAllowedOrigin("https://app.chat.example", RP)).toBe(true);
    expect(isAllowedOrigin("http://chat.example", RP)).toBe(false); // plain http off localhost
    expect(isAllowedOrigin("https://chat.example.evil.tld", RP)).toBe(false);
    expect(isAllowedOrigin("http://localhost:5173", { rpId: "localhost" })).toBe(true);
    expect(isAllowedOrigin("not a url", RP)).toBe(false);
  });

  it("an explicit list is exact", () => {
    const policy = { rpId: "chat.example", origins: ["https://chat.example"] };
    expect(isAllowedOrigin("https://chat.example", policy)).toBe(true);
    expect(isAllowedOrigin("https://app.chat.example", policy)).toBe(false);
  });
});

describe("registration", () => {
  it("accepts a well-formed ES256 passkey and keeps its public key", () => {
    const auth = new FakeAuthenticator(RP.rpId, ORIGIN);
    const r = register(auth);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.credential.alg).toBe(ALG.ES256);
    expect(r.credential.credentialId).toBe(Buffer.from(auth.credentialId).toString("base64url"));
    expect(r.credential.publicKeyJwk).toMatchObject({ kty: "EC", crv: "P-256" });
  });

  it("accepts Ed25519 and RS256 authenticators", () => {
    expect(stored(new FakeAuthenticator(RP.rpId, ORIGIN, "EdDSA")).alg).toBe(ALG.EdDSA);
    expect(stored(new FakeAuthenticator(RP.rpId, ORIGIN, "RS256")).alg).toBe(ALG.RS256);
  });

  it("rejects a mismatched challenge, a foreign origin and a foreign rpId", () => {
    const auth = new FakeAuthenticator(RP.rpId, ORIGIN);
    const other = verifyRegistration({ response: auth.register("some-other-challenge"), expectedChallenge: CHALLENGE, policy: RP });
    expect(other).toMatchObject({ ok: false });
    expect((other as { error: string }).error).toMatch(/challenge/);
    expect(register(auth, CHALLENGE, { origin: "https://evil.example" })).toMatchObject({ ok: false });
    expect(register(auth, CHALLENGE, { rpId: "evil.example" })).toMatchObject({ ok: false });
    expect(register(auth, CHALLENGE, { crossOrigin: true })).toMatchObject({ ok: false });
  });

  it("requires user presence and user verification", () => {
    const auth = new FakeAuthenticator(RP.rpId, ORIGIN);
    expect(register(auth, CHALLENGE, { up: false })).toMatchObject({ ok: false });
    expect(register(auth, CHALLENGE, { uv: false })).toMatchObject({ ok: false });
  });

  it("rejects garbage instead of an attestation object", () => {
    const auth = new FakeAuthenticator(RP.rpId, ORIGIN);
    const response = auth.register(CHALLENGE);
    response.response.attestationObject = Buffer.from("not cbor at all").toString("base64url");
    expect(verifyRegistration({ response, expectedChallenge: CHALLENGE, policy: RP })).toMatchObject({ ok: false });
  });
});

describe("assertion", () => {
  it("verifies a signature made with the registered key", () => {
    const auth = new FakeAuthenticator(RP.rpId, ORIGIN);
    const cred = stored(auth);
    const r = verifyAssertion({ response: auth.assert(CHALLENGE), expectedChallenge: CHALLENGE, policy: RP, stored: cred });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.signCount).toBeGreaterThan(cred.signCount);
  });

  it("verifies Ed25519 and RS256 signatures too", () => {
    for (const alg of ["EdDSA", "RS256"] as const) {
      const auth = new FakeAuthenticator(RP.rpId, ORIGIN, alg);
      const cred = stored(auth);
      expect(verifyAssertion({ response: auth.assert(CHALLENGE), expectedChallenge: CHALLENGE, policy: RP, stored: cred }).ok).toBe(true);
    }
  });

  it("rejects a tampered signature, a stale challenge and a foreign origin", () => {
    const auth = new FakeAuthenticator(RP.rpId, ORIGIN);
    const cred = stored(auth);
    const base = { expectedChallenge: CHALLENGE, policy: RP, stored: cred };
    expect(verifyAssertion({ ...base, response: auth.assert(CHALLENGE, { tamperSignature: true }) })).toMatchObject({ ok: false });
    expect(verifyAssertion({ ...base, response: auth.assert("an-older-challenge") })).toMatchObject({ ok: false });
    expect(verifyAssertion({ ...base, response: auth.assert(CHALLENGE, { origin: "https://evil.example" }) })).toMatchObject({ ok: false });
    expect(verifyAssertion({ ...base, response: auth.assert(CHALLENGE, { rpId: "evil.example" }) })).toMatchObject({ ok: false });
    expect(verifyAssertion({ ...base, response: auth.assert(CHALLENGE, { uv: false }) })).toMatchObject({ ok: false });
  });

  it("rejects another authenticator's credential and a counter that did not move", () => {
    const auth = new FakeAuthenticator(RP.rpId, ORIGIN);
    const cred = stored(auth);
    const impostor = new FakeAuthenticator(RP.rpId, ORIGIN);
    expect(verifyAssertion({ response: impostor.assert(CHALLENGE), expectedChallenge: CHALLENGE, policy: RP, stored: cred })).toMatchObject({ ok: false });

    // Replay: same counter as the stored one → cloned authenticator.
    const replay = auth.assert(CHALLENGE, { signCount: cred.signCount });
    const r = verifyAssertion({ response: replay, expectedChallenge: CHALLENGE, policy: RP, stored: { ...cred, signCount: cred.signCount } });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/counter/);
  });

  it("allows a passkey that does not count (0/0)", () => {
    const auth = new FakeAuthenticator(RP.rpId, ORIGIN);
    const cred = { ...stored(auth), signCount: 0 };
    const r = verifyAssertion({ response: auth.assert(CHALLENGE, { signCount: 0 }), expectedChallenge: CHALLENGE, policy: RP, stored: cred });
    expect(r.ok).toBe(true);
  });
});

describe("authenticator data", () => {
  it("parses flags and refuses a truncated buffer", () => {
    const auth = new FakeAuthenticator(RP.rpId, ORIGIN);
    const response = auth.assert(CHALLENGE);
    const parsed = parseAuthData(Buffer.from(response.response.authenticatorData, "base64url"));
    expect(parsed.flags).toMatchObject({ up: true, uv: true, at: false });
    expect(() => parseAuthData(Buffer.alloc(10))).toThrow();
  });
});
