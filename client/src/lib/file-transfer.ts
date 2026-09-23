// Chunked encrypted file transfer over the existing P2P DataChannel,
// with an optional server-relay fallback for environments where direct
// P2P cannot be established (strict NAT, symmetric firewall).
//
// Transport choice is enforced by the client, server-side we only ever
// see AES-GCM ciphertext; for the proxy mode the server is a dumb
// reliable byte-pipe that forwards encrypted chunks between endpoints
// identified by (roomId, peerId, transferId).
//
// Default chunk size is 32 KiB. There is no client-side explicit hard
// cap; per-chunk streaming + IndexedDB buffering allow essentially
// unbounded sizes. The server proxy still enforces its own MEMORY cap
// (single in-memory buffer per transfer) so very large files should
// normally go through P2P; the server may still refuse a proxy stream
// when its bytes-per-transfer memory budget is exhausted.
//
// Privacy: server never sees plaintext. File is split into chunks,
// each chunk is AES-GCM 256-encrypted with a per-chunk IV.
//
// Crypto version 2 (envelope.ts), used when the caller passes RoomKeys:
//   - one AES key per transfer (HKDF from the room secret, salt = transfer id)
//   - every frame bound to its place as associated data: the meta to the
//     transfer, each chunk to (transfer, seq, chunk count) — a chunk cannot
//     be moved to another position or another file
//   - the sender hashes each chunk as it goes and sends the digest of the
//     digests, signed with its device identity, in the end frame; the
//     receiver recomputes it before handing the file over
// A plain CryptoKey still means version 1 (no AAD), for old peers.
//
// The receiver trusts nothing in the meta: the name is made harmless, the
// MIME type is reduced to one that is safe to open from a blob: URL in this
// origin (an HTML "attachment" would otherwise run as a page of this app),
// and sizes / chunk counts must be consistent before anything is allocated.
export const DEFAULT_CHUNK_SIZE = 32 * 1024; // 32 KiB
export const MAX_FILE_BYTES = Number.MAX_SAFE_INTEGER; // effectively unlimited


export type FileTransport = "p2p" | "proxy";

export type FileTransferEnvelope =
  // P2P frame envelopes (transmitted over the existing RTCPeerConnection DataChannel)
  | {
      kind: "file-meta";
      transferId: string;
      iv: string;
      ciphertext: string;
      transport: "p2p";
      v?: number;
    }
  | {
      kind: "file-chunk";
      transferId: string;
      seq: number;
      iv: string;
      ciphertext: string;
      transport: "p2p";
      v?: number;
    }
  | {
      kind: "file-end";
      transferId: string;
      transport: "p2p";
      /** v2: sealed { root, totalChunks, size }, signed by the sender. */
      v?: number;
      iv?: string;
      ciphertext?: string;
    }
  | {
      kind: "file-cancel";
      transferId: string;
      transport: "p2p";
    }
  | {
      kind: "file-progress";
      transferId: string;
      received: number;
      transport: "p2p";
    }
  | {
      /** Receiver → sender: these chunks never arrived, send them again. */
      kind: "file-need";
      transferId: string;
      seqs: number[];
      transport: "p2p";
    }
  // Proxy frame envelopes (transmitted over the signaling WebSocket)
  | {
      kind: "proxy-meta";
      transferId: string;
      iv: string;
      ciphertext: string;
      transport: "proxy";
      v?: number;
    }
  | {
      kind: "proxy-chunk";
      transferId: string;
      seq: number;
      iv: string;
      ciphertext: string;
      transport: "proxy";
      v?: number;
    }
  | {
      kind: "proxy-end";
      transferId: string;
      transport: "proxy";
      v?: number;
      iv?: string;
      ciphertext?: string;
    }
  | {
      kind: "proxy-need";
      transferId: string;
      seqs: number[];
      transport: "proxy";
    }
  | {
      kind: "proxy-cancel";
      transferId: string;
      transport: "proxy";
    }
  | {
      kind: "proxy-progress";
      transferId: string;
      received: number;
      transport: "proxy";
    }
  // Server-to-client intermediate states (e.g. relay-accepted)
  | {
      kind: "proxy-ack";
      transferId: string;
      transport: "proxy";
      accepted: boolean;
      reason?: string;
    };

