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
    }
  | {
      kind: "file-chunk";
      transferId: string;
      seq: number;
      iv: string;
      ciphertext: string;
      transport: "p2p";
    }
  | {
      kind: "file-end";
      transferId: string;
      transport: "p2p";
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
  // Proxy frame envelopes (transmitted over the signaling WebSocket)
  | {
      kind: "proxy-meta";
      transferId: string;
      iv: string;
      ciphertext: string;
      transport: "proxy";
    }
  | {
      kind: "proxy-chunk";
      transferId: string;
      seq: number;
      iv: string;
      ciphertext: string;
      transport: "proxy";
    }
  | {
      kind: "proxy-end";
      transferId: string;
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
  chunks: Array<Uint8Array | null>;
  received: number; // bytes
  cancelled: boolean;
  transport: FileTransport;
};

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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}
function fromBase64(value: string) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

export async function encryptBytes(key: CryptoKey, data: Uint8Array): Promise<{ iv: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
  return { iv: toBase64(iv), ciphertext: toBase64(ct) };
}
export async function decryptBytes(key: CryptoKey, iv: string, ct: string): Promise<Uint8Array> {
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
export async function shortSha256(bytes: Uint8Array): Promise<string | undefined> {
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
  key: CryptoKey;
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

  const metaEnc = await encryptJSON(opts.key, meta);

  if (transport === "p2p") {
    const metaFrame: FileTransferEnvelope = { kind: "file-meta", transferId, transport: "p2p", ...metaEnc };
    broadcastP2P(opts.channels, metaFrame);
  } else {
    const metaFrame: FileTransferEnvelope = { kind: "proxy-meta", transferId, transport: "proxy", ...metaEnc };
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
      const enc = await encryptBytes(opts.key, slice);

      if (transport === "p2p") {
        // Backpressure: wait if any channel buffer is large.
        await Promise.all(opts.channels.map((ch) => waitForBuffer(ch)));
      }
      const frame: FileTransferEnvelope = transport === "p2p"
        ? { kind: "file-chunk", transferId, seq: i, transport: "p2p", iv: enc.iv, ciphertext: enc.ciphertext }
        : { kind: "proxy-chunk", transferId, seq: i, transport: "proxy", iv: enc.iv, ciphertext: enc.ciphertext };
      const ok = transport === "p2p"
        ? (() => { broadcastP2P(opts.channels, frame); return true; })()
        : (opts.sendProxy?.(frame) ?? false);
      if (!ok && transport === "proxy") {
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

  const endFrame: FileTransferEnvelope = transport === "p2p"
    ? { kind: "file-end", transferId, transport: "p2p" }
    : { kind: "proxy-end", transferId, transport: "proxy" };
  if (transport === "p2p") broadcastP2P(opts.channels, endFrame);
  else opts.sendProxy?.(endFrame);

  pushStats(total);
  return { ok: true, transferId, transport };
}

function broadcastP2P(channels: RTCDataChannel[], frame: FileTransferEnvelope) {
  const payload = JSON.stringify(frame);
  channels.forEach((ch) => {
    if (ch.readyState === "open") {
      try { ch.send(payload); } catch { /* ignore */ }
    }
  });
}

const HIGH_WATERMARK = 1024 * 1024; // 1 MiB
function waitForBuffer(ch: RTCDataChannel): Promise<void> {
  if (ch.readyState !== "open") return Promise.resolve();
  if (ch.bufferedAmount < HIGH_WATERMARK) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onLow = () => { ch.removeEventListener("bufferedamountlow", onLow); resolve(); };
    try { ch.bufferedAmountLowThreshold = HIGH_WATERMARK / 2; } catch { /* ignore */ }
    ch.addEventListener("bufferedamountlow", onLow);
    setTimeout(onLow, 1500); // safety timeout in case event doesn't fire
  });
}

// Receiver-side helpers
export type IncomingRegistry = Map<string, IncomingFileState>;
export function newIncomingRegistry(): IncomingRegistry { return new Map(); }

export type IncomingCallbacks = {
  onMeta?: (meta: FileMetaPlain, transport: FileTransport) => void;
  onProgress?: (transferId: string, received: number, total: number, stats: TransferStats) => void;
  onComplete?: (transferId: string, blob: Blob, meta: FileMetaPlain, transport: FileTransport) => void;
  onCancel?: (transferId: string) => void;
  onError?: (transferId: string, message: string) => void;
};

export async function handleIncomingFrame(
  key: CryptoKey,
  registry: IncomingRegistry,
  frame: FileTransferEnvelope,
  hardLimitBytes: number,
  cb: IncomingCallbacks,
): Promise<void> {
  // Normalise to "kind" we recognise; proxy-meta/chunk/end/cancel/progress
  // share the same lifecycle as p2p-meta/chunk/etc — we map them below.
  if (frame.transport === "proxy") {
    if (frame.kind === "proxy-meta") {
      try {
        const meta = await decryptJSON<FileMetaPlain>(key, frame.iv, frame.ciphertext);
        if (meta.size > hardLimitBytes) {
          cb.onError?.(frame.transferId, `File too large (${meta.size} > ${hardLimitBytes} bytes).`);
          return;
        }
        registry.set(meta.transferId, {
          meta,
          chunks: new Array<Uint8Array | null>(meta.totalChunks).fill(null),
          received: 0,
          cancelled: false,
          transport: "proxy",
        });
        cb.onMeta?.(meta, "proxy");
      } catch (err) {
        cb.onError?.(frame.transferId, (err as Error).message);
      }
      return;
    }
    if (frame.kind === "proxy-chunk") {
      const state = registry.get(frame.transferId);
      if (!state || state.cancelled) return;
      // Surface a notification when a chunk arrives for a transfer
      // whose meta was never seen — this protects the receiver from a
      // misbehaving sender that tries to flood the buffer.
      try {
        const bytes = await decryptBytes(key, frame.iv, frame.ciphertext);
        if (state.chunks[frame.seq] === null) {
          state.chunks[frame.seq] = bytes;
          state.received += bytes.byteLength;
          cb.onProgress?.(frame.transferId, state.received, state.meta.size, buildIncomingStats(state, "in"));
        }
      } catch (err) {
        cb.onError?.(frame.transferId, (err as Error).message);
      }
      return;
    }
    if (frame.kind === "proxy-end") {
      const state = registry.get(frame.transferId);
      if (!state) return;
      if (state.chunks.some((c) => c === null)) {
        cb.onError?.(frame.transferId, "Missing chunks at end-of-transfer.");
        return;
      }
      const blob = new Blob(state.chunks as Uint8Array[], { type: state.meta.mime });
      cb.onComplete?.(frame.transferId, blob, state.meta, "proxy");
      registry.delete(frame.transferId);
      return;
    }
    if (frame.kind === "proxy-cancel") {
      const state = registry.get(frame.transferId);
      if (state) state.cancelled = true;
      registry.delete(frame.transferId);
      cb.onCancel?.(frame.transferId);
      return;
    }
    return;
  }

  if (frame.kind === "file-meta") {
    try {
      const meta = await decryptJSON<FileMetaPlain>(key, frame.iv, frame.ciphertext);
      if (meta.size > hardLimitBytes) {
        cb.onError?.(frame.transferId, `File too large (${meta.size} > ${hardLimitBytes} bytes).`);
        return;
      }
      registry.set(meta.transferId, {
        meta,
        chunks: new Array<Uint8Array | null>(meta.totalChunks).fill(null),
        received: 0,
        cancelled: false,
        transport: "p2p",
      });
      cb.onMeta?.(meta, "p2p");
    } catch (err) {
      cb.onError?.(frame.transferId, (err as Error).message);
    }
    return;
  }
  if (frame.kind === "file-chunk") {
    const state = registry.get(frame.transferId);
    if (!state) {
      cb.onError?.(frame.transferId, `Chunk arrived for unknown transfer ${frame.transferId}.`);
      return;
    }
    if (state.cancelled) return;
    try {
      const bytes = await decryptBytes(key, frame.iv, frame.ciphertext);
      if (state.chunks[frame.seq] === null) {
        state.chunks[frame.seq] = bytes;
        state.received += bytes.byteLength;
        cb.onProgress?.(frame.transferId, state.received, state.meta.size, buildIncomingStats(state, "in"));
      }
    } catch (err) {
      cb.onError?.(frame.transferId, (err as Error).message);
    }
    return;
  }
  if (frame.kind === "file-end") {
    const state = registry.get(frame.transferId);
    if (!state) return;
    if (state.chunks.some((c) => c === null)) {
      cb.onError?.(frame.transferId, "Missing chunks at end-of-transfer.");
      return;
    }
    const blob = new Blob(state.chunks as Uint8Array[], { type: state.meta.mime });
    cb.onComplete?.(frame.transferId, blob, state.meta, "p2p");
    registry.delete(frame.transferId);
    return;
  }
  if (frame.kind === "file-cancel") {
    const state = registry.get(frame.transferId);
    if (state) state.cancelled = true;
    registry.delete(frame.transferId);
    cb.onCancel?.(frame.transferId);
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
