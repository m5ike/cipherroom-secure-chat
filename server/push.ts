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

/**
 * Push services a browser can hand us an endpoint of. The server POSTs to
 * whatever endpoint it is given, so without this list anyone who can
 * register a subscription could make it send requests into its own network
 * (https://10.0.0.5/admin…). PUSH_ENDPOINT_HOSTS adds hosts (comma-separated;
 * a leading dot allows subdomains) for self-hosted push services.
 */
const PUSH_HOSTS = [
  "fcm.googleapis.com", "android.googleapis.com",          // Chrome, Edge (Android), Opera, Samsung
  ".push.services.mozilla.com",                              // Firefox
  ".notify.windows.com",                                     // Edge (Windows)
  "web.push.apple.com", ".push.apple.com",                   // Safari
];

export function isAllowedPushEndpoint(endpoint: unknown): boolean {
  if (typeof endpoint !== "string" || endpoint.length > 1024) return false;
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
  const host = url.hostname.toLowerCase();
  const extra = (process.env.PUSH_ENDPOINT_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return [...PUSH_HOSTS, ...extra].some((allowed) => (allowed.startsWith(".") ? host.endsWith(allowed) : host === allowed));
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
  if (!isAllowedPushEndpoint(sub.endpoint)) return { ok: false, error: "endpoint is not a known push service" };
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
