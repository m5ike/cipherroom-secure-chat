// 6.2: hiding and deleting a message in one's own view (lib/message-hide.ts):
// the hide's end (a time, or the next sign-in), the tombstone of a deletion
// and how both survive the stored history, and the audit journal's request —
// metadata only, never the text.

import { describe, it, expect, vi, afterEach } from "vitest";
import type { ChatMessage } from "../client/src/lib/chat-types";
import {
  HIDE_CHOICES, auditBody, auditEntry, createAuditQueue, deleteMessage, endHides, hiddenCount, hideMessage, hideUntil, isDeleted, isHidden,
  mergeWithDeletions, nextHideEnd, postMessageAudit, unhideMessage,
} from "../client/src/lib/message-hide";
import { prepareHistory, sanitizeRestored } from "../client/src/lib/chat-history";

const T = 1_790_000_000_000;
const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({ id: "msg-1", senderId: "p-a", senderName: "Alice", text: "Tajný plán: sraz v 9", createdAt: T, mine: false, secure: true, ...over });

afterEach(() => { vi.useRealTimers(); });

describe("hiding", () => {
  it("offers 15 min, 1 h, 8 h, 1 day and until the next sign-in", () => {
    expect(HIDE_CHOICES.map((c) => c.id)).toEqual(["15m", "1h", "8h", "1d", "signin"]);
    expect(hideUntil("15m", T)).toBe(T + 900_000);
    expect(hideUntil("1h", T)).toBe(T + 3_600_000);
    expect(hideUntil("8h", T)).toBe(T + 8 * 3_600_000);
    expect(hideUntil("1d", T)).toBe(T + 86_400_000);
    expect(hideUntil("signin", T)).toBe(0);
  });

  it("hides until the time is up, and records it", () => {
    const m = hideMessage(msg(), T + 900_000, T);
    expect(m.hidden).toEqual({ at: T, until: T + 900_000 });
    expect(m.audit).toEqual([{ state: "hidden", at: T, meta: String(T + 900_000) }]);
    expect(isHidden(m, T + 899_999)).toBe(true);
    expect(isHidden(m, T + 900_000)).toBe(false);
    expect(nextHideEnd([m, msg({ id: "b" })], T)).toBe(T + 900_000);
    expect(hiddenCount([m, msg({ id: "b" })], T)).toBe(1);
  });

  it("ends timed hides when their time passes — with an 'unhidden' step at that time", () => {
    const list = [hideMessage(msg(), T + 1000, T), hideMessage(msg({ id: "b" }), 0, T), msg({ id: "c" })];
    expect(endHides(list, T + 500)).toBe(list); // nothing over yet: the same array
    const after = endHides(list, T + 2000);
    expect(after[0].hidden).toBeUndefined();
    expect(after[0].audit?.at(-1)).toEqual({ state: "unhidden", at: T + 1000, meta: "time" });
    expect(after[1].hidden).toEqual({ at: T, until: 0 }); // until the next sign-in: still hidden
    expect(isHidden(after[1], T + 10 * 86_400_000)).toBe(true);
    expect(after[2]).toBe(list[2]);
  });

  it("ends the hides 'until the next sign-in' at a sign-in", () => {
    const list = [hideMessage(msg(), 0, T), hideMessage(msg({ id: "b" }), T + 86_400_000, T)];
    const after = endHides(list, T + 60_000, true);
    expect(after[0].hidden).toBeUndefined();
    expect(after[0].audit?.at(-1)).toEqual({ state: "unhidden", at: T + 60_000, meta: "sign-in" });
    expect(after[1].hidden?.until).toBe(T + 86_400_000);
  });

  it("shows a message again by hand", () => {
    const m = unhideMessage(hideMessage(msg(), 0, T), T + 5);
    expect(m.hidden).toBeUndefined();
    expect(m.audit?.map((a) => a.state)).toEqual(["hidden", "unhidden"]);
    expect(unhideMessage(msg(), T)).toEqual(msg());
  });
});

