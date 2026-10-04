// 6.10 (security review G-12, G-13): the side paths of sending — a file from
// the Files panel, a location, a text from the Speech panel, an attachment,
// Forward — follow the same two promises as a message from the composer:
//
//  · the recipient selection holds (G-12): what is meant for chosen people
//    goes only to them, never to the whole room; where a path cannot be
//    private (the server's relay reaches everyone in the room) it refuses;
//  · the message options are never dropped in silence (G-13): what a path
//    can carry it carries (tap-to-reveal and disappearing on an attachment
//    sent inline, a forwarded message's own kinds), and what it cannot (a
//    seal on a file, any kind on a large file) is said before it goes — the
//    app asks, and nothing is sent unless the person agrees.
//
// Pure: App.tsx asks these and does the sending.

import type { MsgFlags } from "./message-kinds";

/** The send options' message kinds (components/SendOptions.tsx › SendState). */
export type SendKinds = { tap: boolean; vanishSeconds: number; sealed: boolean; sealCode: string; asVoice: boolean };
export type KindName = "sealed" | "tap" | "vanish";

/** A resolved recipient selection (App.tsx › resolveRecipients): no `targets` = the whole room; null = a private send with nobody chosen. */
export type Recipients = { targets?: ReadonlySet<string>; toNames?: string[] } | null;

/**
 * G-13: what of the chosen kinds an attachment can carry. Inline (in the
 * chat message): tap and vanish yes, the seal no (it encrypts a text body
 * with a code; a file has none). A large file (the chunked transfer): none
 * of them — it is a file card, not a message. `dropped`: what would not
 * apply, for the question before sending.
 */
export function attachmentKinds(send: SendKinds, large: boolean): { send: SendKinds; dropped: KindName[] } {
  const dropped: KindName[] = [];
  if (send.sealed) dropped.push("sealed");
  if (large && send.tap) dropped.push("tap");
  if (large && send.vanishSeconds > 0) dropped.push("vanish");
  return { send: { ...send, sealed: false, sealCode: "", ...(large ? { tap: false, vanishSeconds: 0 } : {}) }, dropped };
}

/**
 * G-13: Forward sends the message as it was — tap-to-reveal and disappearing
 * stay, and the author's own sealed message goes sealed again with its code
 * (6.9 sent it unsealed and a disappearing one as permanent). A sealed message
 * whose code this app does not have (someone else's, or an own one after a
 * reload) cannot be forwarded: it would arrive as unreadable ciphertext, or
 * in clear.
 */
export function forwardPlan(m: { mine: boolean; text: string; sealPlain?: string; sealCode?: string; flags?: MsgFlags }): { ok: true; text: string; send: SendKinds } | { ok: false; reason: "sealed" } {
  const f = m.flags;
  const send: SendKinds = { tap: Boolean(f?.tap), vanishSeconds: f?.vanishSeconds && f.vanishSeconds > 0 ? f.vanishSeconds : 0, sealed: false, sealCode: "", asVoice: false };
  if (f?.sealed) {
    if (!m.mine || !m.sealPlain || !m.sealCode) return { ok: false, reason: "sealed" };
    return { ok: true, text: m.sealPlain, send: { ...send, sealed: true, sealCode: m.sealCode } };
  }
  return { ok: true, text: m.text, send };
}

/**
 * G-12: a large file from the Files panel goes to the selection like a
 * message: the whole room (no targets), or only the chosen people — and then
 * only over their direct channels (file-transfer.ts › largeFileRoute refuses
 * the relay). Chosen people who are all away cannot get a large file at all.
 */
export function largeFileTargets(rec: Recipients): { ok: true; targets?: Set<string> } | { ok: false; error: "none" | "chosen-away" } {
  if (!rec) return { ok: false, error: "none" };
  if (!rec.targets) return { ok: true };
  if (rec.targets.size === 0) return { ok: false, error: "chosen-away" };
  return { ok: true, targets: new Set(rec.targets) };
}

/**
 * G-12: who an update of a live location goes to. The selection is fixed
 * when the sharing starts (`snapshot`) and never widens: changing the
 * recipients later (to write to everyone) does not make the location public.
 * Of chosen people only those connected now get an update — a position is
 * not queued for later; `send: false` when none is.
 */
export function liveLocationTargets(snapshot: Exclude<Recipients, null>, isOpen: (peerId: string) => boolean): { send: boolean; targets?: Set<string> } {
  if (!snapshot.targets) return { send: true };
  const targets = new Set([...snapshot.targets].filter(isOpen));
  return targets.size ? { send: true, targets } : { send: false };
}
