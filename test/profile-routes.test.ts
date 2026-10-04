// @vitest-environment node
//
// The public part of a profile (6.7, server/accounts/public-profile.ts) over
// HTTP: only the owner publishes or withdraws it, anyone reads it by
// username, a missing profile and a missing account look the same, what is
// stored is checked (types, sizes, images re-checked and stripped of EXIF),
// the journal records sizes but never the content, deleting the account
// deletes the profile, and the console may look at it and remove it. The
// sealed card itself goes into the vault's own slot, which the server cannot
// open.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../server/accounts/store";
import { registerAccountRoutes } from "../server/accounts/routes";
import { PublicProfileStore, registerPublicProfileRoutes } from "../server/accounts/public-profile";
import { audit } from "../server/monitor/audit";
import { toDataUrl } from "../client/src/lib/profile/image";
import { PROFILE_LIMITS } from "../client/src/lib/profile/model";

const OWNER = "owner-token-profile-0123456789";
const saved = { ...process.env };
let dir = "";
let store: AccountStore;
let profiles: PublicProfileStore;
let server: Server;
let base = "";

const credential = (n: string) => ({ credentialId: `cred-${n}-000000001`, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 1 });

function account(username: string): { id: string; token: string } {
  const r = store.create(credential(username), { username });
  if (!r.ok) throw new Error(r.reason);
  return { id: r.account.id, token: store.issueToken(r.account.id) };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-profile-"));
  process.env.ADMIN_API_TOKEN = OWNER;
  process.env.ADMIN_TOKENS = "aud:auditor:auditor-token-profile-0123,ops:operator:operator-token-profile-01";
  store = new AccountStore(dir);
  profiles = new PublicProfileStore(join(dir, "profiles"));
  const app = express();
  app.use("/api/account/vault", express.json({ limit: "8mb" }));
  app.use("/api/profile", express.json({ limit: "1mb" }));
  app.use(express.json());
  registerAccountRoutes(app, store);
  registerPublicProfileRoutes(app, store, profiles);
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
  return { status: r.status, headers: r.headers, json: await r.json().catch(() => ({})) as Record<string, any> };
};

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const seg = (marker: number, body: number[]) => [0xff, marker, ((body.length + 2) >> 8) & 0xff, (body.length + 2) & 0xff, ...body];
const JPEG_WITH_GPS = toDataUrl(Uint8Array.from([
  0xff, 0xd8,
  ...seg(0xe0, [...ascii("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
  ...seg(0xe1, [...ascii("Exif\0\0"), ...ascii("GPSLatitude=49.1951")]),
  ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
  0x11, 0x22, 0xff, 0xd9,
]), "image/jpeg");

const PUBLIC = { v: 1, nickname: "Alice", about: "Hello", avatar: JPEG_WITH_GPS, fields: [{ type: "url", label: "Blog", value: "https://alice.example" }] };

describe("publishing", () => {
  it("needs the owner's live session", async () => {
    expect((await call("PUT", "/api/profile", undefined, { profile: PUBLIC })).status).toBe(401);
    expect((await call("PUT", "/api/profile", "x".repeat(43), { profile: PUBLIC })).status).toBe(401);
    expect((await call("DELETE", "/api/profile")).status).toBe(401);
    expect((await call("GET", "/api/profile")).status).toBe(401);
    // A session whose key is not verified yet cannot publish either.
    const a = account("alice-locked-001");
    const locked = store.issueToken(a.id, Date.now(), { locked: true });
    expect((await call("PUT", "/api/profile", locked, { profile: PUBLIC })).status).toBe(401);
  });

  it("stores the checked profile; anyone reads it by username, without caching", async () => {
    const a = account("alice-public-01");
    const put = await call("PUT", "/api/profile", a.token, { profile: PUBLIC });
    expect(put.status).toBe(200);
    const got = await call("GET", "/api/profile/alice-public-01");
    expect(got.status).toBe(200);
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect(got.json).toMatchObject({ ok: true, username: "alice-public-01", profile: { nickname: "Alice", about: "Hello", fields: [{ type: "url", value: "https://alice.example" }] } });
    // Case does not matter for a lookup.
    expect((await call("GET", "/api/profile/ALICE-public-01")).status).toBe(200);
    // The owner sees what is stored.
    expect((await call("GET", "/api/profile", a.token)).json.profile.nickname).toBe("Alice");
  });

  it("strips the photo's EXIF (with its GPS position) before storing it", async () => {
    const a = account("alice-exif-0001");
    await call("PUT", "/api/profile", a.token, { profile: PUBLIC });
    const avatar = (await call("GET", "/api/profile/alice-exif-0001")).json.profile.avatar as string;
    const bytes = Buffer.from(avatar.split(",")[1], "base64").toString("latin1");
    expect(bytes).not.toContain("GPS");
    expect(bytes).not.toContain("Exif");
    expect(readFileSync(join(dir, "profiles", "alice-exif-0001.json"), "utf8")).not.toContain(Buffer.from("GPSLatitude").toString("base64").slice(0, 8));
  });

  it("refuses what is not a profile, an image that is not one, an empty one and an oversized one", async () => {
    const a = account("alice-refused-1");
    expect((await call("PUT", "/api/profile", a.token, {})).status).toBe(400);
    const svg = await call("PUT", "/api/profile", a.token, { profile: { ...PUBLIC, avatar: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" } });
    expect(svg.status).toBe(400);
    expect(svg.json.code).toBe("bad-image");
    const lying = await call("PUT", "/api/profile", a.token, { profile: { ...PUBLIC, avatar: JPEG_WITH_GPS.replace("image/jpeg", "image/png") } });
    expect(lying.json.code).toBe("bad-image");
    const remote = await call("PUT", "/api/profile", a.token, { profile: { ...PUBLIC, avatar: "https://tracker.example/p.png" } });
    expect(remote.json.code).toBe("bad-image");
    expect((await call("PUT", "/api/profile", a.token, { profile: { v: 1, fields: [{ type: "email", label: "x", value: "nope" }] } })).json.code).toBe("empty");
    const huge = await call("PUT", "/api/profile", a.token, { profile: { ...PUBLIC, about: "x", pad: "y".repeat(400_000) } });
    expect(huge.status).toBe(413);
    expect((await call("GET", "/api/profile/alice-refused-1")).status).toBe(404);
  });

  it("keeps only checked values: long texts cut, invalid fields and unknown keys dropped", async () => {
    const a = account("alice-clean-001");
    await call("PUT", "/api/profile", a.token, { profile: { v: 1, nickname: "N".repeat(300), fields: [{ type: "url", label: "x", value: "javascript:alert(1)" }, { type: "phone", label: "Tel", value: "+420 777 000 111" }], secret: "leak", audience: "public" } });
    const p = (await call("GET", "/api/profile/alice-clean-001")).json.profile;
    expect(p.nickname).toHaveLength(PROFILE_LIMITS.nicknameChars);
    expect(p.fields).toEqual([{ type: "phone", label: "Tel", value: "+420 777 000 111" }]);
    expect(JSON.stringify(p)).not.toContain("leak");
  });

  it("is withdrawn by its owner; a missing profile and a missing account answer the same", async () => {
    const a = account("alice-withdraw1");
    await call("PUT", "/api/profile", a.token, { profile: PUBLIC });
    expect((await call("DELETE", "/api/profile", a.token)).json).toEqual({ ok: true, removed: true });
    const gone = await call("GET", "/api/profile/alice-withdraw1");
    const nobody = await call("GET", "/api/profile/nobody-here-0001");
    expect(gone.status).toBe(404);
    expect(nobody.status).toBe(404);
    expect(gone.json).toEqual(nobody.json);
    expect((await call("GET", "/api/profile/../../etc")).status).toBe(404);
  });

  it("goes with the account when the account is deleted", async () => {
    const a = account("alice-deleted-1");
    await call("PUT", "/api/profile", a.token, { profile: PUBLIC });
    expect(existsSync(join(dir, "profiles", "alice-deleted-1.json"))).toBe(true);
    expect((await call("DELETE", "/api/account", a.token)).status).toBe(200);
    expect(existsSync(join(dir, "profiles", "alice-deleted-1.json"))).toBe(false);
    expect((await call("GET", "/api/profile/alice-deleted-1")).status).toBe(404);
  });

  it("is journaled with sizes and counts, never the content", async () => {
    const a = account("alice-journal-1");
    await call("PUT", "/api/profile", a.token, { profile: PUBLIC });
    const entry = audit.recent({ event: "account.profile.published", accountId: a.id, limit: 1 })[0];
    expect(entry).toBeTruthy();
    expect(entry.detail).toMatchObject({ nickname: true, avatar: true, fields: 1 });
    expect(JSON.stringify(entry)).not.toContain("Alice");
    expect(JSON.stringify(entry)).not.toContain("alice.example");
    expect(store.get(a.id)!.audit.some((e) => e.kind === "profile-published")).toBe(true);
  });

  it("returns the account's signing key with the profile, when it has one", async () => {
    const a = account("alice-identity1");
    store.setIdentity(a.id, "A".repeat(43));
    await call("PUT", "/api/profile", a.token, { profile: PUBLIC });
    expect((await call("GET", "/api/profile/alice-identity1")).json.accountKey).toBe("A".repeat(43));
  });
});

describe("limits", () => {
  it("an owner may change the profile 30 times in 10 minutes; a lookup 60 times a minute", async () => {
    const a = account("alice-limited-1");
    const writes: number[] = [];
    for (let i = 0; i < 31; i++) writes.push((await call(i % 2 ? "DELETE" : "PUT", "/api/profile", a.token, i % 2 ? undefined : { profile: PUBLIC })).status);
    expect(writes.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(writes[30]).toBe(429);
    // Another account has its own budget.
    const b = account("bob-unlimited-1");
    expect((await call("PUT", "/api/profile", b.token, { profile: PUBLIC })).status).toBe(200);
    const reads: number[] = [];
    for (let i = 0; i < 61; i++) reads.push((await call("GET", "/api/profile/bob-unlimited-1")).status);
    expect(reads.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(reads[60]).toBe(429);
  });
});

describe("the console", () => {
  it("an auditor sees a public profile, an operator removes it (audited), a user token does neither", async () => {
    const a = account("alice-moderate1");
    await call("PUT", "/api/profile", a.token, { profile: PUBLIC });
    expect((await call("GET", `/api/admin/users/${a.id}/public-profile`)).status).toBe(401);
    expect((await call("GET", `/api/admin/users/${a.id}/public-profile`, a.token)).status).toBe(401);
    const seen = await call("GET", `/api/admin/users/${a.id}/public-profile`, "auditor-token-profile-0123");
    expect(seen.status).toBe(200);
    expect(seen.json.profile.nickname).toBe("Alice");
    expect((await call("DELETE", `/api/admin/users/${a.id}/public-profile`, "auditor-token-profile-0123")).status).toBe(403);
    expect((await call("DELETE", `/api/admin/users/${a.id}/public-profile`, "operator-token-profile-01")).status).toBe(200);
    expect((await call("GET", "/api/profile/alice-moderate1")).status).toBe(404);
    expect(audit.recent({ event: "admin.user.profile-removed", limit: 1 })[0]?.target).toBe(a.id);
    expect(store.get(a.id)!.audit.some((e) => e.kind === "profile-removed-by-operator")).toBe(true);
    expect((await call("DELETE", `/api/admin/users/${a.id}/public-profile`, OWNER)).status).toBe(404);
  });
});

describe("the sealed card in the vault", () => {
  it("has its own slot: stored and returned as given, never mixed with the profile slot", async () => {
    const a = account("alice-vault-001");
    const ct = Buffer.from("sealed-by-the-browser").toString("base64");
    expect((await call("PUT", "/api/account/vault", a.token, { card: ct })).status).toBe(200);
    const v = (await call("GET", "/api/account/vault", a.token)).json;
    expect(v.card.ct).toBe(ct);
    expect(v.profile).toBeNull();
    // A preference save does not touch it.
    await call("PUT", "/api/account/vault", a.token, { profile: Buffer.from("prefs").toString("base64") });
    expect((await call("GET", "/api/account/vault", a.token)).json.card.ct).toBe(ct);
    // Not base64, or too large: refused.
    expect((await call("PUT", "/api/account/vault", a.token, { card: "not base64 !" })).status).toBe(413);
    expect((await call("PUT", "/api/account/vault", a.token, { card: "A".repeat(400_004) })).status).toBe(413);
  });
});
