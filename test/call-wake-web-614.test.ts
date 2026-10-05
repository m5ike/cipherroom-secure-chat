// 6.14 — call wake, the web client's decisions (client/src/lib/call-wake.ts):
// when a call I start rings the away members and when hanging up ends that
// ring; the sealed payload and the relay frame's fields; checking a relayed
// call item like a message; and what a relayed item becomes — a missed call
// once, unless the room shows the call (then the room has it). Older clients
// drop the payload silently (validatePayload refuses an unknown kind).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { parseFrame } from "../server/signaling/frames";
import {
  CALL_RING_MS, CALL_SETTLE_MS, CALL_WAKE_FEATURE, CallWakeInbox, CallWakeSender,
  callRelayFields, callWakeMessageId, callWakePayload, parseCallWake, type CallWakePayload,
} from "../client/src/lib/call-wake";
import { validatePayload } from "../client/src/lib/validate";
import { t, tf } from "../client/src/lib/i18n";

const NOW = 1_760_000_000_000;
let n = 0;
const newCallId = () => `cw-${++n}`;

describe("the caller: a ring when I start a call nobody is in, its end when nobody answered", () => {
  it("rings the away members when the server wakes for calls and I start the call", () => {
    const s = new CallWakeSender();
    const ring = s.start({ serverWakes: true, othersInCall: 0, away: ["ref-a", "ref-b", "ref-a"], video: true, now: NOW, newCallId });
    expect(ring).toEqual({ callId: expect.stringMatching(/^cw-/), video: true, at: NOW, refs: ["ref-a", "ref-b"] });
    expect(s.ringing()).toEqual(ring);
  });

  it("rings nobody: an older server, someone already in the call (I join theirs), nobody away", () => {
    const s = new CallWakeSender();
    expect(s.start({ serverWakes: false, othersInCall: 0, away: ["ref-a"], video: false, now: NOW, newCallId })).toBeNull();
    expect(s.start({ serverWakes: true, othersInCall: 1, away: ["ref-a"], video: false, now: NOW, newCallId })).toBeNull();
    expect(s.start({ serverWakes: true, othersInCall: 0, away: [], video: false, now: NOW, newCallId })).toBeNull();
    expect(s.stop(["ref-a"])).toBeNull();
  });

  it("hanging up before anyone answered ends the ring for those still away; an answer means no end", () => {
    const s = new CallWakeSender();
    const ring = s.start({ serverWakes: true, othersInCall: 0, away: ["ref-a", "ref-b"], video: false, now: NOW, newCallId })!;
    expect(s.stop(["ref-b", "ref-c"])).toEqual({ ...ring, refs: ["ref-b"] });
    expect(s.stop(["ref-b"])).toBeNull(); // once
    s.start({ serverWakes: true, othersInCall: 0, away: ["ref-a"], video: false, now: NOW, newCallId });
    s.answered();
    expect(s.ringing()).toBeNull();
    expect(s.stop(["ref-a"])).toBeNull();
    s.start({ serverWakes: true, othersInCall: 0, away: ["ref-a"], video: false, now: NOW, newCallId });
    expect(s.stop([])).toBeNull(); // everyone came back: they see the room
  });

  it("the payload and the relay frame's fields — the server takes them", () => {
    const ring = callWakePayload({ callId: "cw-7", state: "ring", video: true, at: NOW - 5, senderId: "peer-1", senderName: "Bob", now: NOW });
    expect(ring).toEqual({ kind: "call", id: "cw-7:r", createdAt: NOW, senderId: "peer-1", senderName: "Bob", call: "cw-7", state: "ring", video: true, at: NOW - 5 });
    expect(callWakeMessageId("cw-7", "end")).toBe("cw-7:e");
    expect(callRelayFields({ callId: "cw-7", state: "ring", video: true })).toEqual({ call: true, callId: "cw-7", video: true });
    expect(callRelayFields({ callId: "cw-7", state: "end", video: false })).toEqual({ callEnd: true, callId: "cw-7" });
    const frame = parseFrame(JSON.stringify({ type: "relay", messageId: ring.id, to: ["ref-a"], envelope: { iv: "aXY=", ciphertext: "Y3Q=" }, ...callRelayFields({ callId: "cw-7", state: "end", video: true }) }));
    expect(frame).toMatchObject({ type: "relay", messageId: "cw-7:r", callEnd: true, callId: "cw-7", video: true });
    expect(CALL_WAKE_FEATURE).toBe("call-wake");
  });
});

