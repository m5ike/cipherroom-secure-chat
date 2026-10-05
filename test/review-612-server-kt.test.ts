// @vitest-environment node
//
// REVIEW 6.12 (server) — key transparency and the key directory
// (kt/*, keys/*). Each test asserts the secure / correct behaviour; the ones
// failing on de2874d3 are `it.skip` with a REVIEW-612 note.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSqliteDriver, openPlainDatabase, type SqliteDatabase } from "../server/storage/db";
import { ktSignerFromSeed } from "../server/kt/log";
import { KtService, ktUser } from "../server/kt/service";
import { KeyServices } from "../server/keys/service";
import { MemoryDirectory } from "../server/keys/directory";
import { AccountStore, usernameOf, type AccountRecord } from "../server/accounts/store";
import { generateUsername } from "../server/accounts/username";
import { DEVICE_CERT_LIFETIME_MS, MAILBOX_LIFETIME_MS } from "../client/src/lib/p4/contract";
import type { StoredCredential } from "../server/accounts/webauthn";

let dir = "";
let db: SqliteDatabase;
let accounts: AccountStore;
let kt: KtService;
let keys: KeyServices;

beforeAll(async () => { expect(await loadSqliteDriver()).not.toBeNull(); });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-review-kt-"));
  db = openPlainDatabase(join(dir, "kt.db"), []);
  accounts = new AccountStore(dir);
  kt = KtService.open(db, () => ktSignerFromSeed(randomBytes(32)));
  keys = new KeyServices(accounts, new MemoryDirectory(), () => kt);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

function newAccount(username: string) {
  const credential: StoredCredential = { credentialId: `cred-${randomBytes(8).toString("hex")}`, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 1 };
  const r = accounts.create(credential, { username });
  if (!r.ok) throw new Error(r.reason);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { record: r.account as AccountRecord, apk: b64((publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(12)), accountKey: privateKey };
}

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

/* ------------------------------------------------------------------ S03 */

describe("u = SHA-256(LABEL.ktUser ‖ username) (§ 14.1: 'the log names no user in clear text')", () => {
  // REVIEW-612 S03: u is an UNKEYED hash of the username. Usernames from POST /api/account/register/options (the passkey-only
  // registration, still served) and every 4.0–6.4.0 account are "adj-noun-xxxx": 30 × 30 × 31^4 ≈ 2^29.6 possibilities
  // (form registrations since 6.4.1 have 95 bits and are not affected). Anyone who sees a u — every member of a room via the hub's kt-lookup (also an unproven, blind-id-only joiner), or
  // anyone holding a KT entry — inverts it offline; anyone with a username guess confirms the account and reads its device
  // timeline over the PUBLIC GET /api/kt/lookup?u=. This test inverts the tail in ~1 s; the full space is ~900× that.
  it.skip("the username behind a KT user id cannot be recovered by enumerating the generated-username space", async () => {
    const username = generateUsername(() => false);
    const acc = newAccount(username);
    const dev = newDevice();
    const r = keys.putBundle(accounts.get(acc.record.id)!, null, body(acc, dev, Date.now() + DEVICE_CERT_LIFETIME_MS - 60_000));
    expect(r.ok).toBe(true);
    // What a room member gets from `kt-lookup`: entries carrying u.
    const lookup = await keys.lookup(acc.record.id);
    const u = lookup!.entries[0].entry.u;
    expect(u).toBe(ktUser(usernameOf(acc.record)));

    // The attacker: the two words are 900 guesses; enumerate the 4-character tail for the right pair (923 521 hashes).
    const [adj, noun] = username.split("-");
    const TAIL = "abcdefghjkmnpqrstuvwxyz23456789";
    let found: string | null = null;
    outer: for (const a of TAIL) for (const b of TAIL) for (const c of TAIL) for (const d of TAIL) {
      const guess = `${adj}-${noun}-${a}${b}${c}${d}`;
      if (createHash("sha256").update(`m5cet/kt/user|${guess}`, "utf8").digest("base64url") === u) { found = guess; break outer; }
    }
    // Secure: u is keyed (e.g. an HMAC under a server key, or a VRF) — enumeration finds nothing.
    expect(found).toBeNull();
  }, 60_000);
});

/* ------------------------------------------------------------------ S10 */

describe("growth of the (never pruned) log from one account", () => {
  // REVIEW-612 S10a: every upload of the SAME device with a different cert.exp (the owner signs as many as it likes; exp may
  // even go backwards) appends a `dev` leaf. Only the 60/15 min per-address HTTP limit applies — no per-account / per-device
  // bound — so any signed-in user grows the global log (disk + the in-memory Merkle tree) for ever.
  // REVIEW-612 S10b: ensureAccount() looks for the account's `acct` among the NEWEST 500 entries only (entriesOf limit):
  // once 500 other entries follow it, the next upload appends ANOTHER `acct` leaf for the unchanged key (once per 500).
  it.skip("re-certifying one device 520 times neither appends 520 `dev` leaves nor repeats the unchanged `acct`", async () => {
    const acc = newAccount(`grow${randomBytes(4).toString("hex")}`);
    const dev = newDevice();
    const base = Date.now() + DEVICE_CERT_LIFETIME_MS - 3_600_000;
    for (let i = 0; i < 520; i += 1) {
      const r = keys.putBundle(accounts.get(acc.record.id)!, null, body(acc, dev, base - i * 1000)); // exp going BACKWARDS
      expect(r.ok).toBe(true);
    }
    const entries = kt.entriesOf(ktUser(usernameOf(acc.record)));
    const all = (db.prepare("SELECT kind, count(*) AS n FROM kt_leaves GROUP BY kind").all() as Array<{ kind: string; n: number }>);
    const count = (k: string) => Number(all.find((r) => r.kind === k)?.n ?? 0);
    expect(entries.length).toBeGreaterThan(0);
    // On de2874d3: acct 2, dev 520.
    expect.soft(count("dev")).toBeLessThan(520);
    expect.soft(count("acct")).toBe(1);
  }, 120_000);
});
