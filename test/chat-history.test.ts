// Chat history (client/src/lib/chat-history.ts): what survives being stored.
// A conversation must never fail to save because someone sent a video, and a
// restored history must not resurrect messages that already expired.

import { describe, it, expect, beforeEach } from "vitest";
import { HISTORY_LIMITS, createHistoryStore, historyStats, isChatRetention, prepareHistory, sanitizeRestored } from "../client/src/lib/chat-history";
import type { ChatMessage } from "../client/src/lib/chat-types";

function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: over.id ?? `m-${Math.random().toString(36).slice(2)}`,
    senderId: "peer-1",
    senderName: "Bob",
    text: "hello",
    createdAt: Date.now(),
    mine: false,
    secure: true,
    ...over,
  };
}

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(k: string) { return this.map.get(k) ?? null; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  removeItem(k: string) { this.map.delete(k); }
  setItem(k: string, v: string) { this.map.set(k, v); }
  [name: string]: unknown;
}

describe("retention modes", () => {
  it("recognises exactly the three modes", () => {
    expect(["ephemeral", "session", "server"].every(isChatRetention)).toBe(true);
    expect(isChatRetention("forever")).toBe(false);
    expect(isChatRetention(undefined)).toBe(false);
  });
});

describe("prepareHistory", () => {
  it("drops the on-wire ciphertext and keeps the message itself", () => {
    const [kept] = prepareHistory([message({ text: "keep me", cipher: "A".repeat(5000) })]);
    expect(kept.text).toBe("keep me");
    expect(kept.cipher).toBeUndefined();
  });

  it("keeps a small inline attachment but reduces a large one to its metadata", () => {
    const small = message({ attachment: { kind: "file" as const, name: "note.txt", mime: "text/plain", size: 12, dataUrl: "data:text/plain;base64,aGVsbG8=" } });
    const huge = message({ attachment: { kind: "file" as const, name: "clip.mp4", mime: "video/mp4", size: 9_000_000, dataUrl: `data:video/mp4;base64,${"A".repeat(HISTORY_LIMITS.maxAttachmentChars + 1)}` } });
    const blob = message({ attachment: { kind: "image" as const, name: "photo.jpg", mime: "image/jpeg", size: 1000, dataUrl: "blob:https://chat.example/abc" } });
    const [a, b, c] = prepareHistory([small, huge, blob]);
    expect(a.attachment?.dataUrl).toContain("data:text/plain");
    expect(b.attachment).toMatchObject({ name: "clip.mp4", size: 9_000_000, dataUrl: "", dropped: true });
    expect(c.attachment).toMatchObject({ name: "photo.jpg", dropped: true });
  });

  it("keeps the newest messages within the count and byte budgets", () => {
    const many = Array.from({ length: HISTORY_LIMITS.maxMessages + 40 }, (_, i) => message({ id: `m${i}`, text: `msg ${i}` }));
    const kept = prepareHistory(many);
    expect(kept).toHaveLength(HISTORY_LIMITS.maxMessages);
    expect(kept.at(-1)!.id).toBe(`m${many.length - 1}`);
    expect(kept[0].id).toBe(`m${many.length - HISTORY_LIMITS.maxMessages}`);

    const fat = Array.from({ length: 40 }, (_, i) => message({ id: `f${i}`, text: "x".repeat(200_000) }));
    const trimmed = prepareHistory(fat);
    expect(historyStats(trimmed).bytes).toBeLessThanOrEqual(HISTORY_LIMITS.maxBytes);
    expect(trimmed.at(-1)!.id).toBe("f39"); // the newest is always kept
  });

  it("leaves out messages that already vanished and trims long audit trails", () => {
    const audit = Array.from({ length: 30 }, (_, i) => ({ state: "sent" as const, at: i }));
    const kept = prepareHistory([message({ vanished: true, vanishedAt: Date.now() }), message({ id: "keep", audit })]);
    expect(kept.map((m) => m.id)).toEqual(["keep"]);
    expect(kept[0].audit).toHaveLength(12);
  });
});

