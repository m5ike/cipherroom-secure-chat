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
import { StorageService, type StorageOptions } from "../server/storage/service";
import { registerStorageRoutes } from "../server/storage/routes";
import { handleStorageFrame, newStorageSocketState, type StorageSocketState } from "../server/storage/ws";
import { apiContext, clientKeyFor } from "../server/storage/api";
import { _resetMasterKeyForTests, holderForToken } from "../server/storage/keys";
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

/* ---------------------------------------------------------------------- */
/* The hardening, as a client sees it                                      */
/* ---------------------------------------------------------------------- */

/** Another server, with its own storage limits, on the same account store. */
async function serveWith(options: StorageOptions) {
  const svc = new StorageService(join(dir, `svc-${randomBytes(4).toString("hex")}`), options);
  expect((await svc.init()).ok).toBe(true);
  const app = express();
  registerStorageRoutes(app, svc, accounts);
  const srv = createServer(app);
  srv.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const request = async (path: string, opts: Options = {}) => {
    const saved = base;
    base = url;
    try { return await call(path, opts); } finally { base = saved; }
  };
  const close = async () => {
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
    svc.close();
  };
  return { svc, request, close };
}

describe("what the public status tells", () => {
  it("answers availability and identity only — no directory, no counts", async () => {
    for (const opts of [{}, { token }]) {
      const body = (await call("/api/storage/status", opts)).body;
      expect(Object.keys(body).sort()).toEqual(opts.token ? ["available", "caller", "engine", "locked", "ok"] : ["available", "caller", "engine", "ok"]);
    }
    const asOperator = await fetch(`${base}/api/admin/storage`, { headers: { authorization: "Bearer storage-operator-token" } });
    expect(await asOperator.json()).toMatchObject({ dir: expect.any(String), stats: expect.any(Object) });
  });
});

describe("session ids", () => {
  it("are not accepted in the URL", async () => {
    const started = await call("/api/storage/session", { body: {} });
    const session = String(started.body.sessionId);
    await call("/api/storage/kv", { session, method: "PUT", body: { key: "draft", value: "x" } });
    expect((await call(`/api/storage/kv?key=draft&session=${encodeURIComponent(session)}`)).status).toBe(401);
  });

  it("are capped per client (429) and per server (503)", async () => {
    const capped = await serveWith({ limits: { sessionsPerClientPerHour: 2, maxLiveSessions: 10 } });
    try {
      expect((await capped.request("/api/storage/session", { body: {} })).status).toBe(200);
      expect((await capped.request("/api/storage/session", { body: {} })).status).toBe(200);
      const third = await capped.request("/api/storage/session", { body: {} });
      expect(third).toMatchObject({ status: 429, body: { code: "rate-limit" } });
    } finally {
      await capped.close();
    }
    const full = await serveWith({ limits: { maxLiveSessions: 1 } });
    try {
      expect((await full.request("/api/storage/session", { body: {} })).status).toBe(200);
      expect(await full.request("/api/storage/session", { body: {} })).toMatchObject({ status: 503, body: { code: "capacity" } });
    } finally {
      await full.close();
    }
  });
});

describe("the vault key", () => {
  it("cannot be written, deleted or listed through the settings API", async () => {
    await openAccountDb();
    expect(await call("/api/storage/kv", { token, method: "PUT", body: { key: "vault", value: { profile: "forged" } } })).toMatchObject({ status: 400, body: { code: "reserved" } });
    expect((await call("/api/storage/kv?key=vault", { token, method: "DELETE" })).status).toBe(400);
    expect((await call("/api/storage/kv", { token })).body.keys).toEqual([]);
  });
});

