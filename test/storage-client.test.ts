// The browser side of the server storage (client/src/lib/storage-client.ts):
// which transport it uses, what identity it sends, and that the database key
// a passkey derived survives a reload without another prompt — wrapped, not
// lying about in clear text.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  _resetStorageClientForTests, attachStorageSocket, forgetServerData, getValue, openUserDatabase,
  putMessages, putValue, readMessages, recallDatabaseKey, rememberDatabaseKey, sendLog,
  setStorageToken, startStorageSession, storageSessionId, storageStatus,
} from "../client/src/lib/storage-client";

type Call = { url: string; method: string; body: Record<string, unknown> | null; headers: Record<string, string> };
let calls: Call[] = [];

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A socket that answers storage frames the way the server does. */
function fakeSocket(answer: (frame: { op: string; payload: Record<string, unknown> }) => Record<string, unknown>) {
  const listeners: Array<(event: MessageEvent) => void> = [];
  const sent: Array<Record<string, unknown>> = [];
  const socket = {
    readyState: 1, // OPEN
    addEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.push(listener),
    send: (raw: string) => {
      const frame = JSON.parse(raw) as { id: string; op: string; payload: Record<string, unknown>; auth?: string; session?: string };
      sent.push(frame);
      const data = answer(frame);
      queueMicrotask(() => {
        const event = { data: JSON.stringify({ type: "storage-result", id: frame.id, ...data }) } as MessageEvent;
        listeners.forEach((l) => l(event));
      });
    },
  };
  return { socket: socket as unknown as WebSocket, sent };
}

beforeEach(() => {
  calls = [];
  _resetStorageClientForTests();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null,
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    if (url.endsWith("/status")) return reply({ ok: true, available: true, engine: "sqlite+sqlcipher", caller: "none", openDatabases: 0, stats: null });
    if (url.endsWith("/session")) return reply({ ok: true, sessionId: "sess-abcdefghijklmnopqr", expiresAt: Date.now() + 86_400_000 });
    if (url.endsWith("/open")) return reply({ ok: true, databaseId: "db-1" });
    if (url.includes("/kv?key=")) return reply({ ok: true, value: { name: "Alice" } });
    if (url.endsWith("/messages")) return reply({ ok: true, stored: 2 });
    if (url.includes("/messages?")) return reply({ ok: true, messages: [{ id: "m1", room: "alpha", createdAt: 1, payload: { text: "hi" } }] });
    return reply({ ok: true });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  _resetStorageClientForTests();
  sessionStorage.clear();
});

describe("without a socket", () => {
  it("asks over REST and carries the identity it was given", async () => {
    expect(await storageStatus()).toMatchObject({ available: true, engine: "sqlite+sqlcipher" });

    setStorageToken("account-token-123456789");
    await openUserDatabase("b".repeat(64));
    const opened = calls.at(-1)!;
    expect(opened).toMatchObject({ url: "/api/storage/open", method: "POST", body: { key: "b".repeat(64) } });
    expect(opened.headers.Authorization).toBe("Bearer account-token-123456789");
  });

  it("starts a session store and sends its id from then on", async () => {
    const session = await startStorageSession();
    expect(session?.sessionId).toBe("sess-abcdefghijklmnopqr");
    expect(storageSessionId()).toBe("sess-abcdefghijklmnopqr");

    await putValue("draft", "unsent");
    expect(calls.at(-1)!.headers["X-M5cet-Session"]).toBe("sess-abcdefghijklmnopqr");
    expect(await getValue<{ name: string }>("profile")).toEqual({ name: "Alice" });
  });

  it("stores and reads a conversation", async () => {
    setStorageToken("t-123456789012345678");
    expect(await putMessages([
      { id: "m1", room: "alpha", createdAt: 1, payload: { text: "one" } },
      { id: "m2", room: "alpha", createdAt: 2, payload: { text: "two" } },
    ])).toBe(2);
    expect(await readMessages({ room: "alpha" })).toMatchObject([{ id: "m1" }]);
  });

  it("never throws at the caller when the server says no", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ ok: false, message: "locked", code: "locked" }, 409)));
    expect(await putValue("x", 1)).toBe(false);
    expect(await getValue("x")).toBeNull();
    expect(await readMessages()).toEqual([]);
    expect(await putMessages([{ id: "m", room: "a", createdAt: 1, payload: {} }])).toBe(0);
    await expect(sendLog("warn", "noop")).resolves.toBeUndefined();
  });
});

describe("with the signaling socket", () => {
  it("rides on the open connection instead of a new request", async () => {
    const { socket, sent } = fakeSocket(() => ({ ok: true, data: { stored: true } }));
    attachStorageSocket(socket);
    setStorageToken("account-token-123456789");

    expect(await putValue("profile", { name: "Alice" })).toBe(true);
    expect(sent).toMatchObject([{ op: "kv.put", payload: { key: "profile", value: { name: "Alice" } }, auth: "account-token-123456789" }]);
    // No HTTP request was needed at all.
    expect(calls).toEqual([]);
  });

  it("passes a refusal through rather than retrying over REST", async () => {
    const { socket } = fakeSocket(() => ({ ok: false, message: "send the key first", code: "locked" }));
    attachStorageSocket(socket);
    expect(await putValue("profile", { name: "Alice" })).toBe(false);
    expect(calls).toEqual([]);
  });

  it("falls back to REST when the socket is gone", async () => {
    const { socket } = fakeSocket(() => ({ ok: true }));
    attachStorageSocket(socket);
    (socket as unknown as { readyState: number }).readyState = 3; // CLOSED
    expect(await putValue("profile", { name: "Alice" })).toBe(true);
    expect(calls.at(-1)).toMatchObject({ url: "/api/storage/kv", method: "PUT" });
  });
});

describe("the database key", () => {
  it("comes back after a reload, and only with the vault key", async () => {
    const vaultKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await rememberDatabaseKey("c".repeat(64), vaultKey);

    // What is stored is ciphertext, not the key.
    const stored = sessionStorage.getItem("m5cet:storage:dbkey:v1")!;
    expect(stored).not.toContain("c".repeat(64));

    _resetStorageClientForTests.call(null); // a reload keeps sessionStorage
    sessionStorage.setItem("m5cet:storage:dbkey:v1", stored);
    expect(await recallDatabaseKey(vaultKey)).toBe("c".repeat(64));

    const otherKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    _resetStorageClientForTests();
    sessionStorage.setItem("m5cet:storage:dbkey:v1", stored);
    expect(await recallDatabaseKey(otherKey)).toBeNull();
  });

  it("is forgotten when everything is cleared", async () => {
    const vaultKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await startStorageSession();
    await rememberDatabaseKey("d".repeat(64), vaultKey);

    expect(await forgetServerData()).toBe(true);
    expect(calls.at(-1)).toMatchObject({ url: "/api/storage", method: "DELETE" });
    expect(storageSessionId()).toBeNull();
    expect(sessionStorage.getItem("m5cet:storage:dbkey:v1")).toBeNull();
  });
});
