// GDPR-friendly data retention for the main service's in-memory state.
//
// Maximum lifetimes (days, env overrides):
//   SETTINGS_RETENTION_DAYS  settings sync records (/api/settings)       default 30
//   AUDIT_RETENTION_DAYS     per-device audit entries (/api/audit/log)   default 60
//   PUSH_RETENTION_DAYS      Web Push subscriptions                      default 90
//   DATA_RETENTION_DAYS      analytics consent ledger                    default 30
//   EVENT_RETENTION_DAYS     event metadata ring (LOG_EVENTS=1)          default 7
//
// The main service sweeps on an unref'd timer every RETENTION_SWEEP_MINUTES
// (default 60, 1 – 1440) and on demand via the token-protected
// POST /api/admin/retention/run (retention-routes.ts). Everything lives in
// memory, so a restart also clears it — the sweep bounds how long data can
// survive in a long-running process.
//
// planRetention() only counts (pure, used for dry runs and tests);
// sweepRetention() deletes. Both use retentionCutoffs(), the single source
// of the cutoffs, so what is reported and what is deleted cannot drift.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export const RETENTION = {
  data: envNumber("DATA_RETENTION_DAYS", 30),
  audit: envNumber("AUDIT_RETENTION_DAYS", 60),
  push: envNumber("PUSH_RETENTION_DAYS", 90),
  event: envNumber("EVENT_RETENTION_DAYS", 7),
  settings: envNumber("SETTINGS_RETENTION_DAYS", 30),
};

/** Anything older than (strictly before) these timestamps is expired. */
export type RetentionCutoffs = { settings: number; audit: number; push: number; consent: number; event: number };

export function retentionCutoffs(now = Date.now()): RetentionCutoffs {
  return {
    settings: now - RETENTION.settings * MS_PER_DAY,
    audit: now - RETENTION.audit * MS_PER_DAY,
    push: now - RETENTION.push * MS_PER_DAY,
    consent: now - RETENTION.data * MS_PER_DAY,
    event: now - RETENTION.event * MS_PER_DAY,
  };
}

export interface RetentionTargets {
  /** Per-device server-side preference sync. */
  deviceSettings?: Iterable<{ deviceId: string; updatedAt: number }>;
  /** Per-device audit log entries. */
  deviceAuditLog?: Iterable<{ deviceId: string; entries: Array<{ at: number }> }>;
  /** Push subscriptions (keyed by id). */
  pushSubscriptions?: Iterable<{ id: string; createdAt: number }>;
  /** Analytics consent ledger (keyed by deviceId). */
  consentLedger?: Iterable<{ deviceId: string; updatedAt: number }>;
  /** Event store entries. */
  events?: Iterable<{ id: string; ts: number }>;
}

export type RemovedCounts = {
  deviceSettings: number;
  auditEntries: number;
  pushSubscriptions: number;
  consentRecords: number;
  events: number;
};

export interface RetentionResult {
  removed: RemovedCounts;
  ranAt: number;
}

/** Pure: counts what a sweep at `now` would remove. Mutates nothing. */
export function planRetention(targets: RetentionTargets, now = Date.now()): RetentionResult {
  const c = retentionCutoffs(now);
  const removed: RemovedCounts = { deviceSettings: 0, auditEntries: 0, pushSubscriptions: 0, consentRecords: 0, events: 0 };
  for (const e of targets.deviceSettings ?? []) if (e.updatedAt < c.settings) removed.deviceSettings++;
  for (const block of targets.deviceAuditLog ?? []) {
    for (const entry of block.entries ?? []) if (entry.at < c.audit) removed.auditEntries++;
  }
  for (const p of targets.pushSubscriptions ?? []) if (p.createdAt < c.push) removed.pushSubscriptions++;
  for (const r of targets.consentLedger ?? []) if (r.updatedAt < c.consent) removed.consentRecords++;
  for (const ev of targets.events ?? []) if (ev.ts < c.event) removed.events++;
  return { removed, ranAt: now };
}

/** The live collections a sweep prunes (see retention-routes.ts). */
export interface RetentionStores {
  deviceSettings: Map<string, { updatedAt: number }>;
  deviceAuditLog: Map<string, Array<{ at: number }>>;
  pushSubscriptions: Map<string, { createdAt: number }>;
  consentLedger: Map<string, { updatedAt: number }>;
  events?: { pruneOlderThan(cutoff: number): number };
}

export type SweepResult = RetentionResult & { total: number; trigger: "timer" | "manual" };

let lastSweep: SweepResult | null = null;

/** Deletes everything older than its category's cutoff; returns what went. */
export function sweepRetention(stores: RetentionStores, now = Date.now(), trigger: SweepResult["trigger"] = "manual"): SweepResult {
  const c = retentionCutoffs(now);
  const removed: RemovedCounts = { deviceSettings: 0, auditEntries: 0, pushSubscriptions: 0, consentRecords: 0, events: 0 };

  for (const [key, record] of Array.from(stores.deviceSettings)) {
    if (record.updatedAt < c.settings) { stores.deviceSettings.delete(key); removed.deviceSettings++; }
  }
  for (const [key, entries] of Array.from(stores.deviceAuditLog)) {
    const kept = entries.filter((e) => e.at >= c.audit);
    removed.auditEntries += entries.length - kept.length;
    if (kept.length === 0) stores.deviceAuditLog.delete(key);
    else if (kept.length < entries.length) entries.splice(0, entries.length, ...kept); // in place, keeps the element type
  }
  for (const [key, sub] of Array.from(stores.pushSubscriptions)) {
    if (sub.createdAt < c.push) { stores.pushSubscriptions.delete(key); removed.pushSubscriptions++; }
  }
  for (const [key, record] of Array.from(stores.consentLedger)) {
    if (record.updatedAt < c.consent) { stores.consentLedger.delete(key); removed.consentRecords++; }
  }
  removed.events = stores.events ? stores.events.pruneOlderThan(c.event) : 0;

  const total = Object.values(removed).reduce((a, b) => a + b, 0);
  lastSweep = { removed, ranAt: now, total, trigger };
  return lastSweep;
}

export function getLastSweep(): SweepResult | null {
  return lastSweep;
}

/** Sweep period: RETENTION_SWEEP_MINUTES (default 60), clamped to 1 min – 24 h. */
export function retentionIntervalMs(): number {
  const minutes = Math.min(24 * 60, Math.max(1, envNumber("RETENTION_SWEEP_MINUTES", 60)));
  return Math.round(minutes * 60 * 1000);
}

/** Runs `run` every `intervalMs` on an unref'd timer (never keeps the process
 *  alive). A throwing sweep is logged and the schedule continues. */
export function startRetentionTimer(run: () => void, intervalMs = retentionIntervalMs()): () => void {
  const timer = setInterval(() => {
    try { run(); } catch (err) { console.error("[retention] sweep failed:", err); }
  }, intervalMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

/** Test helper: forget the last sweep. */
export function __resetRetentionForTests() {
  lastSweep = null;
}
