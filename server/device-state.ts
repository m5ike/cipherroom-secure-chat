// Per-device server state of the main service (server-enhanced mode):
// settings sync, per-device audit log, analytics consent. In memory only —
// gone on restart — and pruned by the retention sweep (retention.ts).
//
// Its own module so the routes that write it (routes.ts) and the retention
// routes / timer that prune it (retention-routes.ts) share one instance.

import { retentionCutoffs } from "./retention";

export type DeviceSettings = {
  deviceId: string;
  updatedAt: number;
  /** The settings as JSON text (6.7): a parsed object of the same size takes
   *  ~20× the memory (audit V4), the text is what the cap measures. */
  payload: string;
};

export type DeviceAuditEntry = { kind: string; at: number; meta?: Record<string, unknown> };

/** Only fields the client explicitly opted into are kept. */
export type ConsentRecord = { deviceId: string; analyticsConsent: boolean; updatedAt: number };

export const deviceSettings = new Map<string, DeviceSettings>();
export const deviceAuditLog = new Map<string, DeviceAuditEntry[]>();
export const consentLedger = new Map<string, ConsentRecord>();

/* ------------------------------------------------- bounds (6.7, audit V4) */

/** Largest settings document a device may store, as JSON text. */
export const MAX_SETTINGS_BYTES = 16 * 1024;
/** Devices with stored settings (and consent records); the least recently
 *  written goes first. Unauthenticated, so the total must stay small:
 *  5000 × 16 kB ≈ 80 MB at most. */
export const MAX_DEVICE_RECORDS = 5_000;

/** Re-inserting moves a key to the end, so the first key is the oldest
 *  write; expired records (the retention cutoff, retention.ts) go first. */
function boundedSet<V extends { updatedAt: number }>(map: Map<string, V>, key: string, value: V, cutoff: number): void {
  map.delete(key);
  map.set(key, value);
  for (const [k, v] of map) {
    if (map.size <= MAX_DEVICE_RECORDS && v.updatedAt >= cutoff) break;
    map.delete(k);
  }
}

/** A record past its retention is gone even before the next sweep. */
function fresh<V extends { updatedAt: number }>(map: Map<string, V>, key: string, cutoff: number): V | undefined {
  const v = map.get(key);
  if (v && v.updatedAt < cutoff) { map.delete(key); return undefined; }
  return v;
}

export type PutSettingsResult = { ok: true } | { ok: false; status: number; message: string };

/** Stores a device's settings (POST /api/settings) within the bounds above. */
export function putDeviceSettings(deviceId: string, settings: unknown, now = Date.now()): PutSettingsResult {
  const payload = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  let text: string;
  try { text = JSON.stringify(payload); } catch { return { ok: false, status: 400, message: "settings must be plain JSON." }; }
  if (Buffer.byteLength(text) > MAX_SETTINGS_BYTES) return { ok: false, status: 413, message: `settings are larger than ${MAX_SETTINGS_BYTES} bytes.` };
  boundedSet(deviceSettings, deviceId, { deviceId, payload: text, updatedAt: now }, retentionCutoffs(now).settings);
  return { ok: true };
}

/** A device's settings (GET /api/settings); null when none or expired. */
export function getDeviceSettings(deviceId: string, now = Date.now()): { settings: Record<string, unknown>; updatedAt: number } | null {
  const record = fresh(deviceSettings, deviceId, retentionCutoffs(now).settings);
  if (!record) return null;
  try { return { settings: JSON.parse(record.payload) as Record<string, unknown>, updatedAt: record.updatedAt }; } catch { return null; }
}

/** Records a device's analytics consent within the same bounds. */
export function putConsent(deviceId: string, analyticsConsent: boolean, now = Date.now()): ConsentRecord {
  const record = { deviceId, analyticsConsent, updatedAt: now };
  boundedSet(consentLedger, deviceId, record, retentionCutoffs(now).consent);
  return record;
}

export function getConsent(deviceId: string, now = Date.now()): ConsentRecord | null {
  return fresh(consentLedger, deviceId, retentionCutoffs(now).consent) ?? null;
}
