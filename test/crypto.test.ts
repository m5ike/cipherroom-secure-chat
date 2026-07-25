import { describe, expect, it } from "vitest";
import { deriveRoomKey, encryptEnvelope, decryptEnvelope } from "../client/src/lib/crypto";

describe("deriveRoomKey", () => {
  it("returns a non-extractable AES-GCM 256 key", async () => {
    const key = await deriveRoomKey("alfa-bravo", "correct horse battery staple");
    expect(key).toBeInstanceOf(CryptoKey);
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(expect.arrayContaining(["encrypt", "decrypt"]));
  });

  it("produces deterministic keys for same room+passphrase", async () => {
    const a = await deriveRoomKey("room-1", "phrase");
    const b = await deriveRoomKey("room-1", "phrase");
    const payload = { hello: "world", n: 42 };
    const enc1 = await encryptEnvelope(a, payload);
    const dec1 = await decryptEnvelope(b, enc1);
    expect(dec1).toEqual(payload);
  });

  it("produces independent keys for different rooms", async () => {
    const a = await deriveRoomKey("room-1", "phrase");
    const b = await deriveRoomKey("room-2", "phrase");
    const enc = await encryptEnvelope(a, { ok: true });
    await expect(decryptEnvelope(b, enc)).rejects.toThrow();
  });

  it("produces independent keys for different passphrases", async () => {
    const a = await deriveRoomKey("room-1", "phrase-1");
    const b = await deriveRoomKey("room-1", "phrase-2");
    const enc = await encryptEnvelope(a, { ok: true });
    await expect(decryptEnvelope(b, enc)).rejects.toThrow();
  });
});

describe("encryptEnvelope / decryptEnvelope", () => {
  it("round-trips a payload", async () => {
    const key = await deriveRoomKey("room", "pass");
    const payload = { id: "msg-1", text: "ahoj", createdAt: 1700000000000, senderId: "x", senderName: "y" };
    const enc = await encryptEnvelope(key, payload);
    expect(enc.iv).toBeTypeOf("string");
    expect(enc.ciphertext).toBeTypeOf("string");
    // IV must be 12 random bytes (16 base64 chars without padding).
    expect(enc.iv.length).toBeGreaterThanOrEqual(16);
    const dec = await decryptEnvelope(key, enc);
    expect(dec).toEqual(payload);
  });

  it("uses a fresh 12-byte IV per call", async () => {
    const key = await deriveRoomKey("room", "pass");
    const enc1 = await encryptEnvelope(key, { a: 1 });
    const enc2 = await encryptEnvelope(key, { a: 1 });
    expect(enc1.iv).not.toBe(enc2.iv);
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
  });

  it("rejects tampered ciphertext", async () => {
    const key = await deriveRoomKey("room", "pass");
    const enc = await encryptEnvelope(key, { secret: "value" });
    // Flip first base64 character of ciphertext by flipping first char of the hash.
    const firstChar = enc.ciphertext[0];
    const replacement = firstChar === "A" ? "B" : "A";
    const tampered = { ...enc, ciphertext: replacement + enc.ciphertext.slice(1) };
    await expect(decryptEnvelope(key, tampered)).rejects.toThrow();
  });
});
