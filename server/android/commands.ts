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
//
// 6.14: the wire form, the payloads and the queue are shared with iOS
// (server/mobile/commands.ts); this file is Android's transport (FCM).

import { acknowledgeCommand, COLLAPSE, commandWire, createCommand, HIGH, pendingCommands, TTL_S, type CommandWire } from "../mobile/commands";
import { fcmReady, fcmSend } from "./fcm";
import { androidStore, type Command, type CommandKind, type Device } from "./store";

export { COMMAND_KINDS, TTL_S, commandWire, sanitizePayload, type CommandWire } from "../mobile/commands";

export type SendOutcome = { command: Command; via: "fcm" | "poll"; error?: string };

/** Creates a command for a device and sends it (FCM) or queues it (check-in). */
export async function sendCommand(device: Device, kind: CommandKind, payload: unknown, by: string): Promise<SendOutcome> {
  const command = createCommand(androidStore, device, kind, payload, by);
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
  return pendingCommands(androidStore, device, now);
}

/** The device says what came of a command. */
export function acknowledge(device: Device, commandId: string, ok: boolean, result: unknown, error: string): Command | null {
  return acknowledgeCommand(androidStore, device, commandId, ok, result, error);
}
