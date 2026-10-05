// The notifier's channels (6.7). Each knows how many endpoints an account
// has with it, whether the server can use it at all, and sends one
// notification to every endpoint of the account, reporting each attempt:
//
//   android   the account's linked Android devices: a "notify" control
//             message (commands.ts wire form) — ECIES-sealed for the one
//             device and signed by the server, so FCM carries only
//             ciphertext; HIGH priority, an hour to live
//   webpush   the account's Web Push subscriptions (RFC 8291: the payload
//             is encrypted for the browser); 404 / 410 = dead, forgotten
//   email     the address the user confirmed, through the operator's SMTP
//             relay; only what the user's privacy level lets through
//
// No channel ever carries message content: the server has none. What a
// payload may carry is decided before it gets here (dispatch.ts).

import type { AccountStore } from "../accounts/store";
import { sendWebPush, isWebPushReady, type WebPushOptions, type WebPushResult } from "../push";
import { androidStore, newId, type Command, type Device } from "../android/store";
import { commandWire, TTL_S } from "../android/commands";
import { CALL_TTL_S } from "../mobile/commands";
import { fcmReady, fcmSend, type FcmOptions, type FcmResult } from "../android/fcm";
import { iosStore, type IosDevice } from "../ios/store";
import { sendIosNotify } from "../ios/commands";
import { apnsReady } from "../ios/apns";
import type { NotifyChannel, NotifyKind, NotifyGroup, NotifyLang, NotifyPrivacy } from "../../client/src/lib/notify-template";
import type { NotifyConfig } from "./config";
import { openSmtpPassword } from "./config";
import type { NotifyStore } from "./store";
import { sendSmtp, type SmtpMessage, type SmtpResult, type SmtpSettings } from "./smtp";
import { LOCALE_INFO, isLocale } from "../../client/src/lib/locales";

/** One notification as every channel gets it. */
export type NotifyPayload = {
  v: 1;
  id: string;
  kind: NotifyKind;
  /** Rendered by the server (no room name, no preview: it has neither). */
  title: string;
  body: string;
  /** The template in the user's language: the device renders it again with what only it knows. */
  tpl: { title: string; body: string };
  /** The variables the privacy level lets through (cleaned). */
  vars: Record<string, string>;
  privacy: NotifyPrivacy;
  /** The opaque room id — only at privacy room / content, for the device to name the room itself. */
  room?: string;
  tag: string;
  group: NotifyGroup;
  icon: string;
  accent: string;
  sound: boolean;
  vibrate: boolean;
  sticky: boolean;
  actions: boolean;
  url: string;
  lang: NotifyLang;
  at: number;
  /**
   * 6.14 (call wake, kind "call"): the call — the caller's id for it, video,
   * when it rang, `end` (it ended before anyone answered: the ring becomes a
   * missed call), and `room` (only for the app channel: sealed for the one
   * device, which maps it to its saved room).
   */
  call?: { id: string; video: boolean; at: number; end?: true; room?: string };
};

/** 6.14: the first Android app that knows a call's end (6.14.0); an older one would sound a "missed call" on its calls channel. */
export const CALL_END_MIN_ANDROID = 61_400;

export type Attempt = { channel: NotifyChannel; target: string; ok: boolean; status?: number; error?: string; gone?: boolean; ms: number };

export type ChannelContext = { accountId: string; payload: NotifyPayload; config: NotifyConfig };

export interface Channel {
  id: NotifyChannel;
  /** Whether the server can use the channel at all (keys, accounts, relays). */
  ready(config: NotifyConfig): { ready: boolean; reason: string };
  /** How many endpoints the account has with it. */
  targets(accountId: string): Promise<number>;
  send(ctx: ChannelContext): Promise<Attempt[]>;
}

const elapsed = (t0: number) => Math.max(0, Date.now() - t0);

/** How a target is named in the operator's log: enough to tell them apart, nothing more. */
export const maskEndpoint = (endpoint: string): string => {
  try { const u = new URL(endpoint); return `${u.hostname}/…${u.pathname.slice(-6)}`; } catch { return "?"; }
};
export const maskEmail = (address: string): string => {
  const [user, domain] = address.split("@");
  return `${(user ?? "").slice(0, 1)}***@${domain ?? "?"}`;
};

/* ------------------------------------------------------------------ android */

/**
 * 6.14: the app channel ("android" — the id the users' settings already
 * name) wakes the account's linked iOS devices (ios_…) too, over APNs
 * (server/ios/commands.ts): the same sealed, signed "notify" message.
 */
export type IosNotifyDeps = {
  device: (id: string) => IosDevice | null;
  send: (device: IosDevice, payload: NotifyPayload) => Promise<{ ok: boolean; status?: number; error?: string; unregistered?: boolean }>;
};

export type AndroidDeps = {
  store: NotifyStore;
  device: (id: string) => Device | null;
  putDevice: (d: Device) => void;
  putCommand: (c: Command) => void;
  ready: () => { ready: boolean; reason: string };
  send: (token: string, data: Record<string, string>, opts: FcmOptions) => Promise<FcmResult>;
  wire: (device: Pick<Device, "id" | "encKey">, command: Command) => Record<string, string>;
  ios?: IosNotifyDeps;
};

