// The settings file, encrypted with the operating system's key store.
//
// safeStorage: macOS Keychain, Windows DPAPI (bound to the user account).
// The file holds the server list and the app's options — no session, no key
// of the web client (those stay in the page's own storage, as on the web).
// Where the OS offers no key store (some Linux desktops) the file is kept as
// plain JSON and the log says so; it never holds secrets.

import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultSettings, sanitizeSettings, type Settings } from "./settings";

const FILE = "m5cet-settings.bin";
const PLAIN = "m5cet-settings.json";

export class SettingsStore {
  private value: Settings;
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<(s: Settings) => void>();

  constructor(private readonly opts: { allowLoopbackHttp: boolean }) {
    this.value = this.load();
  }

  private path(name: string): string {
    return join(app.getPath("userData"), name);
  }

  private load(): Settings {
    try {
      const bin = this.path(FILE);
      if (existsSync(bin) && safeStorage.isEncryptionAvailable()) {
        return sanitizeSettings(JSON.parse(safeStorage.decryptString(readFileSync(bin))), this.opts);
      }
      const plain = this.path(PLAIN);
      if (existsSync(plain)) return sanitizeSettings(JSON.parse(readFileSync(plain, "utf8")), this.opts);
    } catch (err) {
      console.warn("[m5cet] settings unreadable, starting fresh:", (err as Error).message);
    }
    return defaultSettings();
  }

  get(): Settings {
    return this.value;
  }

  set(next: Settings): void {
    this.value = sanitizeSettings(next, this.opts);
    for (const fn of this.listeners) fn(this.value);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }

  update(fn: (s: Settings) => Settings): Settings {
    this.set(fn(this.value));
    return this.value;
  }

  onChange(fn: (s: Settings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try {
      const json = JSON.stringify(this.value);
      const encrypted = safeStorage.isEncryptionAvailable();
      const target = this.path(encrypted ? FILE : PLAIN);
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, encrypted ? safeStorage.encryptString(json) : json, { mode: 0o600 });
      renameSync(tmp, target);
      if (!encrypted) console.warn("[m5cet] no OS key store: settings saved unencrypted (they hold no secrets)");
    } catch (err) {
      console.error("[m5cet] settings not saved:", (err as Error).message);
    }
  }
}
