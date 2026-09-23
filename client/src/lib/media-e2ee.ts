// The page side of call-frame encryption (media-frames.ts): one worker for
// every peer connection, RTCRtpScriptTransform on each sender and receiver,
// keys handed over once a peer's signed hello produced the pair keys.
//
// Browsers without RTCRtpScriptTransform keep DTLS-SRTP only; peers that
// did not announce "media" in their hello never get sealed frames.

import { emptyStats, type MediaKind, type MediaStats } from "./media-frames";

type ScriptTransformCtor = new (worker: Worker, options: unknown) => unknown;

export function mediaE2eeSupported(): boolean {
  return typeof window !== "undefined" && typeof (window as unknown as { RTCRtpScriptTransform?: unknown }).RTCRtpScriptTransform === "function" && typeof Worker === "function";
}

export class MediaE2ee {
  private worker: Worker | null = null;
  private stats: Record<string, MediaStats> = {};
  private recent: Record<string, MediaStats> = {};
  private listeners = new Set<(stats: Record<string, MediaStats>) => void>();
  private readonly keyed = new Set<string>();

  readonly supported = mediaE2eeSupported();

  private ensure(): Worker | null {
    if (!this.supported) return null;
    if (this.worker) return this.worker;
    try {
      this.worker = new Worker(new URL("./media-e2ee.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (event: MessageEvent<{ type: string; total?: Record<string, MediaStats>; recent?: Record<string, MediaStats> }>) => {
        if (event.data?.type !== "stats" || !event.data.total) return;
        this.stats = event.data.total;
        this.recent = event.data.recent ?? {};
        for (const l of this.listeners) l(this.stats);
      };
    } catch {
      this.worker = null;
    }
    return this.worker;
  }

  private attach(target: RTCRtpSender | RTCRtpReceiver, operation: "encrypt" | "decrypt", peerId: string, kind: string): boolean {
    const slot = target as unknown as { transform: unknown };
    if (slot.transform) return true;
    const worker = this.ensure();
    if (!worker || (kind !== "audio" && kind !== "video")) return false;
    const Ctor = (window as unknown as { RTCRtpScriptTransform: ScriptTransformCtor }).RTCRtpScriptTransform;
    try {
      slot.transform = new Ctor(worker, { operation, peerId, kind: kind as MediaKind });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Both directions of a transceiver, at once and as early as possible —
   * when our track is added, or when the peer's first arrives. Chrome
   * ignores a transform set on the other direction of a transceiver whose
   * first transform is already running, so "sender now, receiver later"
   * would leave one direction unsealed.
   */
  protectTransceiver(transceiver: RTCRtpTransceiver, peerId: string): boolean {
    const kind = transceiver.receiver.track.kind;
    const out = this.attach(transceiver.sender, "encrypt", peerId, kind);
    const inn = this.attach(transceiver.receiver, "decrypt", peerId, kind);
    return out && inn;
  }

  /** The transceiver a sender belongs to (after addTrack). */
  protectSender(pc: RTCPeerConnection, sender: RTCRtpSender, peerId: string): boolean {
    const transceiver = pc.getTransceivers().find((t) => t.sender === sender);
    return transceiver ? this.protectTransceiver(transceiver, peerId) : false;
  }

  setKeys(peerId: string, send: CryptoKey, recv: CryptoKey): void {
    const worker = this.ensure();
    if (!worker) return;
    worker.postMessage({ type: "keys", peerId, send, recv });
    this.keyed.add(peerId);
  }

  forget(peerId: string): void {
    this.worker?.postMessage({ type: "forget", peerId });
    this.keyed.delete(peerId);
    delete this.stats[peerId];
    delete this.recent[peerId];
  }

  hasKeys(peerId: string): boolean { return this.keyed.has(peerId); }

  statsFor(peerId: string): MediaStats { return this.stats[peerId] ?? emptyStats(); }
  recentFor(peerId: string): MediaStats { return this.recent[peerId] ?? emptyStats(); }

  /** Over the last second — "e2ee": every frame both ways sealed and opened;
   *  "partial": some frames were not; "off": no sealed frames. */
  stateFor(peerId: string): "e2ee" | "partial" | "off" {
    const s = this.recent[peerId] ?? emptyStats();
    if (s.sealed > 0 && s.opened > 0 && s.clearIn === 0 && s.clearOut === 0 && s.failed === 0) return "e2ee";
    return s.sealed > 0 || s.opened > 0 ? "partial" : "off";
  }

  onStats(listener: (stats: Record<string, MediaStats>) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  close(): void {
    this.worker?.terminate();
    this.worker = null;
    this.keyed.clear();
    this.stats = {};
    this.recent = {};
  }
}
