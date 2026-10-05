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
//               reports the call to CallKit after opening it). 6.14 (call
//               wake): the sealed content is the call itself —
//                 { id, kind: "call" | "call-end", at, exp: at + 60 s,
//                   payload: { call, room, who, video, at } }
//               (voipCallContent): `call` the caller's id for the call,
//               `room` the room id the hub knows (the app maps it to its
//               saved room), `who` the caller's name when the user's privacy
//               level shows senders (else ""), `at` when it rang. A
//               "call-end" goes only within 60 s of its ring (later the
//               phone has ended the ring itself — and every VoIP push must
//               show a call in CallKit).
//
// apns-collapse-id: m5-status / m5-update / m5-config, m5-notify-<kind>
// when the user groups notifications by kind, and (6.14) m5-call-<call id>
// for a call's alert ring and its "missed call" — never a room or a tag.
// apns-expiration: the command's own expiry (a call's: 60 s).

import type { NotifyPayload } from "../notify/channels";
import { CALL_TTL_S, COLLAPSE, commandWire, createCommand, HIGH, pendingCommands, sealedWire, TTL_S, type CommandWire } from "../mobile/commands";
import { newId, type Command, type CommandKind } from "../mobile/store";
import { apnsReady, apnsSend, type ApnsRequest, type ApnsResult } from "./apns";
import { iosStore, type IosDevice } from "./store";

/* ------------------------------------------------------- neutral texts */

type Neutral = { message: string; call: string; missed: string; notice: string; security: string };
const NEUTRAL: Record<string, Neutral> = {
  cs: { message: "Nová zpráva", call: "Příchozí hovor", missed: "Zmeškaný hovor", notice: "Nové upozornění", security: "Bezpečnostní oznámení" },
  en: { message: "New message", call: "Incoming call", missed: "Missed call", notice: "New notification", security: "Security notice" },
  de: { message: "Neue Nachricht", call: "Eingehender Anruf", missed: "Verpasster Anruf", notice: "Neue Benachrichtigung", security: "Sicherheitshinweis" },
  es: { message: "Nuevo mensaje", call: "Llamada entrante", missed: "Llamada perdida", notice: "Nueva notificación", security: "Aviso de seguridad" },
  it: { message: "Nuovo messaggio", call: "Chiamata in arrivo", missed: "Chiamata persa", notice: "Nuova notifica", security: "Avviso di sicurezza" },
  fr: { message: "Nouveau message", call: "Appel entrant", missed: "Appel manqué", notice: "Nouvelle notification", security: "Avis de sécurité" },
  sk: { message: "Nová správa", call: "Prichádzajúci hovor", missed: "Zmeškaný hovor", notice: "Nové upozornenie", security: "Bezpečnostné oznámenie" },
  sl: { message: "Novo sporočilo", call: "Dohodni klic", missed: "Zgrešen klic", notice: "Novo obvestilo", security: "Varnostno obvestilo" },
  fi: { message: "Uusi viesti", call: "Saapuva puhelu", missed: "Vastaamaton puhelu", notice: "Uusi ilmoitus", security: "Tietoturvailmoitus" },
};

/** The text Apple carries and a phone shows when the extension cannot open the message (never content). 6.14: `end` — a call's end ("Missed call"). */
export function neutralAlert(kind: CommandKind, lang: string, notifyKind?: string, end = false): { title: string; body: string } {
  const t = NEUTRAL[(lang || "").slice(0, 2).toLowerCase()] ?? NEUTRAL.en;
  if (kind === "lock" || kind === "wipe") return { title: "M5cet", body: t.security };
  if (kind === "notify") return { title: "M5cet", body: notifyKind === "call" ? (end ? t.missed : t.call) : notifyKind === "message" || notifyKind === "mention" ? t.message : t.notice };
  return { title: "M5cet", body: t.notice };
}

/* ------------------------------------------------------------ requests */

const ALERT: ReadonlySet<CommandKind> = new Set(["flash", "push", "lock", "wipe", "notify"]);

/**
 * 6.14 (call wake): what a VoIP push seals for the device — the call itself,
 * all CallKit needs before the app opens anything else (see the top of this
 * file). `who` only as far as the user's privacy level lets the sender
 * through (the notifier's `vars.sender`); the app decides what CallKit shows.
 */
export function voipCallContent(command: Pick<Command, "id" | "createdAt" | "expiresAt">, payload: Pick<NotifyPayload, "id" | "at" | "vars" | "call">): { id: string; kind: "call" | "call-end"; at: number; exp: number; payload: { call: string; room: string; who: string; video: boolean; at: number } } {
  const call = payload.call;
  return {
    id: command.id,
    kind: call?.end ? "call-end" : "call",
    at: command.createdAt,
    exp: command.expiresAt,
    payload: { call: call?.id ?? payload.id, room: call?.room ?? "", who: payload.vars.sender ?? "", video: call?.video === true, at: call?.at ?? payload.at },
  };
}

/** The APNs request that carries a command to a device (see the top of this file). */
export function apnsRequestFor(device: IosDevice, command: Command, wire: CommandWire, notify?: Pick<NotifyPayload, "kind" | "group" | "lang" | "sound" | "call">): ApnsRequest & { via: "apns" | "voip" } {
  const expiration = Math.floor(command.expiresAt / 1000);
  const m5 = { ...wire };
  if (command.kind === "notify" && notify?.kind === "call" && device.voipToken) {
    return { via: "voip", token: device.voipToken, type: "voip", priority: 10, expiration, payload: { m5 }, env: device.apnsEnv };
  }
  if (ALERT.has(command.kind)) {
    const call = command.kind === "notify" && notify?.kind === "call" ? notify.call : undefined;
    const alert = neutralAlert(command.kind, command.kind === "notify" ? notify?.lang ?? device.locale : device.locale, notify?.kind, call?.end === true);
    const sound = command.kind === "push" || (command.kind === "notify" && notify?.sound !== false);
    // 6.14: a call's ring and its "missed call" share one id — the end replaces the ring in Notification Center.
    const collapseId = call ? `m5-call-${call.id}`.slice(0, 64) : command.kind === "notify" && notify?.group === "kind" ? `m5-notify-${notify.kind}` : undefined;
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
export async function sendIosNotify(device: IosDevice, payload: NotifyPayload, now = Date.now()): Promise<{ ok: boolean; status?: number; error?: string; unregistered?: boolean }> {
  const call = payload.kind === "call";
  const voip = call && Boolean(device.voipToken);
  // 6.14: a call's end over PushKit only while its ring can still ring there — later the phone ended the
  // ring itself (and recorded the missed call); a VoIP push now would only flash a call in CallKit.
  if (voip && payload.call?.end && now - payload.call.at > CALL_TTL_S * 1000) return { ok: true };
  if (!voip && !device.apnsToken) return { ok: false, error: "the device has no APNs token (it checks in instead)" };
  const ready = apnsReady();
  if (!ready.ready) return { ok: false, error: ready.reason };
  const command: Command = {
    id: newId("cmd"), deviceId: device.id, kind: "notify", payload, status: "queued",
    createdAt: now, createdBy: "notifier", expiresAt: now + (call ? CALL_TTL_S : TTL_S.notify) * 1000, sentAt: null, via: "", doneAt: null, result: null, error: "",
  };
  // 6.14: a VoIP push seals the call itself (voipCallContent); an alert the notification, as on Android.
  const wire = voip ? sealedWire(device, voipCallContent(command, payload)) : commandWire(device, command);
  const { via, ...req } = apnsRequestFor(device, command, wire, payload);
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
