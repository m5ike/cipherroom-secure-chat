// Notifications (6.7): what the server keeps per account — the user's own
// choice (kinds, privacy, channel order, quiet hours, language), the Android
// devices that asked to be woken for it, and an e-mail address for the
// e-mail channel once the user confirmed it. $DATA_DIR/notify/accounts.json
// (0600, atomic writes; read again when another instance changed it).
//
// A device link carries the hash of the session token it was made with: the
// session ending (sign-out, sign-out everywhere, account deleted) ends the
// link with it (routes.ts listens to the account store's revoke event).
// An e-mail address is used only after its owner opened the link the server
// sent to it — so nobody can make the server write to someone else's inbox
// more than that one confirmation mail.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_USER_PREFS, isLang, sanitizeUserPrefs, type NotifyLang, type UserNotifyPrefs } from "../../client/src/lib/notify-template";
import { notifyDir } from "./config";

export type DeviceLink = { deviceId: string; tokenHash: string; at: number };
export type EmailState = { address: string; confirmed: boolean; tokenHash: string; sentAt: number; confirmedAt: number };
/** `lang`: 6.13 — the language the account's own requests asked for (Accept-Language), used until the user chooses one in their settings. */
export type AccountNotify = { prefs: UserNotifyPrefs; devices: DeviceLink[]; email: EmailState | null; updatedAt: number; lang?: NotifyLang };

