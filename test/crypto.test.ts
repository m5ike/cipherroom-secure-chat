import { describe, expect, it } from "vitest";
import { deriveRoomKey, encryptEnvelope, decryptEnvelope, toBase64, fromBase64 } from "../client/src/lib/crypto";

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

  // Regression guards for the wire format. An envelope that carries anything
  // besides { iv, ciphertext } would put plaintext next to the ciphertext.
  it("emits only iv + ciphertext — never any plaintext field", async () => {
    const key = await deriveRoomKey("room", "pass");
    const payload = { id: "m1", text: "top secret", senderId: "x", senderName: "Alice", createdAt: 1 };
    const enc = await encryptEnvelope(key, payload);
    expect(Object.keys(enc).sort()).toEqual(["ciphertext", "iv"]);
    const wire = JSON.stringify(enc);
    expect(wire).not.toContain("top secret");
    expect(wire).not.toContain("Alice");
  });

  it("uses an IV of exactly 12 bytes", async () => {
    const key = await deriveRoomKey("room", "pass");
    const enc = await encryptEnvelope(key, { a: 1 });
    expect(fromBase64(enc.iv).byteLength).toBe(12);
  });

  it("round-trips non-ASCII text (UTF-8 safe)", async () => {
    const key = await deriveRoomKey("room", "pass");
    const payload = { text: "Příliš žluťoučký kůň úpěl ďábelské ódy — 日本語 🔐" };
    expect(await decryptEnvelope(key, await encryptEnvelope(key, payload))).toEqual(payload);
  });

  it("round-trips a 512 kB inline attachment without overflowing the stack", async () => {
    const key = await deriveRoomKey("room", "pass");
    const payload = { attachment: { dataUrl: "data:application/octet-stream;base64," + "A".repeat(512 * 1024) } };
    expect(await decryptEnvelope(key, await encryptEnvelope(key, payload))).toEqual(payload);
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

describe("toBase64 / fromBase64", () => {
  // Reference: the per-byte implementation this codec replaced.
  const reference = (bytes: Uint8Array) => {
    let binary = "";
    bytes.forEach((b) => { binary += String.fromCharCode(b); });
    return btoa(binary);
  };
  const random = (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(i + 65536, n)));
    return out;
  };

  it("is byte-identical to the reference encoder across chunk boundaries", () => {
    for (const n of [0, 1, 2, 3, 4, 12, 255, 0x7fff, 0x8000, 0x8001, 0x10000 + 7]) {
      const bytes = random(n);
      expect(toBase64(bytes)).toBe(reference(bytes));
    }
  });

  it("round-trips 1 MiB without overflowing the stack", () => {
    const bytes = random(1024 * 1024);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it("decodes to an ArrayBuffer-backed view usable by WebCrypto", () => {
    const out = fromBase64(toBase64(random(12)));
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.buffer).toBeInstanceOf(ArrayBuffer);
  });

  it("throws on malformed input", () => {
    expect(() => fromBase64("not*valid*base64!")).toThrow();
  });
});
