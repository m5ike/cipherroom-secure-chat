// Module manifest published at /api/modules.
// Lets the frontend (window.CipherRoomAPI) discover which optional features
// the operator has enabled without exposing secrets.

export type ModuleManifest = {
  modes: { id: string; label: string; description: string }[];
  features: Record<string, { enabled: boolean; reason?: string }>;
  push: {
    enabled: boolean;
    vapidPublicKey: string | null;
  };
  events: {
    enabled: boolean;
    backend: "disabled" | "memory" | "database";
  };
};

export function buildModuleManifest(eventsBackend: "disabled" | "memory" | "database"): ModuleManifest {
  const vapidPublic = process.env.VAPID_PUBLIC_KEY?.trim() || "";
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY?.trim() || "";
  const pushReady = vapidPublic.length > 0 && vapidPrivate.length > 0;

  return {
    modes: [
      {
        id: "light",
        label: "Light / P2P",
        description: "Pure WebRTC P2P. Server only forwards signaling frames.",
      },
      {
        id: "server",
        label: "Server-enhanced",
        description: "Adds optional event metadata logging and push delivery.",
      },
    ],
    features: {
      audio: { enabled: true, reason: "WebRTC audio uses the existing peer connection (DTLS-SRTP)." },
      video: { enabled: true, reason: "WebRTC video uses the existing peer connection (DTLS-SRTP)." },
      attachments: { enabled: true, reason: "Inline data-URL up to 512 kB; chunked AES-GCM transfer for larger files." },
      chunkedFiles: { enabled: true, reason: "Files split into 32 KiB AES-GCM chunks over DataChannel; per-user max configurable." },
      emoji: { enabled: true },
      linkify: { enabled: true },
      preferences: { enabled: true, reason: "Stored only in this browser's localStorage." },
      connectionKeeper: { enabled: true, reason: "Configurable heartbeat strategy + reconnect with exponential backoff." },
      adminCommands: { enabled: true, reason: "Allowlisted admin → client commands delivered over signaling channel." },
      maps: { enabled: true, reason: "OpenStreetMap link sharing and continuous geolocation; no Leaflet bundle." },
      nfc: { enabled: true, reason: "Web NFC read/write encrypted with PBKDF2/AES-GCM. Android Chrome only." },
      speech: { enabled: true, reason: "Browser Web Speech API for TTS/STT and pitch-based revoice." },
      push: pushReady
        ? { enabled: true }
        : { enabled: false, reason: "Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to enable push." },
      eventLogging: {
        enabled: eventsBackend !== "disabled",
        reason:
          eventsBackend === "database"
            ? "Events go to the configured DATABASE_URL backend."
            : eventsBackend === "memory"
              ? "Events live in-memory only (no DATABASE_URL configured)."
              : "Set LOG_EVENTS=1 to enable.",
      },
    },
    push: {
      enabled: pushReady,
      vapidPublicKey: pushReady ? vapidPublic : null,
    },
    events: {
      enabled: eventsBackend !== "disabled",
      backend: eventsBackend,
    },
  };
}
