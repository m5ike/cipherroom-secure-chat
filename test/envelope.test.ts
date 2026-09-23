// @vitest-environment node
//
// Crypto version 2 (client/src/lib/envelope.ts + identity.ts): separate
// keys per purpose, every ciphertext bound to its context, signatures inside
// the encryption, version 1 still readable, and files checked end to end.

import { describe, it, expect, beforeAll } from "vitest";
import { deriveRoomKey, encryptEnvelope } from "../client/src/lib/crypto";
import {
  createReplayGuard, deriveRoomKeys, isSealedSignal, openMessage, openSignal, sealMessage, sealSignal, type RoomKeys,
} from "../client/src/lib/envelope";
import { createPinStore, loadIdentity, safetyNumber, verifySignature, _resetIdentityForTests, type Identity } from "../client/src/lib/identity";
import { handleIncomingFrame, newIncomingRegistry, sendFile, type FileProof, type FileTransferEnvelope } from "../client/src/lib/file-transfer";

const FAST = { iterations: 1_000 };
let keys: RoomKeys;
let me: Identity;

beforeAll(async () => {
  keys = await deriveRoomKeys("alpha", "correct horse", FAST);
  _resetIdentityForTests();
  me = await loadIdentity();
});

describe("room keys", () => {
  it("derive the same keys and check value for the same room and passphrase", async () => {
    const again = await deriveRoomKeys("alpha", "correct horse", FAST);
    expect(again.check).toBe(keys.check);
    expect((await deriveRoomKeys("alpha", "wrong horse", FAST)).check).not.toBe(keys.check);
    expect((await deriveRoomKeys("beta", "correct horse", FAST)).check).not.toBe(keys.check);
  });

  it("normalises the passphrase, so the same word typed differently is the same key", async () => {
    const composed = await deriveRoomKeys("alpha", "kód", FAST);
    const decomposed = await deriveRoomKeys("alpha", "kód", FAST);
    expect(composed.check).toBe(decomposed.check);
  });
});

describe("chat envelopes", () => {
  const payload = { id: "msg-1", text: "ahoj", createdAt: 1, senderId: "p-a", senderName: "Alice" };

  it("round-trip, signed inside the encryption", async () => {
    const env = await sealMessage(keys, "msg-1", payload, me);
    expect(env).toMatchObject({ v: 2, id: "msg-1" });
    // The server sees neither the key nor who signed.
    expect(JSON.stringify(env)).not.toContain(me.publicKey.slice(0, 40));
    const opened = await openMessage<typeof payload>(keys, env);
    expect(opened.payload).toEqual(payload);
    expect(opened.signer).toEqual({ publicKey: me.publicKey, valid: true });
  });

  it("does not open in another room, or under another message id", async () => {
    const env = await sealMessage(keys, "msg-1", payload);
    const beta = await deriveRoomKeys("beta", "correct horse", FAST);
    await expect(openMessage(beta, env)).rejects.toThrow();
    await expect(openMessage(keys, { ...env, id: "msg-2" })).rejects.toThrow();
  });

  it("refuses an envelope whose inner id differs from the one it is bound to", async () => {
    const env = await sealMessage(keys, "msg-9", { ...payload, id: "msg-other" });
    await expect(openMessage(keys, env)).rejects.toThrow(/id mismatch/);
  });

  it("still reads a version 1 envelope from an old client", async () => {
    const legacyKey = await deriveRoomKey("alpha", "correct horse");
    const env = await encryptEnvelope(legacyKey, payload);
    const opened = await openMessage<typeof payload>(await deriveRoomKeys("alpha", "correct horse", FAST), env);
    expect(opened).toMatchObject({ version: 1, signer: null, payload });
  });

  it("drops a replayed message id", () => {
    const guard = createReplayGuard(3);
    expect(guard.accept("a")).toBe(true);
    expect(guard.accept("a")).toBe(false);
    ["b", "c", "d"].forEach((id) => guard.accept(id));
    expect(guard.size).toBe(3);
  });
});

