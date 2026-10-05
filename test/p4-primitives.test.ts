import { describe, expect, it } from "vitest";
import {
  b64, b64url, ctEqual, ecdh, ecdsaSign, ecdsaVerify, ed25519FromSeed, ed25519Sign, ed25519Verify, hex, hkdf, hmac, join, joinText,
  kemDecaps, kemEncaps, kemEncapsWith, kemKeygen, kemKeygenFromSeed, kemKid, keyIv, pad, paddedLength, RecordingRng, systemRng,
  TapeRng, unb64, unb64url, unpad, aesGcmOpen, aesGcmSeal, importP256Pkcs8, KEM, PAD_BUCKETS,
} from "../client/src/lib/p4";

const fromHex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("p4 primitives", () => {
  it("joins ASCII parts with | and refuses anything ambiguous", () => {
    expect(text(join("m5cet/x", "a", 0, 12, "b=="))).toBe("m5cet/x|a|0|12|b==");
    expect(joinText("x", "")).toBe("x|");
    for (const bad of ["a|b", "ž", "\n", "tab\t"]) expect(() => join("x", bad)).toThrow();
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) expect(() => join("x", bad)).toThrow();
  });

  it("accepts only canonical base64 / base64url", () => {
    expect(Array.from(unb64("AAE="))).toEqual([0, 1]);
    for (const bad of ["AAE", "AAF=", "AA E=", "AA==\n", "!!!!", 5]) expect(() => unb64(bad)).toThrow();
    expect(() => unb64("AAE=", 3)).toThrow();
    expect(b64url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
    expect(Array.from(unb64url("-_8"))).toEqual([0xfb, 0xff]);
    for (const bad of ["-_8=", "-_9", "+/8"]) expect(() => unb64url(bad)).toThrow();
  });

  it("HKDF and HMAC match RFC 5869 / RFC 4231", async () => {
    const okm = await hkdf(fromHex("000102030405060708090a0b0c"), fromHex("0b".repeat(22)), fromHex("f0f1f2f3f4f5f6f7f8f9"), 42);
    expect(hex(okm)).toBe("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
    const mac = await hmac(new TextEncoder().encode("Jefe"), new TextEncoder().encode("what do ya want for nothing?"));
    expect(hex(mac)).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  it("keyIv splits a 44-byte HKDF output with a zero salt", async () => {
    const mk = new Uint8Array(32).fill(5);
    const { key, iv } = await keyIv(mk, "m5cet/p4/mk");
    const okm = await hkdf(new Uint8Array(32), mk, "m5cet/p4/mk", 44);
    expect(hex(key)).toBe(hex(okm.slice(0, 32)));
    expect(hex(iv)).toBe(hex(okm.slice(32)));
  });

  it("compares in constant time", () => {
    expect(ctEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(ctEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(ctEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });

  it("does ECDH (x-coordinate) and raw r||s ECDSA on P-256", async () => {
    const a = await systemRng.p256("ecdh", "a");
    const b = await systemRng.p256("ecdh", "b");
    const ab = await ecdh(a.privateKey, b.spki);
    expect(ab.length).toBe(32);
    expect(hex(ab)).toBe(hex(await ecdh(b.privateKey, a.spki)));
    const s = await systemRng.p256("ecdsa", "s");
    const sig = await ecdsaSign(s.privateKey, new Uint8Array([1, 2, 3]));
    expect(unb64(sig).length).toBe(64);
    expect(await ecdsaVerify(s.spki, new Uint8Array([1, 2, 3]), sig)).toBe(true);
    expect(await ecdsaVerify(s.spki, new Uint8Array([1, 2, 4]), sig)).toBe(false);
    expect(await ecdsaVerify("garbage", new Uint8Array([1]), sig)).toBe(false);
    await expect(ecdh(a.privateKey, "AAAA")).rejects.toMatchObject({ code: "malformed" });
  });

  it("AES-GCM binds the associated data", async () => {
    const key = new Uint8Array(32).fill(1);
    const iv = new Uint8Array(12).fill(2);
    const c = await aesGcmSeal(key, iv, new Uint8Array([9]), new Uint8Array([1, 2, 3]));
    expect(Array.from(await aesGcmOpen(key, iv, new Uint8Array([9]), c))).toEqual([1, 2, 3]);
    await expect(aesGcmOpen(key, iv, new Uint8Array([8]), c)).rejects.toMatchObject({ code: "aead" });
  });

  it("derives Ed25519 keys from a seed as RFC 8032 does (test 1)", async () => {
    const { privateKey, publicKey } = await ed25519FromSeed(fromHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"));
    expect(hex(publicKey)).toBe("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
    const sig = await ed25519Sign(privateKey, new Uint8Array(0));
    expect(hex(sig)).toBe("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
    expect(await ed25519Verify(publicKey, new Uint8Array(0), sig)).toBe(true);
    expect(await ed25519Verify(b64(publicKey), new Uint8Array([0]), b64(sig))).toBe(false);
    expect(privateKey.extractable).toBe(false);
  });

  it("records and replays a tape of random draws, refusing a draw out of order", async () => {
    const rec = new RecordingRng();
    const bytes = rec.bytes(8, "n");
    const key = await rec.p256("ecdh", "e");
    const replay = new TapeRng(rec.tape);
    expect(hex(replay.bytes(8, "n"))).toBe(hex(bytes));
    expect((await replay.p256("ecdh", "e")).spki).toBe(key.spki);
    expect(replay.remaining).toBe(0);
    expect(() => replay.bytes(1, "more")).toThrow(/exhausted/);
    expect(() => new TapeRng(rec.tape).bytes(8, "other")).toThrow(/wanted "other"/);
    await expect(new TapeRng(rec.tape.slice(1)).p256("ecdsa", "e")).rejects.toThrow();
    const imported = await importP256Pkcs8((rec.tape[1] as { pkcs8: string }).pkcs8, "ecdsa");
    expect(imported.spki).toBe(key.spki);
  });
});

describe("p4 padding (§ 10)", () => {
  it("pads to the bucket boundaries, then to multiples of 64 KiB", () => {
    const cases: Array<[number, number]> = [
      [0, 256], [1, 256], [255, 256], [256, 512], [511, 512], [512, 1024], [4095, 4096], [32767, 32768],
      [65535, 65536], [65536, 131072], [131071, 131072], [131072, 196608], [200000, 262144],
    ];
    for (const [len, padded] of cases) {
      expect(paddedLength(len), `len ${len}`).toBe(padded);
      const m = new Uint8Array(len).fill(0x41);
      const p = pad(m);
      expect(p.length).toBe(padded);
      expect(p[len]).toBe(0x80);
      expect(p.subarray(len + 1).every((b) => b === 0)).toBe(true);
      expect(unpad(p)).toEqual(m);
    }
    expect(PAD_BUCKETS[0]).toBe(256);
  });

  it("round-trips messages that themselves end in 0x80 or 0x00", () => {
    for (const tail of [[0x80], [0x00], [0x80, 0x00], [0x00, 0x00, 0x80]]) {
      const m = new Uint8Array([1, 2, ...tail]);
      expect(Array.from(unpad(pad(m)))).toEqual(Array.from(m));
    }
  });

  it("refuses a missing marker", () => {
    for (const bad of [new Uint8Array(0), new Uint8Array(256), new Uint8Array([1, 2, 3]), new Uint8Array([0x80, 0x01])]) {
      expect(() => unpad(bad)).toThrow();
    }
  });
});

describe("p4 ML-KEM-768", () => {
  it("is deterministic from a 64-byte seed and a 32-byte m, and decapsulates", async () => {
    const seed = new Uint8Array(64).map((_, i) => i);
    const a = kemKeygenFromSeed(seed);
    const b = kemKeygenFromSeed(seed);
    expect(a.ek.length).toBe(KEM.ek);
    expect(a.dk.length).toBe(KEM.dk);
    expect(hex(a.ek)).toBe(hex(b.ek));
    const m = new Uint8Array(32).fill(7);
    const x = kemEncapsWith(a.ek, m);
    const y = kemEncapsWith(a.ek, m);
    expect(x.ct.length).toBe(KEM.ct);
    expect(hex(x.ct)).toBe(hex(y.ct));
    expect(hex(kemDecaps(x.ct, a.dk))).toBe(hex(x.ss));
    // Implicit rejection: a tampered ciphertext gives another secret, no error.
    const bad = x.ct.slice();
    bad[0] ^= 1;
    expect(hex(kemDecaps(bad, a.dk))).not.toBe(hex(x.ss));
    expect((await kemKid(a.ek)).length).toBe(16);
  });

  it("checks sizes", () => {
    const k = kemKeygen();
    const { ct } = kemEncaps(k.ek);
    expect(() => kemKeygenFromSeed(new Uint8Array(32))).toThrow();
    expect(() => kemEncapsWith(k.ek.slice(1), new Uint8Array(32))).toThrow();
    expect(() => kemEncapsWith(k.ek, new Uint8Array(31))).toThrow();
    expect(() => kemDecaps(ct.slice(1), k.dk)).toThrow(expect.objectContaining({ code: "kct" }));
    expect(() => kemEncapsWith(new Uint8Array(KEM.ek).fill(0xff), new Uint8Array(32))).toThrow(expect.objectContaining({ code: "malformed" }));
  });
});
