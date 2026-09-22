// Persistent storage for the telephony module: SIP trunks (incl. their
// passwords — they are needed to reach the trunk) and the admin-chosen default
// providers. One small JSON file, written atomically with mode 0600.
//
// Where:  TELEPHONY_DATA_FILE            explicit path, or
//         $DATA_DIR/telephony.json       when DATA_DIR is set (Docker: mount a
//                                        volume at /data and set DATA_DIR=/data), or
//         ./.m5cet/telephony.json        next to the app otherwise.
//
// The app (port 5000) and the admin service are separate processes; both read
// this file and the admin writes it. Readers call `dataFileMtime()` and reload
// when it changes, so an admin edit is visible to the app without a restart.
// If the location is not writable (e.g. a read-only container without a
// volume) the store keeps working in memory and reports `writable: false`.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, accessSync, constants } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type PersistedSettings = { smsProvider?: string; voiceProvider?: string };

export type PersistedTrunk = {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  authUser: string;
  password: string;
  register: boolean;
  didNumbers: string[];
  callerIdName: string;
  callerIdNumber: string;
  updatedAt: number;
};

export type TelephonyFile = { version: 1; settings: PersistedSettings; trunks: PersistedTrunk[] };

const EMPTY: TelephonyFile = { version: 1, settings: {}, trunks: [] };

const env = (name: string): string => (process.env[name]?.trim() || "");

export function dataFilePath(): string {
  const explicit = env("TELEPHONY_DATA_FILE");
  if (explicit) return resolve(explicit);
  const dir = env("DATA_DIR");
  return dir ? resolve(dir, "telephony.json") : resolve(process.cwd(), ".m5cet", "telephony.json");
}

export function dataFileMtime(): number {
  try { return statSync(dataFilePath()).mtimeMs; } catch { return 0; }
}

/** Never throws: a missing or corrupt file yields the empty document. */
export function loadTelephonyFile(): { data: TelephonyFile; mtimeMs: number; exists: boolean } {
  const file = dataFilePath();
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<TelephonyFile>;
    const data: TelephonyFile = {
      version: 1,
      settings: parsed.settings && typeof parsed.settings === "object" ? { ...parsed.settings } : {},
      trunks: Array.isArray(parsed.trunks) ? parsed.trunks.filter((t) => t && typeof t === "object" && typeof (t as PersistedTrunk).id === "string") as PersistedTrunk[] : [],
    };
    return { data, mtimeMs: statSync(file).mtimeMs, exists: true };
  } catch {
    return { data: { ...EMPTY, settings: {}, trunks: [] }, mtimeMs: 0, exists: false };
  }
}

export function saveTelephonyFile(data: TelephonyFile): { ok: true } | { ok: false; message: string } {
  const file = dataFilePath();
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: `cannot write ${file}: ${(err as Error).message}` };
  }
}

export function persistenceStatus(): { file: string; exists: boolean; writable: boolean; reason?: string } {
  const file = dataFilePath();
  const exists = existsSync(file);
  try {
    // The file (if present) or its directory (if we would create it) must be writable.
    accessSync(exists ? file : dirname(file), constants.W_OK);
    return { file, exists, writable: true };
  } catch {
    // The directory may simply not exist yet; that is fine if its parent is writable.
    try {
      let dir = dirname(file);
      while (!existsSync(dir) && dir !== dirname(dir)) dir = dirname(dir);
      accessSync(dir, constants.W_OK);
      return { file, exists, writable: true };
    } catch (err) {
      return { file, exists, writable: false, reason: (err as Error).message };
    }
  }
}

export const dataDir = (): string => join(dirname(dataFilePath()));
