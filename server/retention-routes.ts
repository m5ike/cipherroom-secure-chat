// Retention in the main service: the scheduled sweep and the operator
// routes. Both act on this process's in-memory state (device-state.ts,
// routes-admin-shared.ts, events.ts) and on the passkey accounts' away
// mailboxes + audit logs (accounts/store.ts) — which is why they live here
// and not in the separate admin process (see admin-auth.ts).
//
// RELAY_RETENTION_DAYS (default 30): undelivered away-relay items expire.
// Account audit entries follow AUDIT_RETENTION_DAYS.
//
//   GET  /api/admin/retention       policy, schedule, last sweep   (admin token)
//   POST /api/admin/retention/run   sweep now                      (admin token)

import type { Express } from "express";
import { requireAdminToken } from "./admin-auth";
import { consentLedger, deviceAuditLog, deviceSettings } from "./device-state";
import { eventStore } from "./events";
import { RETENTION, getLastSweep, retentionIntervalMs, startRetentionTimer, sweepRetention, type SweepResult } from "./retention";
import { pushSubscriptions } from "./routes-admin-shared";
import { accountStore } from "./accounts/store";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function relayRetentionDays(): number {
  const n = Number(process.env.RELAY_RETENTION_DAYS?.trim() || "");
  return Number.isFinite(n) && n > 0 ? n : 30;
}

export type AccountSweep = { mailboxItems: number; auditEntries: number; tokens: number };

/** One sweep over the live state of this process. */
export function sweepNow(now = Date.now(), trigger: SweepResult["trigger"] = "manual"): SweepResult & { accounts: AccountSweep } {
  const result = sweepRetention({ deviceSettings, deviceAuditLog, pushSubscriptions, consentLedger, events: eventStore }, now, trigger);
  let accounts: AccountSweep = { mailboxItems: 0, auditEntries: 0, tokens: 0 };
  try {
    accounts = accountStore.prune({ mailbox: now - relayRetentionDays() * MS_PER_DAY, audit: now - RETENTION.audit * MS_PER_DAY }, now);
  } catch {
    // A broken accounts dir must not stop the in-memory sweep.
  }
  // Logged after the prune, so the record itself is never swept by this run.
  if (result.total > 0 || accounts.mailboxItems + accounts.auditEntries > 0) {
    eventStore.record({ kind: "retention-sweep", meta: { ...result.removed, relayItems: accounts.mailboxItems, accountAudit: accounts.auditEntries, trigger } });
  }
  return { ...result, accounts };
}

let stopTimer: (() => void) | null = null;
let nextSweepAt = 0;

/** Starts the periodic sweep once per process (idempotent). */
export function startRetentionSchedule(intervalMs = retentionIntervalMs()): () => void {
  if (stopTimer) return stopTimer;
  nextSweepAt = Date.now() + intervalMs;
  const stop = startRetentionTimer(() => {
    nextSweepAt = Date.now() + intervalMs;
    sweepNow(Date.now(), "timer");
  }, intervalMs);
  stopTimer = () => { stop(); stopTimer = null; nextSweepAt = 0; };
  return stopTimer;
}

export function registerRetentionRoutes(app: Express): void {
  const operatorOnly = requireAdminToken();

  app.get("/api/admin/retention", operatorOnly, (_req, res) => {
    res.json({
      ok: true,
      policy: { ...RETENTION, relay: relayRetentionDays() },
      intervalMinutes: retentionIntervalMs() / 60_000,
      scheduled: stopTimer !== null,
      nextSweepAt: nextSweepAt || null,
      lastSweep: getLastSweep(),
    });
  });

  app.post("/api/admin/retention/run", operatorOnly, (_req, res) => {
    const result = sweepNow(Date.now(), "manual");
    res.json({ ok: true, ...result });
  });
}
