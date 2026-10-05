// Control messages for iOS devices (6.14): the same commands, payloads and
// wire form as Android's (server/mobile/commands.ts) — ECIES-sealed for the
// one device, signed by the server — carried by APNs instead of FCM, and by
// the device's next check-in when APNs cannot (no token, push off, refused).
//
// The APNs payload (what the Notification Service Extension gets):
//
//   alert       flash, push, lock, wipe, notify — priority 10:
//                 { aps: { alert: { title: "M5cet", body: <neutral text> },
//                          "mutable-content": 1, sound?: "default" },
//                   m5: { m5: "1", i, e, iv, ct, s } }
//               The extension verifies `s`, opens the sealed content and shows
//               what it says (or does it: lock, wipe) — the neutral text in the
//               device's language is all Apple and a locked phone ever see.
//   background  ping, status, update, config — priority 5, no alert:
//                 { aps: { "content-available": 1 }, m5: {…} }
//   voip        a "call" notification to a device with a PushKit token —
//               priority 10, topic <bundle id>.voip: { m5: {…} } (the app
//               reports the call to CallKit after opening it)
//
// apns-collapse-id: m5-status / m5-update / m5-config, and m5-notify-<kind>
// when the user groups notifications by kind — never a room or a tag.
// apns-expiration: the command's own expiry.

import type { NotifyPayload } from "../notify/channels";
import { COLLAPSE, commandWire, createCommand, HIGH, pendingCommands, TTL_S, type CommandWire } from "../mobile/commands";
import { newId, type Command, type CommandKind } from "../mobile/store";
import { apnsReady, apnsSend, type ApnsRequest, type ApnsResult } from "./apns";
import { iosStore, type IosDevice } from "./store";

/* ------------------------------------------------------- neutral texts */

type Neutral = { message: string; call: string; notice: string; security: string };
const NEUTRAL: Record<string, Neutral> = {
  cs: { message: "Nová zpráva", call: "Příchozí hovor", notice: "Nové upozornění", security: "Bezpečnostní oznámení" },
  en: { message: "New message", call: "Incoming call", notice: "New notification", security: "Security notice" },
  de: { message: "Neue Nachricht", call: "Eingehender Anruf", notice: "Neue Benachrichtigung", security: "Sicherheitshinweis" },
  es: { message: "Nuevo mensaje", call: "Llamada entrante", notice: "Nueva notificación", security: "Aviso de seguridad" },
  it: { message: "Nuovo messaggio", call: "Chiamata in arrivo", notice: "Nuova notifica", security: "Avviso di sicurezza" },
  fr: { message: "Nouveau message", call: "Appel entrant", notice: "Nouvelle notification", security: "Avis de sécurité" },
  sk: { message: "Nová správa", call: "Prichádzajúci hovor", notice: "Nové upozornenie", security: "Bezpečnostné oznámenie" },
  sl: { message: "Novo sporočilo", call: "Dohodni klic", notice: "Novo obvestilo", security: "Varnostno obvestilo" },
  fi: { message: "Uusi viesti", call: "Saapuva puhelu", notice: "Uusi ilmoitus", security: "Tietoturvailmoitus" },
};

/** The text Apple carries and a phone shows when the extension cannot open the message (never content). */
export function neutralAlert(kind: CommandKind, lang: string, notifyKind?: string): { title: string; body: string } {
  const t = NEUTRAL[(lang || "").slice(0, 2).toLowerCase()] ?? NEUTRAL.en;
  if (kind === "lock" || kind === "wipe") return { title: "M5cet", body: t.security };
  if (kind === "notify") return { title: "M5cet", body: notifyKind === "call" ? t.call : notifyKind === "message" || notifyKind === "mention" ? t.message : t.notice };
  return { title: "M5cet", body: t.notice };
}

/* ------------------------------------------------------------ requests */

const ALERT: ReadonlySet<CommandKind> = new Set(["flash", "push", "lock", "wipe", "notify"]);

