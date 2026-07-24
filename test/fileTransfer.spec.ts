import { describe, it, expect } from "vitest";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto as unknown as Crypto;
}

import {
  encryptEnvelope,
  decryptEnvelope,
  deriveRoomKey,
} from "../client/src/lib/crypto.js";

type Subset = {
  kind: string;
  transferId?: string;
  iv?: string;
  ciphertext?: string;
};

describe("file chunk encrypted envelope round-trip", () => {
  it("encrypts and decrypts a 64 KB chunk", async () => {
    const key = await deriveRoomKey("xfer-room", "secret12345");
    const payload = { index: 0, total: 16, data: new Array(64 * 1024).fill(0).map((_, i) => i % 256) };
    const envelope = await encryptEnvelope(key, payload);
    expect(envelope).toMatchObject({ v: 1, alg: "AES-GCM" });
    expect((envelope.ciphertext as string).length).toBeGreaterThan(0);

    const dec = await decryptEnvelope<typeof payload>(key, envelope);
    expect(dec.index).toBe(0);
    expect(dec.total).toBe(16);
    expect(dec.data.length).toBe(64 * 1024);
  });

  it("detects tampering — wrong ciphertext fails decryption", async () => {
    const key = await deriveRoomKey("room", "secret12345");
    const badEnv = await encryptEnvelope(key, { index: 0 });
    // Zkorumpuj první byte ciphertext (base64)
    const ctBytes = Buffer.from(badEnv.ciphertext, "base64");
    ctBytes[0] = ctBytes[0] ^ 0xff;
    badEnv.ciphertext = ctBytes.toString("base64");
    await expect(decryptEnvelope(key, badEnv)).rejects.toThrow();
  });
});
