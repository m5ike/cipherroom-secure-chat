// Web push subscription helper. Server returns a VAPID public key from
// /api/push/status when configured; otherwise we expose disabled state.
//
// Public methods:
//   fetchPushStatus()       — GET /api/push/status
//   ensureServiceWorker()   — register /sw.js
//   subscribeToPush(key)    — full register + subscribe + POST to server
//   sendTestPush(id?)       — POST /api/push/test (real push if VAPID ok)
//   showLocalTestNotification() — bypasses push service, useful for QA

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

const SUBSCRIPTION_ID_KEY = "m5cet:push:id";

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

export async function subscribeToPush(
  vapidPublicKey: string,
  deviceId?: string,
): Promise<{ ok: boolean; reason?: string; id?: string }> {
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
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
    }
    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription, deviceId }),
    });
    if (!res.ok) return { ok: false, reason: "Server odmítl subscription." };
    const json = (await res.json().catch(() => ({}))) as { id?: string };
    if (json.id) {
      try { localStorage.setItem(SUBSCRIPTION_ID_KEY, json.id); } catch { /* ignore */ }
    }
    return { ok: true, id: json.id };
  } catch (err) {
    return { ok: false, reason: (err as Error).message || "Subscribe selhal." };
  }
}

export async function sendTestPush(): Promise<{ ok: boolean; reason?: string }> {
  let id: string | null = null;
  try { id = localStorage.getItem(SUBSCRIPTION_ID_KEY); } catch { /* ignore */ }
  try {
    const res = await fetch("/api/push/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, title: "M5cet · test", body: "Push delivery test" }),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { message?: string };
      return { ok: false, reason: json.message || `Server vrátil ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

// Local-only notification (no push service). Useful when VAPID is not
// configured but we still want to verify SW + permissions + click handler.
export async function showLocalTestNotification(): Promise<{ ok: boolean; reason?: string }> {
  if (!("Notification" in window)) return { ok: false, reason: "Notification API neexistuje." };
  if (Notification.permission !== "granted") {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return { ok: false, reason: "Oprávnění nebylo uděleno." };
  }
  try {
    const reg = await ensureServiceWorker();
    if (reg && reg.active) {
      reg.active.postMessage({
        type: "show-test-notification",
        title: "M5cet · test",
        body: "Local notification – service worker ok.",
      });
      return { ok: true };
    }
    new Notification("M5cet · test", { body: "Local notification (no SW)." });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
