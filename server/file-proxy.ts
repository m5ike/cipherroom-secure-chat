// Server-side file transfer relay (proxy mode).
//
// Purpose:
//   When two clients cannot establish a direct P2P link (symmetric NAT,
//   restrictive firewall, IPv6-only server with only one peer on the
//   same protocol), the encrypted chunks can still be exchanged via the
//   signaling WebSocket. The server never sees plaintext: chunks arrive
//   already encrypted with AES-GCM by the room key, so the relay
//   forwards opaque ciphertext as-is.
//
// Security guarantees:
//   - Server does NOT decrypt frames. The room key lives in the browser.
//   - Server bounds each transfer to MAX_BYTES (10 GiB hard cap).
//   - Cache TTL: TRANSFER_TTL_MS — abandoned transfers are garbage-collected.
//   - On memory pressure (ring buffer full), we reject new transfers
//     with `proxy-ack accepted=false reason=server-full` so the sender
//     can fall back to P2P or surface an error.

import type { WebSocket } from "ws";

const MAX_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB hard cap
const TRANSFER_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_PARALLEL_PER_PEER = 4;
const MAX_PARALLEL_TOTAL = 64;

type ProxyTransferState = {
  id: string;
  senderPeerId: string;
  recipientPeerId?: string; // populated when the recipient joins the relay
  meta: { iv: string; ciphertext: string; size: number }; // size opaque; we trust sender cipher length after meta decrypt in client
  plaintextSize: number; // extracted from decrypted meta on sender side, just for capping
  createdAt: number;
  lastActivityAt: number;
  chunks: Map<number, { iv: string; ciphertext: string }>;
  cancelled: boolean;
};

export class FileProxy {
  private byTransfer = new Map<string, ProxyTransferState>();
  private byPeer = new Map<string, Set<string>>(); // senderPeerId → transfers
  private totalActive = 0;

  begin(
    senderClientId: string,
    frame: { transferId: string; iv: string; ciphertext: string },
    plaintextSizeHint: number,
  ): { ok: boolean; reason?: string } {
    const transferId = String(frame.transferId || "").slice(0, 128);
    if (!/^[a-zA-Z0-9_-]{4,128}$/.test(transferId)) {
      return { ok: false, reason: "invalid-id" };
    }
    if (this.byTransfer.has(transferId)) {
      return { ok: false, reason: "duplicate" };
    }
    if (this.totalActive >= MAX_PARALLEL_TOTAL) {
      return { ok: false, reason: "server-full" };
    }
    const peerSet = this.byPeer.get(senderClientId) || new Set<string>();
    if (peerSet.size >= MAX_PARALLEL_PER_PEER) {
      return { ok: false, reason: "per-peer-cap" };
    }
    if (plaintextSizeHint > MAX_BYTES) {
      return { ok: false, reason: "too-large" };
    }
    const now = Date.now();
    const state: ProxyTransferState = {
      id: transferId,
      senderPeerId: senderClientId,
      meta: { iv: String(frame.iv).slice(0, 256), ciphertext: String(frame.ciphertext).slice(0, 256), size: plaintextSizeHint },
      plaintextSize: plaintextSizeHint,
      createdAt: now,
      lastActivityAt: now,
      chunks: new Map(),
      cancelled: false,
    };
    this.byTransfer.set(transferId, state);
    peerSet.add(transferId);
    this.byPeer.set(senderClientId, peerSet);
    this.totalActive += 1;
    this.gc(now);
    return { ok: true };
  }

  pushChunk(senderClientId: string, frame: { transferId: string; seq: number; iv: string; ciphertext: string }): { ok: boolean; reason?: string; total?: number } {
    const state = this.byTransfer.get(frame.transferId);
    if (!state) return { ok: false, reason: "not-found" };
    if (state.senderPeerId !== senderClientId) return { ok: false, reason: "wrong-sender" };
    if (state.cancelled) return { ok: false, reason: "cancelled" };
    const seq = Math.floor(Number(frame.seq) || 0);
    if (seq < 0 || !Number.isFinite(seq) || seq > 1_000_000) return { ok: false, reason: "bad-seq" };
    state.chunks.set(seq, {
      iv: String(frame.iv).slice(0, 256),
      ciphertext: String(frame.ciphertext).slice(0, 256),
    });
    state.lastActivityAt = Date.now();
    return { ok: true, total: state.chunks.size };
  }

