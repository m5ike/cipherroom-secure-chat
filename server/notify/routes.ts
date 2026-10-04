// Notifications (6.7): the HTTP side.
//
// Everyone:
//   GET    /api/notify/config               the templates and what may be chosen (no SMTP)
//   GET    /api/notify/email/confirm?t=…     the link in the confirmation mail
// The signed-in user (Bearer, the "notifications" module):
//   GET    /api/account/notify               my choice, what the operator allows, my endpoints
//   PUT    /api/account/notify               { on, kinds, privacy, order, quiet, lang }
//   POST   /api/account/notify/test          { channel? } — one test through my channels, with the fallback
//   POST   /api/account/notify/email         { address } — sends the confirmation mail
//   DELETE /api/account/notify/email         forget the address
//   DELETE /api/account/push                 { endpoint } — this browser stops being woken
// An Android device (signed by its key, android/routes.ts):
//   POST   /api/android/notify               { token, on } — wake this device for the account
// The console (/api/admin/notify, the admin guard + the "notifications" module):
//   GET    /                                 settings, channels and their readiness, numbers
//   PUT    /                                 settings (the SMTP password: "" keeps it, null removes it)
//   POST   /preview                          { kind, lang, privacy, vars } → title and body
//   POST   /test                             { username, kind?, channel? } — a notification to an account
//   POST   /email/test                       { to } — one mail through the SMTP relay
//   GET    /log                              ?account=&outcome=&channel=&limit=

import type { Express, Request, Response, NextFunction } from "express";
import { rateLimit } from "express-rate-limit";
import type { AccountRecord, AccountStore } from "../accounts/store";
import type { Device } from "../android/store";
import { androidStore } from "../android/store";
import { adminName } from "../admin-auth";
import { consoleGuard, requireModule } from "../access";
import { audit } from "../monitor/audit";
import { isAllowedPushEndpoint } from "../push";
import {
  NOTIFY_KINDS, isChannel, isKind, isLang, isPrivacy, renderNotification, visibleVars,
  type NotifyChannel, type NotifyKind,
} from "../../client/src/lib/notify-template";
import {
  clientNotifyPolicy, openSmtpPassword, publicNotifyConfig, sanitizeChannels, sanitizeNotifyConfig, sealSmtpPassword,
  type NotifyConfigStore,
} from "./config";
import type { NotifyStore } from "./store";
import type { Channel } from "./channels";
import { escapeHtml } from "./channels";
import type { Notifier } from "./dispatch";
import { sendSmtp, type SmtpResult } from "./smtp";

export type NotifyRouteDeps = {
  accounts: AccountStore;
  notifier: Notifier;
  store: NotifyStore;
  config: NotifyConfigStore;
  channels: Channel[];
  /** Tests: the mail of the confirmation. */
  sendMail?: typeof sendSmtp;
};

type Authed = Request & { account?: AccountRecord; token?: string };

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function baseUrlOf(req: Request): string {
  const configured = (process.env.PUBLIC_BASE_URL?.trim() || "").replace(/\/+$/, "");
  if (configured) return configured;
  return `${req.protocol}://${req.get("host") ?? "localhost"}`;
}

/** The channels and their endpoints for one account (what the settings show). */
async function endpointsOf(deps: NotifyRouteDeps, accountId: string) {
  const config = deps.config.get();
  const devices = deps.store.devices(accountId).map((l) => {
    const d = androidStore.devices.get(l.deviceId);
    return { id: l.deviceId, name: d?.name || d?.model || "Android", model: d?.model ?? "", lastSeen: d?.lastSeen ?? 0, fcm: Boolean(d?.fcmToken), linkedAt: l.at };
  });
  const email = deps.store.email(accountId);
  const ready: Record<string, { ready: boolean; reason: string; on: boolean }> = {};
  for (const ch of deps.channels) ready[ch.id] = { ...ch.ready(config), on: config.channels.some((c) => c.id === ch.id && c.on) };
  return {
    android: devices,
    webpush: deps.accounts.get(accountId)?.push.length ?? 0,
    email: email ? { address: email.address, confirmed: email.confirmed, sentAt: email.sentAt } : null,
    ready,
  };
}

