// Notifications (6.7): the operator's settings — which channels the server
// may use and in what order, the template of every kind (title and body per
// language, privacy, icon, accent, grouping, sound), limits, and the SMTP
// relay for the e-mail channel. $DATA_DIR/notify/config.json (NOTIFY_DIR
// moves it; 0600, atomic writes). The SMTP password is sealed with the
// storage master key (storage/keys.ts sealValue) — never in clear on disk,
// never sent to the console.
//
// Another instance on a shared directory changes the file: it is read again
// when its mtime moves (checked at most every 2 s).

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { openValue, sealValue } from "../storage/keys";
import {
  DEFAULT_TEMPLATES, NOTIFY_CHANNELS, NOTIFY_KINDS, NOTIFY_LANGS, TEMPLATE_MAX, isChannel, isPrivacy, minPrivacy,
  type NotifyChannel, type NotifyKind, type NotifyTemplate,
} from "../../client/src/lib/notify-template";

export type SmtpSecurity = "tls" | "starttls" | "none";
export type SmtpConfig = { host: string; port: number; secure: SmtpSecurity; user: string; pass: string | null; from: string };

export type NotifyConfig = {
  /** Off: the server sends nothing (the clients still show their own local notifications). */
  enabled: boolean;
  /** {app} in every template. */
  appName: string;
  /** The order the server tries channels in when a user chose none; off = never used. */
  channels: Array<{ id: NotifyChannel; on: boolean }>;
  templates: Record<NotifyKind, NotifyTemplate>;
  limits: { perHour: number; testsPerHour: number; timeoutMs: number };
  email: SmtpConfig;
  rev: string;
  updatedAt: number;
  updatedBy: string;
};

export const DEFAULT_NOTIFY_CONFIG: NotifyConfig = {
  enabled: true,
  appName: "M5cet",
  channels: [{ id: "android", on: true }, { id: "webpush", on: true }, { id: "email", on: false }],
  templates: structuredClone(DEFAULT_TEMPLATES),
  limits: { perHour: 60, testsPerHour: 10, timeoutMs: 10_000 },
  email: { host: "", port: 587, secure: "starttls", user: "", pass: null, from: "" },
  rev: "",
  updatedAt: 0,
  updatedBy: "",
};

export function notifyDir(): string {
  const explicit = process.env.NOTIFY_DIR?.trim();
  if (explicit) return resolve(explicit);
  const data = process.env.DATA_DIR?.trim();
  return data ? resolve(data, "notify") : resolve(process.cwd(), ".m5cet", "notify");
}

const SMTP_AAD = "notify:smtp:password";
export const sealSmtpPassword = (pass: string): string => sealValue(pass, SMTP_AAD).toString("base64");
export const openSmtpPassword = (sealed: string | null): string | null => (sealed ? openValue(Buffer.from(sealed, "base64"), SMTP_AAD) : null);

const clampInt = (v: unknown, min: number, max: number, dflt: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : dflt;
};
const bool = (v: unknown, dflt: boolean) => (typeof v === "boolean" ? v : dflt);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const ICON = /^[a-z0-9-]{0,40}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

/** One kind's template, every field checked; what is missing comes from `base`. */
export function sanitizeTemplate(raw: unknown, base: NotifyTemplate): NotifyTemplate {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const texts = (v: unknown, dflt: Record<string, string>) => {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const out = { ...dflt } as NotifyTemplate["title"];
    for (const lang of NOTIFY_LANGS) if (typeof o[lang] === "string") out[lang] = String(o[lang]).replace(/[\r\n]+/g, " ").slice(0, TEMPLATE_MAX);
    return out;
  };
  const maxPrivacy = isPrivacy(r.maxPrivacy) ? r.maxPrivacy : base.maxPrivacy;
  const privacy = minPrivacy(isPrivacy(r.privacy) ? r.privacy : base.privacy, maxPrivacy);
  const icon = typeof r.icon === "string" && ICON.test(r.icon) ? r.icon : base.icon;
  const accent = r.accent === "" ? "" : typeof r.accent === "string" && COLOR.test(r.accent) ? r.accent.toLowerCase() : base.accent;
  return {
    on: bool(r.on, base.on),
    title: texts(r.title, base.title),
    body: texts(r.body, base.body),
    privacy,
    maxPrivacy,
    icon,
    accent,
    group: r.group === "room" || r.group === "kind" || r.group === "none" ? r.group : base.group,
    sound: bool(r.sound, base.sound),
    vibrate: bool(r.vibrate, base.vibrate),
    sticky: bool(r.sticky, base.sticky),
    actions: bool(r.actions, base.actions),
    throttle: clampInt(r.throttle, 0, 3600, base.throttle),
  };
}

