// @vitest-environment node
//
// /api/push/test: a device may test-push ITSELF (its own subscription id,
// fixed text) without a token; pushing to everyone — or any request without
// an id — needs the admin token. sendWebPush is stubbed: nothing leaves the
// machine.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const push = vi.hoisted(() => ({
  ready: true,
  sent: [] as Array<{ endpoint: string; payload: { title?: string; body?: string } }>,
}));
vi.mock("../server/push", async (importOriginal) => ({
  isAllowedPushEndpoint: (await importOriginal<typeof import("../server/push")>()).isAllowedPushEndpoint,
  isWebPushReady: () => push.ready,
  sendWebPush: vi.fn(async (sub: { endpoint: string }, payload: { title?: string; body?: string }) => {
    push.sent.push({ endpoint: sub.endpoint, payload });
    return { ok: true };
  }),
}));

import express from "express";
import type { AddressInfo } from "node:net";
import { registerPushRoutes } from "../server/push-routes";
import { pushSubscriptions } from "../server/routes-admin-shared";

const TOKEN = "push-op-token";
let base = "";
let close: (() => void) | null = null;
const saved = { token: process.env.ADMIN_API_TOKEN, pub: process.env.VAPID_PUBLIC_KEY, priv: process.env.VAPID_PRIVATE_KEY };

beforeEach(async () => {
  push.ready = true;
  push.sent = [];
  pushSubscriptions.clear();
  pushSubscriptions.set("sub-alice", { endpoint: "https://fcm.googleapis.com/fcm/send/alice", keys: { p256dh: "k", auth: "a" }, createdAt: Date.now() });
  pushSubscriptions.set("sub-bob", { endpoint: "https://fcm.googleapis.com/fcm/send/bob", keys: { p256dh: "k", auth: "a" }, createdAt: Date.now() });
  process.env.ADMIN_API_TOKEN = TOKEN;
  process.env.VAPID_PUBLIC_KEY = "test-public";
  process.env.VAPID_PRIVATE_KEY = "test-private";
  const app = express();
  app.use(express.json());
  registerPushRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => {
  close?.(); close = null;
  for (const [k, v] of [["ADMIN_API_TOKEN", saved.token], ["VAPID_PUBLIC_KEY", saved.pub], ["VAPID_PRIVATE_KEY", saved.priv]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const test = (body: unknown, auth?: string) =>
  fetch(`${base}/api/push/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify(body),
  });

describe("self-test (own subscription id, no token)", () => {
  it("pushes the fixed test text to that one subscription only", async () => {
    const res = await test({ id: "sub-alice", title: "You won!", body: "click here" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, mode: "self" });
    expect(push.sent).toEqual([{ endpoint: "https://fcm.googleapis.com/fcm/send/alice", payload: { title: "M5cet · test", body: "Push delivery test" } }]);
  });

  it("works end to end with the id /api/push/subscribe hands out", async () => {
    const sub = await (await fetch(`${base}/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/carol", keys: { p256dh: "k", auth: "a" } } }),
    })).json() as { id: string };
    expect(sub.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await test({ id: sub.id })).status).toBe(200);
    expect(push.sent.map((s) => s.endpoint)).toEqual(["https://fcm.googleapis.com/fcm/send/carol"]);
  });

  it("404 for an unknown id, 503 when VAPID is missing", async () => {
    expect((await test({ id: "not-a-subscription" })).status).toBe(404);
    push.ready = false;
    expect((await test({ id: "sub-alice" })).status).toBe(503);
    expect(push.sent).toEqual([]);
  });
});

describe("broadcast (admin token)", () => {
  it("a request without an id is a broadcast: 401 without / with a wrong token, nothing sent", async () => {
    const none = await test({ title: "spam" });
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect((await test({}, "Bearer wrong")).status).toBe(401);
    expect(push.sent).toEqual([]);
  });

  it("broadcast:true cannot ride on a valid id without the token", async () => {
    expect((await test({ id: "sub-alice", broadcast: true, body: "spam" })).status).toBe(401);
    expect(push.sent).toEqual([]);
  });

  it("503 when no ADMIN_API_TOKEN is configured", async () => {
    delete process.env.ADMIN_API_TOKEN;
    expect((await test({ broadcast: true }, "Bearer anything")).status).toBe(503);
    expect(push.sent).toEqual([]);
  });

  it("with the token: every subscriber gets the operator's text", async () => {
    const res = await test({ broadcast: true, title: "Maintenance", body: "Back at 10:00" }, `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, mode: "broadcast", sent: 2, failed: 0 });
    expect(push.sent.map((s) => s.endpoint).sort()).toEqual(["https://fcm.googleapis.com/fcm/send/alice", "https://fcm.googleapis.com/fcm/send/bob"]);
    expect(push.sent.every((s) => s.payload.title === "Maintenance" && s.payload.body === "Back at 10:00")).toBe(true);
  });
});

describe("push endpoints", () => {
  it("only reach known push services (no requests into the server's own network)", async () => {
    const { isAllowedPushEndpoint } = await import("../server/push");
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(isAllowedPushEndpoint("https://web.push.apple.com/Q")).toBe(true);
    expect(isAllowedPushEndpoint("https://10.0.0.5/admin")).toBe(false);
    expect(isAllowedPushEndpoint("https://localhost/x")).toBe(false);
    expect(isAllowedPushEndpoint("http://fcm.googleapis.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com.evil.example/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://user:pw@fcm.googleapis.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com:8443/x")).toBe(false);
  });
});
