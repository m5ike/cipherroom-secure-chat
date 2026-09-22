// Retention in the main service: the scheduled sweep and the operator
// routes. Both act on this process's in-memory state (device-state.ts,
// routes-admin-shared.ts, events.ts) — which is why they live here and not
// in the separate admin process (see admin-auth.ts).
//
//   GET  /api/admin/retention       policy, schedule, last sweep   (admin token)
//   POST /api/admin/retention/run   sweep now                      (admin token)

import type { Express } from "express";
import { requireAdminToken } from "./admin-auth";
import { consentLedger, deviceAuditLog, deviceSettings } from "./device-state";
import { eventStore } from "./events";
import { RETENTION, getLastSweep, retentionIntervalMs, startRetentionTimer, sweepRetention, type SweepResult } from "./retention";
import { pushSubscriptions } from "./routes-admin-shared";

/** One sweep over the live state of this process. */
export function sweepNow(now = Date.now(), trigger: SweepResult["trigger"] = "manual"): SweepResult {
  const result = sweepRetention({ deviceSettings, deviceAuditLog, pushSubscriptions, consentLedger, events: eventStore }, now, trigger);
  // Logged after the prune, so the record itself is never swept by this run.
  if (result.total > 0) eventStore.record({ kind: "retention-sweep", meta: { ...result.removed, trigger } });
  return result;
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
      policy: RETENTION,
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
