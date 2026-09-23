// @vitest-environment node
//
// Call-frame encryption (client/src/lib/media-frames.ts): the frame layout,
// what stays in the clear, what a tampered or foreign frame does, and the
// per-direction media keys two peers derive from their signed hellos
// (sender-keys.ts).

import { describe, it, expect, beforeAll } from "vitest";
import { clearBytes, FrameIvs, isSealed, openFrame, sealFrame } from "../client/src/lib/media-frames";
import { deriveRoomKeys, type RoomKeys } from "../client/src/lib/envelope";
import { loadIdentity, _resetIdentityForTests, type Identity } from "../client/src/lib/identity";
import { SenderKeyStore } from "../client/src/lib/sender-keys";

const aesKey = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
const frame = (n: number, seed = 1) => new Uint8Array(n).map((_, i) => (i * 13 + seed) & 0xff).buffer;

describe("sealed frames", () => {
  it("round-trip with the clear prefix untouched and authenticated", async () => {
    const key = await aesKey();
    const ivs = new FrameIvs();
    const plain = frame(200);
    const clear = clearBytes("video", true, plain.byteLength);
    expect(clear).toBe(10);
    const sealed = await sealFrame(key, plain, clear, ivs.next());
    expect(isSealed(sealed)).toBe(true);
    expect(sealed.byteLength).toBe(200 + 16 + 12 + 3);
    expect(new Uint8Array(sealed).subarray(0, 10)).toEqual(new Uint8Array(plain).subarray(0, 10));
    expect(new Uint8Array((await openFrame(key, sealed))!)).toEqual(new Uint8Array(plain));

    // Flipping a clear byte (a middlebox rewriting the header) breaks it.
    const tampered = new Uint8Array(sealed.slice(0)); tampered[0] ^= 1;
    expect(await openFrame(key, tampered.buffer)).toBeNull();
    // So does another key.
    expect(await openFrame(await aesKey(), sealed)).toBeNull();
  });

  it("keeps one byte of audio (the Opus TOC) and never more than the frame", () => {
    expect(clearBytes("audio", false, 80)).toBe(1);
    expect(clearBytes("video", false, 80)).toBe(3);
    expect(clearBytes("video", true, 4)).toBe(4);
  });

  it("never repeats an IV and does not mistake plain frames for sealed ones", async () => {
    const ivs = new FrameIvs();
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(Buffer.from(ivs.next()).toString("hex"));
    expect(seen.size).toBe(1000);
    let mistaken = 0;
    for (let i = 0; i < 2000; i++) if (isSealed(crypto.getRandomValues(new Uint8Array(60)).buffer)) mistaken += 1;
    expect(mistaken).toBeLessThan(3); // two magic bytes: ~1 in 65 536
  });
});

describe("media keys from the hello", () => {
  let keys: RoomKeys;
  let alice: Identity;
  let bob: Identity;
  beforeAll(async () => {
    keys = await deriveRoomKeys("media-room", "pw", { iterations: 1_000 });
    _resetIdentityForTests(); alice = await loadIdentity();
    _resetIdentityForTests(); bob = await loadIdentity();
  });

  it("are one key per direction, shared by exactly the two peers", async () => {
    const a = new SenderKeyStore();
    const b = new SenderKeyStore();
    expect(await b.acceptHello(keys, bob, await a.hello(keys, alice, "p-a", "p-b"), "p-a", "p-b")).toBeNull();
    expect(await a.acceptHello(keys, alice, await b.hello(keys, bob, "p-b", "p-a"), "p-b", "p-a")).toBeNull();
    const pa = a.pairOf("p-b")!;
    const pb = b.pairOf("p-a")!;

    const ivs = new FrameIvs();
    const fromAlice = await sealFrame(pa.mediaSend, frame(120), 1, ivs.next());
    expect(await openFrame(pb.mediaRecv, fromAlice)).not.toBeNull();
    // Not with the other direction's key, not with Alice's own receive key.
    expect(await openFrame(pb.mediaSend, fromAlice)).toBeNull();
    expect(await openFrame(pa.mediaRecv, fromAlice)).toBeNull();
    const fromBob = await sealFrame(pb.mediaSend, frame(120, 7), 1, new FrameIvs().next());
    expect(await openFrame(pa.mediaRecv, fromBob)).not.toBeNull();
  });
});
