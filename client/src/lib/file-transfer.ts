// Chunked encrypted file transfer over the existing P2P DataChannel.
//
// Why: removing the 512 kB inline data-URL cap. Files are split into
// small chunks (default 32 KiB), each encrypted with the room AES-GCM
// key, and reassembled by the receiver. Memory safeguard: chunks are
// held in a list of ArrayBuffers and joined into a single Blob only
// at completion. Browser memory still bounds maximum size — we expose
// configurable hard limit. For very large files (> a few hundred MB)
// the operator should prefer a storage-provider plugin (see docs).

export type FileTransferEnvelope =
  | {
      kind: "file-meta";
      transferId: string;
      iv: string;
      ciphertext: string; // encrypted JSON of FileMetaPlain
    }
  | {
      kind: "file-chunk";
      transferId: string;
      seq: number;
      iv: string;
      ciphertext: string;
    }
  | {
      kind: "file-end";
      transferId: string;
    }
  | {
      kind: "file-cancel";
      transferId: string;
    }
  | {
      kind: "file-progress";
      transferId: string;
      received: number;
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
};

export type IncomingFileState = {
  meta: FileMetaPlain;
  chunks: Array<Uint8Array | null>;
  received: number; // bytes
  cancelled: boolean;
};

export const DEFAULT_CHUNK_SIZE = 32 * 1024; // 32 KiB

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

export type SendOptions = {
  key: CryptoKey;
  file: File;
  senderId: string;
  senderName: string;
  chunkSize?: number;
  channels: RTCDataChannel[]; // broadcast to all open channels
  onProgress?: (sent: number, total: number) => void;
  isCancelled?: () => boolean;
};

export async function sendFile(opts: SendOptions): Promise<{ ok: boolean; transferId: string; reason?: string }> {
  const transferId = `xfer-${crypto.randomUUID()}`;
  const chunkSize = opts.chunkSize || DEFAULT_CHUNK_SIZE;
  const total = opts.file.size;
  const totalChunks = Math.max(1, Math.ceil(total / chunkSize));

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
  };

  const metaEnc = await encryptJSON(opts.key, meta);
  const metaFrame: FileTransferEnvelope = { kind: "file-meta", transferId, ...metaEnc };
  broadcast(opts.channels, metaFrame);

  let sent = 0;
  for (let i = 0; i < totalChunks; i += 1) {
    if (opts.isCancelled?.()) {
      broadcast(opts.channels, { kind: "file-cancel", transferId });
      return { ok: false, transferId, reason: "cancelled" };
    }
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, total);
    const slice = new Uint8Array(await opts.file.slice(start, end).arrayBuffer());
    const enc = await encryptBytes(opts.key, slice);
    const frame: FileTransferEnvelope = {
      kind: "file-chunk",
      transferId,
      seq: i,
      iv: enc.iv,
      ciphertext: enc.ciphertext,
    };
    // Backpressure: wait if any channel buffer is large.
    await Promise.all(opts.channels.map((ch) => waitForBuffer(ch)));
    broadcast(opts.channels, frame);
    sent = end;
    opts.onProgress?.(sent, total);
  }

  broadcast(opts.channels, { kind: "file-end", transferId });
  return { ok: true, transferId };
}

function broadcast(channels: RTCDataChannel[], frame: FileTransferEnvelope) {
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

export async function handleIncomingFrame(
  key: CryptoKey,
  registry: IncomingRegistry,
  frame: FileTransferEnvelope,
  hardLimitBytes: number,
  cb: {
    onMeta?: (meta: FileMetaPlain) => void;
    onProgress?: (transferId: string, received: number, total: number) => void;
    onComplete?: (transferId: string, blob: Blob, meta: FileMetaPlain) => void;
    onCancel?: (transferId: string) => void;
    onError?: (transferId: string, message: string) => void;
  },
): Promise<void> {
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
      });
      cb.onMeta?.(meta);
    } catch (err) {
      cb.onError?.(frame.transferId, (err as Error).message);
    }
    return;
  }
  if (frame.kind === "file-chunk") {
    const state = registry.get(frame.transferId);
    if (!state || state.cancelled) return;
    try {
      const bytes = await decryptBytes(key, frame.iv, frame.ciphertext);
      if (state.chunks[frame.seq] === null) {
        state.chunks[frame.seq] = bytes;
        state.received += bytes.byteLength;
        cb.onProgress?.(frame.transferId, state.received, state.meta.size);
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
    cb.onComplete?.(frame.transferId, blob, state.meta);
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
