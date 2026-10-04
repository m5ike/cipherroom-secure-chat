// Notifications in the browser (6.7): the user's own choice (kinds, privacy,
// the channel order, quiet hours) — kept by the server for a signed-in
// account so it knows how to notify, in this browser for a guest — the
// operator's templates, and the notifications the page shows itself.
//
// The page shows a notification when a message arrives in a room that is not
// on screen; it decrypted that message itself, so it may show the content
// when the user's privacy level (within what the operator allows) says so.
// A push from the server never has content (the server has none); the
// service worker names the room from what the page tells it here.

import { accountToken } from "./account";
import {
  DEFAULT_TEMPLATES, DEFAULT_USER_PREFS, effectivePrivacy, inQuietHours, minPrivacy, renderNotification, sanitizeUserPrefs,
  type NotifyChannel, type NotifyKind, type NotifyLang, type NotifyTemplate, type UserNotifyPrefs,
} from "./notify-template";

export type NotifyPolicy = {
  enabled: boolean;
  appName: string;
  channels: Array<{ id: NotifyChannel; on: boolean }>;
  templates: Record<NotifyKind, NotifyTemplate>;
  rev: string;
};

export type NotifyEndpoints = {
  android: Array<{ id: string; name: string; model: string; lastSeen: number; fcm: boolean; linkedAt: number }>;
  webpush: number;
  email: { address: string; confirmed: boolean; sentAt: number } | null;
  ready: Record<string, { ready: boolean; reason: string; on: boolean }>;
};

export type AccountNotify = { prefs: UserNotifyPrefs; saved: boolean; policy: NotifyPolicy; endpoints: NotifyEndpoints };
export type NotifyTestResult = { ok: boolean; channel: NotifyChannel | null; skipped: string | null; order: NotifyChannel[]; attempts: Array<{ channel: NotifyChannel; target: string; ok: boolean; status?: number; error?: string }> };

export const DEFAULT_POLICY: NotifyPolicy = {
  enabled: true, appName: "M5cet",
  channels: [{ id: "android", on: true }, { id: "webpush", on: true }, { id: "email", on: false }],
  templates: DEFAULT_TEMPLATES, rev: "",
};

const GUEST_KEY = "m5cet:notify:prefs";

