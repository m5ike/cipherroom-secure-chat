// GDPR-friendly data retention policy.
//
// Enforces maximum lifetimes for all per-device server-side state:
//   - Settings sync records (`/api/settings`)
//   - Audit log (`/api/audit/log` + admin command audit)
//   - Push subscriptions (in `routes-admin-shared.ts`)
//   - Analytics consent ledger
//   - Event store metadata (already capped, but we also expire old rows)
//
// All checks are purely runtime; data structures are kept in-memory and
// bounded by 24-hour default unless the operator overrides via env vars.
//
// Environment overrides (in days):
//   DATA_RETENTION_DAYS      — global default (default 30)
//   AUDIT_RETENTION_DAYS     — admin audit (default 60, longer for compliance)
//   PUSH_RETENTION_DAYS      — push subscriptions (default 90)
//   EVENT_RETENTION_DAYS     — server event metadata (default 7)
//   SETTINGS_RETENTION_DAYS  — settings sync (default 30)
//
// The retention sweep is `O(N)` over each container but only runs at
// most once per process and is bounded by a lastSweepAt timestamp.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function envDays(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export const RETENTION = {
  data: envDays("DATA_RETENTION_DAYS", 30),
  audit: envDays("AUDIT_RETENTION_DAYS", 60),
  push: envDays("PUSH_RETENTION_DAYS", 90),
  event: envDays("EVENT_RETENTION_DAYS", 7),
  settings: envDays("SETTINGS_RETENTION_DAYS", 30),
};

/**
 * Runs every collection sweep step. Call this after any mutation that
 * could introduce expired data.
 *
 * The sweep is intentionally incremental — we never walk the entire map
 * on the hot path, and the slow path runs at most every 60 s.
 */
let lastSweepAt = 0;
let sweepBusy = false;

export function shouldSweep(now = Date.now()): boolean {
  return now - lastSweepAt > 60_000;
}

/**
 * Cacheable age predicate so callers can hot-check whether a single
 * entry is expired without re-parsing env.
 */
function isExpired(ts: number, days: number, now = Date.now()): boolean {
  const maxAgeMs = days * MS_PER_DAY;
  return now - ts > maxAgeMs;
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
  /** Event store entries (already capped to length 500). */
  events?: Iterable<{ id: string; ts: number }>;
}

export interface RetentionResult {
  removed: {
    deviceSettings: number;
    auditEntries: number;
    pushSubscriptions: number;
    consentRecords: number;
    events: number;
  };
  ranAt: number;
}

/**
 * Pure function that returns counts of items that should be removed.
 * Callers are responsible for actually mutating their collections.
 */
export function planRetention(targets: RetentionTargets, now = Date.now()): RetentionResult {
  const auditAgeDays = RETENTION.audit;
  const pushAgeDays = RETENTION.push;
  const settingsAgeDays = RETENTION.settings;
  const consentAgeDays = RETENTION.data;
  const eventAgeDays = RETENTION.event;

  let settingsRemoved = 0;
  let auditEntriesRemoved = 0;
  let pushRemoved = 0;
  let consentRemoved = 0;
  let eventsRemoved = 0;

  if (targets.deviceSettings) {
    for (const e of targets.deviceSettings) {
      if (isExpired(e.updatedAt, settingsAgeDays, now)) settingsRemoved++;
    }
  }
  if (targets.deviceAuditLog) {
    for (const block of targets.deviceAuditLog) {
      if (!block.entries || block.entries.length === 0) continue;
      const cutoff = now - auditAgeDays * MS_PER_DAY;
      for (const entry of block.entries) {
        if (entry.at < cutoff) auditEntriesRemoved++;
      }
    }
  }
  if (targets.pushSubscriptions) {
    for (const p of targets.pushSubscriptions) {
      if (isExpired(p.createdAt, pushAgeDays, now)) pushRemoved++;
    }
  }
  if (targets.consentLedger) {
    for (const c of targets.consentLedger) {
      if (isExpired(c.updatedAt, consentAgeDays, now)) consentRemoved++;
    }
  }
  if (targets.events) {
    for (const ev of targets.events) {
      if (isExpired(ev.ts, eventAgeDays, now)) eventsRemoved++;
    }
  }
  return {
    removed: {
      deviceSettings: settingsRemoved,
      auditEntries: auditEntriesRemoved,
      pushSubscriptions: pushRemoved,
      consentRecords: consentRemoved,
      events: eventsRemoved,
    },
    ranAt: now,
  };
}

/**
 * Periodically run the sweep. Idempotent — callers can call this freely.
 */
export function runRetentionIfDue(targets: RetentionTargets, now = Date.now()): RetentionResult | null {
  if (sweepBusy) return null;
  if (!shouldSweep(now) && lastSweepAt !== 0) return null;
  sweepBusy = true;
  try {
    const r = planRetention(targets, now);
    lastSweepAt = now;
    return r;
  } finally {
    sweepBusy = false;
  }
}

/**
 * Reset sweep cache (test helper).
 */
export function __resetRetentionForTests() {
  lastSweepAt = 0;
  sweepBusy = false;
}