describe("the stored history", () => {
  it("keeps a hide; a guest's next page load (or a sign-in) ends one until the next sign-in", () => {
    const stored = prepareHistory([hideMessage(msg(), 0, T), hideMessage(msg({ id: "b", createdAt: T + 1 }), Date.now() + 3_600_000, T)]);
    const reload = sanitizeRestored(JSON.parse(JSON.stringify(stored)));
    expect(reload.map((m) => Boolean(m.hidden))).toEqual([true, true]);
    const signIn = sanitizeRestored(JSON.parse(JSON.stringify(stored)), undefined, { signIn: true });
    expect(signIn.map((m) => Boolean(m.hidden))).toEqual([false, true]);
  });

  it("keeps a deletion as a tombstone with nothing of the message", () => {
    const full = msg({
      text: "Tajný plán", attachment: { kind: "file", name: "plan.pdf", mime: "application/pdf", size: 5, dataUrl: "data:application/pdf;base64,JVBERg==" },
      loc: { lat: 50, lon: 14 }, replyTo: { id: "m0", senderName: "Bob", text: "Kdy?" }, to: ["Bob"], cipher: "CIPHER", sealPlain: "p", sealCode: "c",
      audit: [{ state: "received", at: T }],
    });
    const gone = deleteMessage(full, T + 9);
    expect(gone).toEqual({ id: "msg-1", senderId: "p-a", senderName: "", text: "", createdAt: T, mine: false, secure: true, deletedAt: T + 9 });
    expect(isDeleted(gone)).toBe(true);
    const back = sanitizeRestored(JSON.parse(JSON.stringify(prepareHistory([gone]))));
    expect(back).toEqual([gone]);
    // A tombstone that somehow still carries content is emptied on the way in.
    const dirty = sanitizeRestored([{ ...full, deletedAt: T + 9 }]);
    expect(JSON.stringify(dirty)).not.toContain("Tajn");
    expect(dirty[0].attachment).toBeUndefined();
  });

  it("drops a malformed hide", () => {
    const r = sanitizeRestored([{ ...msg(), hidden: { at: "x", until: -1 } }, { ...msg({ id: "b" }), deletedAt: "yesterday" }]);
    expect(r[0].hidden).toBeUndefined();
    expect(r[1].deletedAt).toBeUndefined();
  });

  it("lets a deletion win over the live copy when the stores are merged", () => {
    const live = [msg(), msg({ id: "b", createdAt: T + 1 })];
    const merged = mergeWithDeletions(live, [deleteMessage(msg(), T + 5), msg({ id: "c", createdAt: T + 2 })]);
    expect(merged.map((m) => [m.id, isDeleted(m)])).toEqual([["msg-1", true], ["b", false], ["c", false]]);
    // …and a copy from a store never brings a deleted message back.
    const again = mergeWithDeletions(merged, [msg()]);
    expect(isDeleted(again[0])).toBe(true);
  });
});

describe("the audit journal", () => {
  const full = msg({
    mine: true, text: "Tajný plán", to: ["Bob"], loc: { lat: 50.1, lon: 14.4 },
    attachment: { kind: "image", name: "tajne.png", mime: "image/png", size: 3, dataUrl: "data:image/png;base64,AAAA" },
    cipher: "CIPHERTEXT", sealPlain: "x", sealCode: "123", replyTo: { id: "m0", senderName: "Bob", text: "citace" },
  });

  it("is told what happened — never the text, the file, the place or a key", () => {
    const e = auditEntry("hide", full, "r3.blindRoomId", T, T + 3_600_000);
    expect(e).toEqual({ action: "hide", messageId: "msg-1", room: "r3.blindRoomId", until: T + 3_600_000, kinds: ["text", "image", "location", "private", "reply"], mine: true, at: T });
    const d = auditEntry("delete", full, "r3.blindRoomId", T);
    expect(d).not.toHaveProperty("until");
    expect(auditEntry("hide", full, "r", T).until).toBe(0);
    const wire = JSON.stringify(auditBody([e, d], "dev-1"));
    for (const secret of ["Tajn", "tajne.png", "AAAA", "50.1", "CIPHERTEXT", "citace", "123", "Bob"]) expect(wire).not.toContain(secret);
  });

  it("sends one action as it is, several as a batch of up to 50", () => {
    const e = auditEntry("unhide", full, "r", T);
    expect(auditBody([e], "dev-1")).toEqual({ ...e, client: "dev-1" });
    expect(auditBody([e])).toEqual(e);
    expect(auditBody([e], "bad client!")).toEqual(e);
    const many = Array.from({ length: 60 }, () => e);
    expect((auditBody(many).actions as unknown[]).length).toBe(50);
  });

  it("collects the actions of a moment into one request", async () => {
    vi.useFakeTimers();
    const sent: Array<Record<string, unknown>> = [];
    const q = createAuditQueue(async (body) => { sent.push(body); }, { delayMs: 300, client: () => "dev-1" });
    q.push(auditEntry("hide", full, "r", T, 0));
    q.push(auditEntry("hide", msg({ id: "msg-2" }), "r", T, 0));
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(sent).toHaveLength(1);
    expect((sent[0].actions as Array<{ messageId: string }>).map((a) => a.messageId)).toEqual(["msg-1", "msg-2"]);
    expect(sent[0].client).toBe("dev-1");
    q.push(auditEntry("delete", full, "r", T));
    await q.flush();
    expect(sent[1]).toMatchObject({ action: "delete", messageId: "msg-1" });
  });

  it("swallows a failed request (the action already happened here)", async () => {
    const q = createAuditQueue(async () => { throw new Error("offline"); });
    q.push(auditEntry("delete", full, "r", T));
    await expect(q.flush()).resolves.toBeUndefined();
  });

  it("posts with the account's token when signed in", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    expect(await postMessageAudit({ action: "delete", messageId: "m", room: "r" }, "tok-1", fetcher)).toBe(true);
    expect(await postMessageAudit({ action: "delete", messageId: "m", room: "r" }, null, fetcher)).toBe(true);
    expect(calls[0].url).toBe("/api/chat/message-audit");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
