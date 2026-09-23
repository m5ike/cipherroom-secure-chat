// Small pieces of the chat screen that need no React: room names, pacing a
// relayed transfer, where a peer connection actually goes.

import { Pacer } from "./file-transfer";

export function normalizeRoom(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "secure-room"
  );
}

/** The server's per-socket budget for relayed file chunks (hello.limits.proxy). */
export type ProxyLimits = { bytesPerSec: number; burstBytes: number; framesPerSec: number; burstFrames: number };
export const DEFAULT_PROXY_LIMITS: ProxyLimits = { bytesPerSec: 2 * 1024 * 1024, burstBytes: 8 * 1024 * 1024, framesPerSec: 60, burstFrames: 400 };

/** Paces a relayed transfer at 80 % of the server's budget and keeps the
 *  socket's own send buffer short, so the relay never refuses a chunk. */
export function proxyPacer(limits: ProxyLimits, socket: () => WebSocket | null): (bytes: number) => Promise<void> {
  const pacer = new Pacer(
    { bytesPerSec: limits.bytesPerSec * 0.8, burstBytes: limits.burstBytes / 2, framesPerSec: limits.framesPerSec * 0.8, burstFrames: limits.burstFrames / 2 },
    async () => {
      for (let i = 0; i < 400; i++) {
        const sock = socket();
        if (!sock || sock.readyState !== WebSocket.OPEN || sock.bufferedAmount < 1024 * 1024) return;
        await new Promise((r) => setTimeout(r, 25));
      }
    },
  );
  return (bytes) => pacer.take(bytes);
}

/** Read the in-use ICE candidate pair to learn the peer's remote address and
 *  how media is routed (direct host/reflexive vs TURN relay). Best-effort:
 *  returns null when getStats is blocked or the pair is not yet nominated. */
export async function extractPeerAddress(pc: RTCPeerConnection): Promise<{ ip?: string; candidateType?: string } | null> {
  try {
    const stats = await pc.getStats();
    let pairId: string | null = null;
    const remotes = new Map<string, RTCIceCandidate & { address?: string; ip?: string; candidateType?: string }>();
    stats.forEach((r: { type?: string; state?: string; selected?: boolean; nominated?: boolean; remoteCandidateId?: string; id?: string; address?: string; ip?: string; candidateType?: string }) => {
      if (r.type === "candidate-pair" && (r.selected || r.nominated || r.state === "succeeded")) pairId = r.remoteCandidateId ?? null;
      if (r.type === "remote-candidate" && r.id) remotes.set(r.id, r as never);
    });
    const remote = pairId ? remotes.get(pairId) : undefined;
    if (!remote) return null;
    return { ip: remote.address || remote.ip, candidateType: remote.candidateType };
  } catch {
    return null;
  }
}