export type FileMetaPlain = {
  transferId: string;
  name: string;
  mime: string;
  size: number;
  totalChunks: number;
  chunkSize: number;
  senderId: string;
  senderName: string;
  createdAt: number;
  /** Hint: sender's local timestamp at encryption time. */
  sha256Hint?: string; // first 8 hex chars of base SHA-256 for tamper detection
};

export type IncomingFileState = {
  meta: FileMetaPlain;
  chunks: Array<Bytes | null>;
  received: number; // bytes
  cancelled: boolean;
  transport: FileTransport;
  /** How many times we already asked the sender to repeat lost chunks. */
  resendRounds?: number;
  /** Crypto version of the transfer and the key its frames use. */
  version: 1 | 2;
  key: CryptoKey;
  /** v2: SHA-256 of each chunk, to check the sender's signed root. */
  digests?: Array<Bytes | null>;
  /** v2: who signed the meta (the end frame must come from the same key). */
  signer?: Signer | null;
};

/** What the receiver learns about a finished file besides its bytes. */
export type FileProof = { version: 1 | 2; verified: boolean; signer: Signer | null };

/** How often a receiver may ask for missing chunks before giving up. */
export const MAX_RESEND_ROUNDS = 3;

/**
 * Live statistics emitted to the UI while a file transfer is in flight.
 * The values are smoothed over a sliding window so the ETA does not
 * jitter on short bursts.
 */
export type TransferStats = {
  id: string;
  name: string;
  size: number;
  received: number;
  direction: "in" | "out";
  transport: FileTransport;
  encrypted: true; // AES-GCM 256 — we never relay plaintext, even via proxy
  bytesPerSecond: number;
  startedAt: number;
  updatedAt: number;
  etaSeconds: number;
  progress: number; // 0..1
};

import { toBase64, fromBase64, type Bytes } from "./crypto";
import {
  chunkDigest, digestList, fileContext, fileKey, openChunk, openFileBody, sealChunk, sealFileBody,
  type RoomKeys, type Signer,
} from "./envelope";
import type { Identity } from "./identity";
import { safeFileName, safeMime } from "./validate";

/** RoomKeys (crypto v2) or a bare AES key (v1). */
export type TransferKey = CryptoKey | RoomKeys;

export function isRoomKeys(key: TransferKey): key is RoomKeys {
  // Version 2 (3.0) and 3 (3.1) room keys both carry the per-file HKDF key.
  const version = (key as RoomKeys).version;
  return (version === 2 || version === 3) && Boolean((key as RoomKeys).files);
}

/** Chunk sizes a sender may choose, and how many chunks one file may have
 *  (2 M × the 32 KiB default = 64 GiB) — the receiver allocates a slot per
 *  chunk, so a meta claiming billions of them must not get that far. */
const MIN_CHUNK = 1;
const MAX_CHUNK = 1024 * 1024;
export const MAX_TOTAL_CHUNKS = 2_000_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function encryptBytes(key: CryptoKey, data: Bytes): Promise<{ iv: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
  return { iv: toBase64(iv), ciphertext: toBase64(ct) };
}
export async function decryptBytes(key: CryptoKey, iv: string, ct: string): Promise<Bytes> {
  const out = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv) }, key, fromBase64(ct));
  return new Uint8Array(out);
}
export async function encryptJSON(key: CryptoKey, payload: unknown) {
  return encryptBytes(key, encoder.encode(JSON.stringify(payload)));
}
export async function decryptJSON<T>(key: CryptoKey, iv: string, ct: string): Promise<T> {
  const out = await decryptBytes(key, iv, ct);
  return JSON.parse(decoder.decode(out)) as T;
}