describe("log lines and transfer records", () => {
  it("need an account or a live session", async () => {
    expect(await call("/api/storage/log", { body: { level: "info", event: "anon" } })).toMatchObject({ status: 401, body: { code: "no-caller" } });
    expect((await call("/api/storage/transfers", { body: { id: "x1" } })).status).toBe(401);
    expect(await call("/api/storage/log", { session: "sess-made-up-identifier-000", body: { level: "info", event: "fake" } })).toMatchObject({ status: 404, body: { code: "no-session" } });

    const session = String((await call("/api/storage/session", { body: {} })).body.sessionId);
    expect((await call("/api/storage/log", { session, body: { level: "info", event: "real", detail: { big: "d".repeat(5_000) } } })).status).toBe(200);
    const logged = storage.global.readLogs({ sessionId: session });
    expect(logged[0]).toMatchObject({ event: "real", detail: { truncated: true } });
  });

  it("have an hourly quota per caller", async () => {
    const capped = await serveWith({ limits: { logLinesPerHour: 2, transfersPerHour: 1 } });
    try {
      for (let i = 0; i < 2; i += 1) expect((await capped.request("/api/storage/log", { token, body: { level: "info", event: `l${i}` } })).status).toBe(200);
      expect(await capped.request("/api/storage/log", { token, body: { level: "info", event: "one too many" } })).toMatchObject({ status: 429, body: { code: "rate-limit" } });
      expect((await capped.request("/api/storage/transfers", { token, body: { id: "x1", status: "started" } })).status).toBe(200);
      expect((await capped.request("/api/storage/transfers", { token, body: { id: "x1", status: "completed" } })).status).toBe(429);
    } finally {
      await capped.close();
    }
  });

  it("cannot overwrite somebody else's transfer", async () => {
    await openAccountDb();
    const session = String((await call("/api/storage/session", { body: {} })).body.sessionId);
    await call("/api/storage/transfers", { session, body: { id: "shared-id", status: "started", bytes: 5 } });
    await call("/api/storage/transfers", { token, body: { id: "shared-id", status: "failed", bytes: 0 } });
    expect((await call("/api/storage/transfers", { session })).body.transfers).toMatchObject([{ id: "shared-id", status: "started", bytes: 5 }]);
    expect((await call("/api/storage/transfers", { token })).body.transfers).toMatchObject([{ id: "shared-id", status: "failed" }]);
  });
});

describe("limits a client can hit", () => {
  it("answers 413 quota when the database is full", async () => {
    const tight = await serveWith({ limits: { sessionQuotaBytes: 300 * 1024 } });
    try {
      const session = String((await tight.request("/api/storage/session", { body: {} })).body.sessionId);
      let last = { status: 200, body: {} as Record<string, unknown> };
      for (let i = 0; i < 20 && last.status === 200; i += 1) {
        last = await tight.request("/api/storage/kv", { session, method: "PUT", body: { key: `k${i}`, value: "v".repeat(50_000) } });
      }
      expect(last).toMatchObject({ status: 413, body: { code: "quota" } });
    } finally {
      await tight.close();
    }
  });

  it("pages messages by the server's sequence number", async () => {
    await openAccountDb();
    await call("/api/storage/messages", { token, body: { messages: [1, 2, 3].map((n) => ({ id: `m${n}`, room: "alpha", createdAt: Date.now() - 10_000 + n, payload: { n } })) } });
    const first = await call("/api/storage/messages?afterSeq=0&limit=2", { token });
    expect((first.body.messages as Array<{ id: string }>).map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(first.body.more).toBe(true);
    const rest = await call(`/api/storage/messages?afterSeq=${first.body.lastSeq}&limit=2`, { token });
    expect((rest.body.messages as Array<{ id: string }>).map((m) => m.id)).toEqual(["m3"]);
    expect(rest.body.more).toBe(false);
  });
});

describe("one account, several devices", () => {
  it("keeps the database open until the last device signs out", async () => {
    const second = accounts.issueToken(accountId);
    const key = dbKey();
    expect((await call("/api/storage/open", { token, body: { key } })).status).toBe(200);
    expect((await call("/api/storage/open", { token: second, body: { key } })).status).toBe(200);

    storage.releaseAccount(accountId, holderForToken(token));        // the laptop signs out
    expect((await call("/api/storage/status", { token: second })).body).toMatchObject({ locked: false });
    storage.releaseAccount(accountId, holderForToken(second));       // and the phone
    expect((await call("/api/storage/status", { token: second })).body).toMatchObject({ locked: true });
  });
});

describe("client identity for the caps", () => {
  it("uses the address, an IPv6 one cut to its /64", () => {
    expect(clientKeyFor("::ffff:198.51.100.7")).toBe("ip:198.51.100.7");
    expect(clientKeyFor("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(clientKeyFor("2001:0db8:0001:0002::1"));
    expect(clientKeyFor("2001:db8:1:2::1")).toBe("ip6:2001:db8:1:2::/64");
    expect(clientKeyFor("2001:db8:1:3::1")).not.toBe(clientKeyFor("2001:db8:1:2::1"));
    expect(newStorageSocketState("::ffff:198.51.100.7").clientKey).toBe("ip:198.51.100.7");
  });
});