export const defaultAndroidDeps = (store: NotifyStore): AndroidDeps => ({
  store,
  device: (id) => androidStore.devices.get(id),
  putDevice: (d) => androidStore.devices.put(d),
  putCommand: (c) => androidStore.commands.put(c),
  ready: fcmReady,
  send: fcmSend,
  wire: (device, command) => commandWire(device, command) as unknown as Record<string, string>,
  ios: { device: (id) => iosStore.devices.get(id), send: sendIosNotify },
});

export function androidChannel(deps: AndroidDeps): Channel {
  return {
    id: "android",
    ready: () => {
      const fcm = deps.ready();
      if (fcm.ready || !deps.ios) return fcm;
      // 6.14: the channel is usable when either transport is.
      const apns = apnsReady();
      return apns.ready ? { ready: true, reason: "" } : fcm;
    },
    async targets(accountId) {
      await androidStore.ready().catch(() => undefined);
      if (deps.ios) await iosStore.ready().catch(() => undefined);
      return deps.store.devices(accountId).length;
    },
    async send({ accountId, payload }) {
      await androidStore.ready().catch(() => undefined);
      if (deps.ios) await iosStore.ready().catch(() => undefined);
      const out: Attempt[] = [];
      for (const link of deps.store.devices(accountId)) {
        const t0 = Date.now();
        if (deps.ios && link.deviceId.startsWith("ios_")) {
          const device = deps.ios.device(link.deviceId);
          const target = device ? `${device.id} (${device.name || device.modelName || device.model || "iOS"})` : link.deviceId;
          if (!device || device.status !== "active") {
            deps.store.unlinkDevice(link.deviceId);
            out.push({ channel: "android", target, ok: false, error: device ? `the device is ${device.status}` : "no such device", gone: true, ms: elapsed(t0) });
            continue;
          }
          const r = await deps.ios.send(device, payload);
          out.push({ channel: "android", target, ok: r.ok, ...(r.status ? { status: r.status } : {}), ...(r.error ? { error: r.error } : {}), ms: elapsed(t0) });
          continue;
        }
        const device = deps.device(link.deviceId);
        const target = device ? `${device.id} (${device.name || device.model || "Android"})` : link.deviceId;
        if (!device || device.status !== "active") {
          // Wiped, retired, blocked or gone: it will not wake for anyone again.
          deps.store.unlinkDevice(link.deviceId);
          out.push({ channel: "android", target, ok: false, error: device ? `the device is ${device.status}` : "no such device", gone: true, ms: elapsed(t0) });
          continue;
        }
        if (!device.fcmToken) { out.push({ channel: "android", target, ok: false, error: "the device has no FCM token (it checks in instead)", ms: elapsed(t0) }); continue; }
        if (payload.call?.end && (device.appCode ?? 0) < CALL_END_MIN_ANDROID) { out.push({ channel: "android", target, ok: false, error: "the app predates call wakes (6.14): no call end", ms: elapsed(t0) }); continue; }
        const now = Date.now();
        // 6.14: a call's ring (and its end) lives 60 s — an older one must not ring.
        const ttl = payload.kind === "call" ? CALL_TTL_S : TTL_S.notify;
        const command: Command = {
          id: newId("cmd"), deviceId: device.id, kind: "notify", payload, status: "queued",
          createdAt: now, createdBy: "notifier", expiresAt: now + ttl * 1000, sentAt: null, via: "", doneAt: null, result: null, error: "",
        };
        const r = await deps.send(device.fcmToken, deps.wire(device, command), { priority: "high", ttlSeconds: ttl, collapseKey: `m5-notify-${payload.tag}`.slice(0, 64) });
        if (r.ok) {
          deps.putCommand({ ...command, status: "sent", sentAt: Date.now(), via: "fcm" });
          out.push({ channel: "android", target, ok: true, ms: elapsed(t0) });
          continue;
        }
        // Not delivered now: a notification hours later at check-in is no use — it does not wait.
        deps.putCommand({ ...command, status: "failed", doneAt: Date.now(), error: r.error });
        if (r.unregistered) deps.putDevice({ ...device, fcmToken: "" });
        out.push({ channel: "android", target, ok: false, status: r.status || undefined, error: r.error, ms: elapsed(t0) });
      }
      return out;
    },
  };
}

/* ------------------------------------------------------------------ web push */

export type WebPushDeps = {
  accounts: Pick<AccountStore, "get" | "removePushEndpoint">;
  send: (sub: { endpoint: string; keys?: { p256dh?: string; auth?: string } }, payload: Record<string, unknown>, opts?: WebPushOptions) => Promise<WebPushResult>;
  ready: () => boolean;
};

export const defaultWebPushDeps = (accounts: WebPushDeps["accounts"]): WebPushDeps => ({ accounts, send: sendWebPush, ready: isWebPushReady });