/**
 * Lightweight SHA-256 hex of arbitrary bytes (first 16 chars returned).
 * Used as a tamper-detection hint in FileMetaPlain without forcing the
 * receiver to hash a multi-gigabyte stream up front.
 */
export async function shortSha256(bytes: Bytes): Promise<string | undefined> {
  try {
    // Avoid hashing multi-GB files at send time. For small files we can
    // include a 16-char prefix for free; for larger ones the receiver
    // still has GCM integrity.
    if (bytes.byteLength > 64 * 1024) return undefined;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return undefined;
  }
}

export type SendOptions = {
  key: TransferKey;
  /** Signs the meta and the end frame (crypto v2). */
  identity?: Identity | null;
  file: File;
  senderId: string;
  senderName: string;
  chunkSize?: number;
  channels: RTCDataChannel[]; // for P2P transport
  sendProxy?: (frame: FileTransferEnvelope) => boolean; // for proxy transport
  forceTransport?: FileTransport;
  onProgress?: (sent: number, total: number, stats: TransferStats) => void;
  isCancelled?: () => boolean;
  onTransport?: (transport: FileTransport) => void;
  onStats?: (stats: TransferStats) => void;
};

export type TransferResult = {
  ok: boolean;
  transferId: string;
  transport: FileTransport;
  reason?: string;
  /** Sends the given chunks again (answer to a "file-need" request) and
   *  repeats the end frame. Present once the file went out. */
  resend?: (seqs: number[]) => Promise<void>;
};

