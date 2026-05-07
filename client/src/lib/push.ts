// Web push subscription helper. Server returns a VAPID public key from
// /api/push/status when configured; otherwise we expose disabled state.

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

export type PushStatus = {
  enabled: boolean;
  vapidPublicKey: string | null;
  subscribers: number;
};

export async function fetchPushStatus(): Promise<PushStatus | null> {
  try {
    const res = await fetch("/api/push/status", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as PushStatus;
  } catch {
    return null;
  }
}

export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

export async function subscribeToPush(vapidPublicKey: string): Promise<{ ok: boolean; reason?: string }> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return { ok: false, reason: "Notification API není dostupné." };
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return { ok: false, reason: "PushManager není dostupný." };
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, reason: "Oprávnění nebylo uděleno." };
  }

  const registration = await ensureServiceWorker();
  if (!registration) return { ok: false, reason: "Service worker selhal." };

  try {
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription }),
    });
    if (!res.ok) return { ok: false, reason: "Server odmítl subscription." };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message || "Subscribe selhal." };
  }
}
