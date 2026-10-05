// 6.14 — call wake (docs/api.md › Buzení při hovoru).
//
// Calls in a room do not ring over the network: someone's audio going live
// is the announcement, and only members on a live data channel see it. A
// member who is AWAY (no awake socket: the page suspended, the app in the
// background or closed) never did — so when I start a call, my client relays
// ONE call item to the away members, sealed like a message (their devices'
// mailboxes, else the room envelope), and the server wakes them with kind
// "call" (Android, web push, iOS PushKit — notify/dispatch.ts). When I hang
// up before anyone answered, a second item ends the ring. The item itself
// is what the member's client finds when it comes back: a missed call,
// unless the room shows that call meanwhile (then the room's own call
// tracking has it — one record per call).
//
// The sealed payload (older clients drop an unknown `kind` silently — web
// validate.ts, Android Payloads.validate, iOS Payloads.validate):
//
//   { kind: "call", id, createdAt, senderId, senderName,
//     call: "<call id>", state: "ring" | "end", video, at }
//
// The relay frame adds `call: true` (ring) or `callEnd: true` (end), `callId`
// and `video` — sent only to a server whose hello lists "call-wake".
//
// Pure: App.tsx feeds it (the call's start and end, the peers' audio, the
// away list, the relayed items); this module decides. Android's
// chat/CallWake.java and the iOS port do exactly the same.

import { normalizeDisplayName } from "./names";
import { isReservedSender, PAYLOAD_LIMITS } from "./validate";

/** The hello feature of a server that wakes for calls (server/signaling/frames.ts KNOWN_FEATURES). */
export const CALL_WAKE_FEATURE = "call-wake";
/** A ring rings at most this long (the server's push expiry on every channel). */
export const CALL_RING_MS = 60_000;
/** A relayed ring waits this long for the room to show its call before it counts as missed. */
export const CALL_SETTLE_MS = 30_000;

export type CallWakeState = "ring" | "end";

export type CallWakePayload = {
  kind: "call";
  id: string;
  createdAt: number;
  senderId: string;
  senderName: string;
  /** The call's id (the caller's; the server sees it too). */
  call: string;
  state: CallWakeState;
  video: boolean;
  /** When the call started (the caller's clock). */
  at: number;
};

const CALL_ID = /^[A-Za-z0-9_:.-]{1,90}$/;

/** The relay message id of a call's ring / end: the queue deduplicates a repeated one. */
export const callWakeMessageId = (callId: string, state: CallWakeState): string => `${callId}:${state === "ring" ? "r" : "e"}`;

export function callWakePayload(o: { callId: string; state: CallWakeState; video: boolean; at: number; senderId: string; senderName: string; now: number }): CallWakePayload {
  return { kind: "call", id: callWakeMessageId(o.callId, o.state), createdAt: o.now, senderId: o.senderId, senderName: o.senderName, call: o.callId, state: o.state, video: o.video, at: o.at };
}

/** What the relay frame adds for a ring or an end (server/signaling/frames.ts). */
export function callRelayFields(o: { callId: string; state: CallWakeState; video: boolean }): { call?: true; callEnd?: true; callId: string; video?: true } {
  return { ...(o.state === "ring" ? { call: true as const } : { callEnd: true as const }), callId: o.callId, ...(o.video ? { video: true as const } : {}) };
}

/**
 * A decrypted relayed payload that is a call item — checked like a message
 * (validate.ts): its sender must be the peer the server says relayed it, never
 * us or a reserved id; bounded; a clock far ahead is held to now. null when it
 * is not one (then validatePayload decides, as before).
 */
export function parseCallWake(value: unknown, opts: { transportSender?: string; myId?: string; now?: number } = {}): CallWakePayload | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  if (p.kind !== "call") return null;
  const now = opts.now ?? Date.now();
  const id = typeof p.id === "string" && p.id.length > 0 && p.id.length <= PAYLOAD_LIMITS.idChars ? p.id : null;
  const senderId = typeof p.senderId === "string" && p.senderId.length > 0 && p.senderId.length <= PAYLOAD_LIMITS.idChars ? p.senderId : null;
  if (!id || !senderId || isReservedSender(senderId)) return null;
  if (opts.myId && senderId === opts.myId) return null;
  if (opts.transportSender && senderId !== opts.transportSender) return null;
  if (typeof p.call !== "string" || !CALL_ID.test(p.call)) return null;
  if (p.state !== "ring" && p.state !== "end") return null;
  const clamp = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), now + PAYLOAD_LIMITS.futureSkewMs) : now);
  return {
    kind: "call", id, createdAt: clamp(p.createdAt), senderId,
    senderName: normalizeDisplayName(p.senderName, PAYLOAD_LIMITS.nameChars) || `peer-${senderId.slice(-4)}`,
    call: p.call, state: p.state, video: p.video === true, at: clamp(p.at),
  };
}

