// 6.2: a message's timeline (the vocabulary the Android app shares), its
// receipts by recipient, its kinds and its size (lib/message-timeline.ts).

import { describe, it, expect } from "vitest";
import type { ChatMessage } from "../client/src/lib/chat-types";
import { MSG_STATES, isMsgState, messageKinds, messageSize, receiptsOf, timelineOf, withAudit } from "../client/src/lib/message-timeline";

const T = 1_790_000_000_000;
const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({ id: "msg-1", senderId: "p-a", senderName: "Alice", text: "Ahoj", createdAt: T, mine: true, secure: true, ...over });

describe("states", () => {
  it("are the shared vocabulary", () => {
    for (const s of ["created", "encrypted", "sent", "queued", "stored", "forwarded", "delivered", "read", "received", "decrypted", "displayed", "revealed", "opened", "expired", "hidden", "unhidden"]) {
      expect(isMsgState(s)).toBe(true);
    }
    expect(MSG_STATES).toContain("discarded"); // what 6.1 and older recorded for "expired"
    expect(isMsgState("seen")).toBe(false);
  });

  it("happen once — per recipient for the receipts", () => {
    let m = withAudit(msg(), "created", T);
    m = withAudit(m, "created", T + 5);
    m = withAudit(m, "delivered", T + 10, "Bob");
    m = withAudit(m, "delivered", T + 11, "Bob");
    m = withAudit(m, "delivered", T + 12, "Carol");
    m = withAudit(m, "opened", T + 20);
    m = withAudit(m, "opened", T + 21);
    expect(m.audit).toEqual([
      { state: "created", at: T },
      { state: "delivered", at: T + 10, meta: "Bob" },
      { state: "delivered", at: T + 12, meta: "Carol" },
      { state: "opened", at: T + 20 },
    ]);
  });

  it("keeps each reveal of a hold-to-read message, not each twitch", () => {
    let m = msg({ flags: { tap: true } });
    m = withAudit(m, "revealed", T);
    m = withAudit(m, "revealed", T + 800);
    m = withAudit(m, "revealed", T + 5_000);
    expect(m.audit?.map((a) => a.at)).toEqual([T, T + 5_000]);
  });

  it("returns the same message when nothing is added (no re-render)", () => {
    const m = withAudit(msg(), "displayed", T);
    expect(withAudit(m, "displayed", T + 1)).toBe(m);
  });

  it("are listed in the order they happened", () => {
    const m = msg({ audit: [{ state: "read", at: T + 30, meta: "Bob" }, { state: "created", at: T }, { state: "sent", at: T + 2 }, { state: "encrypted", at: T + 2 }] });
    expect(timelineOf(m).map((a) => a.state)).toEqual(["created", "sent", "encrypted", "read"]);
    expect(timelineOf(msg({ mine: false }))).toEqual([{ state: "received", at: T }]);
  });
});

describe("receipts", () => {
  it("are grouped by recipient with the first time of each step", () => {
    const m = msg({
      audit: [
        { state: "created", at: T },
        { state: "stored", at: T + 5, meta: "Dan" },
        { state: "delivered", at: T + 9, meta: "Bob" },
        { state: "read", at: T + 40, meta: "Bob" },
        { state: "delivered", at: T + 8, meta: "Bob" },
        { state: "forwarded", at: T + 60, meta: "Dan" },
        { state: "sent", at: T + 1, meta: "2 recipients" },
      ],
    });
    expect(receiptsOf(m)).toEqual([
      { name: "Bob", delivered: T + 8, read: T + 40 },
      { name: "Dan", stored: T + 5, forwarded: T + 60 },
    ]);
  });

  it("belong to my own messages only", () => {
    expect(receiptsOf(msg({ mine: false, audit: [{ state: "stored", at: T, meta: "server" }] }))).toEqual([]);
  });
});

describe("kinds and size", () => {
  it("name everything a message is, as the audit journal does", () => {
    expect(messageKinds(msg())).toEqual(["text"]);
    expect(messageKinds(msg({
      text: "", to: ["Bob"], forwardedFrom: "Dan", replyTo: { id: "m0", senderName: "Bob", text: "?" }, loc: { lat: 1, lon: 2 },
      flags: { tap: true, vanishSeconds: 15, sealed: { iv: "i", salt: "s" } },
      attachment: { kind: "file", name: "a.mp4", mime: "video/mp4", size: 9, dataUrl: "" },
    }))).toEqual(["video", "location", "tap", "vanish", "sealed", "private", "forwarded", "reply"]);
    expect(messageKinds(msg({ attachment: { kind: "image", name: "a.png", mime: "image/png", size: 1, dataUrl: "" } }))).toEqual(["text", "image"]);
    expect(messageKinds(msg({ text: "", attachment: { kind: "file", name: "v.webm", mime: "audio/webm", size: 1, dataUrl: "" } }))).toEqual(["audio"]);
    expect(messageKinds(msg({ flags: { fn: { keyword: "dns", name: "DNS" } } }))).toEqual(["fn"]);
  });

  it("weighs the text in UTF-8 bytes and the file", () => {
    expect(messageSize(msg({ text: "čau" }))).toEqual({ text: 4, file: 0 });
    expect(messageSize(msg({ text: "", attachment: { kind: "file", name: "a", mime: "text/plain", size: 1234, dataUrl: "" } }))).toEqual({ text: 0, file: 1234 });
    // My own sealed message: the text I wrote, not the ciphertext.
    expect(messageSize(msg({ text: "Q0lQSEVSVEVYVA==", sealPlain: "hi", flags: { sealed: { iv: "i", salt: "s" } } }))).toEqual({ text: 2, file: 0 });
  });
});
