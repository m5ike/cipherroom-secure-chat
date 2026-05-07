// Shared between routes.ts (signaling server) and admin.ts (admin API).
// Holds the in-memory admin command queue and audit log so both modules
// can enqueue commands and observe delivery.

export const ADMIN_COMMAND_ALLOWLIST = [
  "refresh-settings",
  "reconnect",
  "purge-local",
  "show-notification",
  "run-diagnostic",
  "download-file-from-admin",
] as const;
export type AdminCommandKind = typeof ADMIN_COMMAND_ALLOWLIST[number];

export type AdminCommand = {
  id: string;
  kind: AdminCommandKind;
  createdAt: number;
  payload?: Record<string, unknown>;
};

export type StoredSubscription = {
  endpoint: string;
  keys?: { p256dh?: string; auth?: string };
  createdAt: number;
  deviceId?: string;
};

export const pushSubscriptions = new Map<string, StoredSubscription>();

const adminCommandQueue = new Map<string, AdminCommand[]>();

export const adminCommandAudit: Array<{
  ts: number;
  kind: string;
  commandId?: string;
  peerId?: string;
  result?: string;
  deviceId?: string;
}> = [];

export function enqueue(deviceId: string, cmd: AdminCommand) {
  const list = adminCommandQueue.get(deviceId) || [];
  list.push(cmd);
  adminCommandQueue.set(deviceId, list);
}

export function drain(deviceId: string): AdminCommand[] {
  const list = adminCommandQueue.get(deviceId);
  if (!list || list.length === 0) return [];
  const out = list.splice(0, list.length);
  return out;
}

export function pendingCount(deviceId: string): number {
  return adminCommandQueue.get(deviceId)?.length || 0;
}
