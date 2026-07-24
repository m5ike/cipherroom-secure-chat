import { describe, it, expect } from "vitest";
import { webcrypto } from "node:crypto";

// Polyfill crypto.subtle for Node
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto as unknown as Crypto;
}

import {
  deriveRoomKey,
  encryptEnvelope,
  decryptEnvelope,
  evaluatePassphrase,
  normalizeRoom,
  toBase64,
  fromBase64,
  newId,
} from "../client/src/lib/crypto.js";

describe("crypto helpers", () => {
  it("normalizeRoom strips invalid chars and trims", () => {
    expect(normalizeRoom("Brno Secure!!")).toBe("brno-secure");
    expect(normalizeRoom(" --foo-- ")).toBe("foo");
    expect(normalizeRoom("a".repeat(60))).toHaveLength(48);
  });

  it("base64 roundtrip", () => {
    const data = new Uint8Array([0, 1, 2, 3, 254, 255]);
    expect(Array.from(fromBase64(toBase64(data)))).toEqual(Array.from(data));
  });

  it("newId has correct prefix and length", () => {
    const id = newId("peer");
    expect(id.startsWith("peer-")).toBe(true);
    expect(id.length).toBe(5 + 24); // prefix + 24 hex chars
  });

  it("derive key and encrypt/decrypt roundtrip", async () => {
    const key = await deriveRoomKey("test-room", "sup3r-secret-pass");
    const envelope = await encryptEnvelope(key, { hello: "world" });
    expect(envelope).toMatchObject({ v: 1, alg: "AES-GCM" });
    expect(envelope.iv).toBeTypeOf("string");
    expect(envelope.ciphertext).toBeTypeOf("string");
    const decoded = await decryptEnvelope<{ hello: string }>(key, envelope);
    expect(decoded.hello).toBe("world");
  });

  it("encrypt with different IV each time", async () => {
    const key = await deriveRoomKey("test", "passphrase-1111");
    const e1 = await encryptEnvelope(key, { a: 1 });
    const e2 = await encryptEnvelope(key, { a: 1 });
    expect(e1.iv).not.toBe(e2.iv);
    expect(e1.ciphertext).not.toBe(e2.ciphertext);
  });

  it("wrong key cannot decrypt", async () => {
    const k1 = await deriveRoomKey("a", "passphrase-1111");
    const k2 = await deriveRoomKey("b", "passphrase-1111");
    const env = await encryptEnvelope(k1, { secret: "x" });
    await expect(decryptEnvelope(k2, env)).rejects.toThrow();
  });
});

describe("passphrase strength check", () => {
  it.each([
    ["", "weak"],
    ["a", "weak"],
    ["1234567", "weak"],
    ["abcd1234", "warn"], // ≥ 8 ale < 12 → warn
    ["abcd12345678", "ok"], // ≥ 12
    ["a".repeat(20), "ok"], // ≥ 12 dost unikátních
    ["a".repeat(20).replace(/a/g, "b"), "ok"], // unique < 6 & len >=20 → warn? ne, protoze unique < 6 a len >= 20 je ok
  ])("evaluatePassphrase(%j) → level %j", (pp, expected) => {
    expect(evaluatePassphrase(pp).level).toBe(expected);
  });
});
