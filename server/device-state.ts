// Per-device server state of the main service (server-enhanced mode):
// settings sync, per-device audit log, analytics consent. In memory only —
// gone on restart — and pruned by the retention sweep (retention.ts).
//
// Its own module so the routes that write it (routes.ts) and the retention
// routes / timer that prune it (retention-routes.ts) share one instance.

export type DeviceSettings = {
  deviceId: string;
  updatedAt: number;
  payload: Record<string, unknown>;
};

export type DeviceAuditEntry = { kind: string; at: number; meta?: Record<string, unknown> };

/** Only fields the client explicitly opted into are kept. */
export type ConsentRecord = { deviceId: string; analyticsConsent: boolean; updatedAt: number };

export const deviceSettings = new Map<string, DeviceSettings>();
export const deviceAuditLog = new Map<string, DeviceAuditEntry[]>();
export const consentLedger = new Map<string, ConsentRecord>();
