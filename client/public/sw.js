// CipherRoom service worker — minimal, no caching.
// Registers so push notifications can be delivered when VAPID keys are
// configured server-side. Message contents never reach the worker;
// payloads are opaque metadata only (room id, sender id, timestamp).

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// A relay wake-up carries no name and no room (it shows on a locked
// screen); it is worded here, in the device's language.
const RELAY_TEXT = {
  cs: "Máte novou zprávu. Otevřete M5cet a přihlaste se.",
  de: "Sie haben eine neue Nachricht. Öffnen Sie M5cet und melden Sie sich an.",
  en: "You have a new message. Open M5cet and sign in.",
};

function relayText() {
  const lang = String((self.navigator && self.navigator.language) || "en").slice(0, 2).toLowerCase();
  return RELAY_TEXT[lang] || RELAY_TEXT.en;
}

/** Same-origin path ("/signin") or an http(s) URL of this site; anything else → "/". */
function safeUrl(value) {
  const url = String(value || "/").slice(0, 512);
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  try {
    const parsed = new URL(url);
    if (parsed.origin === self.location.origin) return parsed.pathname + parsed.search;
  } catch (_err) { /* not a URL */ }
  return "/";
}

self.addEventListener("push", (event) => {
  let data = { title: "M5cet", body: "New activity in your room.", url: "/" };
  try {
    if (event.data) {
      const parsed = event.data.json();
      if (parsed && typeof parsed === "object") {
        // Sanitize push payload so a malicious push service cannot inject
        // arbitrary HTML, excessively long text, or a foreign URL.
        data = {
          title: String(parsed.title || data.title).slice(0, 64),
          body: parsed.kind === "relay" ? relayText() : String(parsed.body || data.body).slice(0, 200),
          url: safeUrl(parsed.url),
          tag: parsed.tag ? String(parsed.tag).slice(0, 64) : data.tag,
          requireInteraction: parsed.requireInteraction === true,
        };
      }
    }
  } catch (_err) {
    // ignore — fall back to defaults
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.svg",
      badge: "/icon-192.svg",
      tag: data.tag || "m5cet",
      data: { url: data.url || "/" },
      requireInteraction: !!data.requireInteraction,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      try {
        if ("focus" in c) {
          await c.focus();
          if ("navigate" in c && target && target !== "/") await c.navigate(target);
          return;
        }
      } catch (_e) { /* ignore */ }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

// Allow page → SW message exchange (used by the push test button to verify
// the worker is alive without going through the push service).
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "show-test-notification") {
    self.registration.showNotification(String(data.title || "M5cet test").slice(0, 64), {
      body: String(data.body || "Local test notification").slice(0, 200),
      icon: "/icon-192.svg",
      tag: "m5cet-test",
      data: { url: "/" },
    });
  }
});
