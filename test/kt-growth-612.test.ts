// @vitest-environment node
//
// 6.12 review S10: the key-transparency log grows only with what changed —
// `acct` when the account key is not the newest one logged (looked up
// directly, not among the newest 500 entries), `dev` when the device was
// never logged, was revoked since, changed its account key or got a
// certificate at least a day longer — and an account adds at most
// KT_ACCOUNT_ENTRIES_PER_DAY entries a day by uploading keys.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSqliteDriver, openPlainDatabase, type SqliteDatabase } from "../server/storage/db";
import { ktSignerFromSeed } from "../server/kt/log";
import { KtService, ktUser } from "../server/kt/service";
import { KeyServices, KT_DEV_RENEW_STEP_MS, ktEntriesPerDay } from "../server/keys/service";
import { MemoryDirectory } from "../server/keys/directory";
import { AccountStore, usernameOf, type AccountRecord } from "../server/accounts/store";
import { DEVICE_CERT_LIFETIME_MS, MAILBOX_LIFETIME_MS } from "../client/src/lib/p4/contract";
import type { StoredCredential } from "../server/accounts/webauthn";

let dir = "";
let db: SqliteDatabase;
let accounts: AccountStore;
let kt: KtService;
let keys: KeyServices;
const saved = { ...process.env };

beforeAll(async () => { expect(await loadSqliteDriver()).not.toBeNull(); });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-kt-growth-"));
  db = openPlainDatabase(join(dir, "kt.db"), []);
  accounts = new AccountStore(dir);
  kt = KtService.open(db, () => ktSignerFromSeed(randomBytes(32)));
  keys = new KeyServices(accounts, new MemoryDirectory(), () => kt);
});
afterEach(() => { process.env = { ...saved }; db.close(); rmSync(dir, { recursive: true, force: true }); });

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

function newAccount() {
  const credential: StoredCredential = { credentialId: `cred-${randomBytes(8).toString("hex")}`, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 1 };
  const r = accounts.create(credential, { username: `grow${randomBytes(4).toString("hex")}` });
  if (!r.ok) throw new Error(r.reason);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { record: r.account as AccountRecord, apk: b64((publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(12)), accountKey: privateKey };
}
type Acc = ReturnType<typeof newAccount>;

function newDevice() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { pk: b64(publicKey.export({ format: "der", type: "spki" }) as Buffer), key: privateKey };
}

function body(acc: { accountKey: KeyObject; apk: string }, dev: { pk: string; key: KeyObject }, certExp: number) {
  const id = randomBytes(8).toString("base64url");
  const dh = b64(generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }) as Buffer);
  const kemRaw = randomBytes(1184);
  const exp = Date.now() + MAILBOX_LIFETIME_MS - 60_000;
  const digest = createHash("sha256").update(kemRaw).digest("base64");
  return {
    pk: dev.pk, apk: acc.apk,
    cert: { v: 2, exp: certExp, sig: b64(sign(null, Buffer.from(`m5cet/device-cert/2|${dev.pk}|${certExp}`), acc.accountKey)) },
    bundle: { id, dh, kem: b64(kemRaw), exp, sig: b64(sign("sha256", Buffer.from(`m5cet/mb/4|${id}|${dh}|${digest}|${exp}`), { key: dev.key, dsaEncoding: "ieee-p1363" })) },
  };
}

const put = (acc: Acc, dev: ReturnType<typeof newDevice>, certExp = Date.now() + DEVICE_CERT_LIFETIME_MS - 60_000, token: string | null = null) =>
  keys.putBundle(accounts.get(acc.record.id)!, token, body(acc, dev, certExp));
const leaves = () => Object.fromEntries((db.prepare("SELECT kind, count(*) AS n FROM kt_leaves GROUP BY kind").all() as Array<{ kind: string; n: number }>).map((r) => [r.kind, Number(r.n)]));

describe("what is logged", () => {
  it("the newest `acct` is found however many entries follow it — an unchanged key is not logged again", () => {
    const u = ktUser("someone");
    const apk = Buffer.alloc(32, 9).toString("base64");
    expect(kt.ensureAccount(u, apk, 1)).toEqual(expect.any(Number));
    for (let i = 0; i < 510; i += 1) kt.append({ t: "dev", u, apk, dpk: `d${i}`, exp: 10, ts: 2 });
    expect(kt.ensureAccount(u, apk, 3)).toBeNull();
    expect(kt.ensureAccount(u, Buffer.alloc(32, 8).toString("base64"), 4)).toEqual(expect.any(Number));
  });

  it("a device is logged again after a revocation, with another account key, or a certificate a day longer — not otherwise", () => {
    const acc = newAccount();
    const dev = newDevice();
    const base = Date.now() + DEVICE_CERT_LIFETIME_MS / 3;
    expect(put(acc, dev, base)).toMatchObject({ ok: true, kt: { dev: expect.any(Number) } });
    expect(put(acc, dev, base + KT_DEV_RENEW_STEP_MS - 1_000)).toMatchObject({ ok: true, kt: { dev: null } });
    expect(put(acc, dev, base - 1_000)).toMatchObject({ ok: true, kt: { dev: null } });
    expect(put(acc, dev, base + KT_DEV_RENEW_STEP_MS)).toMatchObject({ ok: true, kt: { dev: expect.any(Number) } });
    // Signed out on that device: `rev`, and the next upload logs the device again.
    const token = accounts.issueToken(acc.record.id);
    const dev2 = newDevice();
    expect(put(acc, dev2, base, `hash-${token.slice(0, 8)}`)).toMatchObject({ ok: true });
    expect(keys.sessionsEnded(acc.record.id, `hash-${token.slice(0, 8)}`, "signout")).toBe(1);
    expect(put(acc, dev2, base)).toMatchObject({ ok: true, kt: { dev: expect.any(Number) } });
    expect(leaves()).toEqual({ acct: 1, dev: 4, rev: 1 });
  });
});

describe("the daily cap per account", () => {
  it("KT_ACCOUNT_ENTRIES_PER_DAY: past it an upload that would log something is refused (429 kt-quota); one that logs nothing is not", () => {
    process.env.KT_ACCOUNT_ENTRIES_PER_DAY = "5";
    expect(ktEntriesPerDay()).toBe(5);
    const acc = newAccount();
    const devices = Array.from({ length: 5 }, newDevice);
    for (const d of devices.slice(0, 4)) expect(put(acc, d)).toMatchObject({ ok: true }); // acct + 4 dev = 5
    expect(put(acc, devices[4])).toMatchObject({ ok: false, status: 429, code: "kt-quota" });
    // A bundle renewal of a known device (nothing new in the log) still goes through.
    expect(put(acc, devices[0])).toMatchObject({ ok: true, kt: { acct: null, dev: null } });
    // Another account has its own budget.
    expect(put(newAccount(), newDevice())).toMatchObject({ ok: true });
    expect(kt.countSince(ktUser(usernameOf(acc.record)), 0)).toBe(5);
  });

  it("defaults to 40, takes 5 – 10 000", () => {
    expect(ktEntriesPerDay({})).toBe(40);
    expect(ktEntriesPerDay({ KT_ACCOUNT_ENTRIES_PER_DAY: "4" })).toBe(40);
    expect(ktEntriesPerDay({ KT_ACCOUNT_ENTRIES_PER_DAY: "100" })).toBe(100);
  });
});
