// Runtime WebRTC configuration. Merges a public STUN server with any TURN
// server credentials configured by the operator and advertised via /api/turn.

export let RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  iceTransportPolicy: "all",
};

export async function loadTurnConfig() {
  try {
    const res = await fetch("/api/turn", { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json()) as { iceServers?: RTCIceServer[] } | null;
    if (json?.iceServers && json.iceServers.length > 0) {
      RTC_CONFIG = { iceServers: json.iceServers, iceTransportPolicy: "all" };
    }
  } catch {
    // leave defaults
  }
}

// Kick off the TURN fetch early; consumers can await this promise before
// creating peer connections.
export const turnConfigPromise = loadTurnConfig();