export async function sendFile(opts: SendOptions): Promise<TransferResult> {
  const transferId = `xfer-${crypto.randomUUID()}`;
  const chunkSize = opts.chunkSize || DEFAULT_CHUNK_SIZE;
  const total = opts.file.size;
  const totalChunks = Math.max(1, Math.ceil(total / chunkSize));

  // Upper bound on what the runtime can address. Number.MAX_SAFE_INTEGER
  // is the largest representable integer; above this arithmetic on byte
  // counters would silently degrade. We refuse anything larger — the
  // browser will not have the file backing it anyway.
  if (!Number.isFinite(total) || total < 0 || total > Number.MAX_SAFE_INTEGER) {
    return {
      ok: false,
      transferId: "",
      transport: opts.forceTransport ?? "p2p",
      reason: `Unrepresentable file size (${total} bytes).`,
    };
  }

  // Decide transport: P2P if at least one channel is open AND opted in by the caller.
  // Fall back to proxy otherwise.
  const canP2p = (opts.channels?.length ?? 0) > 0 && opts.channels.some((c) => c.readyState === "open");
  const transport: FileTransport = opts.forceTransport ?? (canP2p ? "p2p" : "proxy");
  opts.onTransport?.(transport);

  const meta: FileMetaPlain = {
    transferId,
    name: opts.file.name.slice(0, 200),
    mime: opts.file.type || "application/octet-stream",
    size: total,
    totalChunks,
    chunkSize,
    senderId: opts.senderId,
    senderName: opts.senderName,
    createdAt: Date.now(),
    sha256Hint: transport === "proxy" ? await shortSha256(new Uint8Array(await opts.file.slice(0, 64 * 1024).arrayBuffer())) : undefined,
  };

  const startedAt = Date.now();
  let lastSampleAt = startedAt;
  let lastSampleSent = 0;
  let smoothedBps = 0;

  function makeStats(received: number, now: number): TransferStats {
    const dt = Math.max(1, now - lastSampleAt);
    const db = Math.max(0, received - lastSampleSent);
    const instBps = (db * 1000) / dt;
    smoothedBps = smoothedBps === 0 ? instBps : smoothedBps * 0.7 + instBps * 0.3;
    const remaining = Math.max(0, total - received);
    const etaSeconds = smoothedBps > 1 ? Math.round(remaining / smoothedBps) : 0;
    return {
      id: transferId,
      name: meta.name,
      size: total,
      received,
      direction: "out",
      transport,
      encrypted: true,
      bytesPerSecond: Math.round(smoothedBps),
      startedAt,
      updatedAt: now,
      etaSeconds,
      progress: total === 0 ? 1 : received / total,
    };
  }
  function pushStats(sent: number) {
    const now = Date.now();
    const stats = makeStats(sent, now);
    if (now - lastSampleAt > 250) {
      lastSampleAt = now;
      lastSampleSent = sent;
    }
    opts.onProgress?.(sent, total, stats);
    opts.onStats?.(stats);
  }

  // v2: a key of its own for this file, each frame bound to its place.
  const v2 = isRoomKeys(opts.key);
  const key = v2 ? await fileKey(opts.key as RoomKeys, transferId) : (opts.key as CryptoKey);
  const versionField = v2 ? { v: 2 } : {};
  const digests: Array<Bytes | null> = new Array(totalChunks).fill(null);
  const encryptChunk = async (seq: number, slice: Bytes) => {
    if (!v2) return encryptBytes(key, slice);
    digests[seq] = await chunkDigest(slice);
    return sealChunk(key, fileContext.chunk(transferId, seq, totalChunks), slice);
  };
  const metaEnc = v2 ? await sealFileBody(key, fileContext.meta(transferId), meta, opts.identity) : await encryptJSON(key, meta);

  if (transport === "p2p") {
    const metaFrame: FileTransferEnvelope = { kind: "file-meta", transferId, transport: "p2p", ...versionField, ...metaEnc };
    broadcastP2P(opts.channels, metaFrame);
  } else {
    const metaFrame: FileTransferEnvelope = { kind: "proxy-meta", transferId, transport: "proxy", ...versionField, ...metaEnc };
    if (!opts.sendProxy?.(metaFrame)) {
      return { ok: false, transferId, transport, reason: "proxy-channel-unavailable" };
    }
  }

  let sent = 0;
  try {
    for (let i = 0; i < totalChunks; i += 1) {
      if (opts.isCancelled?.()) {
        const cancelFrame: FileTransferEnvelope = transport === "p2p"
          ? { kind: "file-cancel", transferId, transport: "p2p" }
          : { kind: "proxy-cancel", transferId, transport: "proxy" };
        if (transport === "p2p") broadcastP2P(opts.channels, cancelFrame);
        else opts.sendProxy?.(cancelFrame);
        return { ok: false, transferId, transport, reason: "cancelled" };
      }
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, total);
      const slice = new Uint8Array(await opts.file.slice(start, end).arrayBuffer());
      const enc = await encryptChunk(i, slice);

      if (transport === "p2p") {
        // Backpressure: wait if any channel buffer is large.
        await Promise.all(opts.channels.map((ch) => waitForBuffer(ch, DRAIN_TIMEOUT_MS)));
      }
      const frame: FileTransferEnvelope = transport === "p2p"
        ? { kind: "file-chunk", transferId, seq: i, transport: "p2p", ...versionField, iv: enc.iv, ciphertext: enc.ciphertext }
        : { kind: "proxy-chunk", transferId, seq: i, transport: "proxy", ...versionField, iv: enc.iv, ciphertext: enc.ciphertext };
      if (transport === "p2p") {
        await sendChunkP2P(opts.channels, frame); // throws rather than dropping
      } else if (!(opts.sendProxy?.(frame) ?? false)) {
        return { ok: false, transferId, transport, reason: "proxy-channel-closed" };
      }
      sent = end;
      pushStats(sent);
    }
  } catch (err) {
    const cancelFrame: FileTransferEnvelope = transport === "p2p"
      ? { kind: "file-cancel", transferId, transport: "p2p" }
      : { kind: "proxy-cancel", transferId, transport: "proxy" };
    if (transport === "p2p") broadcastP2P(opts.channels, cancelFrame);
    else opts.sendProxy?.(cancelFrame);
    return { ok: false, transferId, transport, reason: (err as Error).message || "send-error" };
  }

  // v2: the digest of every chunk's digest, signed — the receiver checks the
  // whole file against it before handing it over.
  const endBody = v2
    ? await sealFileBody(key, fileContext.end(transferId), { root: await digestList(digests as Bytes[]), totalChunks, size: total }, opts.identity)
    : null;
  const endFrame: FileTransferEnvelope = transport === "p2p"
    ? { kind: "file-end", transferId, transport: "p2p", ...(endBody ? { v: 2, ...endBody } : {}) }
    : { kind: "proxy-end", transferId, transport: "proxy", ...(endBody ? { v: 2, ...endBody } : {}) };
  if (transport === "p2p") broadcastP2P(opts.channels, endFrame);
  else opts.sendProxy?.(endFrame);

  pushStats(total);

  /** The receiver missed a few chunks: read, encrypt and send just those. */
  const resend = async (seqs: number[]): Promise<void> => {
    const wanted = Array.from(new Set(seqs)).filter((seq) => Number.isInteger(seq) && seq >= 0 && seq < totalChunks);
    for (const seq of wanted) {
      const start = seq * chunkSize;
      const enc = await encryptChunk(seq, new Uint8Array(await opts.file.slice(start, Math.min(start + chunkSize, total)).arrayBuffer()));
      const frame: FileTransferEnvelope = transport === "p2p"
        ? { kind: "file-chunk", transferId, seq, transport: "p2p", ...versionField, iv: enc.iv, ciphertext: enc.ciphertext }
        : { kind: "proxy-chunk", transferId, seq, transport: "proxy", ...versionField, iv: enc.iv, ciphertext: enc.ciphertext };
      if (transport === "p2p") await sendChunkP2P(opts.channels, frame);
      else opts.sendProxy?.(frame);
    }
    // Repeat the end frame so the receiver checks again.
    if (transport === "p2p") broadcastP2P(opts.channels, endFrame);
    else opts.sendProxy?.(endFrame);
  };

  return { ok: true, transferId, transport, resend };
}

