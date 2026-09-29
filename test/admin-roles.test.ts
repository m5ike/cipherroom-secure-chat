// @vitest-environment node
//
// Administrators with names and roles (server/admin-users.ts, admin-auth.ts,
// admin-api.ts): the old ADMIN_API_TOKEN is still the owner, ADMIN_TOKENS
// and console-made administrators get their role, an auditor can only read,
// and an administrator can sign in to the console with a passkey.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.hoisted(() => { process.env.WEBAUTHN_RP_ID = "localhost"; });

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdminDirectory, adminDirectory, adminPrefs } from "../server/admin-users";
import { registerAdminApi, type AdminProviders } from "../server/admin-api";
import { FakeAuthenticator } from "./helpers/authenticator";

const OWNER = "owner-token-0123456789abcdef";
const saved = { ...process.env };
let server: Server;
let base = "";
let dir = "";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-admins-"));
  process.env.ADMIN_API_TOKEN = OWNER;
  process.env.ADMIN_TOKENS = "aud:auditor:auditor-token-0123456789,ops:operator:operator-token-0123456789";
  // The module singleton reads its file lazily; point it at a fresh one.
  (adminDirectory as unknown as { file: string; loaded: boolean; users: Map<string, unknown> }).file = join(dir, "admin-users.json");
  (adminDirectory as unknown as { loaded: boolean }).loaded = false;
  (adminDirectory as unknown as { users: Map<string, unknown> }).users.clear();
  Object.assign(adminPrefs as unknown as { file: string; data: unknown }, { file: join(dir, "admin-prefs.json"), data: null });
  const app = express();
  app.use(express.json());
  const deps = {
    rooms: () => [], closeConnection: () => false, queue: () => null,
    accounts: { all: () => [], size: 0, sessionCount: () => 0 },
    storage: { isAvailable: false, status: () => ({ available: false }) },
  } as unknown as AdminProviders;
  registerAdminApi(app, deps);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  process.env = { ...saved };
  rmSync(dir, { recursive: true, force: true });
});

const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, any> };
};

describe("roles", () => {
  it("knows who is asking", async () => {
    expect((await call("GET", "/api/admin/whoami", OWNER)).json.admin).toMatchObject({ name: "admin", role: "owner" });
    expect((await call("GET", "/api/admin/whoami", "auditor-token-0123456789")).json.admin).toMatchObject({ name: "aud", role: "auditor" });
    expect((await call("GET", "/api/admin/whoami", "nope-nope-nope-nope-nope")).status).toBe(401);
  });

  it("lets an auditor read but not act, and only an owner manage administrators", async () => {
    expect((await call("GET", "/api/admin/commands", "auditor-token-0123456789")).status).toBe(200);
    expect((await call("POST", "/api/admin/commands", "auditor-token-0123456789", { kind: "reconnect", deviceId: "dev-12345" })).status).toBe(403);
    expect((await call("POST", "/api/admin/commands", "operator-token-0123456789", { kind: "reconnect", deviceId: "dev-12345" })).status).toBe(200);
    expect((await call("GET", "/api/admin/admins", "operator-token-0123456789")).status).toBe(403);
    expect((await call("GET", "/api/admin/admins", OWNER)).status).toBe(200);
  });

  it("creates a named administrator whose token works once issued, and stops working when revoked", async () => {
    expect((await call("POST", "/api/admin/admins", OWNER, { name: "Eva", role: "operator" })).status).toBe(200);
    const issued = await call("POST", "/api/admin/admins/eva/tokens", OWNER, { label: "laptop" });
    const token = issued.json.token as string;
    expect(token).toMatch(/^m5a_/);
    expect(readFileSync(join(dir, "admin-users.json"), "utf8")).not.toContain(token);
    expect((await call("GET", "/api/admin/whoami", token)).json.admin).toMatchObject({ name: "eva", role: "operator", via: "token" });
    await call("PATCH", "/api/admin/admins/eva", OWNER, { disabled: true });
    expect((await call("GET", "/api/admin/whoami", token)).status).toBe(401);
    await call("PATCH", "/api/admin/admins/eva", OWNER, { disabled: false });
    const id = issued.json.admins.find((a: { name: string }) => a.name === "eva").tokens[0].id;
    await call("DELETE", `/api/admin/admins/eva/tokens/${id}`, OWNER);
    expect((await call("GET", "/api/admin/whoami", token)).status).toBe(401);
  });
});

