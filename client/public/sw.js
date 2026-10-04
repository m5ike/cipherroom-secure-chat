// CipherRoom service worker — minimal, no caching.
// Registers so push notifications can be delivered when VAPID keys are
// configured server-side. Message contents never reach the worker;
// payloads are opaque metadata only (room id, sender id, timestamp).
//
// 6.7: a notification comes with the operator's template (title and body in
// the user's language) and the variables the user's privacy level lets
// through. The worker renders it again with what only this device knows —
// the room's name, which the page tells it (kept in memory, gone when the
// worker stops) — by the same rules as client/src/lib/notify-template.ts.
// It never has a message's content: it cannot decrypt.

// The build this worker came with (the build writes it in; 4.0 version check).
const SW_BUILD = "m5cet-sw:dev";

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

/* ------------------------------------------------------------ templates */

// The room names the page told us: room id (what the server knows) → name.
const ROOM_NAMES = new Map();
const PRIVACY = ["neutral", "sender", "room", "content"];
const VISIBLE = {
  neutral: ["app", "count", "time", "channel"],
  sender: ["app", "count", "time", "channel", "sender"],
  room: ["app", "count", "time", "channel", "sender", "room"],
  content: ["app", "count", "time", "channel", "sender", "room", "preview"],
};
const LIMITS = { app: 40, sender: 64, room: 64, count: 6, time: 16, preview: 200, channel: 16 };
const VARS = Object.keys(LIMITS);

function cleanValue(v, max) {
  if (v === undefined || v === null) return "";
  const one = String(v)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > max ? one.slice(0, Math.max(0, max - 1)).trimEnd() + "…" : one;
}

function visibleVars(vars, privacy) {
  const show = VISIBLE[privacy] || VISIBLE.neutral;
  const out = {};
  for (const k of VARS) out[k] = show.indexOf(k) >= 0 ? cleanValue(vars && vars[k], LIMITS[k]) : "";
  if (out.count && !(Number(out.count) > 1)) out.count = "";
  return out;
}

/** {name}, {name|fallback}, [optional part], \-escapes — see notify-template.ts. */
function renderTpl(template, vars, max) {
  const src = String(template || "").slice(0, 300);
  let out = "";
  let part = null;
  let partOk = true;
  const put = (s) => { if (part !== null) part += s; else out += s; };
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) { put(src[i + 1]); i += 1; continue; }
    if (c === "[") { if (part === null) { part = ""; partOk = true; } else part += "["; continue; }
    if (c === "]") { if (part === null) out += "]"; else { if (partOk) out += part; part = null; } continue; }
    if (c === "{") {
      let j = i + 1;
      let inner = "";
      while (j < src.length && src[j] !== "}") {
        if (src[j] === "\\" && j + 1 < src.length) { inner += "\\" + src[j + 1]; j += 2; continue; }
        inner += src[j];
        j += 1;
      }
      if (j >= src.length) { put(src.slice(i)); break; }
      let bar = -1;
      for (let k = 0; k < inner.length; k += 1) { if (inner[k] === "\\") { k += 1; continue; } if (inner[k] === "|") { bar = k; break; } }
      const name = (bar < 0 ? inner : inner.slice(0, bar)).trim();
      const fallback = bar < 0 ? null : inner.slice(bar + 1).replace(/\\(.)/g, "$1");
      const value = VARS.indexOf(name) >= 0 ? vars[name] || "" : "";
      if (value) put(value);
      else if (fallback !== null) put(fallback);
      else if (part !== null) partOk = false;
      i = j;
      continue;
    }
    put(c);
  }
  if (part !== null && partOk) out += part;
  return cleanValue(out, max || 240);
}