/** Meta / end / cancel: best effort to every open channel. */
function broadcastP2P(channels: RTCDataChannel[], frame: FileTransferEnvelope) {
  const payload = JSON.stringify(frame);
  channels.forEach((ch) => {
    if (ch.readyState === "open") {
      try { ch.send(payload); } catch { /* ignore */ }
    }
  });
}

/**
 * A chunk, unlike a control frame, MUST NOT be dropped: one lost chunk only
 * shows up at the very end, as "Missing chunks at end-of-transfer", after
 * the whole file has been pushed. `send()` throws once the browser's send
 * queue is full (Chrome: 16 MiB), so back off, let the buffer drain and try
 * again; give up loudly rather than silently delivering a hole.
 */
async function sendChunkP2P(channels: RTCDataChannel[], frame: FileTransferEnvelope): Promise<void> {
  const payload = JSON.stringify(frame);
  for (const ch of channels) {
    if (ch.readyState !== "open") continue;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < SEND_ATTEMPTS; attempt += 1) {
      try {
        ch.send(payload);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        await waitForBuffer(ch, DRAIN_TIMEOUT_MS);
        if (ch.readyState !== "open") { lastError = null; break; } // gone: nothing to deliver
      }
    }
    if (lastError) {
      throw new Error(`Chunk ${"seq" in frame ? frame.seq : "?"} could not be sent: ${(lastError as Error).message || String(lastError)}`);
    }
  }
}

const HIGH_WATERMARK = 1024 * 1024; // 1 MiB
const SEND_ATTEMPTS = 6;
const DRAIN_TIMEOUT_MS = 10_000;

