// "File transfer failed: Missing chunks at end-of-transfer."
//
// Two causes, both of which only ever showed at the very end of an
// otherwise healthy transfer:
//
//   1. the receiver processed frames concurrently — every frame is
//      decrypted asynchronously and each one arrives in its own handler
//      call, so the first chunks could overtake the meta frame they
//      belong to, and the end frame could overtake the last chunks;
//   2. the sender swallowed a failed `send()` (the browser's send queue
//      fills up under backpressure), so a chunk was simply never sent.
//
// Both are reproduced here against the real module.

import { describe, expect, it, vi } from "vitest";
import {
  newIncomingRegistry, handleIncomingFrame, sendFile, encryptBytes, encryptJSON, MAX_RESEND_ROUNDS,
  type FileTransferEnvelope,
} from "../client/src/lib/file-transfer";
import { deriveRoomKey } from "../client/src/lib/crypto";

const key = await deriveRoomKey("delivery-room", "delivery-passphrase");

/** The frames a sender would put on the wire for `chunks`. */
async function wireFrames(transferId: string, chunks: Uint8Array[]): Promise<FileTransferEnvelope[]> {
  const meta = await encryptJSON(key, {
    transferId,
    name: "payload.bin",
    mime: "application/octet-stream",
    size: chunks.reduce((n, c) => n + c.byteLength, 0),
    totalChunks: chunks.length,
    chunkSize: chunks[0]?.byteLength ?? 0,
    senderId: "peer-a",
    senderName: "Alice",
    createdAt: Date.now(),
  });
  const frames: FileTransferEnvelope[] = [{ kind: "file-meta", transferId, transport: "p2p", ...meta }];
  for (let i = 0; i < chunks.length; i += 1) {
    frames.push({ kind: "file-chunk", transferId, seq: i, transport: "p2p", ...(await encryptBytes(key, chunks[i])) });
  }
  frames.push({ kind: "file-end", transferId, transport: "p2p" });
  return frames;
}

/** Feeds frames the way a DataChannel handler does: in order, not awaited. */
function feed(registry: ReturnType<typeof newIncomingRegistry>, frames: FileTransferEnvelope[]) {
  const errors: string[] = [];
  let completed: { size: number; name: string } | null = null;
  const pending = frames.map((frame) => handleIncomingFrame(key, registry, frame, 50_000_000, {
    onError: (_id, message) => errors.push(message),
    onComplete: (_id, blob, meta) => { completed = { size: blob.size, name: meta.name }; },
  }));
  return { errors, done: () => completed, settled: Promise.all(pending) };
}

describe("receiving frames back to back", () => {
  it("assembles the file even when every frame lands in its own handler call", async () => {
    const chunks = Array.from({ length: 64 }, (_, i) => new Uint8Array(1024).fill(i % 256));
    const run = feed(newIncomingRegistry(), await wireFrames("xfer-order", chunks));
    await run.settled;

    expect(run.errors).toEqual([]);
    expect(run.done()).toEqual({ size: 64 * 1024, name: "payload.bin" });
  });

  it("still reports a genuinely missing chunk, and says how many", async () => {
    const chunks = Array.from({ length: 8 }, (_, i) => new Uint8Array([i, i, i, i]));
    const frames = await wireFrames("xfer-hole", chunks);
    // Drop chunk 3 on the way, as a lost send would.
    const withHole = frames.filter((f) => !(f.kind === "file-chunk" && f.seq === 3));
    const run = feed(newIncomingRegistry(), withHole);
    await run.settled;

    expect(run.done()).toBeNull();
    expect(run.errors).toEqual(["Missing chunks at end-of-transfer (1 of 8)."]);
  });

  it("keeps two transfers apart", async () => {
    const registry = newIncomingRegistry();
    const a = await wireFrames("xfer-a", [new Uint8Array([1, 1, 1, 1])]);
    const b = await wireFrames("xfer-b", [new Uint8Array([2, 2, 2, 2]), new Uint8Array([3, 3, 3, 3])]);
    // Interleaved, as two parallel transfers arrive.
    const interleaved = [a[0], b[0], b[1], a[1], b[2], a[2], b[3]];
    const completed: string[] = [];
    const errors: string[] = [];
    await Promise.all(interleaved.map((frame) => handleIncomingFrame(key, registry, frame, 50_000_000, {
      onComplete: (id) => completed.push(id),
      onError: (_id, message) => errors.push(message),
    })));

    expect(errors).toEqual([]);
    expect(completed.sort()).toEqual(["xfer-a", "xfer-b"]);
  });
});

/** A DataChannel that refuses `send()` while its buffer is "full". */
function fakeChannel(opts: { failuresPerChunk?: number; alwaysFail?: boolean } = {}) {
  const sent: FileTransferEnvelope[] = [];
  let failuresLeft = opts.failuresPerChunk ?? 0;
  const channel = {
    readyState: "open" as RTCDataChannelState,
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    addEventListener: (_type: string, listener: () => void) => { setTimeout(listener, 0); },
    removeEventListener: () => {},
    send: (payload: string) => {
      const frame = JSON.parse(payload) as FileTransferEnvelope;
      if (opts.alwaysFail && frame.kind === "file-chunk") throw new Error("send queue is full");
      if (frame.kind === "file-chunk" && failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error("send queue is full");
      }
      failuresLeft = opts.failuresPerChunk ?? 0;
      sent.push(frame);
    },
  };
  return { channel: channel as unknown as RTCDataChannel, sent };
}

function fixtureFile(bytes: number): File {
  return new File([new Uint8Array(bytes).fill(7)], "big.bin", { type: "application/octet-stream" });
}