/** The APNs request that carries a command to a device (see the top of this file). */
export function apnsRequestFor(device: IosDevice, command: Command, wire: CommandWire, notify?: Pick<NotifyPayload, "kind" | "group" | "lang" | "sound">): ApnsRequest & { via: "apns" | "voip" } {
  const expiration = Math.floor(command.expiresAt / 1000);
  const m5 = { ...wire };
  if (command.kind === "notify" && notify?.kind === "call" && device.voipToken) {
    return { via: "voip", token: device.voipToken, type: "voip", priority: 10, expiration, payload: { m5 }, env: device.apnsEnv };
  }
  if (ALERT.has(command.kind)) {
    const alert = neutralAlert(command.kind, command.kind === "notify" ? notify?.lang ?? device.locale : device.locale, notify?.kind);
    const sound = command.kind === "push" || (command.kind === "notify" && notify?.sound !== false);
    const collapseId = command.kind === "notify" && notify?.group === "kind" ? `m5-notify-${notify.kind}` : undefined;
    return {
      via: "apns", token: device.apnsToken, type: "alert", priority: HIGH.has(command.kind) ? 10 : 5, expiration, env: device.apnsEnv,
      payload: { aps: { alert, "mutable-content": 1, ...(sound ? { sound: "default" } : {}) }, m5 },
      ...(collapseId ? { collapseId } : {}),
    };
  }
  return {
    via: "apns", token: device.apnsToken, type: "background", priority: 5, expiration, env: device.apnsEnv,
    payload: { aps: { "content-available": 1 }, m5 },
    ...(COLLAPSE.has(command.kind) ? { collapseId: `m5-${command.kind}` } : {}),
  };
}

/** A token APNs called dead is forgotten (the device sends a new one at its next check-in). */
function forgetToken(device: IosDevice, which: "apns" | "voip", reason: string): void {
  const now = iosStore.devices.get(device.id) ?? device;
  iosStore.devices.put({ ...now, ...(which === "voip" ? { voipToken: "" } : { apnsToken: "" }), apnsError: reason || "Unregistered" });
}

/* ---------------------------------------------------------------- send */

export type IosSendOutcome = { command: Command; via: "apns" | "poll"; error?: string; apns?: ApnsResult };

/** Creates a command for a device and pushes it (APNs) or queues it (check-in). */
export async function sendIosCommand(device: IosDevice, kind: CommandKind, payload: unknown, by: string): Promise<IosSendOutcome> {
  const command = createCommand(iosStore, device, kind, payload, by);
  if (device.status !== "active") return { command, via: "poll", error: `the device is ${device.status}` };
  if (!device.apnsToken || !apnsReady().ready) return { command, via: "poll" };
  const wire = commandWire(device, command);
  const { via: _via, ...req } = apnsRequestFor(device, command, wire);
  const result = await apnsSend(req);
  if (result.ok) {
    command.status = "sent"; command.sentAt = Date.now(); command.via = "apns";
    iosStore.commands.put(command);
    return { command, via: "apns", apns: result };
  }
  command.error = result.error;
  iosStore.commands.put(command);
  if (result.unregistered) forgetToken(device, "apns", result.reason);
  return { command, via: "poll", error: result.error, apns: result };
}

/** What a device gets on check-in: every command it has not acknowledged, in wire form. */
export const iosPendingFor = (device: IosDevice, now = Date.now()): CommandWire[] => pendingCommands(iosStore, device, now);

/**
 * The notifier's notification to one linked iOS device (server/notify/channels.ts):
 * a "notify" command that does not wait for a check-in — sent now or failed.
 */
export async function sendIosNotify(device: IosDevice, payload: NotifyPayload): Promise<{ ok: boolean; status?: number; error?: string; unregistered?: boolean }> {
  const voip = payload.kind === "call" && Boolean(device.voipToken);
  if (!voip && !device.apnsToken) return { ok: false, error: "the device has no APNs token (it checks in instead)" };
  const ready = apnsReady();
  if (!ready.ready) return { ok: false, error: ready.reason };
  const now = Date.now();
  const command: Command = {
    id: newId("cmd"), deviceId: device.id, kind: "notify", payload, status: "queued",
    createdAt: now, createdBy: "notifier", expiresAt: now + TTL_S.notify * 1000, sentAt: null, via: "", doneAt: null, result: null, error: "",
  };
  const { via, ...req } = apnsRequestFor(device, command, commandWire(device, command), payload);
  const r = await apnsSend(req);
  if (r.ok) {
    iosStore.commands.put({ ...command, status: "sent", sentAt: Date.now(), via: "apns" });
    return { ok: true };
  }
  // Not delivered now: a notification hours later at check-in is no use — it does not wait.
  iosStore.commands.put({ ...command, status: "failed", doneAt: Date.now(), error: r.error });
  if (r.unregistered) forgetToken(device, via === "voip" ? "voip" : "apns", r.reason);
  return { ok: false, status: r.status || undefined, error: r.error, unregistered: r.unregistered };
}
