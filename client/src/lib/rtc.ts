// Runtime WebRTC configuration: whatever STUN / TURN the operator advertises
// via /api/turn. With TURN_SECRET the server hands out credentials that
// expire (server/turn.ts); they are fetched again before a new peer
// connection is made once they are close to running out.
//
// 6.12 (F-15):
//  * The server's own ICE servers come first — its STUN (STUN_URLS) and TURN.
//    The public STUN below is only the fallback for a server that offers
//    none (or cannot be asked): nothing changes for deployments without TURN.
//  * "Hide my IP address from other members" (Preferences › hideIp) makes
//    every peer connection relay-only (iceTransportPolicy "relay") when the
//    server offers TURN: peers then see the TURN server's address, not this
//    device's. Calls and file transfers then work only through TURN; without
//    TURN on the server the setting cannot hide anything and the connection
//    stays as it was (the settings say so).

const PUBLIC_STUN: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

const DEFAULT_CONFIG: RTCConfiguration = {
  iceServers: PUBLIC_STUN,
  iceTransportPolicy: "all",
};

/** Kept for code that reads the current value directly. */
export let RTC_CONFIG: RTCConfiguration = DEFAULT_CONFIG;
let expiresAt = 0;
let inFlight: Promise<void> | null = null;
let relayOnly = false;
let turnOffered = false;

/** Refetch this long before the credentials expire. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Does this list hold a TURN server (turn: / turns:)? */
export function hasTurn(servers: readonly RTCIceServer[] | undefined): boolean {
  return Boolean(servers?.some((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => /^turns?:/i.test(String(u)))));
}

export async function loadTurnConfig(fetcher: typeof fetch = fetch): Promise<void> {
  try {
    const res = await fetcher("/api/turn", { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json()) as { iceServers?: RTCIceServer[]; expiresAt?: number } | null;
    if (json?.iceServers && json.iceServers.length > 0) {
      // The server's own list replaces the public fallback.
      RTC_CONFIG = { iceServers: json.iceServers, iceTransportPolicy: "all" };
      turnOffered = hasTurn(json.iceServers);
      expiresAt = typeof json.expiresAt === "number" ? json.expiresAt : 0;
    }
  } catch {
    // leave what we have
  }
}

/** 6.12 (F-15): the user's "Hide my IP address" — relay-only connections where the server offers TURN. */
export function setHideIp(on: boolean): void {
  relayOnly = on;
}

/** Can "Hide my IP address" work here (the server offered a TURN server)? */
export function turnAvailable(): boolean {
  return turnOffered;
}

/** The configuration as it is used: relay-only when the user asked for it and TURN exists. */
export function effectiveRtcConfig(): RTCConfiguration {
  return relayOnly && turnOffered ? { ...RTC_CONFIG, iceTransportPolicy: "relay" } : RTC_CONFIG;
}

/** The configuration to build a peer connection with, refreshed first if
 *  its TURN credentials are about to expire. */
export async function freshRtcConfig(now = Date.now(), fetcher: typeof fetch = fetch): Promise<RTCConfiguration> {
  if (expiresAt && now > expiresAt - REFRESH_MARGIN_MS) {
    inFlight ??= loadTurnConfig(fetcher).finally(() => { inFlight = null; });
    await inFlight;
  }
  return effectiveRtcConfig();
}

/** Test seam. */
export function _resetRtcForTests(): void {
  RTC_CONFIG = DEFAULT_CONFIG;
  expiresAt = 0;
  inFlight = null;
  relayOnly = false;
  turnOffered = false;
}

// Kick off the TURN fetch early; consumers can await this promise before
// creating peer connections.
export const turnConfigPromise = typeof window !== "undefined" ? loadTurnConfig() : Promise.resolve();