export type CallRing = { callId: string; video: boolean; at: number; refs: string[] };

/**
 * The caller's side of one call: whether starting it rings the away members,
 * and whether hanging up tells them it ended.
 */
export class CallWakeSender {
  private current: (CallRing & { answered: boolean }) | null = null;

  /**
   * I turned my audio on. A ring when the server wakes for calls, nobody else
   * is in the call (I start it — an outgoing call, as Android's CallTrack
   * says) and somebody is away; null otherwise (joining someone's call rings
   * nobody).
   */
  start(o: { serverWakes: boolean; othersInCall: number; away: string[]; video: boolean; now: number; newCallId: () => string }): CallRing | null {
    this.current = null;
    if (!o.serverWakes || o.othersInCall > 0) return null;
    const refs = [...new Set(o.away)].slice(0, 50);
    if (refs.length === 0) return null;
    const ring = { callId: o.newCallId(), video: o.video, at: o.now, refs };
    this.current = { ...ring, answered: false };
    return ring;
  }

  /** Someone else's audio went on (live or muted) while my ring was out: answered — no end. */
  answered(): void {
    if (this.current) this.current.answered = true;
  }

  /** The ring that is out (for the info view and tests). */
  ringing(): CallRing | null {
    return this.current && !this.current.answered ? { callId: this.current.callId, video: this.current.video, at: this.current.at, refs: this.current.refs } : null;
  }

  /**
   * I hung up: the end of my ring when nobody answered it — to those of its
   * members who are still away (who came back sees the room). null otherwise.
   */
  stop(awayNow: string[]): CallRing | null {
    const c = this.current;
    this.current = null;
    if (!c || c.answered) return null;
    const still = new Set(awayNow);
    const refs = c.refs.filter((r) => still.has(r));
    return refs.length ? { callId: c.callId, video: c.video, at: c.at, refs } : null;
  }
}

/**
 * The receiver's side: relayed call items. A ring waits CALL_SETTLE_MS for the
 * room to show its call (then the room has it — nothing to record); one that
 * does not show, or an end, is a missed call — once per call.
 */
export class CallWakeInbox {
  private pending = new Map<string, { item: CallWakePayload; until: number }>();
  private done = new Set<string>();

  private finish(callId: string): void {
    this.pending.delete(callId);
    this.done.add(callId);
    if (this.done.size > 500) this.done.delete(this.done.values().next().value as string);
  }

  /**
   * A relayed item. `roomInCall`: someone's audio is on in the room now (or mine).
   * Returns a missed call to record now, or null (waiting, or nothing to do).
   */
  take(item: CallWakePayload, now: number, roomInCall: boolean): CallWakePayload | null {
    if (this.done.has(item.call)) return null;
    if (item.state === "end") {
      const ring = this.pending.get(item.call)?.item;
      this.finish(item.call);
      return ring ?? item;
    }
    if (roomInCall) { this.finish(item.call); return null; }
    if (!this.pending.has(item.call)) this.pending.set(item.call, { item, until: now + CALL_SETTLE_MS });
    return null;
  }

  /** The room shows a call now: the waiting rings are that call — the room has it. */
  roomInCall(): void {
    for (const id of [...this.pending.keys()]) this.finish(id);
  }

  /** The rings whose time is up: missed calls. */
  due(now: number): CallWakePayload[] {
    const out: CallWakePayload[] = [];
    for (const [id, p] of [...this.pending]) if (p.until <= now) { out.push(p.item); this.finish(id); }
    return out;
  }

  /** When the next waiting ring is due (null: none). */
  nextDue(): number | null {
    let next: number | null = null;
    for (const p of this.pending.values()) if (next === null || p.until < next) next = p.until;
    return next;
  }

  /** The room was left: nothing waits any more. */
  clear(): void {
    this.pending.clear();
  }
}