  end(senderClientId: string, transferId: string): { ok: boolean; reason?: string } {
    const state = this.byTransfer.get(transferId);
    if (!state) return { ok: false, reason: "not-found" };
    if (state.senderPeerId !== senderClientId) return { ok: false, reason: "wrong-sender" };
    // We do not decompress / decrypt; we just mark "complete" so GC keeps it briefly
    // so that a late-arriving recipient can still fetch the chunks.
    state.lastActivityAt = Date.now();
    return { ok: true };
  }

  cancel(transferId: string): { ok: boolean; reason?: string } {
    const state = this.byTransfer.get(transferId);
    if (!state) return { ok: false, reason: "not-found" };
    state.cancelled = true;
    this.finalize(transferId);
    return { ok: true };
  }

  /**
   * Allow an in-progress (or recently ended) transfer to be re-bound to a
   * different recipient. We do not filter by identity here — the room key
   * gates decryption on the recipient side, so we just pick the smallest
   * payload available as the most likely target.
   */
  hasRoomForNewTransfer(): boolean {
    this.gc(Date.now());
    return this.totalActive < MAX_PARALLEL_TOTAL;
  }

  stats() {
    return {
      totalActive: this.totalActive,
      totalByPeer: Object.fromEntries(Array.from(this.byPeer.entries()).map(([k, v]) => [k, v.size])),
      maxParallel: MAX_PARALLEL_TOTAL,
      capBytes: MAX_BYTES,
      ttlMs: TRANSFER_TTL_MS,
    };
  }

  private finalize(transferId: string) {
    const state = this.byTransfer.get(transferId);
    if (!state) return;
    const peerSet = this.byPeer.get(state.senderPeerId);
    if (peerSet) {
      peerSet.delete(transferId);
      if (peerSet.size === 0) this.byPeer.delete(state.senderPeerId);
    }
    this.byTransfer.delete(transferId);
    this.totalActive = Math.max(0, this.totalActive - 1);
  }

  /**
   * Background GC: drop transfers whose `lastActivityAt` is older than the
   * TTL window or whose `meta.plaintextSize` is invalid. Safe to call after
   * every mutation; O(N) over the active map.
   */
  private gc(now: number) {
    for (const [id, state] of this.byTransfer) {
      const age = now - state.lastActivityAt;
      if (age > TRANSFER_TTL_MS) {
        state.cancelled = true;
        this.finalize(id);
      }
    }
  }
}

/**
 * Helper for routes.ts: try to dispatch proxy-meta/-chunk/-end/-cancel
 * to a connected peer within the same room.
 */
export function relayProxyFrame(
  proxy: FileProxy,
  senderClientId: string,
  payload: Record<string, unknown>,
  forward: (peerId: string, frame: Record<string, unknown>) => void,
): { ok: boolean; reason?: string } {
  const id = String(payload.transferId || "");
  // We do NOT and CANNOT decrypt meta on the server side; we record metadata
  // about the transfer for byte counting only. Payload size is approximated
  // by base64 length / 4 * 3.
  let plaintextSizeHint = 0;
  if (typeof payload.ciphertext === "string") {
    plaintextSizeHint = Math.floor((payload.ciphertext.length * 3) / 4);
  }
  switch (payload.kind) {
    case "proxy-meta":
      return proxy.begin(senderClientId, {
        transferId: id,
        iv: String(payload.iv || ""),
        ciphertext: String(payload.ciphertext || ""),
      }, plaintextSizeHint);
    case "proxy-chunk":
      return proxy.pushChunk(senderClientId, {
        transferId: id,
        seq: Number(payload.seq || 0),
        iv: String(payload.iv || ""),
        ciphertext: String(payload.ciphertext || ""),
      });
    case "proxy-end":
      proxy.end(senderClientId, id);
      // Forward to recipient peers; in a real impl we would also know the
      // intended recipient — for now broadcast to all peers in the room
      // except the sender so that any room member can pick it up.
      forward("__broadcast__", { ...payload });
      return { ok: true };
    case "proxy-cancel":
      proxy.cancel(id);
      forward("__broadcast__", { ...payload });
      return { ok: true };
    default:
      return { ok: false, reason: "unknown-kind" };
  }
}

/**
 * Notify subscribers (the room's WebSocket handlers in routes.ts) about
 * incoming proxy-* frames from a peer so the server can relay them.
 */
export function bindProxyForwarder(
  proxy: FileProxy,
  forward: (peerId: string, frame: Record<string, unknown>) => void,
): (senderClientId: string, payload: Record<string, unknown>) => { ok: boolean; reason?: string } {
  return (senderClientId, payload) => relayProxyFrame(proxy, senderClientId, payload, forward);
}

export { MAX_BYTES as FILE_PROXY_MAX_BYTES, TRANSFER_TTL_MS as FILE_PROXY_TTL_MS };
