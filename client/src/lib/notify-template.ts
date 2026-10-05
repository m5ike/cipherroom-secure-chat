// Notification templates (6.7). PURE module (no DOM, no Node): the server
// renders a notification with it before it goes out, the web client renders
// its local notifications and the settings' preview with it, and the service
// worker (client/public/sw.js) and the Android app (push/NotifyTemplate.java)
// carry a port of the same few rules.
//
// A template is plain text with
//   {name}         a variable: app, sender, room, count, time, preview, channel
//   {name|text}    the variable, or the text when it is empty / not shown
//   [ … ]          an optional part: dropped when a variable in it is empty
//   \{ \} \[ \] \| \\   the character itself
// Values are put in once and never read as a template again, so a sender
// called "{room}" stays "{room}". Control and bidi characters are taken out
// of every value, and every value has a length limit.
//
// Privacy decides which variables a notification may show at all:
//   neutral   nothing about who or where (app, count, time, channel)
//   sender    + the sender's display name
//   room      + the room — only the device knows its name (the server sees
//               an opaque room id), so the device fills it in
//   content   + a preview of the message — only where the device itself
//               decrypted it; the server never has it and never sends it
//
// 6.13: the templates speak the nine languages of the contract (locales.ts);
// a text a template lacks comes from the language's chain (Slovak → Czech →
// English), so a template saved with three languages still works.

import { isLocale, localeChain, type Locale } from "./locales";

export type NotifyKind = "message" | "mention" | "call" | "function" | "summon" | "test";
export type NotifyChannel = "android" | "webpush" | "email";
export type NotifyPrivacy = "neutral" | "sender" | "room" | "content";
/** 6.13: the nine languages of the contract (locales.ts). */
export type NotifyLang = Locale;
export type NotifyGroup = "room" | "kind" | "none";

export const NOTIFY_KINDS: readonly NotifyKind[] = ["message", "mention", "call", "function", "summon", "test"];
export const NOTIFY_CHANNELS: readonly NotifyChannel[] = ["android", "webpush", "email"];
export const NOTIFY_PRIVACY: readonly NotifyPrivacy[] = ["neutral", "sender", "room", "content"];
export const NOTIFY_LANGS: readonly NotifyLang[] = ["cs", "en", "de", "es", "it", "fr", "sk", "sl", "fi"];
export const NOTIFY_VARS = ["app", "sender", "room", "count", "time", "preview", "channel"] as const;
export type NotifyVar = (typeof NOTIFY_VARS)[number];
export type NotifyVars = Partial<Record<NotifyVar, string | number>>;

/** What each privacy level lets through. */
const VISIBLE: Record<NotifyPrivacy, ReadonlySet<NotifyVar>> = {
  neutral: new Set<NotifyVar>(["app", "count", "time", "channel"]),
  sender: new Set<NotifyVar>(["app", "count", "time", "channel", "sender"]),
  room: new Set<NotifyVar>(["app", "count", "time", "channel", "sender", "room"]),
  content: new Set<NotifyVar>(["app", "count", "time", "channel", "sender", "room", "preview"]),
};

const LIMITS: Record<NotifyVar, number> = { app: 40, sender: 64, room: 64, count: 6, time: 16, preview: 200, channel: 16 };
export const TITLE_MAX = 100;
export const BODY_MAX = 240;
export const TEMPLATE_MAX = 300;

export const privacyRank = (p: NotifyPrivacy): number => NOTIFY_PRIVACY.indexOf(p);
/** The lower of two levels (what a user chose, capped by what the operator allows). */
export const minPrivacy = (a: NotifyPrivacy, b: NotifyPrivacy): NotifyPrivacy => (privacyRank(a) <= privacyRank(b) ? a : b);
export const isPrivacy = (v: unknown): v is NotifyPrivacy => typeof v === "string" && (NOTIFY_PRIVACY as readonly string[]).includes(v);
export const isKind = (v: unknown): v is NotifyKind => typeof v === "string" && (NOTIFY_KINDS as readonly string[]).includes(v);
export const isChannel = (v: unknown): v is NotifyChannel => typeof v === "string" && (NOTIFY_CHANNELS as readonly string[]).includes(v);
export const isLang = (v: unknown): v is NotifyLang => typeof v === "string" && (NOTIFY_LANGS as readonly string[]).includes(v);

