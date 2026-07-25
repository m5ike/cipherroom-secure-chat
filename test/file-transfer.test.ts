import { describe, expect, it, vi } from "vitest";
import {
  newIncomingRegistry,
  handleIncomingFrame,
  sendFile,
  encryptBytes,
  decryptBytes,
  encryptJSON,
  decryptJSON,
  MAX_FILE_BYTES,
  type FileTransferEnvelope,
} from "../client/src/lib/file-transfer";
import { deriveRoomKey } from "../client/src/lib/crypto";

async function fixtureKey() {
  return await deriveRoomKey("test-room", "test-passphrase");
}

describe("encryptBytes / decryptBytes", () => {
  it("round-trips arbitrary bytes", async () => {
    const key = await fixtureKey();
    const data = new Uint8Array([0, 1, 2, 3, 254, 255, 128]);
    const enc = await encryptBytes(key, data);
    const out = await decryptBytes(key, enc.iv, enc.ciphertext);
    expect(Array.from(out)).toEqual(Array.from(data));
  });

  it("produces unique IVs per call", async () => {
    const key = await fixtureKey();
    const a = await encryptBytes(key, new Uint8Array([1, 2, 3]));
    const b = await encryptBytes(key, new Uint8Array([1, 2, 3]));
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});

describe("encryptJSON / decryptJSON", () => {
  it("round-trips object payloads", async () => {
    const key = await fixtureKey();
    const payload = { name: "mike", values: [1, 2, 3], nested: { ok: true } };
    const enc = await encryptJSON(key, payload);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await decryptJSON<any>(key, enc.iv, enc.ciphertext);
    expect(out).toEqual(payload);
  });
});

describe("handleIncomingFrame (file-meta/chunk/end)", () => {
  it("reassembles a chunked file", async () => {
    const key = await fixtureKey();
    const registry = newIncomingRegistry();
    const transferId = "xfer-test-1";
    const fileBytes = new Uint8Array(65_536);
    for (let i = 0; i < fileBytes.length; i += 1) fileBytes[i] = i & 0xff;

    const meta = {
      transferId,
      name: "test.bin",
      mime: "application/octet-stream",
      size: fileBytes.length,
      totalChunks: 2,
      chunkSize: 32 * 1024,
      senderId: "peer-1",
      senderName: "Alice",
      createdAt: 1700000000000,
    };
    const metaEnc = await encryptJSON(key, meta);
    const part1 = fileBytes.slice(0, 32 * 1024);
    const part2 = fileBytes.slice(32 * 1024);
    const encPart1 = await encryptBytes(key, part1);
    const encPart2 = await encryptBytes(key, part2);

    const events: Array<{ kind: string; args: unknown[] }> = [];
    const cb = {
      onMeta: (...args: unknown[]) => events.push({ kind: "meta", args }),
      onProgress: (...args: unknown[]) => events.push({ kind: "progress", args }),
      onComplete: (...args: unknown[]) => events.push({ kind: "complete", args }),
      onCancel: (...args: unknown[]) => events.push({ kind: "cancel", args }),
      onError: (...args: unknown[]) => events.push({ kind: "error", args }),
    };

    await handleIncomingFrame(key, registry, { kind: "file-meta", transferId, ...metaEnc }, Infinity, cb);
    await handleIncomingFrame(key, registry, { kind: "file-chunk", transferId, seq: 0, ...encPart1 }, Infinity, cb);
    await handleIncomingFrame(key, registry, { kind: "file-chunk", transferId, seq: 1, ...encPart2 }, Infinity, cb);
    await handleIncomingFrame(key, registry, { kind: "file-end", transferId }, Infinity, cb);

    const complete = events.find((e) => e.kind === "complete");
    expect(complete).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [finalTransferId, blob, finalMeta] = (complete?.args ?? []) as [string, Blob, typeof meta];
    expect(finalTransferId).toBe(transferId);
    expect(finalMeta.name).toBe("test.bin");
    const ab = await blob.arrayBuffer();
    const recovered = new Uint8Array(ab);
    expect(Array.from(recovered)).toEqual(Array.from(fileBytes));
  });

  it("reports an error when transferId is unknown", async () => {
    const key = await fixtureKey();
    const registry = newIncomingRegistry();
    const errors: unknown[] = [];
    await handleIncomingFrame(
      key,
      registry,
      { kind: "file-chunk", transferId: "nope", seq: 0, iv: "AAAA", ciphertext: "BBBB" },
      Infinity,
      { onError: (...args) => errors.push(args) },
    );
    expect(errors.length).toBe(1);
  });

  it("rejects unrepresentable (non-finite) file sizes", async () => {
    const key = await fixtureKey();
    // MAX_FILE_BYTES is now Number.MAX_SAFE_INTEGER; a file with size
    // exceeding it (e.g. Number.MAX_VALUE or Infinity) is rejected.
    const weird = { name: "weird.bin", size: Number.POSITIVE_INFINITY, type: "application/octet-stream" } as unknown as File;
    const result = await sendFile({
      key,
      file: weird,
      senderId: "s",
      senderName: "S",
      channels: [],
      sendProxy: () => false,
      onProgress: () => undefined,
      onStats: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Unrepresentable/);
  });

  it("accepts arbitrarily large finite sizes including values >= 10 GiB", async () => {
    const key = await fixtureKey();
    // A 12 GiB synthetic file — used to be rejected; now accepted.
    const file = { name: "huge.bin", size: 12 * 1024 ** 3, type: "application/octet-stream" } as unknown as File;
    // Stub arrayBuffer so we don't actually allocate 12 GiB.
    (file as unknown as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer = async () => new Uint8Array(0).buffer;
    const sendProxy = vi.fn(() => true);
    const result = await sendFile({
      key,
      file,
      senderId: "s",
      senderName: "S",
      channels: [],
      sendProxy,
      onProgress: () => undefined,
      onStats: () => undefined,
    });
    // We expect the call to *succeed* sending the meta frame; the loop
    // over chunks will exit early because no chunks remain.
    expect(result.ok).toBe(true);
    expect(sendProxy).toHaveBeenCalled();
  });

  it("falls back to proxy transport when no P2P channel is open", async () => {
    const key = await fixtureKey();
    const fileBytes = new Uint8Array(4096);
    for (let i = 0; i < fileBytes.length; i += 1) fileBytes[i] = i & 0xff;
    const file = new File([fileBytes], "tiny.bin", { type: "application/octet-stream" });

    const sentFrames: FileTransferEnvelope[] = [];
    const sendProxy = vi.fn((frame: FileTransferEnvelope) => { sentFrames.push(frame); return true; });

    const statsEvents: number[] = [];
    const result = await sendFile({
      key,
      file,
      senderId: "s",
      senderName: "S",
      channels: [], // empty -> proxy fallback
      sendProxy,
      onProgress: (sent) => statsEvents.push(sent),
      onStats: () => undefined,
    });

    expect(result.ok).toBe(true);
    expect(result.transport).toBe("proxy");
    // Expect at least: meta, every chunk, end
    expect(sendProxy).toHaveBeenCalled();
    const kinds = sentFrames.map((f) => f.kind);
    expect(kinds[0]).toBe("proxy-meta");
    expect(kinds).toContain("proxy-end");
    // No frame should have transport === "p2p"
    for (const f of sentFrames) {
      expect(f.transport).toBe("proxy");
    }
  });

  it("uses P2P transport when a DataChannel is open", async () => {
    const key = await fixtureKey();
    const fileBytes = new Uint8Array(2048);
    const file = new File([fileBytes], "p.bin", { type: "application/octet-stream" });

    // Fake an open channel that just records what was sent.
    const seen: string[] = [];
    const fakeChannel = { readyState: "open", bufferedAmount: 0, send: (payload: string) => { seen.push(payload); }, addEventListener: () => undefined, removeEventListener: () => undefined, set bufferedAmountLowThreshold(_: number) {} };
    fakeChannel.readyState = "open";

    const result = await sendFile({
      key,
      file,
      senderId: "s",
      senderName: "S",
      channels: [fakeChannel as unknown as RTCDataChannel],
      sendProxy: () => true, // would be wrong use; we are testing P2P wins
      onProgress: () => undefined,
      onStats: () => undefined,
    });
    expect(result.ok).toBe(true);
    expect(result.transport).toBe("p2p");
    expect(seen.length).toBeGreaterThan(0);
  });

  it("handles cancel gracefully", async () => {
    const key = await fixtureKey();
    const registry = newIncomingRegistry();
    let cancelled = 0;
    await handleIncomingFrame(
      key,
      registry,
      { kind: "file-cancel", transferId: "xfer-cancel" },
      Infinity,
      { onCancel: () => (cancelled += 1) },
    );
    expect(cancelled).toBe(1);
  });
});