/** Resolves once the channel has room again (or is gone / the wait times out). */
function waitForBuffer(ch: RTCDataChannel, timeoutMs = 2_000): Promise<void> {
  if (ch.readyState !== "open") return Promise.resolve();
  if (ch.bufferedAmount < HIGH_WATERMARK) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let poll = 0;
    const done = () => {
      ch.removeEventListener("bufferedamountlow", onLow);
      clearInterval(poll);
      resolve();
    };
    const onLow = () => done();
    try { ch.bufferedAmountLowThreshold = HIGH_WATERMARK / 2; } catch { /* ignore */ }
    ch.addEventListener("bufferedamountlow", onLow);
    // The event does not fire in every engine (and never when the channel
    // closes), so poll as well and stop at the deadline either way.
    poll = setInterval(() => {
      if (ch.readyState !== "open" || ch.bufferedAmount < HIGH_WATERMARK || Date.now() >= deadline) done();
    }, 50) as unknown as number;
  });
}

function missingChunksMessage(missing: number, total: number): string {
  return `Missing chunks at end-of-transfer (${missing} of ${total}).`;
}

function missingChunkSeqs(state: IncomingFileState): number[] {
  const out: number[] = [];
  state.chunks.forEach((chunk, seq) => { if (chunk === null) out.push(seq); });
  return out;
}

/** Asks the sender for `seqs`. Returns false once we have asked enough. */
function requestResend(
  transferId: string,
  state: IncomingFileState,
  seqs: number[],
  transport: FileTransport,
  cb: IncomingCallbacks,
): boolean {
  const round = (state.resendRounds ?? 0) + 1;
  if (!cb.onNeed || round > MAX_RESEND_ROUNDS) return false;
  state.resendRounds = round;
  cb.onNeed(transferId, seqs, transport, round);
  return true;
}

// Receiver-side helpers
export type IncomingRegistry = Map<string, IncomingFileState>;
export function newIncomingRegistry(): IncomingRegistry { return new Map(); }

export type IncomingCallbacks = {
  onMeta?: (meta: FileMetaPlain, transport: FileTransport) => void;
  /** Chunks that never arrived; the caller sends the request to the sender. */
  onNeed?: (transferId: string, seqs: number[], transport: FileTransport, round: number) => void;
  onProgress?: (transferId: string, received: number, total: number, stats: TransferStats) => void;
  onComplete?: (transferId: string, blob: Blob, meta: FileMetaPlain, transport: FileTransport, proof: FileProof) => void;
  onCancel?: (transferId: string) => void;
  onError?: (transferId: string, message: string) => void;
};

/**
 * Frames of one transfer have to be PROCESSED in the order they arrived,
 * not merely received in order. Every frame is decrypted asynchronously and
 * the DataChannel handler fires each one in its own async call, so without a
 * queue the first chunks can overtake the meta frame they belong to ("chunk
 * arrived for unknown transfer") and the end frame can overtake the last
 * chunks — which surfaced as "Missing chunks at end-of-transfer" on an
 * otherwise perfectly delivered file.
 */
const frameQueues = new WeakMap<IncomingRegistry, Map<string, Promise<void>>>();

export function handleIncomingFrame(
  key: TransferKey,
  registry: IncomingRegistry,
  frame: FileTransferEnvelope,
  hardLimitBytes: number,
  cb: IncomingCallbacks,
): Promise<void> {
  let queues = frameQueues.get(registry);
  if (!queues) { queues = new Map(); frameQueues.set(registry, queues); }
  const transferId = String(frame.transferId);
  const previous = queues.get(transferId) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => processIncomingFrame(key, registry, frame, hardLimitBytes, cb));
  queues.set(transferId, current);
  // Drop the queue once this transfer goes quiet, so the map cannot grow.
  void current.catch(() => undefined).then(() => {
    if (queues!.get(transferId) === current) queues!.delete(transferId);
  });
  return current;
}

/** Checks the sender's meta before anything is allocated for it. Returns
 *  the meta with a harmless name and a safe MIME type, or why it is refused. */
