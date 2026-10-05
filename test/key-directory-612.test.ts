// @vitest-environment node
//
// 6.12 — the key directory (protocol 4, § 7.5) on the whole main service
// (registerRoutes, SQLite storage): PUT /api/keys/bundle with an account
// session — the v2 device certificate checked against the account key, the
// bundle's signature against the device key, sizes and lifetimes; `acct` and
// `dev` entries in key transparency; the hub's `key-bundles` and `kt-lookup`
// by room-scoped reference with no oracle for unknown or foreign references;
// devices leaving (with `rev`) on sign-out, an account-key change and deletion;
// and the operator's read-only view.

import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";

vi.hoisted(() => {
  const base = process.env.TMPDIR?.replace(/\/$/, "") || "/tmp";
  process.env.ACCOUNTS_DIR = `${base}/m5cet-keydir-${process.pid}-${Date.now()}`;
  process.env.DATA_DIR = process.env.ACCOUNTS_DIR;
  process.env.WEBAUTHN_RP_ID = "localhost";
  process.env.ADMIN_API_TOKEN = "admin-token-for-the-key-directory-test";
});

import express from "express";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { registerRoutes } from "../server/routes";
import { accountRef } from "../server/signaling/refs";
import { storage } from "../server/storage/service";
import { accountStore, usernameOf } from "../server/accounts/store";
import { KtService, ktUser } from "../server/kt/service";
import { canonicalEntry, ktSignerFromMasterKey, sthMessage } from "../server/kt/log";
import { ed25519PublicKey } from "../server/kt/log";
import { verify as edVerify } from "node:crypto";
import { leafHash, verifyInclusion } from "../client/src/lib/p4/merkle";
import { DEVICE_CERT_LIFETIME_MS, MAILBOX_LIFETIME_MS, type DirectoryDevice, type KtEntry, type KtLookup, type SignedTreeHead } from "../client/src/lib/p4/contract";
import type { StoredCredential } from "../server/accounts/webauthn";
import { WsClient } from "./helpers/ws-client";

let server: Server;
let base = "";
const clients: WsClient[] = [];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  server = createServer(app);
  await registerRoutes(server, app);
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  delete process.env.KEYS_MAX_DEVICES;
});
afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  storage.close();
  rmSync(process.env.ACCOUNTS_DIR!, { recursive: true, force: true });
});

/* ------------------------------------------------------------- helpers */

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
let seq = 0;

function newAccount() {
  seq += 1;
  const credential: StoredCredential = { credentialId: `cred-key-dir-${seq}-${randomBytes(6).toString("hex")}`, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 1 };
  const r = accountStore.create(credential, { username: `keyuser${seq}${randomBytes(4).toString("hex")}` });
  if (!r.ok) throw new Error(r.reason);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const apk = b64((publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(12));
  return { id: r.account.id, token: accountStore.issueToken(r.account.id), apk, accountKey: privateKey, u: ktUser(usernameOf(r.account)) };
}
type Account = ReturnType<typeof newAccount>;

function newDevice() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { pk: b64(publicKey.export({ format: "der", type: "spki" }) as Buffer), key: privateKey };
}
type Device = ReturnType<typeof newDevice>;

function certify(acc: Pick<Account, "accountKey">, pk: string, exp = Date.now() + DEVICE_CERT_LIFETIME_MS - 60_000) {
  return { v: 2 as const, exp, sig: b64(sign(null, Buffer.from(`m5cet/device-cert/2|${pk}|${exp}`), acc.accountKey)) };
}

function bundleOf(device: Pick<Device, "key">, opts: { exp?: number; kemBytes?: number; signer?: KeyObject } = {}) {
  const id = randomBytes(8).toString("base64url");
  const dh = b64(generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }) as Buffer);
  const kemRaw = randomBytes(opts.kemBytes ?? 1184);
  const kem = b64(kemRaw);
  const exp = opts.exp ?? Date.now() + MAILBOX_LIFETIME_MS - 60_000;
  const digest = createHash("sha256").update(kemRaw).digest("base64");
  const sig = b64(sign("sha256", Buffer.from(`m5cet/mb/4|${id}|${dh}|${digest}|${exp}`), { key: opts.signer ?? device.key, dsaEncoding: "ieee-p1363" }));
  return { id, dh, kem, exp, sig };
}

