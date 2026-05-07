// Server-side Web Push wrapper. Loads `web-push` lazily so the server still
// boots when the package is missing. When VAPID keys are configured, real
// push notifications are delivered to subscribed endpoints.

type StoredSubscription = {
  endpoint: string;
  keys?: { p256dh?: string; auth?: string };
};

type WebPushModule = {
  setVapidDetails: (subject: string, pub: string, priv: string) => void;
  sendNotification: (
    sub: { endpoint: string; keys?: { p256dh?: string; auth?: string } },
    payload: string,
  ) => Promise<unknown>;
};

let webpush: WebPushModule | null = null;
let initialized = false;

async function loadWebPush(): Promise<WebPushModule | null> {
  if (initialized) return webpush;
  initialized = true;
  try {
    const mod = (await import("web-push")) as unknown as { default?: WebPushModule } & WebPushModule;
    webpush = (mod.default as WebPushModule) || (mod as WebPushModule);
  } catch {
    webpush = null;
    return null;
  }
  const pub = process.env.VAPID_PUBLIC_KEY?.trim();
  const priv = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim() || "mailto:admin@example.org";
  if (pub && priv && webpush) {
    try { webpush.setVapidDetails(subject, pub, priv); } catch { /* ignore */ }
  }
  return webpush;
}

export function isWebPushReady(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY?.trim() && process.env.VAPID_PRIVATE_KEY?.trim());
}

export async function sendWebPush(
  sub: StoredSubscription,
  payload: { title?: string; body?: string; tag?: string; url?: string; requireInteraction?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  if (!isWebPushReady()) return { ok: false, error: "VAPID keys not configured" };
  const wp = await loadWebPush();
  if (!wp) return { ok: false, error: "web-push module unavailable" };
  if (!sub.keys?.p256dh || !sub.keys?.auth) {
    return { ok: false, error: "subscription missing keys (older subscribe)" };
  }
  try {
    await wp.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
      JSON.stringify(payload),
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message || String(err) };
  }
}
