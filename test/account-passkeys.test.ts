// @vitest-environment node
//
// 3.1 accounts (server/accounts/store.ts + routes.ts): more than one passkey
// per account, a recovery code, sessions that survive a restart and can be
// ended one by one. The server only ever holds sealed blobs of the account
// root; these tests use opaque strings for them.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.hoisted(() => { process.env.WEBAUTHN_RP_ID = "localhost"; });

import express from "express";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const revoked: Array<[string, string | null]> = [];

async function start() {
  store = new AccountStore(dir);
  store.onRevoke((id, hash) => revoked.push([id, hash]));
  const app = express();
  app.use(express.json());
  registerAccountRoutes(app, store);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), "m5cet-passkeys-")); revoked.length = 0; await start(); });
afterEach(async () => { await new Promise((r) => server.close(r)); rmSync(dir, { recursive: true, force: true }); });

const call = async (method: string, path: string, body?: unknown, token?: string) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, json: await r.json() as Record<string, any> };
};
const auth = () => new FakeAuthenticator("localhost", "http://localhost");
const WRAPPED = { iv: "aXZpdml2aXZpdml2", ct: "c2VhbGVkLXJvb3Qtc2VhbGVkLXJvb3Q=" };

async function register(a = auth()) {
  const opts = await call("POST", "/api/account/register/options", { userName: "Alice" });
  const r = await call("POST", "/api/account/register/verify", { credential: a.register(opts.json.publicKey.challenge), keyProof: KEY_PROOF });
  expect(r.status).toBe(200);
  return { a, token: r.json.token as string, id: r.json.account.id as string };
}

/** The global key's proof the browser derives from the account root (4.0). */
const KEY_PROOF = "k".repeat(43);

/** Signs in and proves the global key, as the browser does. */
async function signIn(a: FakeAuthenticator) {
  const opts = await call("POST", "/api/account/signin/options");
  const r = await call("POST", "/api/account/signin/verify", { credential: a.assert(opts.json.publicKey.challenge) });
  if (r.status === 200 && r.json.token) await call("POST", "/api/account/unlock", { keyProof: KEY_PROOF }, r.json.token);
  return r;
}

describe("several passkeys", () => {
  it("adds a second passkey that signs into the same account and gets its sealed root", async () => {
    const alice = await register();
    const options = await call("POST", "/api/account/passkeys/options", {}, alice.token);
    expect(options.json.publicKey.excludeCredentials).toHaveLength(1);
    const phone = auth();
    const added = await call("POST", "/api/account/passkeys/verify", { credential: phone.register(options.json.publicKey.challenge), wrapped: WRAPPED, label: "Phone" }, alice.token);
    expect(added.status).toBe(200);
    expect(added.json.account.passkeys.map((p: { label: string; primary: boolean }) => [p.label, p.primary])).toEqual([["", true], ["Phone", false]]);

    const viaPhone = await signIn(phone);
    expect(viaPhone.status).toBe(200);
    expect(viaPhone.json.account.id).toBe(alice.id);
    expect(viaPhone.json.wrapped).toMatchObject(WRAPPED);
    // The first passkey needs no sealed root: its PRF output is the root.
    const viaFirst = await signIn(alice.a);
    expect(viaFirst.json.wrapped).toBeNull();
  });

  it("refuses a second passkey without a sealed root, and never removes the last one", async () => {
    const alice = await register();
    const options = await call("POST", "/api/account/passkeys/options", {}, alice.token);
    const bad = await call("POST", "/api/account/passkeys/verify", { credential: auth().register(options.json.publicKey.challenge) }, alice.token);
    expect(bad.status).toBe(409);
    const last = alice.a.credentialId.toString("base64url");
    expect((await call("DELETE", `/api/account/passkeys/${last}`, undefined, alice.token)).status).toBe(400);
  });

  it("keeps the account reachable when the first passkey is removed", async () => {
    const alice = await register();
    const options = await call("POST", "/api/account/passkeys/options", {}, alice.token);
    const phone = auth();
    await call("POST", "/api/account/passkeys/verify", { credential: phone.register(options.json.publicKey.challenge), wrapped: WRAPPED, label: "Phone" }, alice.token);
    const removed = await call("DELETE", `/api/account/passkeys/${alice.a.credentialId.toString("base64url")}`, undefined, alice.token);
    expect(removed.status).toBe(200);
    expect((await signIn(alice.a)).status).toBe(404);
    const viaPhone = await signIn(phone);
    expect(viaPhone.json.account.id).toBe(alice.id);
    expect(viaPhone.json.wrapped).toMatchObject(WRAPPED);
  });
});

describe("recovery code", () => {
  const proof = "proof-of-the-recovery-code-0123456789";
  const recovery = { id: "rec-id-0123456789abcdef", verifier: createHash("sha256").update(proof).digest("hex"), wrapped: WRAPPED };

  it("lets a user with the code add a new passkey and sign in", async () => {
    const alice = await register();
    expect((await call("PUT", "/api/account/recovery", recovery, alice.token)).json.account.recovery).toMatchObject({ set: true });

    const wrong = await call("POST", "/api/account/recovery/start", { id: recovery.id, proof: "not-it" });
    expect(wrong.status).toBe(404);

    const started = await call("POST", "/api/account/recovery/start", { id: recovery.id, proof });
    expect(started.status).toBe(200);
    expect(started.json.wrapped).toMatchObject(WRAPPED);
    const fresh = auth();
    const finished = await call("POST", "/api/account/recovery/finish", { ticket: started.json.ticket, credential: fresh.register(started.json.publicKey.challenge), wrapped: WRAPPED, label: "New laptop" });
    expect(finished.status).toBe(200);
    expect(finished.json.account.id).toBe(alice.id);
    expect(typeof finished.json.token).toBe("string");
    // The ticket was single-use.
    const again = await call("POST", "/api/account/recovery/finish", { ticket: started.json.ticket, credential: auth().register(started.json.publicKey.challenge), wrapped: WRAPPED });
    expect(again.status).toBe(400);
    expect((await signIn(fresh)).json.account.id).toBe(alice.id);
  });

  it("stores only a verifier, and can be removed", async () => {
    const alice = await register();
    await call("PUT", "/api/account/recovery", recovery, alice.token);
    const onDisk = readFileSync(join(dir, "accounts.json"), "utf8");
    expect(onDisk).not.toContain(proof);
    await call("DELETE", "/api/account/recovery", undefined, alice.token);
    expect((await call("POST", "/api/account/recovery/start", { id: recovery.id, proof })).status).toBe(404);
  });
});

describe("sessions", () => {
  it("lists the account's devices and ends one of them", async () => {
    const alice = await register();
    const second = await signIn(alice.a);
    const listed = await call("GET", "/api/account/sessions", undefined, alice.token);
    expect(listed.json.sessions).toHaveLength(2);
    const other = listed.json.sessions.find((s: { current: boolean }) => !s.current);
    const ended = await call("DELETE", `/api/account/sessions/${other.id}`, undefined, alice.token);
    expect(ended.json.sessions).toHaveLength(1);
    expect(revoked.some(([id, hash]) => id === alice.id && hash !== null)).toBe(true);
    expect((await call("GET", "/api/account/me", undefined, second.json.token)).status).toBe(401);
  });

  it("survive a restart, as hashes only", async () => {
    const alice = await register();
    store.flush();
    expect(readFileSync(join(dir, "sessions.json"), "utf8")).not.toContain(alice.token);
    await new Promise((r) => server.close(r));
    await start(); // a new store reading the same directory
    expect((await call("GET", "/api/account/me", undefined, alice.token)).json.account.id).toBe(alice.id);
  });
});