describe("sanitizeRestored", () => {
  it("skips junk and expired messages, and re-decides what is mine", () => {
    const restored = sanitizeRestored([
      null,
      { id: "no-timestamp" },
      message({ id: "old", expiresAt: Date.now() - 1000 }),
      message({ id: "live", senderId: "me-now", mine: false }),
    ], "me-now");
    expect(restored.map((m) => m.id)).toEqual(["live"]);
    expect(restored[0].mine).toBe(true);
  });

  it("returns nothing for a non-array", () => {
    expect(sanitizeRestored("nope")).toEqual([]);
    expect(sanitizeRestored(undefined)).toEqual([]);
  });
});

describe("session-scoped store", () => {
  let storage: MemoryStorage;
  let keys: Map<string, CryptoKey>;

  beforeEach(() => {
    storage = new MemoryStorage();
    keys = new Map();
  });

  it("stores the conversation as ciphertext and reads it back", async () => {
    const store = createHistoryStore({ storage, keys });
    await store.save("alpha", [message({ id: "m1", text: "a secret sentence" })]);

    const raw = storage.getItem("m5cet:history:v1")!;
    expect(raw).not.toContain("a secret sentence");
    expect(JSON.parse(raw)).toMatchObject({ v: 1, room: "alpha" });

    const back = await store.load("alpha");
    expect(back.map((m) => m.text)).toEqual(["a secret sentence"]);
  });

  it("does not hand the history to a different room", async () => {
    const store = createHistoryStore({ storage, keys });
    await store.save("alpha", [message({ text: "room alpha only" })]);
    expect(await store.load("beta")).toEqual([]);
  });

  it("forgets everything on clear — the key too", async () => {
    const store = createHistoryStore({ storage, keys });
    await store.save("alpha", [message()]);
    await store.clear();
    expect(storage.getItem("m5cet:history:v1")).toBeNull();
    expect(keys.size).toBe(0);
    expect(await store.load("alpha")).toEqual([]);
  });

  it("cannot be read without the key (a new session starts empty)", async () => {
    await createHistoryStore({ storage, keys }).save("alpha", [message()]);
    const otherSession = createHistoryStore({ storage, keys: new Map() });
    expect(await otherSession.load("alpha")).toEqual([]);
  });

  it("stays quiet when storage is unavailable", async () => {
    const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } } as unknown as Storage;
    const store = createHistoryStore({ storage: throwing, keys });
    await expect(store.save("alpha", [message()])).resolves.toBeUndefined();
    await expect(store.load("alpha")).resolves.toEqual([]);
  });
});

describe("history kept by the server for a browser without a passkey", () => {
  it("is sealed here, bound to its message, and never carries a sealed message's secrets", async () => {
    const { createServerSealer } = await import("../client/src/lib/chat-history");
    const keys = new Map<string, CryptoKey>();
    const sealer = createServerSealer({ keys });
    const m = { id: "m-1", senderId: "p", senderName: "Alice", text: "tajné", createdAt: 1, mine: true, secure: true, sealPlain: "plain", sealCode: "CODE", cipher: "x" };
    const row = await sealer.seal(m);
    expect(JSON.stringify(row)).not.toContain("tajné");
    expect(JSON.stringify(row)).not.toContain("Alice");
    const opened = await sealer.open("m-1", row) as Record<string, unknown>;
    expect(opened).toMatchObject({ id: "m-1", text: "tajné", mine: true });
    expect(opened).not.toHaveProperty("sealPlain");
    expect(opened).not.toHaveProperty("sealCode");
    // Moved to another row id: it does not open.
    expect(await sealer.open("m-2", row)).toBeNull();
    // Another browser (another key) cannot open it either.
    expect(await createServerSealer({ keys: new Map() }).open("m-1", row)).toBeNull();
  });
});