describe("sending under backpressure", () => {
  it("retries a refused chunk instead of dropping it", async () => {
    const { channel, sent } = fakeChannel({ failuresPerChunk: 2 });
    const result = await sendFile({
      key, file: fixtureFile(4096), senderId: "peer-a", senderName: "Alice",
      chunkSize: 1024, channels: [channel],
    });

    expect(result.ok).toBe(true);
    expect(sent.filter((f) => f.kind === "file-chunk").map((f) => (f as { seq: number }).seq)).toEqual([0, 1, 2, 3]);
    expect(sent.at(-1)?.kind).toBe("file-end");
  }, 20_000);

  it("fails loudly when a chunk cannot be sent at all — never a silent hole", async () => {
    const { channel, sent } = fakeChannel({ alwaysFail: true });
    const result = await sendFile({
      key, file: fixtureFile(2048), senderId: "peer-a", senderName: "Alice",
      chunkSize: 1024, channels: [channel],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/could not be sent/);
    // The receiver is told to drop what it has rather than wait forever.
    expect(sent.at(-1)?.kind).toBe("file-cancel");
    expect(sent.some((f) => f.kind === "file-end")).toBe(false);
  }, 20_000);

  it("reports progress for every chunk that made it out", async () => {
    const { channel } = fakeChannel();
    const seen: number[] = [];
    const result = await sendFile({
      key, file: fixtureFile(3072), senderId: "peer-a", senderName: "Alice",
      chunkSize: 1024, channels: [channel], onProgress: (bytesSent) => seen.push(bytesSent),
    });

    expect(result.ok).toBe(true);
    expect(seen).toEqual([1024, 2048, 3072, 3072]);
  });
});

describe("transfers through the server relay", () => {
  it("hands every frame to the proxy sender", async () => {
    const frames: FileTransferEnvelope[] = [];
    const sendProxy = vi.fn((frame: FileTransferEnvelope) => { frames.push(frame); return true; });
    const result = await sendFile({
      key, file: fixtureFile(2048), senderId: "peer-a", senderName: "Alice",
      chunkSize: 1024, channels: [], sendProxy, forceTransport: "proxy",
    });

    expect(result).toMatchObject({ ok: true, transport: "proxy" });
    expect(frames.map((f) => f.kind)).toEqual(["proxy-meta", "proxy-chunk", "proxy-chunk", "proxy-end"]);
  });
});

describe("asking for chunks that never arrived", () => {
  it("requests the missing ones instead of failing, and completes when they land", async () => {
    const chunks = Array.from({ length: 10 }, (_, i) => new Uint8Array(8).fill(i));
    const frames = await wireFrames("xfer-lost", chunks);
    const registry = newIncomingRegistry();

    const asked: Array<{ seqs: number[]; round: number }> = [];
    const errors: string[] = [];
    let completed: Blob | null = null;
    const cb = {
      onNeed: (_id: string, seqs: number[], _t: unknown, round: number) => { asked.push({ seqs, round }); },
      onError: (_id: string, message: string) => errors.push(message),
      onComplete: (_id: string, blob: Blob) => { completed = blob; },
    };
    const lost = frames.filter((f) => !(f.kind === "file-chunk" && (f.seq === 2 || f.seq === 7)));
    await Promise.all(lost.map((f) => handleIncomingFrame(key, registry, f, 50_000_000, cb)));

    // Nothing failed yet: the receiver asked for exactly what it is missing.
    expect(errors).toEqual([]);
    expect(asked).toEqual([{ seqs: [2, 7], round: 1 }]);
    expect(completed).toBeNull();

    // The sender repeats them and ends again.
    const repeats = frames.filter((f) => f.kind === "file-chunk" && (f.seq === 2 || f.seq === 7));
    await Promise.all([...repeats, frames.at(-1)!].map((f) => handleIncomingFrame(key, registry, f, 50_000_000, cb)));

    expect(errors).toEqual([]);
    expect(completed).not.toBeNull();
    expect(completed!.size).toBe(80);
  });

  it("gives up after a bounded number of rounds", async () => {
    const chunks = Array.from({ length: 4 }, (_, i) => new Uint8Array([i]));
    const frames = await wireFrames("xfer-hopeless", chunks);
    const registry = newIncomingRegistry();
    const asked: number[] = [];
    const errors: string[] = [];
    const cb = {
      onNeed: (_id: string, _seqs: number[], _t: unknown, round: number) => { asked.push(round); },
      onError: (_id: string, message: string) => errors.push(message),
    };
    const withoutOne = frames.filter((f) => !(f.kind === "file-chunk" && f.seq === 1));
    await Promise.all(withoutOne.map((f) => handleIncomingFrame(key, registry, f, 50_000_000, cb)));
    // The sender keeps answering with an end frame but never the chunk.
    for (let i = 0; i < MAX_RESEND_ROUNDS + 1; i += 1) {
      await handleIncomingFrame(key, registry, frames.at(-1)!, 50_000_000, cb);
    }

    expect(asked).toEqual([1, 2, 3]);
    expect(errors).toEqual(["Missing chunks at end-of-transfer (1 of 4)."]);
  });

  it("repeats exactly the chunks the receiver asked for", async () => {
    const { channel, sent } = fakeChannel();
    const result = await sendFile({
      key, file: fixtureFile(4096), senderId: "peer-a", senderName: "Alice",
      chunkSize: 1024, channels: [channel],
    });
    expect(result.resend).toBeTypeOf("function");
    sent.length = 0;

    await result.resend!([1, 3, 99]); // 99 is out of range and is ignored
    expect(sent.map((f) => f.kind === "file-chunk" ? (f as { seq: number }).seq : f.kind)).toEqual([1, 3, "file-end"]);
  }, 20_000);
});