describe("signals", () => {
  it("are sealed for the server and bound to sender and recipient", async () => {
    const offer = { type: "offer", sdp: "v=0\r\na=fingerprint:sha-256 AA:BB" };
    const sealed = await sealSignal(keys, "p-a", "p-b", offer);
    expect(isSealedSignal(sealed)).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain("fingerprint");
    expect(await openSignal(keys, "p-a", "p-b", sealed.sealed)).toEqual(offer);
    // The server re-addressing it (or swapping who sent it) breaks it.
    await expect(openSignal(keys, "p-x", "p-b", sealed.sealed)).rejects.toThrow();
    await expect(openSignal(keys, "p-a", "p-c", sealed.sealed)).rejects.toThrow();
  });
});

describe("identity", () => {
  it("signs and verifies, and a changed byte fails", async () => {
    const data = new TextEncoder().encode("hello");
    const sig = await me.sign(new Uint8Array(data));
    expect(await verifySignature(me.publicKey, new Uint8Array(data), sig)).toBe(true);
    expect(await verifySignature(me.publicKey, new Uint8Array(new TextEncoder().encode("hellp")), sig)).toBe(false);
  });

  it("gives both sides the same safety number", async () => {
    _resetIdentityForTests();
    const other = await loadIdentity();
    expect(other.publicKey).not.toBe(me.publicKey);
    const a = await safetyNumber(me.publicKey, other.publicKey);
    expect(a).toBe(await safetyNumber(other.publicKey, me.publicKey));
    expect(a).toMatch(/^(\d{5} ){11}\d{5}$/);
  });

  it("pins the first key for a name and flags a different one", () => {
    const pins = createPinStore(null);
    expect(pins.check("alpha", "Alice", "kid-1")).toBe("new");
    expect(pins.check("alpha", "alice", "kid-1")).toBe("match");
    expect(pins.check("alpha", "Alice", "kid-2")).toBe("changed");
    expect(pins.check("beta", "Alice", "kid-2")).toBe("new");
    pins.accept("alpha", "Alice", "kid-2");
    expect(pins.check("alpha", "Alice", "kid-2")).toBe("match");
  });
});

