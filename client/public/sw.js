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

self.addEventListener("push", (event) => {
  let data = { title: "M5cet", body: "New activity in your room.", url: "/" };
  try {
    if (event.data) {
      const parsed = event.data.json();
      if (parsed && typeof parsed === "object") {
        // Sanitize push payload so a malicious push service cannot inject
        // arbitrary HTML, excessively long text, or non-http(s) URLs.
        data = {
          title: String(parsed.title || data.title).slice(0, 64),
          body: String(parsed.body || data.body).slice(0, 200),
          url: String(parsed.url || data.url).slice(0, 512),
          tag: parsed.tag ? String(parsed.tag).slice(0, 64) : data.tag,
          requireInteraction: parsed.requireInteraction === true,
        };
        if (!/^https?:\/\//.test(data.url)) data.url = "/";
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
