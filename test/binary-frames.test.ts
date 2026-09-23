// Binary file chunks (client/src/lib/binary-frames.ts, server/signaling/
// binary.ts): the same bytes as the JSON frame's base64, a third smaller on
// the wire; readers that do not know the layout get nothing they could
// mistake for a chunk.

import { describe, it, expect } from "vitest";
import { decodeChunk, encodeChunk, FRAME_P2P_CHUNK, FRAME_PROXY_CHUNK } from "../client/src/lib/binary-frames";
import {
  binaryFrame, frameFromBinary, handleIncomingFrame, newIncomingRegistry, sendFile, wireFrame,
  type FileTransferEnvelope,
} from "../client/src/lib/file-transfer";
import { deriveRoomKeys } from "../client/src/lib/envelope";
import { toBase64 } from "../client/src/lib/crypto";
import { isBinaryError, parseBinaryChunk } from "../server/signaling/binary";

const iv = new Uint8Array(12).map((_, i) => i + 1);
const data = new Uint8Array(48).map((_, i) => (i * 7) & 0xff);

describe("the chunk layout", () => {
  it("round-trips through the client codec and the server parser", () => {
    const buf = encodeChunk({ type: FRAME_PROXY_CHUNK, version: 3, transferId: "xfer-abc", seq: 70_000, iv, data });
    expect(buf.byteLength).toBe(4 + 8 + 4 + 12 + 48);
    expect(decodeChunk(buf)).toMatchObject({ type: FRAME_PROXY_CHUNK, version: 3, transferId: "xfer-abc", seq: 70_000, iv, data });

    const parsed = parseBinaryChunk(Buffer.from(buf), 256 * 1024);
    if (isBinaryError(parsed)) throw new Error(parsed.error);
    expect(parsed).toMatchObject({ transferId: "xfer-abc", seq: 70_000, v: 3 });
    expect(Buffer.compare(parsed.ciphertext, Buffer.from(data))).toBe(0);
  });

  it("refuses what is not a chunk", () => {
    const good = new Uint8Array(encodeChunk({ type: FRAME_P2P_CHUNK, version: 2, transferId: "t-1", seq: 0, iv, data }));
    expect(decodeChunk(good.slice(0, 20))).toBeNull(); // truncated
    expect(decodeChunk(Uint8Array.of(0x7b, ...good.slice(1)))).toBeNull(); // "{" — JSON text
    const badId = good.slice(); badId[4] = 0x20; // a space in the transfer id
    expect(decodeChunk(badId)).toBeNull();
    // The server takes only proxy chunks, and only up to the frame limit.
    expect(parseBinaryChunk(Buffer.from(good), 1 << 20)).toEqual({ error: "not a proxy chunk" });
    const proxy = Buffer.from(encodeChunk({ type: FRAME_PROXY_CHUNK, version: 2, transferId: "t-1", seq: 0, iv, data }));
    expect(parseBinaryChunk(proxy, 32)).toEqual({ error: "binary frame too large" });
    expect(() => encodeChunk({ version: 2, transferId: "x".repeat(97), seq: 0, iv, data })).toThrow();
  });

  it("converts between the JSON and the binary form of a frame", () => {
    const frame: FileTransferEnvelope = { kind: "proxy-chunk", transferId: "t-2", seq: 5, transport: "proxy", v: 3, iv, ciphertext: data };
    expect(wireFrame(frame)).toMatchObject({ iv: toBase64(iv), ciphertext: toBase64(data) });
    const back = frameFromBinary(binaryFrame(frame)!);
    expect(back).toMatchObject({ kind: "proxy-chunk", transport: "proxy", transferId: "t-2", seq: 5, v: 3 });
    expect(binaryFrame({ kind: "file-end", transferId: "t-2", transport: "p2p" })).toBeNull();
  });
});

describe("a file over binary data channels", () => {
  it("arrives whole, and a JSON-only peer on the same send still gets JSON", async () => {
    const keys = await deriveRoomKeys("bin-room", "bin-passphrase", { kdf: "pbkdf2", iterations: 1000 });
    const payload = new Uint8Array(100_000).map((_, i) => (i * 31) & 0xff);
    const file = new File([payload], "photo.raw", { type: "application/octet-stream" });

    const channel = (binary: boolean) => {
      const sent: Array<string | ArrayBuffer> = [];
      const ch = { readyState: "open", bufferedAmount: 0, binary, sent, send: (d: string | ArrayBuffer) => { sent.push(d); }, addEventListener() {}, removeEventListener() {} };
      return ch as unknown as RTCDataChannel & { sent: typeof sent; binary: boolean };
    };
    const modern = channel(true);
    const older = channel(false);
    const result = await sendFile({
      key: keys, file, senderId: "peer-a", senderName: "Alice", chunkSize: 16 * 1024,
      channels: [modern, older], binary: (ch) => (ch as unknown as { binary: boolean }).binary,
    });
    expect(result.ok).toBe(true);

    const chunksOf = (ch: { sent: Array<string | ArrayBuffer> }) => ch.sent.filter((d) => typeof d !== "string" || d.includes('"file-chunk"'));
    expect(chunksOf(modern).every((d) => d instanceof ArrayBuffer)).toBe(true);
    expect(chunksOf(older).every((d) => typeof d === "string")).toBe(true);
    const wire = (ch: { sent: Array<string | ArrayBuffer> }) => ch.sent.reduce((n, d) => n + (typeof d === "string" ? d.length : d.byteLength), 0);
    expect(wire(modern)).toBeLessThan(wire(older) * 0.8);

    for (const ch of [modern, older]) {
      const registry = newIncomingRegistry();
      let received: Blob | null = null;
      const errors: string[] = [];
      for (const d of ch.sent) {
        const frame = typeof d === "string" ? (JSON.parse(d) as FileTransferEnvelope) : frameFromBinary(d)!;
        await handleIncomingFrame(keys, registry, frame, 10_000_000, {
          onComplete: (_id, blob) => { received = blob; },
          onError: (_id, message) => errors.push(message),
        });
      }
      expect(errors).toEqual([]);
      expect(new Uint8Array(await (received as unknown as Blob).arrayBuffer())).toEqual(payload);
    }
  });
});

describe("pacing a relayed transfer", () => {
  it("keeps inside the byte and frame budget after the burst", async () => {
    let clock = 0;
    const { Pacer } = await import("../client/src/lib/file-transfer");
    const pacer = new Pacer(
      { bytesPerSec: 1000, burstBytes: 2000, framesPerSec: 5, burstFrames: 3 },
      async () => undefined,
      () => clock,
      async (ms) => { clock += ms; },
    );
    // The burst goes at once…
    await pacer.take(500); await pacer.take(500); await pacer.take(500);
    expect(clock).toBe(0);
    // …then frames are the limit (5/s)…
    await pacer.take(10);
    expect(clock).toBeGreaterThanOrEqual(200);
    // …and bytes (1000/s): 690 are left, so 1500 need another 0.81 s.
    const before = clock;
    await pacer.take(1500);
    expect(clock - before).toBeGreaterThanOrEqual(800);
    expect(clock - before).toBeLessThan(900);
  });
});
