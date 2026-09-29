// Control messages for devices (6.0): ping, status, flash, push, update,
// lock, wipe, config. Each is encrypted for the one device (ECIES) and signed
// by the server's Android key, then sent over FCM when the device has a
// token and FCM is set up — otherwise it waits for the device's next
// check-in, which returns it in the very same wire form.
//
// Priorities are chosen for the battery: only what a person should see now
// (flash, push) or what must not wait (lock, wipe) goes HIGH; the rest is
// NORMAL, which Doze delivers in its maintenance windows. Status, update and
// config collapse (a newer one replaces an undelivered older one).

import { eciesSeal, pushSignedString, signP1363, type EciesWire } from "./crypto";
import { fcmReady, fcmSend } from "./fcm";
import { androidStore, newId, type Command, type CommandKind, type Device } from "./store";

export const COMMAND_KINDS: readonly CommandKind[] = ["ping", "status", "flash", "push", "update", "lock", "wipe", "config"];

const TTL_S: Record<CommandKind, number> = { ping: 600, status: 3600, flash: 3600, push: 86_400, update: 86_400, lock: 7 * 86_400, wipe: 30 * 86_400, config: 7 * 86_400 };
const HIGH: ReadonlySet<CommandKind> = new Set(["flash", "push", "lock", "wipe"]);
const COLLAPSE: ReadonlySet<CommandKind> = new Set(["status", "update", "config"]);

export type CommandWire = { m5: "1"; i: string } & EciesWire & { s: string };

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** Only what each kind carries, bounded. */
export function sanitizePayload(kind: CommandKind, raw: unknown): Record<string, unknown> {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  switch (kind) {
    case "flash": return { text: str(p.text, 500), level: ["info", "success", "warn", "error"].includes(String(p.level)) ? p.level : "info", title: str(p.title, 100) };
    case "push": return { title: str(p.title, 100), body: str(p.body, 1000), room: str(p.room, 64), url: /^https:\/\//.test(str(p.url, 500)) ? str(p.url, 500) : "" };
    case "status": return { logs: p.logs === true };
    case "wipe": return { reason: str(p.reason, 200) };
    case "lock": return { reason: str(p.reason, 200) };
    default: return {};
  }
}

export function commandWire(device: Pick<Device, "id" | "encKey">, command: Command): CommandWire {
  const content = { id: command.id, kind: command.kind, at: command.createdAt, exp: command.expiresAt, payload: command.payload };
  const sealed = eciesSeal(device.encKey, device.id, "push", Buffer.from(JSON.stringify(content), "utf8"));
  const s = signP1363(androidStore.signingKey().privateKey, pushSignedString(device.id, command.id, sealed));
  return { m5: "1", i: command.id, ...sealed, s };
}

export type SendOutcome = { command: Command; via: "fcm" | "poll"; error?: string };

/** Creates a command for a device and sends it (FCM) or queues it (check-in). */
export async function sendCommand(device: Device, kind: CommandKind, payload: unknown, by: string): Promise<SendOutcome> {
  const now = Date.now();
  // A newer status/update/config replaces one the device has not fetched yet.
  if (COLLAPSE.has(kind)) {
    for (const old of androidStore.commands.list({ device: device.id, limit: 50, filter: (c) => c.kind === kind && (c.status === "queued" || c.status === "sent") })) {
      androidStore.commands.put({ ...old, status: "expired", doneAt: now, error: "replaced by a newer one" });
    }
  }
  const command: Command = {
    id: newId("cmd"), deviceId: device.id, kind, payload: sanitizePayload(kind, payload), status: "queued",
    createdAt: now, createdBy: by, expiresAt: now + TTL_S[kind] * 1000, sentAt: null, via: "", doneAt: null, result: null, error: "",
  };
  androidStore.commands.put(command);
  if (device.status !== "active") return { command, via: "poll", error: `the device is ${device.status}` };
  if (!device.fcmToken || !fcmReady().ready) return { command, via: "poll" };
  const wire = commandWire(device, command);
  const result = await fcmSend(device.fcmToken, wire, { priority: HIGH.has(kind) ? "high" : "normal", ttlSeconds: TTL_S[kind], ...(COLLAPSE.has(kind) ? { collapseKey: `m5-${kind}` } : {}) });
  if (result.ok) {
    command.status = "sent"; command.sentAt = Date.now(); command.via = "fcm";
    androidStore.commands.put(command);
    return { command, via: "fcm" };
  }
  command.error = result.error;
  androidStore.commands.put(command);
  if (result.unregistered) androidStore.devices.put({ ...device, fcmToken: "" });
  return { command, via: "poll", error: result.error };
}

/** What a device gets on check-in: every command it has not acknowledged, in wire form. */
export function pendingFor(device: Device, now = Date.now()): CommandWire[] {
  const out: CommandWire[] = [];
  for (const c of androidStore.commands.list({ device: device.id, limit: 50, filter: (x) => x.status === "queued" || x.status === "sent" || x.status === "delivered" })) {
    if (c.expiresAt < now) { androidStore.commands.put({ ...c, status: "expired", doneAt: now }); continue; }
    if (c.status !== "delivered") androidStore.commands.put({ ...c, status: "delivered", via: c.via || "poll", sentAt: c.sentAt ?? now });
    out.push(commandWire(device, c));
  }
  return out.reverse();
}

/** The device says what came of a command. */
export function acknowledge(device: Device, commandId: string, ok: boolean, result: unknown, error: string): Command | null {
  const c = androidStore.commands.get(commandId);
  if (!c || c.deviceId !== device.id) return null;
  if (c.status === "done" || c.status === "failed") return c;
  const text = JSON.stringify(result ?? null);
  const done: Command = { ...c, status: ok ? "done" : "failed", doneAt: Date.now(), result: text.length > 32_000 ? { truncated: true } : result ?? null, error: error.slice(0, 500) };
  androidStore.commands.put(done);
  return done;
}
