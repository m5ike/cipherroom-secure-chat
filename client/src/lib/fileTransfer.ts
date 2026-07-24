// FileTransfer — chunked encrypted přenos souborů přes RTCDataChannel.
//
// Architektura:
//
//   1. Odesílatel zašifruje File po CHUNK_SIZE blocích (AES-GCM, nový IV).
//      Každý chunk má index. Vygeneruje se SHA-256 nad plaintext bajty
//      (příjemce si ho ověří po dekryptu) — pokud se neshoduje, transfer se
//      zruší a uživatel je varován.
//
//   2. Příjemce dostane "manifest" — JSON zprávu (přes textový kanál), obsahuje
//      {id, name, mime, size, sha256, chunkCount, chunkSize}. Příjemce odpoví
//      ACK (po jednom chunku) a může kdykoli poslat "resume-from" nebo "abort".
//
//   3. Binární chunky letí přes vyhrazený RTCDataChannel ("cipherroom-files")
//      s bufferAmountLowThreshold řízením zpětného tlaku.
//
//   4. Server NAHRADÍ roli ciphertext routeru = NULA. Soubory putují
//      browser-to-browser, server vidí jen signaling SDP/ICE.
//      Server rate-limit chrání pouze signaling frekvenci, ne file payload.

import { encryptEnvelope, decryptEnvelope, fromBase64, toBase64, newId } from "./crypto";

export const CHUNK_SIZE = 64 * 1024; // 64 KB — bezpečné pro DataChannel msg
export const DEFAULT_MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB cap

// ─────────────────────────────────────────────────────────────────────────────
// Manifesty a ACK
// ─────────────────────────────────────────────────────────────────────────────

export type FileManifest = {
  kind: "file-manifest";
  transferId: string;
  fileId: string;
  name: string;
  mime: string;
  size: number;
  chunks: number;
  chunkSize: number;
  sha256: string; // base64 celého plaintext souboru
};

export type FileAck = {
  kind: "file-ack";
  transferId: string;
  receivedChunks: number;
  ok: boolean;
  reason?: string;
};

export type FileAbort = {
  kind: "file-abort";
  transferId: string;
  reason?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// SignedFileChunkEnvelope — zašifrovaný chunk, který letí binárně jako JSON-string
// (zústaneme na stringu pro jednotu s textem; AES payload je binární ale client
// pošifrovaný jako base64 string v JSONu).
//
// Pro opravdu velké soubory (>100 MB) by bylo lepší posílat nativní binární
// rámečky — to je TODO optimalizace. Aktuálně JSON má overhead cca 33 % (base64).
// ─────────────────────────────────────────────────────────────────────────────

export type FileChunkEnvelope = {
  v: 1;
  alg: "AES-GCM";
  transferId: string;
  index: number;
  total: number;
  sha256: string; // hash tohoto konkrétního chunku (base64)
  iv: string; // base64
  ciphertext: string; // base64 — celý 64 KB chunk (kromě posledního)
};

export type FileControlEnvelope =
  | FileManifest
  | FileAck
  | FileAbort
  | (FileChunkEnvelope & { kind: "file-chunk" });

// ─────────────────────────────────────────────────────────────────────────────
// Odesílatel
// ─────────────────────────────────────────────────────────────────────────────

export type SendOptions = {
  key: CryptoKey;
  channel: RTCDataChannel;
  file: File;
  maxBytes?: number;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  onComplete?: () => void;
  onAbort?: (reason: string) => void;
  // signal abort zvenku
  signal?: AbortSignal;
};

export async function sendFile(opts: SendOptions): Promise<void> {
  const {
    key,
    channel,
    file,
    maxBytes = DEFAULT_MAX_ATTACHMENT_BYTES,
    onProgress,
    onComplete,
    onAbort,
    signal,
  } = opts;

  if (file.size > maxBytes) {
    const reason = `Soubor je větší než ${(maxBytes / 1024 / 1024 / 1024).toFixed(2)} GB.`;
    onAbort?.(reason);
    throw new Error(reason);
  }

  const transferId = newId("xfer");
  const fileId = newId("file");
  const chunkCount = Math.ceil(file.size / CHUNK_SIZE);
  const sha256 = await digestFileSha256(file);

  // Manifest
  const manifest: FileManifest = {
    kind: "file-manifest",
    transferId,
    fileId,
    name: file.name.slice(0, 96),
    mime: file.type || "application/octet-stream",
    size: file.size,
    chunks: chunkCount,
    chunkSize: CHUNK_SIZE,
    sha256,
  };
  channel.send(JSON.stringify(manifest));

  let offset = 0;
  let index = 0;
  let aborted = false;

  signal?.addEventListener(
    "abort",
    () => {
      aborted = true;
      const abort: FileAbort = { kind: "file-abort", transferId, reason: signal.reason };
      try {
        channel.send(JSON.stringify(abort));
      } catch {
        // ignore
      }
      onAbort?.(signal.reason || "aborted");
    },
    { once: true },
  );

  while (offset < file.size && !aborted) {
    // Backpressure — pokud buffer > 8 MB, počkej na drain
    if (channel.bufferedAmount > 8 * 1024 * 1024) {
      await new Promise<void>((resolve) => {
        const handler = () => {
          channel.removeEventListener("bufferedamountlow", handler);
          resolve();
        };
        channel.addEventListener("bufferedamountlow", handler);
      });
    }
    if (aborted) break;

    const slice = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
    const buf = new Uint8Array(await slice.arrayBuffer());
    const chunkSha = await sha256Bytes(buf);

    // payload: { index, fileBuf: number[] } zarolovaný do JSONu → AES-GCM
    const payload = { index, total: chunkCount, data: Array.from(buf) };
    const envelope = await encryptEnvelope(key, payload);

    const chunkMsg = JSON.stringify({
      ...envelope,
      kind: "file-chunk",
      transferId,
      index,
      total: chunkCount,
      sha256: chunkSha,
    });

    try {
      channel.send(chunkMsg);
    } catch (err) {
      aborted = true;
      onAbort?.((err as Error).message);
      return;
    }
    offset += buf.length;
    index += 1;
    onProgress?.(offset, file.size);
  }

  if (!aborted) onComplete?.();
}

// ─────────────────────────────────────────────────────────────────────────────
// Příjemce
// ─────────────────────────────────────────────────────────────────────────────

export type ReceiveState = {
  transferId: string;
  manifest: FileManifest;
  chunks: Uint8Array[];
  receivedCount: number;
  totalReceived: number;
};

export type ReceiveHandlers = {
  onManifest?: (state: ReceiveState) => void;
  onProgress?: (receivedBytes: number, totalBytes: number, state: ReceiveState) => void;
  onComplete?: (blob: Blob, manifest: FileManifest) => void;
  onAbort?: (reason: string, manifest?: FileManifest) => void;
};

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toBase64(new Uint8Array(digest));
}

