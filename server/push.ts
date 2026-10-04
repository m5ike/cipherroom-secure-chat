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
    options?: WebPushOptions,
  ) => Promise<unknown>;
};

/** What web-push takes besides the payload (RFC 8030: TTL, Urgency, Topic). */
export type WebPushOptions = { TTL?: number; urgency?: "very-low" | "low" | "normal" | "high"; topic?: string; timeout?: number };

let webpush: WebPushModule | null = null;
let initialized = false;

/** Tests: replace the web-push module (null: load the real one again). */
export function setWebPushModule(mod: WebPushModule | null): void {
  webpush = mod;
  initialized = mod !== null;
}

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

/** The outcome of one push. `status` is the push service's HTTP answer when
 *  it gave one; `gone` means the subscription is dead for good (404 / 410,
 *  RFC 8030 §7.3) and should be forgotten. */
export type WebPushResult = { ok: boolean; error?: string; status?: number; gone?: boolean };

export async function sendWebPush(
  sub: StoredSubscription,
  payload: Record<string, unknown> & { title?: string; body?: string; tag?: string; url?: string; requireInteraction?: boolean; kind?: string },
  options?: WebPushOptions,
): Promise<WebPushResult> {
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
      ...(options ? [options] : []),
    );
    return { ok: true };
  } catch (err) {
    // web-push's WebPushError says only "Received unexpected response code";
    // the status is on the error object (6.7: it used to be looked for in the
    // message, which never matched — dead subscriptions were never pruned).
    const status = Number((err as { statusCode?: unknown }).statusCode);
    const code = Number.isFinite(status) && status > 0 ? status : undefined;
    const message = (err as Error).message || String(err);
    return { ok: false, error: code ? `${code}: ${message}` : message, ...(code ? { status: code } : {}), gone: code === 404 || code === 410 };
  }
}