/** The topic header (RFC 8030 §5.4): base64url, at most 32 characters; a newer one replaces an undelivered older one. */
const topicOf = (tag: string) => Buffer.from(tag).toString("base64url").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);

export function webPushChannel(deps: WebPushDeps): Channel {
  return {
    id: "webpush",
    ready: () => (deps.ready() ? { ready: true, reason: "" } : { ready: false, reason: "VAPID keys are not set (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)" }),
    async targets(accountId) { return deps.accounts.get(accountId)?.push.length ?? 0; },
    async send({ accountId, payload, config }) {
      const out: Attempt[] = [];
      const targets = [...(deps.accounts.get(accountId)?.push ?? [])];
      for (const target of targets) {
        const t0 = Date.now();
        const r = await deps.send(target, { ...payload, requireInteraction: payload.sticky }, {
          TTL: payload.kind === "call" ? CALL_TTL_S : 3600,
          urgency: payload.kind === "call" || payload.kind === "mention" ? "high" : "normal",
          topic: topicOf(payload.tag),
          timeout: config.limits.timeoutMs,
        });
        if (!r.ok && r.gone) deps.accounts.removePushEndpoint(accountId, target.endpoint);
        out.push({ channel: "webpush", target: maskEndpoint(target.endpoint), ok: r.ok, ...(r.status ? { status: r.status } : {}), ...(r.error ? { error: r.error.slice(0, 200) } : {}), ...(r.gone ? { gone: true } : {}), ms: elapsed(t0) });
      }
      return out;
    },
  };
}

/* ------------------------------------------------------------------ e-mail */

export type EmailDeps = {
  store: NotifyStore;
  send: (cfg: SmtpSettings, msg: SmtpMessage, timeoutMs: number) => Promise<SmtpResult>;
  password: (sealed: string | null) => string | null;
  baseUrl: () => string;
};

export const defaultEmailDeps = (store: NotifyStore): EmailDeps => ({
  store, send: sendSmtp, password: openSmtpPassword, baseUrl: () => (process.env.PUBLIC_BASE_URL?.trim() || "").replace(/\/+$/, ""),
});

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

/** The mail of one notification: the same title and body, as text and as escaped HTML. */
export function emailOf(payload: NotifyPayload, from: string, to: string, base: string): SmtpMessage {
  const link = base ? `${base}${payload.url.startsWith("/") ? payload.url : "/"}` : "";
  const accent = /^#[0-9a-f]{6}$/i.test(payload.accent) ? payload.accent : "#2563eb";
  const text = `${payload.body}\n${link ? `\n${link}\n` : ""}`;
  // 6.13: the language and the charset said in the document too (the MIME part says utf-8 as well).
  const tag = LOCALE_INFO[isLocale(payload.lang) ? payload.lang : "en"].tag;
  const html = `<!doctype html><html lang="${tag}"><head><meta charset="utf-8"></head><body style="font-family:system-ui,sans-serif;margin:0;padding:24px;background:#f6f7f9">`
    + `<div style="max-width:480px;margin:auto;background:#fff;border-radius:12px;padding:20px;border-top:4px solid ${accent}">`
    + `<h1 style="font-size:18px;margin:0 0 8px">${escapeHtml(payload.title)}</h1>`
    + `<p style="font-size:15px;margin:0 0 16px">${escapeHtml(payload.body)}</p>`
    + (link ? `<p><a href="${escapeHtml(link)}" style="color:${accent}">${escapeHtml(link)}</a></p>` : "")
    + `</div></body></html>`;
  return { from, to, subject: payload.title, text, html };
}

export function emailReady(config: NotifyConfig): { ready: boolean; reason: string } {
  const e = config.email;
  if (!e.host) return { ready: false, reason: "no SMTP relay (Notifications › E-mail)" };
  if (!e.from) return { ready: false, reason: "no sender address (Notifications › E-mail)" };
  return { ready: true, reason: "" };
}

export function emailChannel(deps: EmailDeps): Channel {
  return {
    id: "email",
    ready: (config) => emailReady(config),
    async targets(accountId) { return deps.store.email(accountId)?.confirmed ? 1 : 0; },
    async send({ accountId, payload, config }) {
      const e = deps.store.email(accountId);
      if (!e?.confirmed) return [];
      const t0 = Date.now();
      const settings: SmtpSettings = { host: config.email.host, port: config.email.port, secure: config.email.secure, user: config.email.user, pass: deps.password(config.email.pass) ?? "" };
      const r = await deps.send(settings, emailOf(payload, config.email.from, e.address, deps.baseUrl()), config.limits.timeoutMs);
      // The relay refused the recipient for good: stop writing to it.
      const gone = !r.ok && r.permanent && /^RCPT TO/.test(r.error);
      if (gone) deps.store.clearEmail(accountId);
      return [{ channel: "email", target: maskEmail(e.address), ok: r.ok, ...(r.code ? { status: r.code } : {}), ...(!r.ok ? { error: r.error.slice(0, 200) } : {}), ...(gone ? { gone: true } : {}), ms: elapsed(t0) }];
    },
  };
}
