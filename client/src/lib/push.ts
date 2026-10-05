// Web push subscription helper. Server returns a VAPID public key from
// /api/push/status when configured; otherwise we expose disabled state.
//
// Public methods:
//   fetchPushStatus()       — GET /api/push/status
//   ensureServiceWorker()   — register /sw.js
//   subscribeToPush(key)    — full register + subscribe + POST to server
//   sendTestPush()          — POST /api/push/test { id } — a real push to THIS
//                             device's own subscription (id from subscribe,
//                             localStorage "m5cet:push:id"); broadcasting to
//                             all subscribers is operator-only (admin token)
//   showLocalTestNotification() — bypasses push service, useful for QA
//
// 6.13: the reasons are in the caller's language (push.err.* — Czech when
// none is given, as before).

import { t, tf, type Lang } from "./i18n";

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
  lang: Lang = "cs",
): Promise<{ ok: boolean; reason?: string; id?: string }> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return { ok: false, reason: t(lang, "push.err.noApi") };
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return { ok: false, reason: t(lang, "push.err.noPushManager") };
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, reason: t(lang, "push.err.denied") };
  }

  const registration = await ensureServiceWorker();
  if (!registration) return { ok: false, reason: t(lang, "push.err.sw") };

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
    if (!res.ok) return { ok: false, reason: t(lang, "push.err.refused") };
    const json = (await res.json().catch(() => ({}))) as { id?: string };
    if (json.id) {
      try { localStorage.setItem(SUBSCRIPTION_ID_KEY, json.id); } catch { /* ignore */ }
    }
    return { ok: true, id: json.id };
  } catch (err) {
    return { ok: false, reason: (err as Error).message || t(lang, "push.err.subscribe") };
  }
}

export async function sendTestPush(lang: Lang = "cs"): Promise<{ ok: boolean; reason?: string }> {
  let id: string | null = null;
  try { id = localStorage.getItem(SUBSCRIPTION_ID_KEY); } catch { /* ignore */ }
  // The test only ever targets this device's own subscription; without one
  // there is nothing to test (and the server refuses id-less requests).
  if (!id) return { ok: false, reason: t(lang, "push.err.noSubscription") };
  try {
    const res = await fetch("/api/push/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (res.status === 404) {
      // Subscriptions live in server memory: after a restart the id is gone.
      try { localStorage.removeItem(SUBSCRIPTION_ID_KEY); } catch { /* ignore */ }
      return { ok: false, reason: t(lang, "push.err.unknownSubscription") };
    }
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      return { ok: false, reason: json.message || json.error || tf(lang, "push.err.status", { status: res.status }) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

// Local-only notification (no push service). Useful when VAPID is not
// configured but we still want to verify SW + permissions + click handler.
export async function showLocalTestNotification(lang: Lang = "cs"): Promise<{ ok: boolean; reason?: string }> {
  if (!("Notification" in window)) return { ok: false, reason: t(lang, "push.err.noApi") };
  if (Notification.permission !== "granted") {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return { ok: false, reason: t(lang, "push.err.denied") };
  }
  try {
    const reg = await ensureServiceWorker();
    if (reg && reg.active) {
      reg.active.postMessage({
        type: "show-test-notification",
        title: "M5cet · test",
        body: t(lang, "push.test.bodySw"),
      });
      return { ok: true };
    }
    new Notification("M5cet · test", { body: t(lang, "push.test.bodyNoSw") });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
