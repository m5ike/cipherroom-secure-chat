// @vitest-environment node
//
// The storage API over HTTP and over the signaling socket — the same
// operations either way (server/storage/api.ts). What matters here is who
// may touch what: a signed-in user reaches their own database only after
// they have sent the key their passkey derived, a session reaches its own
// temporary one, and neither can see the other's.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.WEBAUTHN_RP_ID = "localhost";
  process.env.ADMIN_API_TOKEN = "storage-operator-token";
});

import express from "express";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { AccountStore } from "../server/accounts/store";
import { StorageService } from "../server/storage/service";
import { registerStorageRoutes } from "../server/storage/routes";
import { handleStorageFrame, newStorageSocketState, type StorageSocketState } from "../server/storage/ws";
import { apiContext } from "../server/storage/api";
import { _resetMasterKeyForTests } from "../server/storage/keys";
import { WsClient } from "./helpers/ws-client";
import type { StoredCredential } from "../server/accounts/webauthn";

const dbKey = () => randomBytes(32).toString("hex");

let dir = "";
let storage: StorageService;
let accounts: AccountStore;
let server: Server;
let base = "";
let token = "";
let accountId = "";

const credential = (id: string): StoredCredential => ({ credentialId: id, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 1 });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-storage-api-"));
  _resetMasterKeyForTests();
  process.env.STORAGE_MASTER_KEY = randomBytes(32).toString("base64");

  storage = new StorageService(join(dir, "storage"));
  expect((await storage.init()).ok).toBe(true);
  accounts = new AccountStore(join(dir, "accounts"));
  const created = accounts.create(credential("cred-alice-00000001"), "Alice");
  if (!created.ok) throw new Error(created.reason);
  accountId = created.account.id;
  token = accounts.issueToken(accountId);

  const app = express();
  registerStorageRoutes(app, storage, accounts);
  server = createServer(app);

  // The same handler the signaling socket uses.
  const wss = new WebSocketServer({ server, path: "/ws" });
  const ctx = apiContext(storage, accounts);
  wss.on("connection", (socket: WebSocket) => {
    const state: StorageSocketState = newStorageSocketState();
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString("utf8")) as { type: string };
      if (frame.type !== "storage") return;
      handleStorageFrame(socket, state, frame as never, (s, payload) => s.send(JSON.stringify(payload)), ctx);
    });
    socket.send(JSON.stringify({ type: "hello" }));
  });

  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  storage.close();
  delete process.env.STORAGE_MASTER_KEY;
  rmSync(dir, { recursive: true, force: true });
});

type Options = { token?: string; session?: string; body?: unknown; method?: string };

