import { describe, expect, it } from "vitest";
import {
  b64, checkReleaseFiles, ed25519FromSeed, ed25519Sign, fileAad4, fileKey4, fileKeyBytes, frameIv, hex, hkdf, ivEpoch, LABEL,
  MediaReceiver, MediaSender, MEDIA_FRAME_LIMIT, MemoryReplayStore, newFileKey, newMediaKey, importMediaKey, openChunk4, openFileBody4,
  parseReleaseManifest, REPLAY, ReplayGuard, replayKey, sealChunk4, sealFileBody4, sealedFrameIv, sha256Hex, unb64,
  verifyReleaseSignature, type ReleaseManifest,
} from "../client/src/lib/p4";
import { sealFrame } from "../client/src/lib/media-frames";
import { ROOM } from "./p4-support";

const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("p4 media keys (§ 9)", () => {
  it("builds IVs from the epoch and a frame counter, big-endian", () => {
    expect(hex(frameIv(1, 2))).toBe("00000001" + "0000000000000002");
    expect(hex(frameIv(0xfffffffe, 2n ** 32n - 1n))).toBe("fffffffe" + "00000000ffffffff");
    expect(ivEpoch(frameIv(77, 5))).toBe(77);
    expect(() => frameIv(2 ** 32, 0)).toThrow();
    expect(() => frameIv(1, MEDIA_FRAME_LIMIT)).toThrow();
    expect(() => frameIv(1, -1)).toThrow();
  });

  it("seals frames per key and epoch; the receiver picks the key by the IV's epoch", async () => {
    const k1 = newMediaKey("call-1", 1);
    const k2 = newMediaKey("call-1", 2);
    const tx1 = new MediaSender(await importMediaKey(k1.raw), 1);
    const tx2 = new MediaSender(await importMediaKey(k2.raw), 2);
    const rx = new MediaReceiver();
    const frame = new Uint8Array([0xab, 1, 2, 3, 4, 5]).buffer;
    // Before any key: unsealed frames pass (older peers); after: they are dropped (F-19).
    expect(await rx.open(frame)).toBe(frame);
    expect(await rx.accept(k1.inner)).toBe(true);
    expect(await rx.accept(k2.inner)).toBe(true);
    expect(await rx.open(frame)).toBeNull();
    const s1 = await tx1.seal(frame, 1);
    const s2 = await tx2.seal(frame, 1);
    expect(hex(sealedFrameIv(s1)!)).toBe(hex(frameIv(1, 0)));
    expect(hex(sealedFrameIv(await tx1.seal(frame, 1))!)).toBe(hex(frameIv(1, 1)));
    expect(new Uint8Array((await rx.open(s1))!)).toEqual(new Uint8Array(frame));
    expect(new Uint8Array((await rx.open(s2))!)).toEqual(new Uint8Array(frame));
    // A frame under an unknown epoch, or with a forged IV, does not open.
    const k3 = await importMediaKey(newMediaKey("c", 3).raw);
    expect(await rx.open(await sealFrame(k3, frame, 1, frameIv(3, 0)))).toBeNull();
    expect(await rx.open(await sealFrame(k3, frame, 1, frameIv(1, 9)))).toBeNull();
    expect(await rx.accept({ t: "media", call: "c", epoch: -1, key: b64(new Uint8Array(32)) })).toBe(false);
    expect(await rx.accept({ t: "media", call: "c", epoch: 1, key: b64(new Uint8Array(16)) })).toBe(false);
  });
});

describe("p4 files (§ 8)", () => {
  it("derives the file key with HKDF(salt = transferId) and binds every frame", async () => {
    const { inner, fk } = newFileKey("tx-1");
    expect(inner).toEqual({ t: "file", transferId: "tx-1", key: b64(fk) });
    expect(hex(await fileKeyBytes(fk, "tx-1"))).toBe(hex(await hkdf(new TextEncoder().encode("tx-1"), fk, LABEL.file, 32)));
    expect(text(fileAad4.meta("tx-1"))).toBe("m5cet/p4/file-meta|tx-1");
    expect(text(fileAad4.chunk("tx-1", 3, 10))).toBe("m5cet/p4/chunk|tx-1|3|10");
    expect(text(fileAad4.end("tx-1"))).toBe("m5cet/p4/file-end|tx-1");
    const key = await fileKey4(inner.key, "tx-1");
    const meta = await sealFileBody4(key, fileAad4.meta("tx-1"), JSON.stringify({ name: "a.txt", size: 3 }));
    expect(unb64(meta.ciphertext).length).toBe(256 + 16);
    expect(JSON.parse(await openFileBody4(key, fileAad4.meta("tx-1"), meta.iv, meta.ciphertext))).toEqual({ name: "a.txt", size: 3 });
    await expect(openFileBody4(key, fileAad4.end("tx-1"), meta.iv, meta.ciphertext)).rejects.toMatchObject({ code: "aead" });
    const chunk = await sealChunk4(key, fileAad4.chunk("tx-1", 0, 2), new Uint8Array([1, 2, 3]));
    expect(chunk.ciphertext.length).toBe(3 + 16); // chunks are not padded
    expect(Array.from(await openChunk4(key, fileAad4.chunk("tx-1", 0, 2), chunk.iv, chunk.ciphertext))).toEqual([1, 2, 3]);
    await expect(openChunk4(key, fileAad4.chunk("tx-1", 1, 2), chunk.iv, chunk.ciphertext)).rejects.toMatchObject({ code: "aead" });
    const otherKey = await fileKey4(inner.key, "tx-2");
    await expect(openChunk4(otherKey, fileAad4.chunk("tx-1", 0, 2), chunk.iv, chunk.ciphertext)).rejects.toMatchObject({ code: "aead" });
    expect(() => newFileKey("a|b")).toThrow();
  });
});