export const NOTIFY_STORE_LIMITS = { devicesPerAccount: 5, accounts: 20_000, confirmHours: 48 } as const;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const EMAIL_RE = /^[^\s@<>"(),;:\\[\]]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/;

export class NotifyStore {
  private data = new Map<string, AccountNotify>();
  private loaded = false;
  private mtime = 0;

  constructor(private readonly dir: () => string = notifyDir) {}

  private file(): string { return join(this.dir(), "accounts.json"); }

  private load(): void {
    let mtime = 0;
    try { mtime = statSync(this.file()).mtimeMs; } catch { /* nothing yet */ }
    if (this.loaded && mtime === this.mtime) return;
    this.loaded = true;
    this.mtime = mtime;
    this.data.clear();
    try {
      const raw = JSON.parse(readFileSync(this.file(), "utf8")) as { accounts?: Record<string, Partial<AccountNotify>> };
      for (const [id, rec] of Object.entries(raw.accounts ?? {})) {
        if (!rec || typeof rec !== "object") continue;
        this.data.set(id, {
          prefs: sanitizeUserPrefs(rec.prefs),
          devices: Array.isArray(rec.devices) ? rec.devices.filter((d) => d && typeof d.deviceId === "string").slice(0, NOTIFY_STORE_LIMITS.devicesPerAccount) : [],
          email: rec.email && typeof rec.email.address === "string" ? rec.email as EmailState : null,
          updatedAt: typeof rec.updatedAt === "number" ? rec.updatedAt : 0,
          ...(isLang(rec.lang) ? { lang: rec.lang } : {}),
        });
      }
    } catch { /* first run, or unreadable: start empty */ }
  }

  private persist(): void {
    const file = this.file();
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(tmp, JSON.stringify({ accounts: Object.fromEntries(this.data) }), { mode: 0o600 });
      renameSync(tmp, file);
      this.mtime = statSync(file).mtimeMs;
    } catch {
      // A read-only data directory: kept in memory until the next restart.
    }
  }

  private record(accountId: string, create: boolean): AccountNotify | null {
    this.load();
    let rec = this.data.get(accountId);
    if (!rec && create) {
      if (this.data.size >= NOTIFY_STORE_LIMITS.accounts) return null;
      rec = { prefs: structuredClone(DEFAULT_USER_PREFS), devices: [], email: null, updatedAt: 0 };
      this.data.set(accountId, rec);
    }
    return rec ?? null;
  }

  /** The user's choice (the defaults when they never chose — 6.13: in the language their requests asked for). */
  prefs(accountId: string): UserNotifyPrefs {
    const rec = this.record(accountId, false);
    const prefs = structuredClone(rec?.prefs ?? DEFAULT_USER_PREFS);
    if (rec && !rec.updatedAt && rec.lang) prefs.lang = rec.lang;
    return prefs;
  }

  /** 6.13: the language an account's request asked for (Accept-Language) — kept until the user chooses one. */
  noteLanguage(accountId: string, lang: NotifyLang | null): void {
    if (!lang) return;
    const known = this.record(accountId, false);
    if (known && (known.updatedAt || known.lang === lang)) return;
    const rec = known ?? this.record(accountId, true);
    if (!rec) return;
    rec.lang = lang;
    this.persist();
  }

  hasPrefs(accountId: string): boolean {
    return Boolean(this.record(accountId, false)?.updatedAt);
  }

  setPrefs(accountId: string, raw: unknown, now = Date.now()): UserNotifyPrefs | null {
    const rec = this.record(accountId, true);
    if (!rec) return null;
    rec.prefs = sanitizeUserPrefs(raw, rec.prefs);
    rec.updatedAt = now;
    this.persist();
    return structuredClone(rec.prefs);
  }

  /* ------------------------------------------------------------- devices */

  devices(accountId: string): DeviceLink[] {
    return (this.record(accountId, false)?.devices ?? []).map((d) => ({ ...d }));
  }

  /** The device wakes for this account from now on (and for no other). */
  linkDevice(accountId: string, deviceId: string, token: string, now = Date.now()): boolean {
    this.load();
    for (const [id, rec] of this.data) if (id !== accountId) rec.devices = rec.devices.filter((d) => d.deviceId !== deviceId);
    const rec = this.record(accountId, true);
    if (!rec) return false;
    rec.devices = rec.devices.filter((d) => d.deviceId !== deviceId);
    rec.devices.push({ deviceId, tokenHash: sha(token), at: now });
    if (rec.devices.length > NOTIFY_STORE_LIMITS.devicesPerAccount) rec.devices.splice(0, rec.devices.length - NOTIFY_STORE_LIMITS.devicesPerAccount);
    this.persist();
    return true;
  }

  unlinkDevice(deviceId: string, accountId?: string): number {
    this.load();
    let n = 0;
    for (const [id, rec] of this.data) {
      if (accountId && id !== accountId) continue;
      const before = rec.devices.length;
      rec.devices = rec.devices.filter((d) => d.deviceId !== deviceId);
      n += before - rec.devices.length;
    }
    if (n) this.persist();
    return n;
  }

  /** A session ended: the links made with it go (`tokenHash` null: every link of the account). */
  dropSession(accountId: string, tokenHash: string | null): number {
    const rec = this.record(accountId, false);
    if (!rec) return 0;
    const before = rec.devices.length;
    rec.devices = tokenHash === null ? [] : rec.devices.filter((d) => d.tokenHash !== tokenHash);
    const n = before - rec.devices.length;
    if (n) this.persist();
    return n;
  }

  /* --------------------------------------------------------------- e-mail */

  email(accountId: string): EmailState | null {
    const e = this.record(accountId, false)?.email;
    return e ? { ...e } : null;
  }

  /** A new address waits for its confirmation; returns the secret for the link. */
  setEmail(accountId: string, address: string, now = Date.now()): { token: string } | { error: string } {
    const clean = address.trim().toLowerCase();
    if (!EMAIL_RE.test(clean) || clean.length > 254) return { error: "not an e-mail address" };
    const rec = this.record(accountId, true);
    if (!rec) return { error: "too many accounts" };
    const token = randomBytes(24).toString("base64url");
    rec.email = { address: clean, confirmed: false, tokenHash: sha(token), sentAt: now, confirmedAt: 0 };
    this.persist();
    return { token };
  }

  /** The link from the confirmation mail was opened. */
  confirmEmail(token: string, now = Date.now()): string | null {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    this.load();
    const hash = sha(token);
    for (const [id, rec] of this.data) {
      const e = rec.email;
      if (!e || e.confirmed || e.tokenHash !== hash) continue;
      if (now - e.sentAt > NOTIFY_STORE_LIMITS.confirmHours * 3_600_000) return null;
      rec.email = { ...e, confirmed: true, tokenHash: "", confirmedAt: now };
      this.persist();
      return id;
    }
    return null;
  }

  clearEmail(accountId: string): void {
    const rec = this.record(accountId, false);
    if (!rec?.email) return;
    rec.email = null;
    this.persist();
  }

  /** The account was deleted. */
  forget(accountId: string): void {
    this.load();
    if (this.data.delete(accountId)) this.persist();
  }

  /** Accounts with a device link (for the console's overview). */
  stats(): { accounts: number; devices: number; emails: number; confirmed: number } {
    this.load();
    let devices = 0, emails = 0, confirmed = 0;
    for (const rec of this.data.values()) {
      devices += rec.devices.length;
      if (rec.email) { emails += 1; if (rec.email.confirmed) confirmed += 1; }
    }
    return { accounts: this.data.size, devices, emails, confirmed };
  }
}

export const notifyStore = new NotifyStore();
export const tokenHashOf = sha;