async function call(path: string, opts: Options = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: {
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.session ? { "x-m5cet-session": opts.session } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function openAccountDb(key = dbKey()) {
  const opened = await call("/api/storage/open", { token, body: { key } });
  expect(opened.status).toBe(200);
  return key;
}

describe("status", () => {
  it("says storage is available and who is asking", async () => {
    const anonymous = await call("/api/storage/status");
    expect(anonymous.body).toMatchObject({ ok: true, available: true, engine: "sqlite+sqlcipher", caller: "none" });

    const signedIn = await call("/api/storage/status", { token });
    expect(signedIn.body).toMatchObject({ caller: "account", locked: true });
  });
});

describe("a signed-in user", () => {
  it("must send the passkey key before the database opens", async () => {
    const locked = await call("/api/storage/kv", { token });
    expect(locked.status).toBe(409);
    expect(locked.body).toMatchObject({ code: "locked" });

    await openAccountDb();
    expect((await call("/api/storage/status", { token })).body).toMatchObject({ locked: false });
    expect((await call("/api/storage/kv", { token })).body).toMatchObject({ ok: true, keys: [] });
  });

  it("keeps settings, messages and its own events", async () => {
    await openAccountDb();
    await call("/api/storage/kv", { token, method: "PUT", body: { key: "profile", value: { name: "Alice" } } });
    const put = await call("/api/storage/messages", { token, body: { messages: [
      { id: "m1", room: "alpha", createdAt: 1000, senderName: "Bob", payload: { text: "hello" } },
      { id: "m2", room: "alpha", createdAt: 2000, mine: true, payload: { text: "hi back" } },
    ] } });
    expect(put.body).toMatchObject({ ok: true, stored: 2 });

    const read = await call("/api/storage/messages?room=alpha", { token });
    expect((read.body.messages as Array<{ id: string }>).map((m) => m.id)).toEqual(["m1", "m2"]);
    expect((await call("/api/storage/kv?key=profile", { token })).body).toMatchObject({ value: { name: "Alice" } });
    expect((await call("/api/storage/rooms", { token })).body.rooms).toMatchObject([{ room: "alpha", messages: 2 }]);

    await call("/api/storage/events", { token, body: { kind: "data-loaded", meta: { messages: 2 } } });
    expect((await call("/api/storage/events", { token })).body.events).toMatchObject([{ kind: "data-loaded" }]);

    const summary = await call("/api/storage/summary", { token });
    expect(summary.body.summary).toMatchObject({ messages: 2, rooms: 1, keys: 1 });
  });

  it("refuses a key that does not open the database", async () => {
    await openAccountDb();
    await call("/api/storage/kv", { token, method: "PUT", body: { key: "x", value: 1 } });
    storage.releaseAccount(accountId);

    const wrong = await call("/api/storage/open", { token, body: { key: dbKey() } });
    expect(wrong.status).toBe(403);
    expect(wrong.body).toMatchObject({ code: "key" });
  });

  it("deletes a conversation and, on request, everything", async () => {
    await openAccountDb();
    await call("/api/storage/messages", { token, body: { messages: [{ id: "m1", room: "alpha", createdAt: 1, payload: {} }] } });
    expect((await call("/api/storage/messages", { token, method: "DELETE" })).body).toMatchObject({ removed: 1 });

    expect((await call("/api/storage", { token, method: "DELETE" })).body).toMatchObject({ removed: true });
    expect(storage.global.findDatabase("account", accountId)).toBeNull();
  });
});

describe("a browser without a passkey", () => {
  it("gets a session store that expires in a day", async () => {
    const started = await call("/api/storage/session", { body: {} });
    expect(started.body).toMatchObject({ ok: true, sessionId: expect.stringMatching(/^sess-/) });
    const session = String(started.body.sessionId);
    expect(Number(started.body.expiresAt) - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);

    await call("/api/storage/kv", { session, method: "PUT", body: { key: "draft", value: "unsent" } });
    expect((await call("/api/storage/kv?key=draft", { session })).body).toMatchObject({ value: "unsent" });
  });

  it("cannot reach anybody else's data", async () => {
    await openAccountDb();
    await call("/api/storage/kv", { token, method: "PUT", body: { key: "profile", value: { name: "Alice" } } });

    const started = await call("/api/storage/session", { body: {} });
    const session = String(started.body.sessionId);
    expect((await call("/api/storage/kv?key=profile", { session })).body).toMatchObject({ value: null });

    // An invented session id has no storage at all.
    expect((await call("/api/storage/kv?key=profile", { session: "sess-made-up-identifier" })).status).toBe(404);
  });

  it("is forgotten at once when the user clears everything", async () => {
    const started = await call("/api/storage/session", { body: {} });
    const session = String(started.body.sessionId);
    await call("/api/storage/kv", { session, method: "PUT", body: { key: "draft", value: "unsent" } });

    expect((await call("/api/storage", { session, method: "DELETE" })).body).toMatchObject({ removed: true });
    expect((await call("/api/storage/kv?key=draft", { session })).status).toBe(404);
  });

  it("is refused without any identity at all", async () => {
    expect((await call("/api/storage/kv")).status).toBe(401);
    expect((await call("/api/storage/summary")).status).toBe(401);
  });
});

describe("registering a passkey mid-session", () => {
  it("moves the session data into the account database", async () => {
    const started = await call("/api/storage/session", { body: {} });
    const session = String(started.body.sessionId);
    await call("/api/storage/kv", { session, method: "PUT", body: { key: "draft", value: "unsent" } });
    await call("/api/storage/messages", { session, body: { messages: [{ id: "m1", room: "alpha", createdAt: 1, payload: { text: "written before signing in" } }] } });

    const promoted = await call("/api/storage/promote", { token, body: { sessionId: session, key: dbKey() } });
    expect(promoted.body).toMatchObject({ ok: true, moved: { messages: 1, keys: 1 } });

    // The data is the account's now, and the session store is gone.
    expect((await call("/api/storage/kv?key=draft", { token })).body).toMatchObject({ value: "unsent" });
    expect((await call("/api/storage/messages", { token })).body.messages).toHaveLength(1);
    expect((await call("/api/storage/kv?key=draft", { session })).status).toBe(404);
  });

  it("needs a signed-in caller", async () => {
    const started = await call("/api/storage/session", { body: {} });
    const promoted = await call("/api/storage/promote", { session: String(started.body.sessionId), body: { key: dbKey() } });
    expect(promoted.status).toBe(401);
  });
});

describe("logs and transfers", () => {
  it("records a client log line and a transfer, and hands them to the operator", async () => {
    await openAccountDb();
    await call("/api/storage/log", { token, body: { level: "warn", event: "decrypt-failed", detail: { room: "alpha" } } });
    await call("/api/storage/transfers", { token, body: { id: "xfer-1", direction: "out", transport: "p2p", status: "completed", bytes: 2048, chunks: 2 } });

    const mine = await call("/api/storage/transfers", { token });
    expect(mine.body.transfers).toMatchObject([{ id: "xfer-1", status: "completed", bytes: 2048 }]);

    const asOperator = await fetch(`${base}/api/admin/storage/logs?level=warn`, { headers: { authorization: "Bearer storage-operator-token" } });
    const logs = (await asOperator.json() as { logs: Array<{ event: string; detail: unknown }> }).logs;
    expect(logs[0]).toMatchObject({ event: "decrypt-failed", detail: { room: "alpha" } });
  });

  it("keeps the operator views behind the admin token", async () => {
    expect((await fetch(`${base}/api/admin/storage`)).status).toBe(401);
    expect((await fetch(`${base}/api/admin/storage/logs`)).status).toBe(401);
    const allowed = await fetch(`${base}/api/admin/storage`, { headers: { authorization: "Bearer storage-operator-token" } });
    expect(allowed.status).toBe(200);
    const body = await allowed.json() as { databases: unknown[]; stats: { databases: number } };
    expect(Array.isArray(body.databases)).toBe(true);
  });
});

describe("the same API over the socket", () => {
  it("runs operations on the connection the client already has", async () => {
    const client = await WsClient.connect(base);
    await client.next("hello");

    client.send({ type: "storage", id: "1", op: "open", auth: token, payload: { key: dbKey() } });
    expect(await client.next("storage-result")).toMatchObject({ id: "1", ok: true });

    // The identity sticks for the rest of the connection.
    client.send({ type: "storage", id: "2", op: "kv.put", payload: { key: "profile", value: { name: "Alice" } } });
    expect(await client.next("storage-result")).toMatchObject({ id: "2", ok: true });

    client.send({ type: "storage", id: "3", op: "kv.get", payload: { key: "profile" } });
    const read = await client.next("storage-result");
    expect(read).toMatchObject({ id: "3", ok: true, data: { value: { name: "Alice" } } });

    // …and what it wrote is the same database the REST surface sees.
    expect((await call("/api/storage/kv?key=profile", { token })).body).toMatchObject({ value: { name: "Alice" } });
    await client.close();
  });

  it("answers an unknown operation and an unidentified caller", async () => {
    const client = await WsClient.connect(base);
    await client.next("hello");

    client.send({ type: "storage", id: "1", op: "drop-everything" });
    expect(await client.next("storage-result")).toMatchObject({ ok: false, code: "unknown-op" });

    client.send({ type: "storage", id: "2", op: "kv.keys" });
    expect(await client.next("storage-result")).toMatchObject({ ok: false, code: "no-caller" });
    await client.close();
  });

  it("starts a session store over the socket too", async () => {
    const client = await WsClient.connect(base);
    await client.next("hello");
    client.send({ type: "storage", id: "1", op: "session.start" });
    const started = await client.next("storage-result") as { data: { sessionId: string } };
    expect(started.data.sessionId).toMatch(/^sess-/);

    client.send({ type: "storage", id: "2", op: "kv.put", session: started.data.sessionId, payload: { key: "draft", value: "x" } });
    expect(await client.next("storage-result")).toMatchObject({ ok: true });
    await client.close();
  });
});
