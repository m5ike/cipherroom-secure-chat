import { describe, expect, it } from "vitest";
import { ShareStore, SHARE_LIMITS } from "../server/share";

const b64 = (n: number, ch = "A") => ch.repeat(n);
const ID = b64(22, "i");
const PROOF = b64(43, "p");
const REVOKE = b64(43, "r");
const make = (over: Record<string, unknown> = {}) => ({
  id: ID, proof: PROOF, revokeToken: REVOKE, serverKey: b64(43, "k"),
  iv: b64(16, "v"), ciphertext: b64(64, "c"), ...over,
});

describe("ShareStore", () => {
  it("releases the server key only for the right proof and counts uses", () => {
    const store = new ShareStore();
    expect(store.create(make({ maxUses: 2 })).ok).toBe(true);

    const first = store.redeem(ID, PROOF);
    expect(first.ok && first.usesLeft).toBe(1);
    expect(first.ok && first.serverKey).toBe(b64(43, "k"));

    const second = store.redeem(ID, PROOF);
    expect(second.ok && second.usesLeft).toBe(0);

    // X connections reached: the invite no longer exists
    expect(store.redeem(ID, PROOF)).toMatchObject({ ok: false, status: 404 });
    expect(store.size).toBe(0);
  });

  it("burns the invite after too many wrong codes — no unlimited guessing", () => {
    const store = new ShareStore();
    store.create(make());
    const wrong = b64(43, "x");
    for (let left = SHARE_LIMITS.maxAttempts - 1; left >= 1; left--) {
      expect(store.redeem(ID, wrong)).toMatchObject({ ok: false, status: 403, attemptsLeft: left });
    }
    expect(store.redeem(ID, wrong)).toMatchObject({ ok: false, status: 410, reason: "burned" });
    // even the correct code is useless now
    expect(store.redeem(ID, PROOF)).toMatchObject({ ok: false, status: 404 });
  });

  it("does not let a wrong code consume a use", () => {
    const store = new ShareStore();
    store.create(make({ maxUses: 1 }));
    store.redeem(ID, b64(43, "x"));
    expect(store.redeem(ID, PROOF)).toMatchObject({ ok: true, usesLeft: 0 });
  });

  it("answers unknown, malformed and expired ids identically", () => {
    let t = 1_000_000;
    const store = new ShareStore(() => t);
    store.create(make({ ttlSec: SHARE_LIMITS.minTtlSec }));
    const unknown = store.redeem(b64(22, "z"), PROOF);
    const malformed = store.redeem("../etc/passwd", PROOF);
    t += SHARE_LIMITS.minTtlSec * 1000 + 1;
    const expired = store.redeem(ID, PROOF);
    for (const r of [unknown, malformed, expired]) expect(r).toEqual({ ok: false, status: 404, reason: "not-found" });
    expect(store.size).toBe(0);
  });

  it("validates every field and clamps uses / ttl", () => {
    const store = new ShareStore();
    for (const bad of [
      { id: "short" }, { id: b64(22, "*") }, { proof: b64(42) }, { serverKey: 7 }, { iv: b64(15) },
      { ciphertext: "" }, { ciphertext: b64(SHARE_LIMITS.maxCiphertextChars + 1) }, { ciphertext: "not base64url!!!!!!!!!!!!" },
      { maxUses: 0 }, { maxUses: SHARE_LIMITS.maxUses + 1 }, { maxUses: 1.5 },
      { ttlSec: SHARE_LIMITS.minTtlSec - 1 }, { ttlSec: SHARE_LIMITS.maxTtlSec + 1 },
    ]) {
      expect(store.create(make(bad))).toMatchObject({ ok: false, status: 400 });
    }
    expect(store.size).toBe(0);
  });

  it("refuses to overwrite an existing invite", () => {
    const store = new ShareStore();
    store.create(make());
    expect(store.create(make({ serverKey: b64(43, "e") }))).toMatchObject({ ok: false, status: 409 });
    const r = store.redeem(ID, PROOF);
    expect(r.ok && r.serverKey).toBe(b64(43, "k"));
  });

  it("revokes only with the creator's token", () => {
    const store = new ShareStore();
    store.create(make());
    expect(store.revoke(ID, b64(43, "x"))).toBe(false);
    expect(store.size).toBe(1);
    expect(store.revoke(ID, REVOKE)).toBe(true);
    expect(store.redeem(ID, PROOF)).toMatchObject({ ok: false, status: 404 });
  });

  it("caps the number of outstanding invites", () => {
    const store = new ShareStore();
    const id = (n: number) => n.toString(36).padStart(22, "0");
    for (let n = 0; n < SHARE_LIMITS.maxLinks; n++) expect(store.create(make({ id: id(n) })).ok).toBe(true);
    expect(store.create(make({ id: id(SHARE_LIMITS.maxLinks) }))).toMatchObject({ ok: false, status: 503 });
  });
});
