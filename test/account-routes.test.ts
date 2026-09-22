// @vitest-environment node
//
// The passkey account API (server/accounts/routes.ts) end to end over HTTP:
// register → sign in → vault → audit → sign out → delete, with the synthetic
// authenticator standing in for the browser. The rejection paths matter as
// much as the happy one: a challenge is single-use, a foreign origin is
// refused, an unknown passkey gets no account, and nothing but a live Bearer
// token opens the vault.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.WEBAUTHN_RP_ID = "localhost";
});

import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../server/accounts/store";
import { registerAccountRoutes } from "../server/accounts/routes";
import { FakeAuthenticator } from "./helpers/authenticator";

let dir = "";
let store: AccountStore;
let server: Server;
let base = "";
let signedOut: string[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-account-api-"));
  store = new AccountStore(dir);
  signedOut = [];
  const app = express();
  app.use("/api/account/vault", express.json({ limit: "8mb" }));
  app.use(express.json());
  registerAccountRoutes(app, store, { onSignOut: (id) => signedOut.push(id) });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body?: unknown, token?: string) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
const get = (path: string, token?: string) => fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
const putVault = (body: unknown, token: string) =>
  fetch(`${base}/api/account/vault`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

/** The rpId comes from WEBAUTHN_RP_ID; the ceremony is what a browser on
 *  http://localhost would have signed. */
const authenticator = () => new FakeAuthenticator("localhost", "http://localhost");

async function challengeFor(kind: "register" | "signin"): Promise<string> {
  const r = await post(`/api/account/${kind}/options`, { userName: "Alice" });
  const j = await r.json() as { publicKey: { challenge: string } };
  return j.publicKey.challenge;
}

async function registerAccount(auth = authenticator()) {
  const challenge = await challengeFor("register");
  const r = await post("/api/account/register/verify", { credential: auth.register(challenge) });
  const j = await r.json() as { ok: boolean; token: string; account: { id: string } };
  return { status: r.status, auth, ...j };
}

async function signIn(auth: FakeAuthenticator) {
  const challenge = await challengeFor("signin");
  const r = await post("/api/account/signin/verify", { credential: auth.assert(challenge) });
  return { status: r.status, body: await r.json() as { ok: boolean; token?: string; account?: { loginCount: number } } };
}

describe("status", () => {
  it("advertises the relying party and whether accounts survive a restart", async () => {
    const j = await (await get("/api/account/status")).json() as { available: boolean; persistent: boolean; rpId: string };
    expect(j).toMatchObject({ available: true, persistent: true, rpId: "localhost" });
  });
});

describe("registration", () => {
  it("creates the account and returns a session token", async () => {
    const r = await registerAccount();
    expect(r.status).toBe(200);
    expect(r.token).toMatch(/^[\w-]{20,}$/);
    expect(store.size).toBe(1);
    expect(store.resolveToken(r.token)?.id).toBe(r.account.id);
    expect(store.get(r.account.id)!.audit.map((e) => e.kind)).toContain("register");
  });

  it("uses each challenge once and refuses a foreign origin", async () => {
    const auth = authenticator();
    const challenge = await challengeFor("register");
    expect((await post("/api/account/register/verify", { credential: auth.register(challenge) })).status).toBe(200);
    // Replaying the same ceremony is rejected (the challenge is gone).
    expect((await post("/api/account/register/verify", { credential: auth.register(challenge) })).status).toBe(400);

    const c2 = await challengeFor("register");
    const evil = await post("/api/account/register/verify", { credential: authenticator().register(c2, { origin: "https://evil.example" }) });
    expect(evil.status).toBe(400);
    expect(store.size).toBe(1);
  });

  it("refuses a challenge the server never issued", async () => {
    const r = await post("/api/account/register/verify", { credential: authenticator().register("this-challenge-was-never-issued") });
    expect(r.status).toBe(400);
    expect(store.size).toBe(0);
  });
});

describe("sign-in", () => {
  it("verifies the passkey and counts the login", async () => {
    const { auth, account } = await registerAccount();
    const r = await signIn(auth);
    expect(r.status).toBe(200);
    expect(r.body.account?.loginCount).toBe(2);
    expect(store.resolveToken(r.body.token!)?.id).toBe(account.id);
    const audit = store.get(account.id)!.audit;
    expect(audit.filter((e) => e.kind === "sign-in")).toHaveLength(2);
    // The sign-in log keeps only coarse client metadata — never the full IP.
    expect(audit.at(-1)!.meta).toMatchObject({ client: expect.stringMatching(/\//) });
    expect(JSON.stringify(audit)).not.toContain("127.0.0.1");
  });

  it("404 for a passkey this server does not know", async () => {
    expect((await signIn(authenticator())).status).toBe(404);
  });

  it("401 and an audit line when the signature does not verify", async () => {
    const { auth, account } = await registerAccount();
    const challenge = await challengeFor("signin");
    const r = await post("/api/account/signin/verify", { credential: auth.assert(challenge, { tamperSignature: true }) });
    expect(r.status).toBe(401);
    expect(store.get(account.id)!.audit.map((e) => e.kind)).toContain("sign-in-failed");
  });
});

describe("vault", () => {
  it("stores and returns the sealed blobs for the signed-in account", async () => {
    const { token, account } = await registerAccount();
    const chat = Buffer.from("sealed chat blob").toString("base64");
    expect((await putVault({ profile: Buffer.from("sealed profile").toString("base64"), chat: { ct: chat, messages: 7, messageBytes: 900, rooms: 1 } }, token)).status).toBe(200);

    const j = await (await get("/api/account/vault", token)).json() as { chat: { ct: string } | null };
    expect(j.chat?.ct).toBe(chat);
    const me = await (await get("/api/account/me", token)).json() as { account: { vault: { messages: number } } };
    expect(me.account.vault.messages).toBe(7);
    expect(store.get(account.id)!.audit.map((e) => e.kind)).toContain("vault-load");
  });

  it("401 without a token, and after signing out", async () => {
    const { token } = await registerAccount();
    expect((await get("/api/account/vault")).status).toBe(401);
    expect((await get("/api/account/vault", "some-token-that-is-not-real")).status).toBe(401);
    expect((await post("/api/account/signout", {}, token)).status).toBe(200);
    expect((await get("/api/account/vault", token)).status).toBe(401);
    expect(signedOut).toHaveLength(1);
  });

  it("413 for a blob over the limit and 400 for an empty patch", async () => {
    const { token } = await registerAccount();
    expect((await putVault({ profile: "A".repeat(200_000) }, token)).status).toBe(413);
    expect((await putVault({}, token)).status).toBe(400);
  });
});

describe("client events", () => {
  it("logs the allowlisted kinds with bounded metadata", async () => {
    const { token, account } = await registerAccount();
    expect((await post("/api/account/event", { kind: "decrypt-ok", meta: { messages: 12, room: "alpha" } }, token)).status).toBe(200);
    expect((await post("/api/account/event", { kind: "data-loaded" }, token)).status).toBe(200);
    expect((await post("/api/account/event", { kind: "anything-goes" }, token)).status).toBe(400);
    const kinds = store.get(account.id)!.audit.map((e) => e.kind);
    expect(kinds).toContain("decrypt-ok");
    expect(kinds).toContain("data-loaded");
    expect(kinds).not.toContain("anything-goes");
  });
});

describe("push, sign-out and deletion", () => {
  it("links a push endpoint for the away wake-up", async () => {
    const { token, account } = await registerAccount();
    expect((await post("/api/account/push", { subscription: { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } } }, token)).status).toBe(200);
    expect(store.get(account.id)!.push).toHaveLength(1);
    expect((await post("/api/account/push", { subscription: { endpoint: "ftp://nope" } }, token)).status).toBe(400);
  });

  it("deletes the account and everything that belongs to it", async () => {
    const { token, account, auth } = await registerAccount();
    await post("/api/account/event", { kind: "data-loaded" }, token);
    const del = await fetch(`${base}/api/account`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    expect(del.status).toBe(200);
    expect(store.size).toBe(0);
    expect(signedOut).toEqual([account.id]);
    // The same passkey can start over, as a new account.
    expect((await signIn(auth)).status).toBe(404);
    expect((await registerAccount(auth)).status).toBe(200);
  });
});
