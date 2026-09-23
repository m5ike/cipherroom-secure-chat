// Runtime WebRTC configuration: a public STUN server plus whatever TURN the
// operator advertises via /api/turn. With TURN_SECRET the server hands out
// credentials that expire (server/turn.ts); they are fetched again before a
// new peer connection is made once they are close to running out.

const DEFAULT_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  iceTransportPolicy: "all",
};

/** Kept for code that reads the current value directly. */
export let RTC_CONFIG: RTCConfiguration = DEFAULT_CONFIG;
let expiresAt = 0;
let inFlight: Promise<void> | null = null;

/** Refetch this long before the credentials expire. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export async function loadTurnConfig(fetcher: typeof fetch = fetch): Promise<void> {
  try {
    const res = await fetcher("/api/turn", { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json()) as { iceServers?: RTCIceServer[]; expiresAt?: number } | null;
    if (json?.iceServers && json.iceServers.length > 0) {
      RTC_CONFIG = { iceServers: json.iceServers, iceTransportPolicy: "all" };
      expiresAt = typeof json.expiresAt === "number" ? json.expiresAt : 0;
    }
  } catch {
    // leave what we have
  }
}

/** The configuration to build a peer connection with, refreshed first if
 *  its TURN credentials are about to expire. */
export async function freshRtcConfig(now = Date.now(), fetcher: typeof fetch = fetch): Promise<RTCConfiguration> {
  if (expiresAt && now > expiresAt - REFRESH_MARGIN_MS) {
    inFlight ??= loadTurnConfig(fetcher).finally(() => { inFlight = null; });
    await inFlight;
  }
  return RTC_CONFIG;
}

/** Test seam. */
export function _resetRtcForTests(): void {
  RTC_CONFIG = DEFAULT_CONFIG;
  expiresAt = 0;
  inFlight = null;
}

// Kick off the TURN fetch early; consumers can await this promise before
// creating peer connections.
export const turnConfigPromise = typeof window !== "undefined" ? loadTurnConfig() : Promise.resolve();
