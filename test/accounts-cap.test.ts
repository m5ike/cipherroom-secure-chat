// @vitest-environment node
//
// The account cap (6.7, audit S8). It was a fixed 5000 and accounts never
// expired, so registrations nobody used again (a software authenticator
// passes) closed registration for good. Now the cap is ACCOUNTS_MAX, and a
// full store makes room by removing accounts that were never used after
// registering (older than a week) — never one with data or a second sign-in.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore, ACCOUNT_LIMITS, accountCap } from "../server/accounts/store";
import type { StoredCredential } from "../server/accounts/webauthn";

const DAY = 24 * 60 * 60 * 1000;
const credential = (id: string): StoredCredential => ({ credentialId: `cred-${id}-00000000`, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 1 });

let dir = "";
let store: AccountStore;
const t0 = 1_800_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-cap-"));
  store = new AccountStore(dir);
  process.env.ACCOUNTS_MAX = "5";
});
afterEach(() => {
  delete process.env.ACCOUNTS_MAX;
  rmSync(dir, { recursive: true, force: true });
});

function fill(n: number, at: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = store.create(credential(`a${i}`), `user${i}`, at + i);
    if (!r.ok) throw new Error(r.reason);
    ids.push(r.account.id);
  }
  return ids;
}

describe("S8 — a full account store", () => {
  it("the cap comes from ACCOUNTS_MAX (default 5000)", () => {
    expect(accountCap()).toBe(5);
    delete process.env.ACCOUNTS_MAX;
    expect(accountCap()).toBe(ACCOUNT_LIMITS.maxAccounts);
    process.env.ACCOUNTS_MAX = "nonsense";
    expect(accountCap()).toBe(ACCOUNT_LIMITS.maxAccounts);
  });

  it("refuses while the accounts are recent, then makes room by removing never-used ones past the grace period", () => {
    const old = fill(3, t0);
    const recent: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = store.create(credential(`r${i}`), `recent${i}`, t0 + 6 * DAY + i);
      if (!r.ok) throw new Error(r.reason);
      recent.push(r.account.id);
    }
    expect(store.create(credential("late"), "late", t0 + 6 * DAY + 10)).toMatchObject({ ok: false, reason: "account store full" });
    // Ten minutes later the scan may run again; the first three are past a week.
    const later = store.create(credential("later"), "later", t0 + 8 * DAY);
    expect(later.ok).toBe(true);
    for (const id of old) expect(store.get(id)).toBeNull();
    expect(store.findByCredential(credential("a0").credentialId)).toBeNull();
    for (const id of recent) expect(store.get(id)).not.toBeNull();
  });

  it("never removes an account that was used: a second sign-in or stored data", () => {
    const ids = fill(5, t0);
    store.recordSignIn(ids[0], 2, {}, t0 + DAY);
    for (const id of ids.slice(1)) expect(store.putVault(id, { profile: "cHJvZmlsZQ==" }, t0 + DAY).ok).toBe(true);
    expect(store.create(credential("x"), "x", t0 + 30 * DAY)).toMatchObject({ ok: false, reason: "account store full" });
    for (const id of ids) expect(store.get(id)).not.toBeNull();
  });
});