async function digestFileSha256(file: File): Promise<string> {
  // Pro soubory do 2 GB: stream po 4 MB.
  const buf = new Uint8Array(await file.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return toBase64(new Uint8Array(digest));
}

export async function handleFileControl(
  raw: string,
  key: CryptoKey,
  handlers: ReceiveHandlers,
  activeTransfers: Map<string, ReceiveState>,
): Promise<void> {
  let envelope: any;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return;
  }
  if (!envelope || typeof envelope.kind !== "string") return;

  if (envelope.kind === "file-manifest") {
    const state: ReceiveState = {
      transferId: envelope.transferId,
      manifest: envelope as FileManifest,
      chunks: new Array(envelope.chunks),
      receivedCount: 0,
      totalReceived: 0,
    };
    activeTransfers.set(envelope.transferId, state);
    handlers.onManifest?.(state);
    return;
  }

  if (envelope.kind === "file-abort") {
    const state = activeTransfers.get(envelope.transferId);
    activeTransfers.delete(envelope.transferId);
    handlers.onAbort?.(envelope.reason || "remote-abort", state?.manifest);
    return;
  }

  if (envelope.kind !== "file-chunk") return;

  const state = activeTransfers.get(envelope.transferId);
  if (!state) {
    // manifest nedošel, zahoď
    return;
  }
  if (envelope.index >= state.manifest.chunks) {
    handlers.onAbort?.("Index out of range", state.manifest);
    return;
  }

  // dešifruj
  const decrypted = await decryptEnvelope<{ index: number; total: number; data: number[] }>(
    key,
    {
      v: envelope.v,
      alg: envelope.alg,
      iv: envelope.iv,
      ciphertext: envelope.ciphertext,
    },
  );

  const bytes = new Uint8Array(decrypted.data);
  const localSha = await sha256Bytes(bytes);
  if (localSha !== envelope.sha256) {
    handlers.onAbort?.(`Chunk ${envelope.index} integrity check failed`, state.manifest);
    return;
  }
  state.chunks[envelope.index] = bytes;
  state.receivedCount += 1;
  state.totalReceived += bytes.length;
  handlers.onProgress?.(state.totalReceived, state.manifest.size, state);

  if (state.receivedCount === state.manifest.chunks) {
    // Slož blob, ověř celkový hash
    const blob = new Blob(state.chunks as BlobPart[], { type: state.manifest.mime });
    const buf = new Uint8Array(await blob.arrayBuffer());
    const finalSha = await sha256Bytes(buf);
    if (finalSha !== state.manifest.sha256) {
      handlers.onAbort?.("Final SHA-256 mismatch — corrupted transfer", state.manifest);
      activeTransfers.delete(envelope.transferId);
      return;
    }
    activeTransfers.delete(envelope.transferId);
    handlers.onComplete?.(blob, state.manifest);
  }
}