describe("files, version 2", () => {
  /** A fake data channel that records every frame the sender puts on it. */
  function channel() {
    const frames: FileTransferEnvelope[] = [];
    const ch = { readyState: "open", bufferedAmount: 0, send: (s: string) => frames.push(JSON.parse(s)), addEventListener() {}, removeEventListener() {} };
    return { ch: ch as unknown as RTCDataChannel, frames };
  }

  async function transfer(mutate?: (frames: FileTransferEnvelope[]) => FileTransferEnvelope[], receiverKeys: RoomKeys = keys) {
    const { ch, frames } = channel();
    const file = new File([new Uint8Array(10_000).map((_, i) => i % 251)], "report.html", { type: "text/html" });
    const sent = await sendFile({ key: keys, identity: me, file, senderId: "p-a", senderName: "Alice", chunkSize: 1024, channels: [ch] });
    expect(sent.ok).toBe(true);
    const registry = newIncomingRegistry();
    const errors: string[] = [];
    let done: { blob: Blob; mime: string; name: string; proof: FileProof } | null = null;
    for (const frame of mutate ? mutate(frames) : frames) {
      await handleIncomingFrame(receiverKeys, registry, frame, 1e9, {
        onError: (_id, m) => errors.push(m),
        onComplete: (_id, blob, meta, _t, proof) => { done = { blob, mime: meta.mime, name: meta.name, proof }; },
      });
    }
    return { frames, errors, done: done as typeof done };
  }

  it("delivers a verified, signed file and never an HTML type", async () => {
    const { frames, errors, done } = await transfer();
    expect(errors).toEqual([]);
    expect(frames.every((f) => (f as { v?: number }).v === 2)).toBe(true);
    expect(done!.blob.size).toBe(10_000);
    // Opened from a blob: URL it would run in this origin; so it downloads.
    expect(done!.mime).toBe("application/octet-stream");
    expect(done!.proof).toMatchObject({ version: 2, verified: true, signer: { publicKey: me.publicKey, valid: true } });
  });

  it("refuses a chunk moved to another position", async () => {
    const { errors, done } = await transfer((frames) => frames.map((f) => (f.kind === "file-chunk" && f.seq === 1 ? { ...f, seq: 2 } : f.kind === "file-chunk" && f.seq === 2 ? { ...f, seq: 1 } : f)));
    expect(done).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  it("refuses a file whose end frame lost its digest", async () => {
    const { errors, done } = await transfer((frames) => frames.map((f) => (f.kind === "file-end" ? { kind: "file-end", transferId: f.transferId, transport: "p2p", v: 2 } as FileTransferEnvelope : f)));
    expect(done).toBeNull();
    expect(errors).toContain("The end of the file carries no digest.");
  });

  it("refuses a meta that claims billions of chunks, before allocating anything", async () => {
    const legacy = await keys.legacy();
    const { encryptJSON } = await import("../client/src/lib/file-transfer");
    const meta = await encryptJSON(legacy, { transferId: "xfer-huge", name: "x", mime: "x/y", size: 4e9, totalChunks: 4e9, chunkSize: 1, senderId: "p", senderName: "M", createdAt: 1 });
    const errors: string[] = [];
    await handleIncomingFrame(keys, newIncomingRegistry(), { kind: "file-meta", transferId: "xfer-huge", transport: "p2p", ...meta }, 1e12, { onError: (_id, m) => errors.push(m) });
    expect(errors).toEqual(["Too many chunks."]);
  });
});

describe("version 3 keys (Argon2id)", () => {
  const LIGHT = { memoryKiB: 1024, passes: 1 };

  it("give a blind room id, the same for the same passphrase and different for another", async () => {
    const a = await deriveRoomKeys("alpha", "correct horse", LIGHT);
    const b = await deriveRoomKeys("alpha", "correct horse", LIGHT);
    const other = await deriveRoomKeys("alpha", "wrong horse", LIGHT);
    expect(a.version).toBe(3);
    expect(a.roomId).toMatch(/^r3\.[A-Za-z0-9_-]{32}$/);
    expect(a.roomId).toBe(b.roomId);
    expect(a.roomId).not.toBe(other.roomId);
    expect(a.roomId).not.toContain("alpha");
    expect(a.check).toBe(b.check);
  });

  it("seal v3 envelopes and still open a v2 one queued by 3.0 with the same passphrase", async () => {
    const v3 = await deriveRoomKeys("alpha", "correct horse", LIGHT);
    const payload = { id: "m-3", text: "hi" };
    const env = await sealMessage(v3, "m-3", payload);
    expect(env.v).toBe(3);
    expect((await openMessage(v3, env)).payload).toEqual(payload);
    // What a 3.0 client sealed (PBKDF2 keys of the same passphrase).
    const v2 = await deriveRoomKeys("alpha", "correct horse", { kdf: "pbkdf2" });
    const old = await sealMessage(v2, "m-2", { id: "m-2", text: "queued" });
    expect(old.v).toBe(2);
    expect((await openMessage(v3, old)).payload).toMatchObject({ text: "queued" });
  }, 30_000);

  it("carry files with the v3 keys", async () => {
    const v3 = await deriveRoomKeys("alpha", "correct horse", LIGHT);
    const frames: FileTransferEnvelope[] = [];
    const ch = { readyState: "open", bufferedAmount: 0, send: (s: string) => frames.push(JSON.parse(s)), addEventListener() {}, removeEventListener() {} } as unknown as RTCDataChannel;
    const file = new File([new Uint8Array(3000).fill(5)], "a.bin");
    expect((await sendFile({ key: v3, file, senderId: "p", senderName: "A", chunkSize: 1024, channels: [ch] })).ok).toBe(true);
    let done = 0;
    const registry = newIncomingRegistry();
    for (const f of frames) await handleIncomingFrame(v3, registry, f, 1e9, { onComplete: (_i, blob) => { done = blob.size; } });
    expect(done).toBe(3000);
  });
});