describe("console sign-in with a passkey", () => {
  it("registers a passkey for a named administrator and signs in with it", async () => {
    await call("POST", "/api/admin/admins", OWNER, { name: "lin", role: "auditor" });
    const token = (await call("POST", "/api/admin/admins/lin/tokens", OWNER)).json.token as string;
    const authenticator = new FakeAuthenticator("localhost", "http://localhost");
    const reg = await call("POST", "/api/admin/me/passkeys/options", token);
    expect((await call("POST", "/api/admin/me/passkeys/verify", token, { credential: authenticator.register(reg.json.publicKey.challenge), label: "YubiKey" })).status).toBe(200);

    const opts = await call("POST", "/api/admin/auth/passkey/options");
    const signed = await call("POST", "/api/admin/auth/passkey/verify", undefined, { credential: authenticator.assert(opts.json.publicKey.challenge) });
    expect(signed.status).toBe(200);
    expect(signed.json.admin).toMatchObject({ name: "lin", role: "auditor", via: "passkey" });
    expect((await call("GET", "/api/admin/whoami", signed.json.token)).json.admin).toMatchObject({ name: "lin" });
    await call("POST", "/api/admin/auth/signout", signed.json.token);
    expect((await call("GET", "/api/admin/whoami", signed.json.token)).status).toBe(401);
  });

  it("refuses a passkey nobody registered", async () => {
    const opts = await call("POST", "/api/admin/auth/passkey/options");
    const stranger = new FakeAuthenticator("localhost", "http://localhost");
    expect((await call("POST", "/api/admin/auth/passkey/verify", undefined, { credential: stranger.assert(opts.json.publicKey.challenge) })).status).toBe(401);
  });
});

describe("directory", () => {
  it("does not count as configured with nothing set", () => {
    delete process.env.ADMIN_API_TOKEN;
    delete process.env.ADMIN_TOKENS;
    expect(new AdminDirectory(join(dir, "none.json")).configured()).toBe(false);
  });
});

describe("console settings (6.1)", () => {
  it("keeps each administrator's own settings, even an auditor's", async () => {
    expect((await call("GET", "/api/admin/me/prefs", OWNER)).json).toMatchObject({ ok: true, prefs: {}, updatedAt: 0 });
    const layout = { "fn:packages": { order: ["editor", "list"], w: { list: 300, editor: "fill" }, h: {}, breaks: [], hidden: [], align: "stretch", gap: 8 } };
    const put = await call("PUT", "/api/admin/me/prefs", OWNER, { prefs: { sidebar: "collapsed", layouts: layout } });
    expect(put.status).toBe(200);
    expect(put.json.prefs).toEqual({ sidebar: "collapsed", layouts: layout });
    expect(put.json.updatedAt).toBeGreaterThan(0);
    // An auditor reads everything and changes nothing — except their own console.
    expect((await call("PUT", "/api/admin/me/prefs", "auditor-token-0123456789", { prefs: { sidebar: "open" } })).status).toBe(200);
    expect((await call("GET", "/api/admin/me/prefs", "auditor-token-0123456789")).json.prefs).toEqual({ sidebar: "open" });
    expect((await call("GET", "/api/admin/me/prefs", OWNER)).json.prefs.sidebar).toBe("collapsed");
    // On disk, readable by the server alone.
    const file = JSON.parse(readFileSync(join(dir, "admin-prefs.json"), "utf8"));
    expect(Object.keys(file).sort()).toEqual(["admin", "aud"]);
  });

  it("refuses what is not an object, or too big, and anyone not signed in", async () => {
    expect((await call("PUT", "/api/admin/me/prefs", OWNER, { prefs: [1, 2] })).status).toBe(400);
    expect((await call("PUT", "/api/admin/me/prefs", OWNER, { prefs: "collapsed" })).status).toBe(400);
    expect((await call("PUT", "/api/admin/me/prefs", OWNER, { prefs: { big: "x".repeat(70 * 1024) } })).status).toBe(400);
    expect((await call("GET", "/api/admin/me/prefs")).status).toBe(401);
    expect((await call("PUT", "/api/admin/me/prefs", undefined, { prefs: {} })).status).toBe(401);
  });
});