describe("a relayed call item is checked like a message", () => {
  const item = (over: Record<string, unknown> = {}) => ({ ...callWakePayload({ callId: "cw-7", state: "ring", video: false, at: NOW - 1_000, senderId: "peer-1", senderName: "Bob", now: NOW - 1_000 }), ...over });

  it("takes a good one; the sender must be who relayed it, never us or a reserved id", () => {
    expect(parseCallWake(item(), { transportSender: "peer-1", myId: "me", now: NOW })).toMatchObject({ call: "cw-7", state: "ring", senderName: "Bob", at: NOW - 1_000 });
    expect(parseCallWake(item(), { transportSender: "peer-2", now: NOW })).toBeNull();
    expect(parseCallWake(item({ senderId: "me" }), { myId: "me", now: NOW })).toBeNull();
    expect(parseCallWake(item({ senderId: "system" }), { now: NOW })).toBeNull();
  });

  it("refuses what is not a call item, bounds the rest, holds a clock far ahead to now", () => {
    expect(parseCallWake({ ...item(), kind: "text" }, { now: NOW })).toBeNull();
    expect(parseCallWake(item({ state: "ringing" }), { now: NOW })).toBeNull();
    expect(parseCallWake(item({ call: "with space" }), { now: NOW })).toBeNull();
    expect(parseCallWake(item({ call: "x".repeat(91) }), { now: NOW })).toBeNull();
    expect(parseCallWake(null)).toBeNull();
    const ahead = parseCallWake(item({ at: NOW + 3_600_000, createdAt: NOW + 3_600_000, senderName: "B‮ob", video: "yes" }), { now: NOW })!;
    expect(ahead.at).toBe(NOW + 5 * 60_000);
    expect(ahead.senderName).toBe("Bob");
    expect(ahead.video).toBe(false);
  });

  it("an older client drops it silently: validatePayload refuses the kind", () => {
    expect(validatePayload(item(), { transportSender: "peer-1", myId: "me" })).toBeNull();
  });
});

describe("the receiver: a missed call once, unless the room shows the call", () => {
  const ring = (call = "cw-7", at = NOW - 2_000): CallWakePayload => callWakePayload({ callId: call, state: "ring", video: false, at, senderId: "peer-1", senderName: "Bob", now: at });
  const end = (call = "cw-7"): CallWakePayload => ({ ...ring(call), id: `${call}:e`, state: "end" });

  it("a ring waits for the room; nobody in a call by then — missed, once", () => {
    const box = new CallWakeInbox();
    expect(box.take(ring(), NOW, false)).toBeNull();
    expect(box.nextDue()).toBe(NOW + CALL_SETTLE_MS);
    expect(box.due(NOW + CALL_SETTLE_MS - 1)).toEqual([]);
    expect(box.due(NOW + CALL_SETTLE_MS)).toEqual([ring()]);
    expect(box.take(ring(), NOW + CALL_SETTLE_MS + 1, false)).toBeNull(); // the same call again: nothing
    expect(box.nextDue()).toBeNull();
  });

  it("the room shows the call (now or meanwhile): the room has it — nothing recorded", () => {
    const box = new CallWakeInbox();
    expect(box.take(ring("cw-1"), NOW, true)).toBeNull();
    expect(box.take(ring("cw-2"), NOW, false)).toBeNull();
    box.roomInCall();
    expect(box.due(NOW + CALL_RING_MS)).toEqual([]);
    expect(box.take(end("cw-2"), NOW, false)).toBeNull();
  });

  it("an end records the missed call at once (the ring's details), and only once", () => {
    const box = new CallWakeInbox();
    box.take(ring(), NOW, false);
    expect(box.take(end(), NOW + 1_000, false)).toEqual(ring());
    expect(box.due(NOW + CALL_SETTLE_MS)).toEqual([]);
    expect(box.take(end(), NOW + 2_000, false)).toBeNull();
    // An end whose ring never came is a missed call by itself.
    expect(new CallWakeInbox().take(end("cw-9"), NOW, false)).toMatchObject({ call: "cw-9", senderName: "Bob" });
  });

  it("says so in every language", () => {
    for (const lang of ["en", "cs", "de"] as const) {
      expect(t(lang, "call.wake.missed")).not.toBe("call.wake.missed");
      expect(tf(lang, "call.wake.missedVideo", { name: "Bob", time: "10:00" })).toContain("Bob");
    }
  });
});