// C0/C1 controls, line and paragraph separators, bidi embeddings and isolates, zero-width marks.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const BIDI = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** A value as a notification may show it: one line, no control or bidi characters, bounded. */
export function cleanValue(v: unknown, max: number): string {
  if (v === undefined || v === null) return "";
  const s = String(typeof v === "number" ? (Number.isFinite(v) ? v : "") : v);
  const one = s.replace(UNSAFE, " ").replace(BIDI, "").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, Math.max(0, max - 1)).trimEnd()}…` : one;
}

/** The variables a privacy level shows, cleaned; the rest are empty. */
export function visibleVars(vars: NotifyVars, privacy: NotifyPrivacy): Record<NotifyVar, string> {
  const out = {} as Record<NotifyVar, string>;
  for (const k of NOTIFY_VARS) out[k] = VISIBLE[privacy].has(k) ? cleanValue(vars[k], LIMITS[k]) : "";
  // A count of one says nothing a notification does not already say.
  if (out.count && !(Number(out.count) > 1)) out.count = "";
  return out;
}

type Token = { t: "text"; v: string } | { t: "var"; name: string; fallback: string | null };

function tokenize(src: string): Array<Token | { t: "open" } | { t: "close" }> {
  const out: Array<Token | { t: "open" } | { t: "close" }> = [];
  let text = "";
  const flush = () => { if (text) { out.push({ t: "text", v: text }); text = ""; } };
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) { text += src[i + 1]; i += 1; continue; }
    if (c === "[") { flush(); out.push({ t: "open" }); continue; }
    if (c === "]") { flush(); out.push({ t: "close" }); continue; }
    if (c === "{") {
      let j = i + 1;
      let inner = "";
      while (j < src.length && src[j] !== "}") {
        if (src[j] === "\\" && j + 1 < src.length) { inner += `\\${src[j + 1]}`; j += 2; continue; }
        inner += src[j];
        j += 1;
      }
      if (j >= src.length) { text += src.slice(i); break; } // no closing brace: literal
      flush();
      const bar = findBar(inner);
      const name = (bar < 0 ? inner : inner.slice(0, bar)).trim();
      const fallback = bar < 0 ? null : unescape(inner.slice(bar + 1));
      out.push({ t: "var", name, fallback });
      i = j;
      continue;
    }
    text += c;
  }
  flush();
  return out;
}

function findBar(s: string): number {
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === "\\") { i += 1; continue; }
    if (s[i] === "|") return i;
  }
  return -1;
}

function unescape(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

/**
 * Renders one template. `vars` are already the visible, cleaned values
 * (visibleVars). Unknown variables are empty; an optional part with an
 * empty variable (without a fallback) is dropped whole.
 */
export function renderTemplate(template: string, vars: Record<string, string>, max = BODY_MAX): string {
  const tokens = tokenize(String(template ?? "").slice(0, TEMPLATE_MAX));
  let out = "";
  let part: string | null = null;
  let partOk = true;
  for (const tk of tokens) {
    if (tk.t === "open") { if (part === null) { part = ""; partOk = true; } else part += "["; continue; }
    if (tk.t === "close") {
      if (part === null) { out += "]"; continue; }
      if (partOk) out += part;
      part = null;
      continue;
    }
    let piece: string;
    if (tk.t === "text") piece = tk.v;
    else {
      const value = (NOTIFY_VARS as readonly string[]).includes(tk.name) ? vars[tk.name] ?? "" : "";
      if (value) piece = value;
      else if (tk.fallback !== null) piece = tk.fallback;
      else { piece = ""; if (part !== null) partOk = false; }
    }
    if (part !== null) part += piece;
    else out += piece;
  }
  if (part !== null && partOk) out += part; // an unclosed part counts as closed
  return cleanValue(out, max);
}

/* ------------------------------------------------------------- templates */

export type NotifyTemplate = {
  /** The operator offers this kind at all. */
  on: boolean;
  title: Record<NotifyLang, string>;
  body: Record<NotifyLang, string>;
  /** For users who did not choose. */
  privacy: NotifyPrivacy;
  /** The most a user may choose. */
  maxPrivacy: NotifyPrivacy;
  /** A lucide icon name ("" = the app's). */
  icon: string;
  /** #rrggbb ("" = the app's). */
  accent: string;
  group: NotifyGroup;
  sound: boolean;
  vibrate: boolean;
  /** Stays until it is opened or dismissed (calls). */
  sticky: boolean;
  /** Reply / mark read where the device has them (Android). */
  actions: boolean;
  /** Seconds between two of this kind for one account and room. */
  throttle: number;
};

/** 6.13: cs, en, de, then es, it, fr, sk, sl, fi. */
const T = (cs: string, en: string, de: string, es: string, it: string, fr: string, sk: string, sl: string, fi: string): Record<NotifyLang, string> => ({ cs, en, de, es, it, fr, sk, sl, fi });
const SAME = (v: string): Record<NotifyLang, string> => T(v, v, v, v, v, v, v, v, v);
const ROOM_TITLE = SAME("{app}[ · {room}]");

export const DEFAULT_TEMPLATES: Record<NotifyKind, NotifyTemplate> = {
  message: {
    on: true, title: ROOM_TITLE,
    body: T("[{sender}: ]{preview|Nová zpráva}[ ({count})]", "[{sender}: ]{preview|New message}[ ({count})]", "[{sender}: ]{preview|Neue Nachricht}[ ({count})]",
      "[{sender}: ]{preview|Mensaje nuevo}[ ({count})]", "[{sender}: ]{preview|Nuovo messaggio}[ ({count})]", "[{sender} : ]{preview|Nouveau message}[ ({count})]",
      "[{sender}: ]{preview|Nová správa}[ ({count})]", "[{sender}: ]{preview|Novo sporočilo}[ ({count})]", "[{sender}: ]{preview|Uusi viesti}[ ({count})]"),
    privacy: "neutral", maxPrivacy: "content", icon: "message-square", accent: "", group: "room", sound: true, vibrate: true, sticky: false, actions: true, throttle: 30,
  },
  mention: {
    on: true, title: ROOM_TITLE,
    body: T("[{sender}: ]{preview|Někdo vás zmínil}", "[{sender}: ]{preview|You were mentioned}", "[{sender}: ]{preview|Sie wurden erwähnt}",
      "[{sender}: ]{preview|Te han mencionado}", "[{sender}: ]{preview|Ti hanno menzionato}", "[{sender} : ]{preview|Quelqu’un vous a mentionné}",
      "[{sender}: ]{preview|Niekto vás spomenul}", "[{sender}: ]{preview|Nekdo vas je omenil}", "[{sender}: ]{preview|Sinut mainittiin}"),
    privacy: "sender", maxPrivacy: "content", icon: "at-sign", accent: "", group: "room", sound: true, vibrate: true, sticky: false, actions: true, throttle: 10,
  },
  call: {
    on: true, title: ROOM_TITLE,
    body: T("{sender|Někdo} vám volá", "{sender|Someone} is calling you", "{sender|Jemand} ruft Sie an",
      "{sender|Alguien} te está llamando", "{sender|Qualcuno} ti sta chiamando", "{sender|Quelqu’un} vous appelle",
      "{sender|Niekto} vám volá", "{sender|Nekdo} vas kliče", "{sender|Joku} soittaa"),
    privacy: "sender", maxPrivacy: "room", icon: "phone", accent: "", group: "kind", sound: true, vibrate: true, sticky: true, actions: false, throttle: 5,
  },
  function: {
    on: true, title: SAME("{app}"),
    body: T("Příkaz doběhl[ v {room}]", "A command finished[ in {room}]", "Ein Befehl ist fertig[ in {room}]",
      "Un comando ha terminado[ en {room}]", "Un comando è terminato[ in {room}]", "Une commande est terminée[ dans {room}]",
      "Príkaz dobehol[ v {room}]", "Ukaz je končan[ v {room}]", "Komento valmistui[ huoneessa {room}]"),
    privacy: "neutral", maxPrivacy: "room", icon: "terminal", accent: "", group: "kind", sound: false, vibrate: false, sticky: false, actions: false, throttle: 30,
  },
  summon: {
    on: true, title: SAME("{app}"),
    body: T("Operátor vás volá zpět[ do {room}]", "The operator asks you back[ to {room}]", "Der Betreiber bittet Sie zurück[ in {room}]",
      "El operador te pide que vuelvas[ a {room}]", "L’operatore ti chiede di tornare[ in {room}]", "L’opérateur vous demande de revenir[ dans {room}]",
      "Prevádzkovateľ vás volá späť[ do {room}]", "Upravljavec vas prosi, da se vrnete[ v {room}]", "Ylläpitäjä pyytää palaamaan[ huoneeseen {room}]"),
    privacy: "neutral", maxPrivacy: "room", icon: "bell-ring", accent: "", group: "kind", sound: true, vibrate: true, sticky: false, actions: false, throttle: 30,
  },
  test: {
    on: true, title: T("{app} · test", "{app} · test", "{app} · Test", "{app} · prueba", "{app} · test", "{app} · test", "{app} · test", "{app} · preizkus", "{app} · testi"),
    body: T("Upozornění fungují[ — {channel}]", "Notifications work[ — {channel}]", "Benachrichtigungen funktionieren[ — {channel}]",
      "Las notificaciones funcionan[ — {channel}]", "Le notifiche funzionano[ — {channel}]", "Les notifications fonctionnent[ — {channel}]",
      "Upozornenia fungujú[ — {channel}]", "Obvestila delujejo[ — {channel}]", "Ilmoitukset toimivat[ — {channel}]"),
    privacy: "neutral", maxPrivacy: "content", icon: "bell", accent: "", group: "kind", sound: true, vibrate: true, sticky: false, actions: false, throttle: 0,
  },
};

/**
 * 6.13: a template's text in a language — along its chain (Slovak → Czech →
 * English); an empty text counts as missing. A template saved before 6.13 has
 * three languages, an operator may fill in only some.
 */
export function templateText(texts: Partial<Record<string, string>>, lang: string): string {
  for (const l of localeChain(isLocale(lang) ? lang : "en")) { const v = texts[l]; if (typeof v === "string" && v) return v; }
  return "";
}

/** Title and body of one notification. */
export function renderNotification(tpl: Pick<NotifyTemplate, "title" | "body">, lang: NotifyLang, vars: NotifyVars, privacy: NotifyPrivacy): { title: string; body: string } {
  const v = visibleVars(vars, privacy);
  // 6.13: along the language's chain (Slovak → Czech → English) — a template saved before 6.13 has three languages.
  const pick = (m: Partial<Record<NotifyLang, string>>) => templateText(m, lang);
  const title = renderTemplate(pick(tpl.title), v, TITLE_MAX) || v.app || "M5cet";
  return { title, body: renderTemplate(pick(tpl.body), v, BODY_MAX) };
}

/* ------------------------------------------------------------ user choice */

export type QuietHours = { on: boolean; from: string; to: string; tz: string };

export type UserNotifyPrefs = {
  on: boolean;
  /** Kinds the user switched off are false; missing = on. */
  kinds: Partial<Record<NotifyKind, boolean>>;
  /** "" = the operator's default for each kind. */
  privacy: NotifyPrivacy | "";
  /** The channels in the order to try them. */
  order: NotifyChannel[];
  quiet: QuietHours;
  lang: NotifyLang;
};

export const DEFAULT_USER_PREFS: UserNotifyPrefs = {
  on: true, kinds: {}, privacy: "", order: ["android", "webpush", "email"], quiet: { on: false, from: "22:00", to: "07:00", tz: "" }, lang: "en",
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A user's choice as the server keeps it (anything unknown dropped, bounded). */
export function sanitizeUserPrefs(raw: unknown, base: UserNotifyPrefs = DEFAULT_USER_PREFS): UserNotifyPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kinds: Partial<Record<NotifyKind, boolean>> = { ...base.kinds };
  if (r.kinds && typeof r.kinds === "object") {
    for (const [k, v] of Object.entries(r.kinds as Record<string, unknown>)) if (isKind(k) && typeof v === "boolean") kinds[k] = v;
  }
  let order = base.order;
  if (Array.isArray(r.order)) {
    const seen = new Set<NotifyChannel>();
    for (const c of r.order) if (isChannel(c)) seen.add(c);
    order = [...seen];
  }
  const q = (r.quiet && typeof r.quiet === "object" ? r.quiet : {}) as Record<string, unknown>;
  const tz = typeof q.tz === "string" && /^[A-Za-z0-9_+\-/]{1,64}$/.test(q.tz) ? q.tz : base.quiet.tz;
  return {
    on: typeof r.on === "boolean" ? r.on : base.on,
    kinds,
    privacy: r.privacy === "" ? "" : isPrivacy(r.privacy) ? r.privacy : base.privacy,
    order,
    quiet: {
      on: typeof q.on === "boolean" ? q.on : base.quiet.on,
      from: typeof q.from === "string" && HHMM.test(q.from) ? q.from : base.quiet.from,
      to: typeof q.to === "string" && HHMM.test(q.to) ? q.to : base.quiet.to,
      tz,
    },
    lang: isLang(r.lang) ? r.lang : base.lang,
  };
}

/** The level a notification of `kind` is shown at for this user. */
export function effectivePrivacy(tpl: Pick<NotifyTemplate, "privacy" | "maxPrivacy">, prefs: Pick<UserNotifyPrefs, "privacy">): NotifyPrivacy {
  return minPrivacy(prefs.privacy || tpl.privacy, tpl.maxPrivacy);
}

/** Minutes since midnight in a time zone ("" = the runtime's own). */
export function minutesIn(at: number, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(tz ? { timeZone: tz } : {}) }).formatToParts(new Date(at));
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return h * 60 + m;
  } catch {
    const d = new Date(at);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
}

/** Inside the user's quiet hours (from–to, across midnight when from > to)? */
export function inQuietHours(quiet: QuietHours, at: number): boolean {
  if (!quiet.on || !HHMM.test(quiet.from) || !HHMM.test(quiet.to)) return false;
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const from = toMin(quiet.from);
  const to = toMin(quiet.to);
  if (from === to) return false;
  const now = minutesIn(at, quiet.tz);
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/** "HH:MM" in a time zone, for the {time} variable. */
export function timeIn(at: number, tz: string): string {
  const m = minutesIn(at, tz);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
