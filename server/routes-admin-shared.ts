// The admin command queue, its audit trail and the anonymous push
// subscriptions. They live in the MAIN service: that is where the sockets
// are that deliver commands and where devices subscribe. (The standalone
// admin process used to enqueue into its own copy of this module, which no
// socket ever read — commands sent from the console never arrived. It now
// forwards to /api/admin/commands and /api/admin/push instead.)

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

const MAX_PER_DEVICE = 50;
const MAX_DEVICES = 5_000;

export function enqueue(deviceId: string, cmd: AdminCommand) {
  const list = adminCommandQueue.get(deviceId) || [];
  list.push(cmd);
  if (list.length > MAX_PER_DEVICE) list.splice(0, list.length - MAX_PER_DEVICE);
  adminCommandQueue.set(deviceId, list);
  if (adminCommandQueue.size > MAX_DEVICES) adminCommandQueue.delete(adminCommandQueue.keys().next().value!);
}

/** Checks an enqueue request from the operator; returns the command or why not. */
export function buildCommand(body: Record<string, unknown>): { ok: true; deviceId: string; command: AdminCommand } | { ok: false; message: string } {
  const kind = String(body.kind || "");
  const deviceId = String(body.deviceId || "");
  if (!(ADMIN_COMMAND_ALLOWLIST as readonly string[]).includes(kind)) {
    return { ok: false, message: `Unknown command. Allowed: ${ADMIN_COMMAND_ALLOWLIST.join(", ")}` };
  }
  if (!/^[a-zA-Z0-9_-]{4,64}$/.test(deviceId)) return { ok: false, message: "deviceId must be 4-64 [a-zA-Z0-9_-]." };
  const payload = body.payload && typeof body.payload === "object" ? (body.payload as Record<string, unknown>) : undefined;
  if (payload && JSON.stringify(payload).length > 2_000) return { ok: false, message: "payload too large." };
  // The client asks the user before fetching anything; still, only an
  // https address (or this site) is worth asking about.
  if (kind === "download-file-from-admin") {
    const url = typeof payload?.url === "string" ? payload.url : "";
    const name = typeof payload?.name === "string" ? payload.name : "";
    if (!url || !/^https:\/\/.{1,512}$/.test(url)) return { ok: false, message: "download-file-from-admin requires a valid https URL." };
    // eslint-disable-next-line no-control-regex
    if (name.length > 200 || /[\x00-\x1f\\/:*?"<>|]/.test(name)) return { ok: false, message: "download-file-from-admin name is invalid." };
  }
  return {
    ok: true,
    deviceId,
    command: { id: `cmd-${(globalThis.crypto as Crypto).randomUUID()}`, kind: kind as AdminCommandKind, createdAt: Date.now(), ...(payload ? { payload } : {}) },
  };
}

/** Everything waiting, for the console. */
export function pendingCommands(): Array<{ deviceId: string; commands: AdminCommand[] }> {
  return [...adminCommandQueue.entries()].filter(([, list]) => list.length > 0).map(([deviceId, commands]) => ({ deviceId, commands: [...commands] }));
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
