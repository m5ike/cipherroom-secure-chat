// CipherRoom service worker — minimal, no caching.
// We only register so push notifications can be delivered when the
// VAPID keys are configured server-side. Message contents never reach
// the worker; payloads are opaque metadata only.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = { title: "CipherRoom", body: "Nová aktivita v místnosti." };
  try {
    if (event.data) {
      const parsed = event.data.json();
      if (parsed && typeof parsed === "object") {
        data = { ...data, ...parsed };
      }
    }
  } catch (_err) {
    // ignore — fall back to defaults
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/favicon.ico",
      tag: "cipherroom",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window" }).then((clients) => {
    if (clients.length > 0) return clients[0].focus();
    if (self.clients.openWindow) return self.clients.openWindow("/");
    return undefined;
  }));
});