/** The Android device's request to be woken for an account (or not any more). */
export function androidNotifyLink(store: NotifyStore, accounts: AccountStore, device: Device, body: Record<string, unknown>): { status: number; json: Record<string, unknown> } {
  const on = body.on !== false;
  if (!on) {
    const n = store.unlinkDevice(device.id);
    if (n) audit.add({ category: "account", event: "notify.device.unlinked", target: device.id });
    return { status: 200, json: { ok: true, linked: false } };
  }
  const token = str(body.token, 128);
  const account = accounts.resolveToken(token);
  if (!account) return { status: 401, json: { ok: false, code: "signed-out", message: "Sign in with your passkey first." } };
  store.linkDevice(account.id, device.id, token);
  accounts.addAudit(account.id, "push-linked", { devices: store.devices(account.id).length, channel: "android" });
  audit.add({ category: "account", event: "notify.device.linked", accountId: account.id, target: device.id });
  return { status: 200, json: { ok: true, linked: true } };
}

export function registerNotifyRoutes(app: Express, deps: NotifyRouteDeps): void {
  const { accounts, store, notifier, config } = deps;
  const sendMail = deps.sendMail ?? sendSmtp;

  // A session that ends ends the device links made with it; a deleted account takes everything.
  accounts.onRevoke((accountId, hash, reason) => {
    if (reason === "deleted") store.forget(accountId);
    else store.dropSession(accountId, hash);
  });

  const requireAccount = (req: Authed, res: Response, next: NextFunction) => {
    const header = req.header("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const account = accounts.resolveToken(token);
    if (!account) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="m5cet-account"');
      return res.status(401).json({ ok: false, code: "signed-out", message: "Sign in with your passkey first." });
    }
    req.account = account;
    req.token = token;
    next();
  };
  const testLimiter = rateLimit({ windowMs: 60_000, limit: 6, standardHeaders: true, legacyHeaders: false, message: { ok: false, message: "Too many tests; wait a minute." } });
  const mailLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 5, standardHeaders: true, legacyHeaders: false, message: { ok: false, message: "Too many confirmation mails; try again in an hour." } });

  /* --------------------------------------------------------------- public */

  app.get("/api/notify/config", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, ...clientNotifyPolicy(config.get()) });
  });

  app.get("/api/notify/email/confirm", (req, res) => {
    const id = store.confirmEmail(str(req.query.t, 80));
    if (id) {
      accounts.addAudit(id, "notify-email-confirmed");
      audit.add({ category: "account", event: "notify.email.confirmed", accountId: id });
    }
    const title = id ? "E-mail confirmed" : "This link does not work";
    const text = id ? "Notifications may now come to this address. You can close this page." : "The link is old, was used already, or is not complete.";
    res.status(id ? 200 : 400).type("html").setHeader("Cache-Control", "no-store");
    res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></body>`);
  });

  /* --------------------------------------------------------------- the user */

  app.use("/api/account/notify", requireModule("notifications"));

  app.get("/api/account/notify", requireAccount, async (req: Authed, res) => {
    const id = req.account!.id;
    res.json({ ok: true, prefs: store.prefs(id), saved: store.hasPrefs(id), policy: clientNotifyPolicy(config.get()), endpoints: await endpointsOf(deps, id) });
  });

  app.put("/api/account/notify", requireAccount, (req: Authed, res) => {
    const id = req.account!.id;
    const prefs = store.setPrefs(id, req.body ?? {});
    if (!prefs) return res.status(507).json({ ok: false, message: "The server keeps no more notification settings." });
    accounts.addAudit(id, "notify-settings", { on: prefs.on, privacy: prefs.privacy || "default", order: prefs.order.join(",") });
    res.json({ ok: true, prefs });
  });

  app.post("/api/account/notify/test", testLimiter, requireAccount, async (req: Authed, res) => {
    const id = req.account!.id;
    const channel = (req.body ?? {}).channel;
    const r = await notifier.notify({ accountId: id, kind: "test", ...(isChannel(channel) ? { only: [channel] } : {}), by: "user" });
    res.status(r.ok ? 200 : r.skipped ? 409 : 502).json({ ok: r.ok, channel: r.channel ?? null, skipped: r.skipped ?? null, order: r.order, attempts: r.attempts });
  });

  app.post("/api/account/notify/email", mailLimiter, requireAccount, async (req: Authed, res) => {
    const id = req.account!.id;
    const cfg = config.get();
    if (!cfg.channels.some((c) => c.id === "email" && c.on) || !cfg.email.host || !cfg.email.from) return res.status(409).json({ ok: false, message: "This server does not send e-mail." });
    const set = store.setEmail(id, str((req.body ?? {}).address, 254));
    if ("error" in set) return res.status(400).json({ ok: false, message: set.error });
    const link = `${baseUrlOf(req)}/api/notify/email/confirm?t=${encodeURIComponent(set.token)}`;
    const address = store.email(id)!.address;
    const r: SmtpResult = await sendMail(
      { host: cfg.email.host, port: cfg.email.port, secure: cfg.email.secure, user: cfg.email.user, pass: openSmtpPassword(cfg.email.pass) ?? "" },
      {
        from: cfg.email.from, to: address, subject: `${cfg.appName}: confirm notifications by e-mail`,
        text: `Open this link to receive ${cfg.appName} notifications at this address:\n\n${link}\n\nIf you did not ask for it, ignore this mail; nothing will be sent.\n`,
        html: `<p>Open this link to receive ${escapeHtml(cfg.appName)} notifications at this address:</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p>If you did not ask for it, ignore this mail; nothing will be sent.</p>`,
      },
      cfg.limits.timeoutMs,
    );
    accounts.addAudit(id, "notify-email", { sent: r.ok });
    audit.add({ category: "account", event: "notify.email.confirmation", accountId: id, status: r.ok ? "sent" : "failed" });
    if (!r.ok) return res.status(502).json({ ok: false, message: `The mail could not be sent: ${r.error}` });
    res.json({ ok: true, email: { address, confirmed: false } });
  });

  app.delete("/api/account/notify/email", requireAccount, (req: Authed, res) => {
    store.clearEmail(req.account!.id);
    res.json({ ok: true });
  });

  // Turning notifications off in a browser: the server stops waking it (6.7 —
  // before, a subscription once linked stayed until it died).
  app.delete("/api/account/push", requireAccount, (req: Authed, res) => {
    const endpoint = (req.body ?? {}).endpoint;
    if (!isAllowedPushEndpoint(endpoint)) return res.status(400).json({ ok: false, message: "not a known push service endpoint" });
    accounts.removePushEndpoint(req.account!.id, String(endpoint));
    accounts.addAudit(req.account!.id, "push-unlinked", { devices: accounts.get(req.account!.id)?.push.length ?? 0 });
    res.json({ ok: true });
  });

  /* ------------------------------------------------------------ the console */

  const r = (app as Express);
  const base = "/api/admin/notify";
  r.use(base, consoleGuard("notifications"));
  const log = (req: Request, event: string, detail?: Record<string, unknown>) =>
    audit.add({ category: "admin", level: "notice", event: `admin.notify.${event}`, actor: adminName(req), detail });

  const overview = async () => {
    const cfg = config.get();
    const channels = deps.channels.map((ch) => ({ id: ch.id, ...ch.ready(cfg), on: cfg.channels.some((c) => c.id === ch.id && c.on) }));
    return { ok: true, config: publicNotifyConfig(cfg), channels, stats: notifier.stats(), store: store.stats(), kinds: NOTIFY_KINDS };
  };

  r.get(base, async (_req, res) => { res.json(await overview()); });

  r.put(base, async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const current = config.get();
    // A kind's template may come in part (one language, one switch): the rest stays as it is.
    const given = (b.templates && typeof b.templates === "object" ? b.templates : {}) as Record<string, Record<string, unknown> | undefined>;
    const templates = Object.fromEntries(NOTIFY_KINDS.map((k) => {
      const cur = current.templates[k];
      const t = given[k] && typeof given[k] === "object" ? given[k]! : {};
      const texts = (v: unknown, base: Record<string, string>) => ({ ...base, ...(v && typeof v === "object" ? v as Record<string, string> : {}) });
      return [k, { ...cur, ...t, title: texts(t.title, cur.title), body: texts(t.body, cur.body) }];
    }));
    const next = sanitizeNotifyConfig({
      ...current,
      ...b,
      channels: b.channels === undefined ? current.channels : sanitizeChannels(b.channels, current.channels),
      templates,
      limits: { ...current.limits, ...((b.limits && typeof b.limits === "object") ? b.limits as object : {}) },
      email: { ...current.email, ...((b.email && typeof b.email === "object") ? b.email as object : {}), pass: current.email.pass },
    });
    const pass = (b.email && typeof b.email === "object") ? (b.email as Record<string, unknown>).pass : undefined;
    if (pass === null) next.email.pass = null;
    else if (typeof pass === "string" && pass) next.email.pass = sealSmtpPassword(pass);
    const saved = config.save(next, adminName(req));
    log(req, "config", { enabled: saved.enabled, channels: saved.channels.filter((c) => c.on).map((c) => c.id).join(","), kinds: NOTIFY_KINDS.filter((k) => saved.templates[k].on).join(",") });
    res.json(await overview());
  });

  r.post(`${base}/preview`, (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const cfg = config.get();
    const kind: NotifyKind = isKind(b.kind) ? b.kind : "message";
    const tpl = b.template && typeof b.template === "object" ? sanitizeNotifyConfig({ templates: { [kind]: b.template } }).templates[kind] : cfg.templates[kind];
    const privacy = isPrivacy(b.privacy) ? b.privacy : tpl.privacy;
    const lang = isLang(b.lang) ? b.lang : "en";
    const raw = (b.vars && typeof b.vars === "object" ? b.vars : {}) as Record<string, unknown>;
    const vars = { app: cfg.appName, sender: str(raw.sender, 200), room: str(raw.room, 200), count: str(raw.count, 10), time: str(raw.time, 10), preview: str(raw.preview, 400), channel: str(raw.channel, 20) };
    const out = renderNotification(tpl, lang, vars, privacy);
    res.json({ ok: true, ...out, privacy, visible: Object.keys(Object.fromEntries(Object.entries(visibleVars(vars, privacy)).filter(([, v]) => v))) });
  });

  r.post(`${base}/test`, async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = str(b.username, 80);
    const acc = accounts.get(name) ?? accounts.all().find((a) => a.username === name || a.userName === name);
    if (!acc) return res.status(404).json({ ok: false, message: "No such account." });
    const kind = isKind(b.kind) ? b.kind : "test";
    const only = isChannel(b.channel) ? [b.channel as NotifyChannel] : undefined;
    const out = await notifier.notify({ accountId: acc.id, kind, ...(only ? { only } : {}), from: { name: "operator" }, by: adminName(req) });
    log(req, "test", { account: acc.id, kind, channel: out.channel ?? "", ok: out.ok });
    res.status(out.ok ? 200 : 409).json({ ok: out.ok, channel: out.channel ?? null, skipped: out.skipped ?? null, order: out.order, attempts: out.attempts });
  });

  r.post(`${base}/email/test`, async (req, res) => {
    const to = str((req.body ?? {}).to, 254);
    const cfg = config.get();
    if (!cfg.email.host || !cfg.email.from) return res.status(409).json({ ok: false, message: "Set the SMTP relay and the sender first." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ ok: false, message: "Not an e-mail address." });
    const r2 = await sendMail(
      { host: cfg.email.host, port: cfg.email.port, secure: cfg.email.secure, user: cfg.email.user, pass: openSmtpPassword(cfg.email.pass) ?? "" },
      { from: cfg.email.from, to, subject: `${cfg.appName} · test`, text: "The SMTP relay works.\n", html: "<p>The SMTP relay works.</p>" },
      cfg.limits.timeoutMs,
    );
    log(req, "email-test", { ok: r2.ok, error: r2.ok ? "" : r2.error });
    res.status(r2.ok ? 200 : 502).json(r2.ok ? { ok: true } : { ok: false, message: r2.error });
  });

  r.get(`${base}/log`, (req, res) => {
    const q = req.query as Record<string, unknown>;
    const limit = Math.max(1, Math.min(1000, Number(q.limit) || 200));
    res.json({ ok: true, entries: notifier.log({ account: str(q.account, 80) || undefined, outcome: str(q.outcome, 10) || undefined, channel: str(q.channel, 10) || undefined, limit }) });
  });
}