async function call<T>(path: string, init: RequestInit = {}, token: string | null = accountToken()): Promise<T> {
  const res = await fetch(path, {
    ...init,
    cache: "no-store",
    headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok && !(res.status === 409 && "skipped" in json)) {
    throw Object.assign(new Error(typeof json.message === "string" ? json.message : `Server error ${res.status}.`), { status: res.status });
  }
  return json as T;
}

/* ---------------------------------------------------------------- policy */

let policyCache: { at: number; policy: NotifyPolicy } | null = null;

/** The operator's templates and switches (cached a minute). */
export async function fetchNotifyPolicy(force = false): Promise<NotifyPolicy> {
  if (!force && policyCache && Date.now() - policyCache.at < 60_000) return policyCache.policy;
  try {
    const p = await call<NotifyPolicy & { ok: boolean }>("/api/notify/config", {}, null);
    const policy: NotifyPolicy = { enabled: p.enabled !== false, appName: p.appName || "M5cet", channels: p.channels ?? DEFAULT_POLICY.channels, templates: { ...DEFAULT_TEMPLATES, ...(p.templates ?? {}) }, rev: p.rev ?? "" };
    policyCache = { at: Date.now(), policy };
    return policy;
  } catch {
    return policyCache?.policy ?? DEFAULT_POLICY;
  }
}

/* ----------------------------------------------------------- the account */

export async function loadAccountNotify(): Promise<AccountNotify> {
  const r = await call<AccountNotify & { ok: boolean }>("/api/account/notify");
  policyCache = { at: Date.now(), policy: r.policy };
  current = sanitizeUserPrefs(r.prefs);
  return r;
}

export async function saveAccountNotify(prefs: UserNotifyPrefs): Promise<UserNotifyPrefs> {
  const r = await call<{ prefs: UserNotifyPrefs }>("/api/account/notify", { method: "PUT", body: JSON.stringify(prefs) });
  current = sanitizeUserPrefs(r.prefs);
  return current;
}

export async function testAccountNotify(channel?: NotifyChannel): Promise<NotifyTestResult> {
  return call<NotifyTestResult>("/api/account/notify/test", { method: "POST", body: JSON.stringify(channel ? { channel } : {}) });
}

export async function setNotifyEmail(address: string): Promise<{ address: string; confirmed: boolean }> {
  const r = await call<{ email: { address: string; confirmed: boolean } }>("/api/account/notify/email", { method: "POST", body: JSON.stringify({ address }) });
  return r.email;
}

export async function clearNotifyEmail(): Promise<void> {
  await call("/api/account/notify/email", { method: "DELETE" });
}

/** This browser stops being woken for the account (notifications turned off here). */
export async function unlinkPushSubscription(endpoint: string): Promise<boolean> {
  try { await call("/api/account/push", { method: "DELETE", body: JSON.stringify({ endpoint }) }); return true; } catch { return false; }
}

/* ------------------------------------------------------------- the guest */

export function loadGuestNotify(): UserNotifyPrefs {
  try { return sanitizeUserPrefs(JSON.parse(localStorage.getItem(GUEST_KEY) || "null")); } catch { return structuredClone(DEFAULT_USER_PREFS); }
}

export function saveGuestNotify(prefs: UserNotifyPrefs): UserNotifyPrefs {
  const clean = sanitizeUserPrefs(prefs);
  try { localStorage.setItem(GUEST_KEY, JSON.stringify(clean)); } catch { /* storage blocked: for this page only */ }
  current = clean;
  return clean;
}

/** What the page's own notifications follow: the account's choice once read, else this browser's. */
let current: UserNotifyPrefs | null = null;
export function currentNotifyPrefs(): UserNotifyPrefs {
  return current ?? loadGuestNotify();
}
export function setCurrentNotifyPrefs(prefs: UserNotifyPrefs | null): void {
  current = prefs ? sanitizeUserPrefs(prefs) : null;
}

/* -------------------------------------------------------- local display */

export type LocalNotice = {
  kind: NotifyKind;
  /** The room's name as this device knows it. */
  room?: string;
  sender?: string;
  /** The decrypted text (only shown at the "content" level). */
  text?: string;
  count?: number;
  /** Replaces an earlier notification with the same tag. */
  tag?: string;
};

/**
 * Title, body and options of a notification the page shows itself — or null
 * when the user's choice says no. The page decrypted the message, so until
 * the user picks a level it shows what it always did (the content, within
 * the operator's maximum); `asPush` renders it as a push from the server
 * would come (the operator's default level, no content) — the settings'
 * preview.
 */
export function localNotification(n: LocalNotice, opts: { prefs?: UserNotifyPrefs; policy?: NotifyPolicy; lang?: NotifyLang; now?: number; asPush?: boolean } = {}): { title: string; options: NotificationOptions & { renotify?: boolean; vibrate?: number[] } } | null {
  const prefs = opts.prefs ?? currentNotifyPrefs();
  const policy = opts.policy ?? policyCache?.policy ?? DEFAULT_POLICY;
  const tpl = policy.templates[n.kind] ?? DEFAULT_TEMPLATES[n.kind];
  if (!tpl.on || !prefs.on || prefs.kinds[n.kind] === false) return null;
  if (n.kind !== "test" && inQuietHours(prefs.quiet, opts.now ?? Date.now())) return null;
  const privacy = prefs.privacy || opts.asPush ? effectivePrivacy(tpl, prefs) : minPrivacy("content", tpl.maxPrivacy);
  const lang = opts.lang ?? prefs.lang;
  const { title, body } = renderNotification(tpl, lang, { app: policy.appName, sender: n.sender, room: n.room, preview: n.text, count: n.count }, privacy);
  return {
    title,
    options: {
      body,
      tag: n.tag ?? `m5cet-${n.kind}`,
      icon: "/icon-192.svg",
      silent: !tpl.sound,
      requireInteraction: tpl.sticky,
      // A silent notification with a vibration pattern is refused: vibrate only with sound.
      ...(tpl.vibrate && tpl.sound ? { vibrate: [120, 60, 120] } : {}),
    },
  };
}

/** Shows it (when the browser lets the page); returns the Notification for a click handler. */
export function showLocalNotification(n: LocalNotice, opts: Parameters<typeof localNotification>[1] = {}): Notification | null {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return null;
  const shown = localNotification(n, opts);
  if (!shown) return null;
  try { return new Notification(shown.title, shown.options); } catch { return null; }
}

const WORD = /[\p{L}\p{N}_]/u;

/**
 * The away members a message mentions ("@name", any case, not part of a
 * longer word) — sent with the relay so their notification is a mention.
 * The sender's own choice: the server learns only that, never the text.
 */
export function mentionedAway(text: string | undefined, away: ReadonlyArray<{ accountId: string; name: string }>): string[] {
  if (!text || !text.includes("@")) return [];
  const lower = text.toLowerCase();
  return away.filter((a) => {
    const name = a.name.trim().toLowerCase();
    if (!name) return false;
    for (let i = lower.indexOf(`@${name}`); i >= 0; i = lower.indexOf(`@${name}`, i + 1)) {
      const before = i === 0 ? " " : lower[i - 1];
      const after = lower[i + name.length + 1] ?? " ";
      if (!WORD.test(before) && !WORD.test(after)) return true;
    }
    return false;
  }).map((a) => a.accountId);
}

/** Tells the service worker a room's name, so a push can name it (memory only). */
export function tellWorkerRoomName(roomId: string | undefined | null, name: string | null): void {
  if (!roomId || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.ready.then((reg) => reg.active?.postMessage({ type: "notify-rooms", rooms: { [roomId]: name ?? "" } })).catch(() => undefined);
}

/** The worker forgets every room name (signing out, clearing data). */
export function forgetWorkerRoomNames(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.ready.then((reg) => reg.active?.postMessage({ type: "notify-forget" })).catch(() => undefined);
}