const put = (body: unknown, token?: string) => fetch(`${base}/api/keys/bundle`, {
  method: "PUT", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
});
const setIdentity = (acc: Account, publicKey = acc.apk) => fetch(`${base}/api/account/identity`, {
  method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${acc.token}` }, body: JSON.stringify({ publicKey }),
});
const getJson = async <T>(path: string) => (await (await fetch(`${base}${path}`)).json()) as T;

async function upload(acc: Account, device: Device, extra: Record<string, unknown> = {}) {
  const res = await put({ pk: device.pk, cert: certify(acc, device.pk), bundle: bundleOf(device), ...extra }, acc.token);
  return { status: res.status, body: await res.json() as { ok: boolean; code?: string; device?: DirectoryDevice; kt?: { acct: number | null; dev: number | null } } };
}

/** Checks a lookup the way a client does: the head's signature with the KT key, every entry's inclusion. */
async function verifiedEntries(lookup: KtLookup): Promise<KtEntry[]> {
  const { key } = await getJson<{ key: string }>("/api/kt/key");
  const sth = lookup.sth;
  expect(edVerify(null, sthMessage(sth.size, sth.root, sth.ts), ed25519PublicKey(Buffer.from(key, "base64")), Buffer.from(sth.sig, "base64"))).toBe(true);
  for (const e of lookup.entries) {
    const leaf = await leafHash(canonicalEntry(e.entry));
    const ok = await verifyInclusion(leaf, e.index, sth.size, e.proof.map((p) => new Uint8Array(Buffer.from(p, "base64"))), new Uint8Array(Buffer.from(sth.root, "base64")));
    expect(ok).toBe(true);
  }
  return lookup.entries.map((e) => e.entry);
}
const kinds = (entries: KtEntry[]) => entries.map((e) => e.t);
// 6.12 review S03: a lookup needs the account's own session.
const lookupOf = async (acc: Account, token = acc.token) => (await (await fetch(`${base}/api/kt/lookup?u=${acc.u}`, { headers: { authorization: `Bearer ${token}` } })).json()) as KtLookup;
/** The log as the server holds it (an account that is gone has no session to look itself up with). */
const lookupDirect = (acc: Account) => KtService.open(storage.global.handleForQueue(), ktSignerFromMasterKey).lookup(acc.u);

async function join(room: string, name: string, auth?: string) {
  const c = await WsClient.connect(base);
  clients.push(c);
  const hello = await c.next("hello");
  c.send({ type: "join", protocol: 2, room, name, peerId: hello.peerId, ...(auth ? { auth } : {}) });
  const joined = await c.next("joined");
  return { c, joined };
}

/* --------------------------------------------------------------- upload */

describe("PUT /api/keys/bundle", () => {
  it("needs an account session", async () => {
    const res = await put({});
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, code: "signed-out" });
  });

  it("needs the account key: from PUT /api/account/identity (logged as `acct`), or `apk` with the first upload", async () => {
    const acc = newAccount();
    const device = newDevice();
    expect(await upload(acc, device)).toMatchObject({ status: 409, body: { code: "no-account-key" } });

    expect((await setIdentity(acc)).status).toBe(200);
    expect(kinds(await verifiedEntries(await lookupOf(acc)))).toEqual(["acct"]);

    const r = await upload(acc, device);
    expect(r.status).toBe(200);
    expect(r.body.device).toMatchObject({ pk: device.pk, apk: acc.apk, cert: { v: 2 } });
    expect(r.body.kt).toEqual({ acct: null, dev: expect.any(Number) });
    const entries = await verifiedEntries(await lookupOf(acc));
    expect(entries).toEqual([
      { t: "acct", u: acc.u, apk: acc.apk, ts: expect.any(Number) },
      { t: "dev", u: acc.u, apk: acc.apk, dpk: device.pk, exp: r.body.device!.cert.exp, ts: expect.any(Number) },
    ]);

    // An account the server knew no key of: `apk` with the certificate sets it, `acct` first.
    const other = newAccount();
    const r2 = await upload(other, newDevice(), { apk: other.apk });
    expect(r2.status).toBe(200);
    expect(r2.body.kt).toEqual({ acct: expect.any(Number), dev: r2.body.kt!.acct! + 1 });
    expect(accountStore.get(other.id)!.identity?.publicKey).toBe(other.apk);
    expect(kinds(await verifiedEntries(await lookupOf(other)))).toEqual(["acct", "dev"]);
  });

  it("logs `dev` only for a new device or certificate; refuses an older bundle", async () => {
    const acc = newAccount();
    await setIdentity(acc);
    const device = newDevice();
    // A certificate with a third of its lifetime left — when a client renews it (account.ts).
    const firstExp = Date.now() + DEVICE_CERT_LIFETIME_MS / 3;
    const first = await upload(acc, device, { cert: certify(acc, device.pk, firstExp) });
    expect(first.body.kt?.dev).toEqual(expect.any(Number));

    // The same certificate, a newer bundle: nothing new in the log.
    const cert = first.body.device!.cert;
    const newer = await put({ pk: device.pk, cert, bundle: bundleOf(device) }, acc.token);
    expect(newer.status).toBe(200);
    expect((await newer.json()).kt).toEqual({ acct: null, dev: null });

    // An older bundle than the directory has.
    const older = await put({ pk: device.pk, cert, bundle: bundleOf(device, { exp: Date.now() + 3_600_000 }) }, acc.token);
    expect(older.status).toBe(409);
    expect(await older.json()).toMatchObject({ code: "stale-bundle" });

    // 6.12 review S10: a certificate re-signed with an earlier, or a barely later, expiry adds no leaf.
    for (const exp of [firstExp - 60_000, firstExp + 60_000]) {
      const same = await put({ pk: device.pk, cert: certify(acc, device.pk, exp), bundle: bundleOf(device) }, acc.token);
      expect(same.status).toBe(200);
      expect((await same.json()).kt).toEqual({ acct: null, dev: null });
    }

    // A renewed certificate: `dev` again.
    const renewed = await put({ pk: device.pk, cert: certify(acc, device.pk, Date.now() + DEVICE_CERT_LIFETIME_MS - 1_000), bundle: bundleOf(device) }, acc.token);
    expect((await renewed.json()).kt.dev).toEqual(expect.any(Number));
    expect(kinds(await verifiedEntries(await lookupOf(acc)))).toEqual(["acct", "dev", "dev"]);
  });

  it("checks the certificate, the bundle, sizes and lifetimes", async () => {
    const acc = newAccount();
    await setIdentity(acc);
    const device = newDevice();
    const stranger = newAccount();
    const cases: Array<[unknown, number, string]> = [
      [{ pk: "not-a-key", cert: certify(acc, device.pk), bundle: bundleOf(device) }, 400, "bad-pk"],
      [{ pk: device.pk, cert: certify(stranger, device.pk), bundle: bundleOf(device) }, 400, "bad-cert-signature"],
      [{ pk: device.pk, cert: { ...certify(acc, device.pk), v: 1 }, bundle: bundleOf(device) }, 400, "bad-cert"],
      [{ pk: device.pk, cert: certify(acc, device.pk, Date.now() - 1), bundle: bundleOf(device) }, 400, "cert-expired"],
      [{ pk: device.pk, cert: certify(acc, device.pk, Date.now() + DEVICE_CERT_LIFETIME_MS + 3_600_000), bundle: bundleOf(device) }, 400, "cert-too-long"],
      [{ pk: device.pk, cert: certify(acc, device.pk), bundle: bundleOf(device, { signer: newDevice().key }) }, 400, "bad-bundle-signature"],
      [{ pk: device.pk, cert: certify(acc, device.pk), bundle: bundleOf(device, { kemBytes: 1183 }) }, 400, "bad-bundle"],
      [{ pk: device.pk, cert: certify(acc, device.pk), bundle: bundleOf(device, { exp: Date.now() - 1 }) }, 400, "bundle-expired"],
      [{ pk: device.pk, cert: certify(acc, device.pk), bundle: bundleOf(device, { exp: Date.now() + MAILBOX_LIFETIME_MS + 3_600_000 }) }, 400, "bundle-too-long"],
      [{ pk: device.pk, cert: certify(acc, device.pk), bundle: { ...bundleOf(device), id: "short" } }, 400, "bad-bundle"],
      [{ pk: device.pk, cert: certify(acc, device.pk), bundle: bundleOf(device), apk: stranger.apk }, 409, "apk-mismatch"],
      [{ pk: device.pk, cert: certify(acc, device.pk), bundle: bundleOf(device), apk: "AAAA" }, 400, "bad-apk"],
      [[], 400, "bad-request"],
    ];
    for (const [body, status, code] of cases) {
      const res = await put(body, acc.token);
      expect({ code, status: res.status }).toEqual({ code, status });
      expect(await res.json()).toMatchObject({ ok: false, code });
    }
    // Nothing reached the log or the directory.
    expect(kinds(await verifiedEntries(await lookupOf(acc)))).toEqual(["acct"]);
  });

  it("keeps at most KEYS_MAX_DEVICES devices per account", async () => {
    process.env.KEYS_MAX_DEVICES = "2";
    const acc = newAccount();
    await setIdentity(acc);
    expect((await upload(acc, newDevice())).status).toBe(200);
    const second = newDevice();
    expect((await upload(acc, second)).status).toBe(200);
    expect(await upload(acc, newDevice())).toMatchObject({ status: 409, body: { code: "too-many-devices" } });
    // A device already there may still renew.
    expect((await upload(acc, second)).status).toBe(200);
  });
});

/* ------------------------------------------------------------------ hub */

describe("the hub's key-bundles and kt-lookup", () => {
  it("answers for a member by room-scoped reference — and the same empty answer for unknown or foreign references", async () => {
    const alice = newAccount();
    await setIdentity(alice);
    const device = newDevice();
    expect((await upload(alice, device)).status).toBe(200);
    const room = `r3.${randomBytes(24).toString("base64url")}`;
    await join(room, "Alice", alice.token);
    const bob = await join(room, "Bob");
    const aliceRef = String((bob.joined.peers as Array<{ account?: string }>)[0].account);
    expect(aliceRef).toBe(accountRef(room, alice.id));

    bob.c.send({ type: "key-bundles", ref: aliceRef });
    const bundles = await bob.c.next("key-bundles");
    expect(bundles).toMatchObject({ ref: aliceRef, devices: [expect.objectContaining({ pk: device.pk, apk: alice.apk, cert: expect.objectContaining({ v: 2 }), bundle: expect.objectContaining({ kem: expect.any(String) }) })] });
    expect(JSON.stringify(bundles)).not.toContain(alice.id);

    bob.c.send({ type: "kt-lookup", ref: aliceRef });
    const lookup = (await bob.c.next("kt-lookup")).lookup as KtLookup;
    expect(kinds(await verifiedEntries(lookup))).toEqual(["acct", "dev"]);

    // Unknown, and Alice's reference in another room: an empty list, a head without entries.
    for (const ref of ["unknown-ref-00000000000", accountRef("another-room", alice.id)]) {
      bob.c.send({ type: "key-bundles", ref });
      expect(await bob.c.next("key-bundles")).toEqual({ type: "key-bundles", ref, devices: [] });
      bob.c.send({ type: "kt-lookup", ref });
      const empty = await bob.c.next("kt-lookup");
      expect(empty).toMatchObject({ ref, lookup: { sth: expect.objectContaining({ size: expect.any(Number) }), entries: [] } });
    }
  });

  it("refuses the frames outside a room, and rate-limits them like other frames", async () => {
    const c = await WsClient.connect(base);
    clients.push(c);
    await c.next("hello");
    c.send({ type: "key-bundles", ref: "whatever-ref-0000000000" });
    expect(await c.next("error")).toMatchObject({ code: "not-in-room" });
    c.send({ type: "kt-lookup", ref: "bad ref!" });
    expect(await c.next("error")).toMatchObject({ code: "invalid-frame" });
    // Their own bucket (60, 2 a second): a flood is answered with rate-limited.
    for (let i = 0; i < 70; i += 1) c.send({ type: "key-bundles", ref: "whatever-ref-0000000000" });
    expect(await c.next("rate-limited")).toMatchObject({ frame: "key-bundles" });
  });
});

/* --------------------------------------------------------- leaving (rev) */

describe("devices leave the directory with a `rev` entry", () => {
  it("signing out on a device removes the devices that uploaded with that session", async () => {
    const acc = newAccount();
    await setIdentity(acc);
    const phone = newDevice();
    expect((await upload(acc, phone)).status).toBe(200);
    // A second device of the same account, with its own session.
    const laptopToken = accountStore.issueToken(acc.id);
    const laptop = newDevice();
    expect((await put({ pk: laptop.pk, cert: certify(acc, laptop.pk), bundle: bundleOf(laptop) }, laptopToken)).status).toBe(200);

    const signout = await fetch(`${base}/api/account/signout`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${acc.token}` }, body: "{}" });
    expect(signout.status).toBe(200);
    const entries = await verifiedEntries(await lookupOf(acc, laptopToken));
    expect(kinds(entries)).toEqual(["acct", "dev", "dev", "rev"]);
    expect(entries.at(-1)).toMatchObject({ t: "rev", dpk: phone.pk, apk: acc.apk });

    const room = `r3.${randomBytes(24).toString("base64url")}`;
    await join(room, "Acc", laptopToken);
    const viewer = await join(room, "Viewer");
    viewer.c.send({ type: "key-bundles", ref: accountRef(room, acc.id) });
    expect(((await viewer.c.next("key-bundles")).devices as DirectoryDevice[]).map((d) => d.pk)).toEqual([laptop.pk]);
  });

  it("a new account key moves the devices of the old one out", async () => {
    const acc = newAccount();
    await setIdentity(acc);
    const device = newDevice();
    expect((await upload(acc, device)).status).toBe(200);
    const { publicKey } = generateKeyPairSync("ed25519");
    const newApk = b64((publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(12));
    expect((await setIdentity(acc, newApk)).status).toBe(200);
    const entries = await verifiedEntries(await lookupOf(acc));
    expect(kinds(entries)).toEqual(["acct", "dev", "acct", "rev"]);
    expect(entries[2]).toMatchObject({ apk: newApk });
    expect(entries[3]).toMatchObject({ apk: acc.apk, dpk: device.pk });
  });

  it("deleting the account removes every device", async () => {
    const acc = newAccount();
    await setIdentity(acc);
    expect((await upload(acc, newDevice())).status).toBe(200);
    expect((await upload(acc, newDevice())).status).toBe(200);
    const del = await fetch(`${base}/api/account`, { method: "DELETE", headers: { authorization: `Bearer ${acc.token}` } });
    expect(del.status).toBe(200);
    expect(kinds(await verifiedEntries(await lookupDirect(acc)))).toEqual(["acct", "dev", "dev", "rev", "rev"]);
  });
});

/* -------------------------------------------------------------- operator */

describe("the operator's view", () => {
  it("shows key transparency, the directory and room proofs — counts and public values only", async () => {
    const res = await fetch(`${base}/api/admin/security/p4`, { headers: { authorization: `Bearer ${process.env.ADMIN_API_TOKEN}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; available: boolean; kt: { mode: string; state: string; size: number; root: string; sth: SignedTreeHead | null }; directory: { persistent: boolean; devices: number }; proofs: { persistent: boolean; rooms: number } };
    expect(body).toMatchObject({ ok: true, available: true, kt: { mode: "on", state: "ok" }, directory: { persistent: true }, proofs: { persistent: true, required: false } });
    expect(body.kt.size).toBeGreaterThan(0);
    expect(body.kt.root).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect((await fetch(`${base}/api/admin/security/p4`)).status).toBe(401);
  });
});
