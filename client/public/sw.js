// CipherRoom service worker — minimal, NO caching.
//
// Prohlížeč může kdykoli znovu načíst app ze serveru (no-store); my držíme
// pouze registraci kvůli push notifikacím (když operátor nastaví VAPID).
//
// Payload push nikdy neobsahuje zprávy — pouze metadata, která operátor
// nastaví svým workerem. Clientí SW tuto hodnotu ověřuje (typ a délka),
// aby push-delivery kompromitace nemohla zobrazit XSS v notifikaci.

const MAX_TITLE_LEN = 64;
const MAX_BODY_LEN = 256;
const MAX_TAG_LEN = 32;
const TAG_REGEX = /[^a-zA-Z0-9._-]/g;

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let title = "CipherRoom";
  let body = "Nová aktivita v místnosti.";
  let tag = "cipherroom";
  let url = "/";

  try {
    if (event.data) {
      const parsed = event.data.json();
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.title === "string") {
          title = parsed.title.slice(0, MAX_TITLE_LEN);
        }
        if (typeof parsed.body === "string") {
          body = parsed.body.slice(0, MAX_BODY_LEN);
        }
        if (typeof parsed.tag === "string") {
          const cleaned = parsed.tag.slice(0, MAX_TAG_LEN).replace(TAG_REGEX, "");
          tag = cleaned || "cipherroom";
        }
        if (typeof parsed.url === "string" && parsed.url.startsWith("/")) {
          url = parsed.url.slice(0, 256);
        }
      }
    }
  } catch (_err) {
    // ignore — fall back to defaults
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/favicon.ico",
      tag,
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window" })
      .then((clients) => {
        for (const client of clients) {
          if ("focus" in client) {
            client.focus();
            return;
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
        return undefined;
      }),
  );
});

// Zachycujeme sync fetch requesty bez response — stránka vždycky komunikuje
// přes WebSocket / DataChannel a žádné HTTP POSTy s citlivými daty.
self.addEventListener("fetch", () => {
  // passthrough — prohlížeč komunikuje se serverem normálně,
  // my nic necachujeme a nic neblokujeme.
});
