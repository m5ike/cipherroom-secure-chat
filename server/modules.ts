// Module manifest publikovaný na /api/modules.
// Frontend (window.CipherRoomAPI) z něj zjišťuje, které volitelné featury
// operátor povolil, bez odhalení tajemství.

export type ModuleManifest = {
  modes: { id: string; label: string; description: string }[];
  features: Record<string, { enabled: boolean; reason?: string; details?: string }>;
  push: {
    enabled: boolean;
    vapidPublicKey: string | null;
    deliveryImplemented: boolean;
  };
  events: {
    enabled: boolean;
    backend: "disabled" | "memory" | "database";
  };
  limits: {
    maxPeersPerRoom: number;
    frameBudgetPerSec: number;
    maxAttachmentBytes: number;
  };
};

export function buildModuleManifest(
  eventsBackend: "disabled" | "memory" | "database",
): ModuleManifest {
  const vapidPublic = process.env.VAPID_PUBLIC_KEY?.trim() || "";
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY?.trim() || "";
  const pushReady = vapidPublic.length > 0 && vapidPrivate.length > 0;
  const maxAttachmentBytes = Number(process.env.MAX_ATTACHMENT_BYTES || 2 * 1024 ** 3); // 2 GB default

  return {
    modes: [
      {
        id: "light",
        label: "Light · P2P",
        description: "Pure WebRTC P2P. Server only forwards signaling frames.",
      },
      {
        id: "server",
        label: "Server-enhanced",
        description: "Adds optional event metadata logging and push metadata.",
      },
    ],
    features: {
      audio: {
        enabled: true,
        reason: "WebRTC audio uses the existing peer connection.",
      },
      attachments: {
        enabled: true,
        reason: "Files up to manifest.limits.maxAttachmentBytes travel encrypted via the DataChannel (chunked, no server).",
        details: "Server acts only as signaling router; ciphertext never leaves the browser.",
      },
      emoji: { enabled: true },
      linkify: { enabled: true },
      preferences: {
        enabled: true,
        reason: "Stored only in this browser's localStorage.",
      },
      autoReconnect: {
        enabled: true,
        reason: "WebSocket signaling re-establishes automatically on transient drops.",
      },
      push: pushReady
        ? { enabled: true, reason: "VAPID ready. Subscribe endpoint accepts registrations, but delivery worker is not part of this codebase." }
        : { enabled: false, reason: "Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to enable push." },
      eventLogging: {
        enabled: eventsBackend !== "disabled",
        reason:
          eventsBackend === "database"
            ? "Events persist via SQLite (DATABASE_URL=sqlite:./path)."
            : eventsBackend === "memory"
              ? "Events live in-memory only (no SQLite backend, no DATABASE_URL)."
              : "Set LOG_EVENTS=1 to enable.",
      },
    },
    push: {
      enabled: pushReady,
      vapidPublicKey: pushReady ? vapidPublic : null,
      // První verze push delivery workeru NENÍ součástí tohoto kódu.
      // Pravda = lze uložit subscription, ale doručení push vyžaduje extra service.
      deliveryImplemented: false,
    },
    events: {
      enabled: eventsBackend !== "disabled",
      backend: eventsBackend,
    },
    limits: {
      maxPeersPerRoom: Number(process.env.MAX_PEERS_PER_ROOM || 16),
      frameBudgetPerSec: Number(process.env.FRAME_BUDGET_PER_SEC || 20),
      maxAttachmentBytes,
    },
  };
}