export function sanitizeChannels(raw: unknown, base: NotifyConfig["channels"]): NotifyConfig["channels"] {
  if (!Array.isArray(raw)) return base.map((c) => ({ ...c }));
  const out: NotifyConfig["channels"] = [];
  for (const c of raw) {
    const id = c && typeof c === "object" ? (c as Record<string, unknown>).id : c;
    if (!isChannel(id) || out.some((x) => x.id === id)) continue;
    out.push({ id, on: c && typeof c === "object" ? bool((c as Record<string, unknown>).on, true) : true });
  }
  // Every channel stays listed (switched off when the list left it out).
  for (const id of NOTIFY_CHANNELS) if (!out.some((x) => x.id === id)) out.push({ id, on: false });
  return out;
}

export function sanitizeNotifyConfig(raw: unknown): NotifyConfig {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_NOTIFY_CONFIG;
  const t = (c.templates && typeof c.templates === "object" ? c.templates : {}) as Record<string, unknown>;
  const templates = {} as Record<NotifyKind, NotifyTemplate>;
  for (const kind of NOTIFY_KINDS) templates[kind] = sanitizeTemplate(t[kind], d.templates[kind]);
  const l = (c.limits && typeof c.limits === "object" ? c.limits : {}) as Record<string, unknown>;
  const e = (c.email && typeof c.email === "object" ? c.email : {}) as Record<string, unknown>;
  const from = str(e.from, 200);
  return {
    enabled: bool(c.enabled, d.enabled),
    appName: str(c.appName, 40).replace(/[\u0000-\u001f]/g, "") || d.appName,
    channels: sanitizeChannels(c.channels, d.channels),
    templates,
    limits: {
      perHour: clampInt(l.perHour, 1, 10_000, d.limits.perHour),
      testsPerHour: clampInt(l.testsPerHour, 1, 1000, d.limits.testsPerHour),
      timeoutMs: clampInt(l.timeoutMs, 1000, 60_000, d.limits.timeoutMs),
    },
    email: {
      host: /^[A-Za-z0-9.-]{0,253}$/.test(str(e.host, 253)) ? str(e.host, 253) : "",
      port: clampInt(e.port, 1, 65_535, d.email.port),
      secure: e.secure === "tls" || e.secure === "starttls" || e.secure === "none" ? e.secure : d.email.secure,
      user: str(e.user, 200),
      pass: typeof e.pass === "string" && e.pass ? e.pass : null,
      from: /^[^\s<>@"]{1,64}@[A-Za-z0-9.-]{1,253}$/.test(from) || /^[^<>\r\n"]{0,80}<[^\s<>@"]{1,64}@[A-Za-z0-9.-]{1,253}>$/.test(from) ? from : "",
    },
    rev: str(c.rev, 40),
    updatedAt: typeof c.updatedAt === "number" ? c.updatedAt : 0,
    updatedBy: str(c.updatedBy, 120),
  };
}

/** What the console sees: the SMTP password only as "set". */
export function publicNotifyConfig(c: NotifyConfig) {
  return { ...c, email: { ...c.email, pass: undefined, hasPassword: Boolean(c.email.pass) } };
}

/** What every client may read: the templates and what may be chosen (no SMTP). */
export function clientNotifyPolicy(c: NotifyConfig) {
  return { enabled: c.enabled, appName: c.appName, channels: c.channels.map((x) => ({ ...x })), templates: c.templates, rev: c.rev };
}

export class NotifyConfigStore {
  private cached: NotifyConfig | null = null;
  private mtime = 0;
  private checkedAt = 0;

  constructor(private readonly dir: () => string = notifyDir) {}

  private file(): string { return join(this.dir(), "config.json"); }

  get(): NotifyConfig {
    const now = Date.now();
    if (this.cached && now - this.checkedAt < 2000) return this.cached;
    this.checkedAt = now;
    let mtime = 0;
    try { mtime = statSync(this.file()).mtimeMs; } catch { /* no file yet */ }
    if (this.cached && mtime === this.mtime) return this.cached;
    this.mtime = mtime;
    try {
      this.cached = sanitizeNotifyConfig(JSON.parse(readFileSync(this.file(), "utf8")));
    } catch {
      this.cached = structuredClone(DEFAULT_NOTIFY_CONFIG);
    }
    return this.cached;
  }

  save(next: NotifyConfig, by: string): NotifyConfig {
    const clean = sanitizeNotifyConfig({ ...next, rev: randomBytes(6).toString("hex"), updatedAt: Date.now(), updatedBy: by });
    const file = this.file();
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, file);
      try { this.mtime = statSync(file).mtimeMs; } catch { /* ignore */ }
    } catch {
      // A read-only data directory: the settings hold until the next restart.
    }
    this.cached = clean;
    this.checkedAt = Date.now();
    return clean;
  }

  /** Tests: forget what was read. */
  reset(): void { this.cached = null; this.mtime = 0; this.checkedAt = 0; }
}

export const notifyConfigStore = new NotifyConfigStore();
export const notifyConfig = (): NotifyConfig => notifyConfigStore.get();
