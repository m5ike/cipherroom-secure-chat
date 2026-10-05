// Control messages for the mobile apps (Android 6.0, iOS 6.14): ping,
// status, flash, push, update, lock, wipe, config. Each is encrypted for the
// one device (ECIES) and signed by the server's key — the same wire form on
// both platforms; only the transport differs (FCM on Android, APNs on iOS,
// and the device's next check-in on both when no push is possible).
//
// What travels is CommandWire: {m5:"1", i, e, iv, ct, s} — FCM carries it as
// the data message, APNs as the "m5" key of the payload, check-in in
// `commands`.

import { eciesSeal, pushSignedString, signP1363, type EciesWire } from "./crypto";
import { mobileSigningKey } from "./signing";
import { newId, type BaseDevice, type Command, type CommandKind, type MobileStore } from "./store";

export const COMMAND_KINDS: readonly CommandKind[] = ["ping", "status", "flash", "push", "update", "lock", "wipe", "config"];

// 6.7: "notify" is not in COMMAND_KINDS — the notifier (server/notify) sends it, the console does not.
export const TTL_S: Record<CommandKind, number> = { ping: 600, status: 3600, flash: 3600, push: 86_400, update: 86_400, lock: 7 * 86_400, wipe: 30 * 86_400, config: 7 * 86_400, notify: 3600 };
/** What a person should see now or what must not wait: high priority (FCM HIGH, APNs 10). */
export const HIGH: ReadonlySet<CommandKind> = new Set(["flash", "push", "lock", "wipe", "notify"]);
/** A newer one replaces an undelivered older one (FCM collapse_key, APNs apns-collapse-id). */
export const COLLAPSE: ReadonlySet<CommandKind> = new Set(["status", "update", "config"]);

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

export function commandWire(device: Pick<BaseDevice, "id" | "encKey">, command: Command): CommandWire {
  const content = { id: command.id, kind: command.kind, at: command.createdAt, exp: command.expiresAt, payload: command.payload };
  const sealed = eciesSeal(device.encKey, device.id, "push", Buffer.from(JSON.stringify(content), "utf8"));
  const s = signP1363(mobileSigningKey().privateKey, pushSignedString(device.id, command.id, sealed));
  return { m5: "1", i: command.id, ...sealed, s };
}

/** A new queued command (an undelivered older status/update/config of the device expires first). */
export function createCommand<D extends BaseDevice, R extends { id: string }>(store: MobileStore<D, R>, device: D, kind: CommandKind, payload: unknown, by: string): Command {
  const now = Date.now();
  if (COLLAPSE.has(kind)) {
    for (const old of store.commands.list({ device: device.id, limit: 50, filter: (c) => c.kind === kind && (c.status === "queued" || c.status === "sent") })) {
      store.commands.put({ ...old, status: "expired", doneAt: now, error: "replaced by a newer one" });
    }
  }
  const command: Command = {
    id: newId("cmd"), deviceId: device.id, kind, payload: sanitizePayload(kind, payload), status: "queued",
    createdAt: now, createdBy: by, expiresAt: now + TTL_S[kind] * 1000, sentAt: null, via: "", doneAt: null, result: null, error: "",
  };
  store.commands.put(command);
  return command;
}

/** What a device gets on check-in: every command it has not acknowledged, in wire form. */
export function pendingCommands<D extends BaseDevice, R extends { id: string }>(store: MobileStore<D, R>, device: D, now = Date.now()): CommandWire[] {
  const out: CommandWire[] = [];
  for (const c of store.commands.list({ device: device.id, limit: 50, filter: (x) => x.status === "queued" || x.status === "sent" || x.status === "delivered" })) {
    if (c.expiresAt < now) { store.commands.put({ ...c, status: "expired", doneAt: now }); continue; }
    if (c.status !== "delivered") store.commands.put({ ...c, status: "delivered", via: c.via || "poll", sentAt: c.sentAt ?? now });
    out.push(commandWire(device, c));
  }
  return out.reverse();
}

/** The device says what came of a command. */
export function acknowledgeCommand<D extends BaseDevice, R extends { id: string }>(store: MobileStore<D, R>, device: D, commandId: string, ok: boolean, result: unknown, error: string): Command | null {
  const c = store.commands.get(commandId);
  if (!c || c.deviceId !== device.id) return null;
  if (c.status === "done" || c.status === "failed") return c;
  const text = JSON.stringify(result ?? null);
  const done: Command = { ...c, status: ok ? "done" : "failed", doneAt: Date.now(), result: text.length > 32_000 ? { truncated: true } : result ?? null, error: error.slice(0, 500) };
  store.commands.put(done);
  return done;
}