/** A 6.7 payload as this device shows it (title, body, options). */
function notificationOf(p) {
  const privacy = PRIVACY.indexOf(p.privacy) >= 0 ? p.privacy : "neutral";
  const given = Object.assign({}, p.vars || {});
  if ((privacy === "room" || privacy === "content") && p.room && ROOM_NAMES.has(p.room)) given.room = ROOM_NAMES.get(p.room);
  delete given.preview; // a push never has content; the worker cannot decrypt
  const vars = visibleVars(given, privacy);
  const tpl = p.tpl && typeof p.tpl === "object" ? p.tpl : null;
  const title = (tpl && renderTpl(tpl.title, vars, 100)) || cleanValue(p.title, 100) || vars.app || "M5cet";
  const body = (tpl && renderTpl(tpl.body, vars, 240)) || cleanValue(p.body, 240);
  const tag = p.tag ? String(p.tag).slice(0, 64) : "m5cet";
  return {
    title,
    options: {
      body,
      icon: "/icon-192.svg",
      badge: "/icon-192.svg",
      tag,
      renotify: Boolean(p.tag) && p.sound !== false,
      silent: p.sound === false,
      // A silent notification with a vibration pattern is refused (TypeError): vibrate only with sound.
      ...(p.vibrate === false || p.sound === false ? {} : { vibrate: [120, 60, 120] }),
      requireInteraction: p.sticky === true,
      timestamp: typeof p.at === "number" ? p.at : Date.now(),
      data: { url: safeUrl(p.url), kind: String(p.kind || ""), room: p.room ? String(p.room).slice(0, 80) : "" },
    },
  };
}

self.addEventListener("push", (event) => {
  let shown = { title: "M5cet", options: { body: "New activity in your room.", icon: "/icon-192.svg", badge: "/icon-192.svg", tag: "m5cet", data: { url: "/" } } };
  try {
    if (event.data) {
      const parsed = event.data.json();
      if (parsed && typeof parsed === "object" && parsed.v === 1) {
        shown = notificationOf(parsed);
      } else if (parsed && typeof parsed === "object") {
        // Before 6.7 (and the operator's broadcast): sanitize the payload so a
        // push service cannot inject markup, very long text, or a foreign URL.
        shown = {
          title: String(parsed.title || "M5cet").slice(0, 64),
          options: {
            body: parsed.kind === "relay" ? relayText() : String(parsed.body || "New activity in your room.").slice(0, 200),
            icon: "/icon-192.svg",
            badge: "/icon-192.svg",
            tag: parsed.tag ? String(parsed.tag).slice(0, 64) : "m5cet",
            data: { url: safeUrl(parsed.url) },
            requireInteraction: parsed.requireInteraction === true,
          },
        };
      }
    }
  } catch (_err) {
    // ignore — fall back to defaults
  }
  event.waitUntil(self.registration.showNotification(shown.title, shown.options));
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
  if (data.type === "version") {
    // Answer on the port the page handed over (IntegrityCheck).
    const port = event.ports && event.ports[0];
    if (port) port.postMessage({ build: SW_BUILD.replace(/^m5cet-sw:/, "") });
    return;
  }
  if (data.type === "notify-rooms" && data.rooms && typeof data.rooms === "object") {
    // 6.7: the names of the rooms this page is in, so a notification can name
    // the room (at the "room" privacy level) — memory only.
    for (const [id, name] of Object.entries(data.rooms)) {
      if (typeof id !== "string" || id.length > 80) continue;
      if (typeof name === "string" && name) ROOM_NAMES.set(id, cleanValue(name, 64));
      else ROOM_NAMES.delete(id);
    }
    while (ROOM_NAMES.size > 200) ROOM_NAMES.delete(ROOM_NAMES.keys().next().value);
    return;
  }
  if (data.type === "notify-forget") {
    ROOM_NAMES.clear();
    return;
  }
  if (data.type === "show-test-notification") {
    self.registration.showNotification(String(data.title || "M5cet test").slice(0, 64), {
      body: String(data.body || "Local test notification").slice(0, 200),
      icon: "/icon-192.svg",
      tag: "m5cet-test",
      data: { url: "/" },
    });
  }
});