/* ------------------------------------------------- the service worker */

describe("the service worker: the ring stays, its end takes its place quietly", () => {
  type Note = { title: string; options: Record<string, any>; closed?: boolean };
  function worker() {
    const handlers: Record<string, (e: unknown) => void> = {};
    const notes: Note[] = [];
    const self = {
      addEventListener: (type: string, fn: (e: unknown) => void) => { handlers[type] = fn; },
      registration: {
        showNotification: async (title: string, options: Record<string, any>) => { notes.push({ title, options }); },
        getNotifications: async () => notes.filter((x) => !x.closed).map((x) => ({ data: x.options.data, close: () => { x.closed = true; } })),
      },
      navigator: { language: "en-GB" },
      location: { origin: "https://chat.example.org" },
      clients: { claim: async () => undefined, matchAll: async () => [] },
      skipWaiting: () => undefined,
    };
    runInNewContext(readFileSync(join(__dirname, "..", "client", "public", "sw.js"), "utf8"), { self, URL, Map, Date, Object, String, Number, JSON, Math, Boolean, Promise });
    const push = async (data: unknown) => {
      let done: Promise<unknown> = Promise.resolve();
      handlers.push({ data: { json: () => data }, waitUntil: (p: Promise<unknown>) => { done = p; } });
      await done;
    };
    return { push, notes };
  }
  const base = {
    v: 1, id: "x", kind: "call", title: "M5cet", body: "Bob is calling you", privacy: "sender", tpl: { title: "{app}[ · {room}]", body: "{sender|Someone} is calling you" },
    vars: { app: "M5cet", sender: "Bob" }, tag: "m5-call-cw-7", group: "kind", icon: "phone", accent: "", sound: true, vibrate: true, sticky: true, actions: false, url: "/signin", lang: "en", at: 1,
    call: { id: "cw-7", video: false, at: 1 },
  };

  it("rings with sound and stays; the end closes it and shows a silent, dismissable missed call under the same tag", async () => {
    const sw = worker();
    await sw.push(base);
    expect(sw.notes[0].options).toMatchObject({ body: "Bob is calling you", tag: "m5-call-cw-7", requireInteraction: true, silent: false, renotify: true, data: { call: "cw-7", callEnd: false } });
    await sw.push({ ...base, body: "Bob: Missed call", tpl: { title: "{app}[ · {room}]", body: "[{sender}: ]Missed call" }, sound: false, vibrate: false, sticky: false, call: { id: "cw-7", video: false, at: 1, end: true } });
    expect(sw.notes[0].closed).toBe(true);
    expect(sw.notes[1].options).toMatchObject({ body: "Bob: Missed call", tag: "m5-call-cw-7", requireInteraction: false, silent: true, renotify: false, data: { call: "cw-7", callEnd: true } });
    expect(sw.notes[1].options).not.toHaveProperty("vibrate");
  });
});