export function checkMeta(raw: unknown, transferId: string, hardLimitBytes: number): FileMetaPlain | string {
  if (!raw || typeof raw !== "object") return "Malformed file meta.";
  const m = raw as Record<string, unknown>;
  if (m.transferId !== transferId) return "File meta does not belong to this transfer.";
  const size = m.size;
  const chunkSize = m.chunkSize;
  const totalChunks = m.totalChunks;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return "Invalid file size.";
  if (size > hardLimitBytes) return `File too large (${size} > ${hardLimitBytes} bytes).`;
  if (typeof chunkSize !== "number" || !Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK || chunkSize > MAX_CHUNK) return "Invalid chunk size.";
  if (totalChunks !== Math.max(1, Math.ceil(size / chunkSize))) return "Chunk count does not match the file size.";
  if (totalChunks > MAX_TOTAL_CHUNKS) return "Too many chunks.";
  const senderId = typeof m.senderId === "string" ? m.senderId.slice(0, 96) : "";
  // eslint-disable-next-line no-control-regex
  const senderName = typeof m.senderName === "string" ? m.senderName.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 48) : "";
  return {
    transferId,
    name: safeFileName(m.name),
    mime: safeMime(m.mime),
    size,
    totalChunks: totalChunks as number,
    chunkSize,
    senderId,
    senderName: senderName || `peer-${senderId.slice(-4)}`,
    createdAt: typeof m.createdAt === "number" && Number.isFinite(m.createdAt) ? Math.min(m.createdAt, Date.now() + 300_000) : Date.now(),
  };
}