describe("p4 replay window (§ 11)", () => {
  const now = 1_800_000_000_000;

  it("stores a hashed id and refuses replays, old and future messages", async () => {
    const key = await replayKey(ROOM, "msg-1");
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(key).not.toBe(await replayKey("r3.other", "msg-1"));
    const store = new MemoryReplayStore();
    const guard = new ReplayGuard(store);
    expect(await guard.check(ROOM, "msg-1", now, { now })).toBe("ok");
    expect(await guard.check(ROOM, "msg-1", now, { now })).toBe("replay");
    expect(await guard.check("r3.other", "msg-1", now, { now })).toBe("ok");
    // A new guard over the same (persistent) store still knows it.
    expect(await new ReplayGuard(store).check(ROOM, "msg-1", now, { now: now + 1000 })).toBe("replay");
    expect(await guard.check(ROOM, "old", now - REPLAY.windowMs - 1, { now })).toBe("too-old");
    expect(await guard.check(ROOM, "edge", now - REPLAY.windowMs, { now })).toBe("ok");
    expect(await guard.check(ROOM, "ahead", now + REPLAY.futureMs + 1, { now })).toBe("future");
    expect(await guard.check(ROOM, "soon", now + REPLAY.futureMs, { now })).toBe("ok");
    expect(await guard.check(ROOM, "bad", "yesterday", { now })).toBe("malformed");
    expect(await guard.check(ROOM, "a|b", now, { now })).toBe("malformed");
    // Restored history: exempt, but remembered.
    expect(await guard.check(ROOM, "restored", now - 10 * REPLAY.windowMs, { now, restored: true })).toBe("ok");
    expect(await guard.check(ROOM, "restored", now - 10 * REPLAY.windowMs, { now, restored: true })).toBe("ok");
  });

  it("forgets ids past the window and the oldest beyond the cap", async () => {
    const store = new MemoryReplayStore();
    const guard = new ReplayGuard(store, { pruneEvery: 1 });
    await guard.check(ROOM, "early", now, { now });
    await guard.check(ROOM, "late", now + REPLAY.windowMs, { now: now + REPLAY.windowMs });
    await guard.check(ROOM, "later", now + REPLAY.windowMs + 1, { now: now + REPLAY.windowMs + 1 });
    expect(store.size(ROOM)).toBe(2); // "early" fell out of the window (and would be refused as too old)
    await store.prune(ROOM, 0, 1);
    expect(store.size(ROOM)).toBe(1);
    expect(await store.has(ROOM, await replayKey(ROOM, "later"))).toBe(true);
  });
});

describe("p4 release manifests (§ 15)", () => {
  const files = { "a.txt": new TextEncoder().encode("alpha\n"), "dir/b.js": new TextEncoder().encode("console.log(1)\n") };
  async function manifestText(): Promise<string> {
    const m: ReleaseManifest = {
      format: "m5cet-release/1", name: "m5cet", version: "6.12.0", commit: "abc", created: "2026-10-05T00:00:00Z",
      files: await Promise.all(Object.entries(files).map(async ([path, bytes]) => ({ path, size: bytes.length, sha256: await sha256Hex(bytes) }))),
    };
    return JSON.stringify(m, null, 2);
  }

  it("parses, verifies the signature over the exact bytes, and hash-checks files", async () => {
    const textJson = await manifestText();
    const m = parseReleaseManifest(textJson);
    const { privateKey, publicKey } = await ed25519FromSeed(new Uint8Array(32).fill(4));
    const sig = b64(await ed25519Sign(privateKey, new TextEncoder().encode(textJson)));
    expect(await verifyReleaseSignature(textJson, `${sig}\n`, `${b64(publicKey)}\n`)).toBe(true);
    expect(await verifyReleaseSignature(textJson + " ", sig, b64(publicKey))).toBe(false);
    expect(await verifyReleaseSignature(textJson, sig, b64(new Uint8Array(32)))).toBe(false);
    expect(await checkReleaseFiles(m, async (p) => files[p as keyof typeof files] ?? null)).toEqual({ ok: true, missing: [], changed: [] });
    const res = await checkReleaseFiles(m, async (p) => (p === "a.txt" ? new TextEncoder().encode("alpha!\n") : null));
    expect(res).toEqual({ ok: false, missing: ["dir/b.js"], changed: ["a.txt"] });
  });

  it("refuses malformed manifests", async () => {
    const base = JSON.parse(await manifestText()) as ReleaseManifest;
    const bad = [
      { ...base, format: "other" },
      { ...base, files: [...base.files].reverse() },
      { ...base, files: [base.files[0], base.files[0]] },
      { ...base, files: [{ ...base.files[0], path: "../etc/passwd" }] },
      { ...base, files: [{ ...base.files[0], path: "/abs" }] },
      { ...base, files: [{ ...base.files[0], sha256: base.files[0].sha256.toUpperCase() }] },
      { ...base, version: 6 },
    ];
    for (const m of bad) expect(() => parseReleaseManifest(JSON.stringify(m))).toThrow();
    expect(() => parseReleaseManifest("{")).toThrow();
  });
});