async function processIncomingFrame(
  key: TransferKey,
  registry: IncomingRegistry,
  frame: FileTransferEnvelope,
  hardLimitBytes: number,
  cb: IncomingCallbacks,
): Promise<void> {
  const transport: FileTransport = frame.transport === "proxy" ? "proxy" : "p2p";
  // proxy-* and file-* frames share one lifecycle.
  const kind = frame.kind.replace(/^proxy-/, "file-");
  const transferId = frame.transferId;

  if (kind === "file-meta") {
    const f = frame as { iv: string; ciphertext: string; v?: number };
    if (registry.has(transferId)) return; // a repeated meta changes nothing
    try {
      const v2 = f.v === 2 && isRoomKeys(key);
      let fk: CryptoKey;
      let raw: unknown;
      let signer: Signer | null = null;
      if (v2) {
        fk = await fileKey(key as RoomKeys, transferId);
        const opened = await openFileBody<unknown>(fk, fileContext.meta(transferId), f.iv, f.ciphertext);
        raw = opened.value;
        signer = opened.signer;
      } else {
        fk = isRoomKeys(key) ? await key.legacy() : key;
        raw = await decryptJSON<unknown>(fk, f.iv, f.ciphertext);
      }
      const meta = checkMeta(raw, transferId, hardLimitBytes);
      if (typeof meta === "string") {
        cb.onError?.(transferId, meta);
        return;
      }
      if (signer && !signer.valid) {
        cb.onError?.(transferId, "The file's signature does not verify.");
        return;
      }
      registry.set(transferId, {
        meta,
        chunks: new Array<Bytes | null>(meta.totalChunks).fill(null),
        received: 0,
        cancelled: false,
        transport,
        version: v2 ? 2 : 1,
        key: fk,
        ...(v2 ? { digests: new Array<Bytes | null>(meta.totalChunks).fill(null), signer } : {}),
      });
      cb.onMeta?.(meta, transport);
    } catch (err) {
      cb.onError?.(transferId, (err as Error).message || "File meta could not be decrypted.");
    }
    return;
  }

  if (kind === "file-chunk") {
    const f = frame as { seq: number; iv: string; ciphertext: string };
    const state = registry.get(transferId);
    if (!state) {
      // A proxy chunk can overtake nothing (the server keeps order), so an
      // unknown one is noise; over P2P it means the meta was lost.
      if (transport === "p2p") cb.onError?.(transferId, `Chunk arrived for unknown transfer ${transferId}.`);
      return;
    }
    if (state.cancelled) return;
    const seq = f.seq;
    if (!Number.isInteger(seq) || seq < 0 || seq >= state.chunks.length || state.chunks[seq] !== null) return;
    try {
      const bytes = state.version === 2
        ? await openChunk(state.key, fileContext.chunk(transferId, seq, state.meta.totalChunks), f.iv, f.ciphertext)
        : await decryptBytes(state.key, f.iv, f.ciphertext);
      if (bytes.byteLength > state.meta.chunkSize) throw new Error(`Chunk ${seq} is larger than the announced chunk size.`);
      state.chunks[seq] = bytes;
      if (state.digests) state.digests[seq] = await chunkDigest(bytes);
      state.received += bytes.byteLength;
      cb.onProgress?.(transferId, state.received, state.meta.size, buildIncomingStats(state, "in"));
    } catch (err) {
      cb.onError?.(transferId, (err as Error).message || `Chunk ${seq} could not be decrypted.`);
    }
    return;
  }

  if (kind === "file-end") {
    const f = frame as { v?: number; iv?: string; ciphertext?: string };
    const state = registry.get(transferId);
    if (!state) return;
    const missingSeqs = missingChunkSeqs(state);
    if (missingSeqs.length > 0) {
      // A chunk can still go missing for honest reasons — the channel
      // dropped and came back, the relay hiccuped. Ask for those few again
      // instead of throwing away a file that is 99 % delivered.
      if (requestResend(transferId, state, missingSeqs, transport, cb)) return;
      cb.onError?.(transferId, missingChunksMessage(missingSeqs.length, state.chunks.length));
      registry.delete(transferId);
      return;
    }
    const fail = (message: string) => {
      cb.onError?.(transferId, message);
      registry.delete(transferId);
    };
    if (state.received !== state.meta.size) return fail(`Received ${state.received} bytes, the sender announced ${state.meta.size}.`);
    let proof: FileProof = { version: state.version, verified: false, signer: state.signer ?? null };
    if (state.version === 2) {
      if (typeof f.iv !== "string" || typeof f.ciphertext !== "string") return fail("The end of the file carries no digest.");
      try {
        const { value, signer } = await openFileBody<{ root?: unknown; totalChunks?: unknown; size?: unknown }>(state.key, fileContext.end(transferId), f.iv, f.ciphertext);
        if (value.totalChunks !== state.meta.totalChunks || value.size !== state.meta.size) return fail("The file's end does not match its meta.");
        if (value.root !== await digestList(state.digests as Bytes[])) return fail("The file does not match the sender's digest.");
        if (state.signer && (!signer || !signer.valid || signer.publicKey !== state.signer.publicKey)) return fail("The file's end was not signed by its sender.");
        proof = { version: 2, verified: true, signer: state.signer ?? null };
      } catch {
        return fail("The file's digest could not be decrypted.");
      }
    }
    const blob = new Blob(state.chunks as Bytes[], { type: state.meta.mime });
    cb.onComplete?.(transferId, blob, state.meta, transport, proof);
    registry.delete(transferId);
    return;
  }

  if (kind === "file-cancel") {
    const state = registry.get(transferId);
    if (state) state.cancelled = true;
    registry.delete(transferId);
    cb.onCancel?.(transferId);
  }
}

function buildIncomingStats(state: IncomingFileState, direction: "in"): TransferStats {
  const now = Date.now();
  const dt = Math.max(1, now - state.meta.createdAt);
  const instBps = (state.received * 1000) / dt;
  const remaining = Math.max(0, state.meta.size - state.received);
  const etaSeconds = instBps > 1 ? Math.round(remaining / instBps) : 0;
  return {
    id: state.meta.transferId,
    name: state.meta.name,
    size: state.meta.size,
    received: state.received,
    direction,
    transport: state.transport,
    encrypted: true,
    bytesPerSecond: Math.round(instBps),
    startedAt: state.meta.createdAt,
    updatedAt: now,
    etaSeconds,
    progress: state.meta.size === 0 ? 1 : state.received / state.meta.size,
  };
}
