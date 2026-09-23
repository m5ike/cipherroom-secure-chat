// @vitest-environment node
//
// The signed-in user's server state (server/accounts/store.ts): accounts,
// session tokens, the encrypted vault, the away mailbox, push targets,
// retention and deletion. Everything runs against a temporary directory —
// the on-disk format is part of the contract (a restart must not sign a
// user out of their data).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore, ACCOUNT_LIMITS, accountIdFor } from "../server/accounts/store";
import type { StoredCredential } from "../server/accounts/webauthn";

const DAY = 24 * 60 * 60 * 1000;

function credential(id = "credential-id-0000001"): StoredCredential {
  return { credentialId: id, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 1 };
}

let dir = "";
let store: AccountStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-accounts-"));
  store = new AccountStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeAccount(name = "Alice", id?: string) {
  const r = store.create(credential(id), name);
  if (!r.ok) throw new Error(r.reason);
  return r.account;
}

describe("accounts", () => {
  it("creates an account keyed by the credential and survives a restart", () => {
    const acc = makeAccount();
    expect(acc.id).toBe(accountIdFor(credential().credentialId));
    expect(store.findByCredential(credential().credentialId)?.id).toBe(acc.id);
    store.flush();

    const reopened = new AccountStore(dir);
    const back = reopened.findByCredential(credential().credentialId);
    expect(back?.userName).toBe("Alice");
    expect(back?.credential.publicKeyJwk).toEqual(credential().publicKeyJwk);
    // Account files must not be world-readable.
    expect(statSync(join(dir, "accounts.json")).mode & 0o077).toBe(0);
  });

  it("refuses the same credential twice", () => {
    makeAccount();
    expect(store.create(credential(), "Mallory")).toMatchObject({ ok: false });
  });

  it("records sign-ins with the new signature counter", () => {
    const acc = makeAccount();
    store.recordSignIn(acc.id, 42, { client: "Chrome/macOS" });
    const back = store.get(acc.id)!;
    expect(back.credential.signCount).toBe(42);
    expect(back.loginCount).toBe(2);
    expect(back.audit.at(-1)).toMatchObject({ kind: "sign-in", meta: { client: "Chrome/macOS" } });
  });
});

describe("session tokens", () => {
  it("resolves only a live token, and forgets it on sign-out", () => {
    const acc = makeAccount();
    const token = store.issueToken(acc.id);
    expect(store.resolveToken(token)?.id).toBe(acc.id);
    expect(store.resolveToken("not-a-real-token-value-here")).toBeNull();
    expect(store.resolveToken(token, Date.now() + ACCOUNT_LIMITS.tokenTtlMs + 1)).toBeNull();
    store.revokeToken(token);
    expect(store.resolveToken(token)).toBeNull();
  });

  it("revokes every session of an account", () => {
    const acc = makeAccount();
    const a = store.issueToken(acc.id);
    const b = store.issueToken(acc.id);
    store.revokeAll(acc.id);
    expect(store.resolveToken(a)).toBeNull();
    expect(store.resolveToken(b)).toBeNull();
  });

  it("keeps sessions across a restart, as hashes, and ends them after 7 days whatever happens", () => {
    const acc = makeAccount();
    const t0 = 1_800_000_000_000;
    const token = store.issueToken(acc.id, t0);
    store.flush();
    const restarted = new AccountStore(dir);
    expect(restarted.resolveToken(token, t0 + 60_000)?.id).toBe(acc.id);
    // Used every few hours it slides on…
    let at = t0;
    for (let i = 0; i < 12; i++) { at += 10 * 60 * 60 * 1000; expect(restarted.resolveToken(token, at)?.id).toBe(acc.id); }
    // …but not past the maximum age.
    expect(restarted.resolveToken(token, t0 + 7 * 24 * 60 * 60 * 1000 + 1)).toBeNull();
  });

  it("ends an idle session after 12 hours", () => {
    const acc = makeAccount();
    const token = store.issueToken(acc.id, 1_000);
    expect(store.resolveToken(token, 1_000 + 12 * 60 * 60 * 1000 + 1)).toBeNull();
  });
});

describe("vault", () => {
  it("stores the sealed blobs and counts what it cannot read", () => {
    const acc = makeAccount();
    const chat = Buffer.from("sealed chat").toString("base64");
    expect(store.putVault(acc.id, { profile: Buffer.from("sealed profile").toString("base64"), chat: { ct: chat, messages: 12, messageBytes: 3400, rooms: 2 } })).toEqual({ ok: true });
    expect(store.getVault(acc.id).chat?.ct).toBe(chat);
    expect(store.summary(acc.id)).toMatchObject({ vault: { messages: 12, messageBytes: 3400, rooms: 2, chatBytes: chat.length } });
  });

  it("refuses non-base64 and oversized blobs", () => {
    const acc = makeAccount();
    expect(store.putVault(acc.id, { profile: "not base64 !!" })).toMatchObject({ ok: false });
    expect(store.putVault(acc.id, { chat: { ct: "A".repeat(ACCOUNT_LIMITS.maxChatChars + 1), messages: 1, messageBytes: 1, rooms: 1 } })).toMatchObject({ ok: false });
    expect(store.getVault(acc.id)).toEqual({});
  });
});

describe("away mailbox", () => {
  const envelope = { iv: "aXY=", ciphertext: "Y3Q=" };
  const from = { peerId: "peer-1", name: "Bob" };

  it("stores, lists per room and hands items over on acknowledgement", () => {
    const acc = makeAccount();
    const a = store.addMail(acc.id, { room: "alpha", kind: "message", from, messageId: "m1", envelope });
    store.addMail(acc.id, { room: "beta", kind: "message", from, messageId: "m2", envelope });
    expect(a.ok).toBe(true);
    expect(store.mailbox(acc.id, "alpha").map((i) => i.messageId)).toEqual(["m1"]);
    expect(store.mailboxStats(acc.id)).toMatchObject({ pending: 2 });

    const taken = store.takeMail(acc.id, [(a as { item: { id: string } }).item.id]);
    expect(taken).toHaveLength(1);
    expect(store.mailbox(acc.id)).toHaveLength(1);
  });

  it("bounds a single item and the mailbox as a whole", () => {
    const acc = makeAccount();
    const huge = { iv: "aXY=", ciphertext: "A".repeat(ACCOUNT_LIMITS.maxItemBytes) };
    expect(store.addMail(acc.id, { room: "alpha", kind: "message", from, messageId: "big", envelope: huge })).toMatchObject({ ok: false });
    for (let i = 0; i < ACCOUNT_LIMITS.maxMailboxItems; i++) {
      store.addMail(acc.id, { room: "alpha", kind: "message", from, messageId: `m${i}`, envelope });
    }
    expect(store.addMail(acc.id, { room: "alpha", kind: "message", from, messageId: "one-too-many", envelope })).toMatchObject({ ok: false, reason: "mailbox full" });
  });

  it("ignores an unknown account", () => {
    expect(store.addMail("nosuchaccount0000000", { room: "a", kind: "message", from, messageId: "m", envelope })).toMatchObject({ ok: false });
    expect(store.mailbox("nosuchaccount0000000")).toEqual([]);
  });
});

describe("away state", () => {
  it("marks, lists and clears per room", () => {
    const acc = makeAccount();
    store.setAway(acc.id, "alpha", "Alice");
    expect(store.isAway(acc.id, "alpha")).toBe(true);
    expect(store.isAway(acc.id, "beta")).toBe(false);
    expect(store.awayInRoom("alpha")).toEqual([{ accountId: acc.id, name: "Alice", since: expect.any(Number) }]);
    expect(store.clearAway(acc.id, "alpha")).toBe(true);
    expect(store.clearAway(acc.id, "alpha")).toBe(false);
  });

  it("clearAllAway reports every room it left", () => {
    const acc = makeAccount();
    store.setAway(acc.id, "alpha", "Alice");
    store.setAway(acc.id, "beta", "Alice");
    expect(store.clearAllAway(acc.id).sort()).toEqual(["alpha", "beta"]);
    expect(store.get(acc.id)!.away).toEqual([]);
  });
});

describe("push targets", () => {
  it("keeps https endpoints, replaces duplicates and rejects junk", () => {
    const acc = makeAccount();
    const sub = { endpoint: "https://push.example/aaa", keys: { p256dh: "p", auth: "a" } };
    expect(store.addPush(acc.id, sub)).toEqual({ ok: true });
    expect(store.addPush(acc.id, sub)).toEqual({ ok: true });
    expect(store.get(acc.id)!.push).toHaveLength(1);
    expect(store.addPush(acc.id, { endpoint: "http://push.example/x", keys: { p256dh: "p", auth: "a" } })).toMatchObject({ ok: false });
    store.removePushEndpoint(acc.id, sub.endpoint);
    expect(store.get(acc.id)!.push).toHaveLength(0);
  });
});

describe("retention and deletion", () => {
  it("prunes old mailbox items, old audit lines and expired tokens", () => {
    const acc = makeAccount();
    const now = Date.now();
    store.addMail(acc.id, { room: "alpha", kind: "message", from: { peerId: "p", name: "B" }, messageId: "old", envelope: { iv: "aXY=", ciphertext: "Y3Q=" } }, now - 40 * DAY);
    store.addMail(acc.id, { room: "alpha", kind: "message", from: { peerId: "p", name: "B" }, messageId: "new", envelope: { iv: "aXY=", ciphertext: "Y3Q=" } }, now);
    store.addAudit(acc.id, "old-line", undefined, now - 100 * DAY);
    store.issueToken(acc.id, now - 2 * ACCOUNT_LIMITS.tokenTtlMs);

    const result = store.prune({ mailbox: now - 30 * DAY, audit: now - 60 * DAY }, now);
    expect(result).toMatchObject({ mailboxItems: 1, tokens: 1 });
    expect(result.auditEntries).toBeGreaterThanOrEqual(1);
    expect(store.mailbox(acc.id).map((i) => i.messageId)).toEqual(["new"]);
    expect(store.get(acc.id)!.audit.some((e) => e.kind === "old-line")).toBe(false);
  });

  it("deleting an account removes its vault and mailbox from disk", () => {
    const acc = makeAccount();
    store.putVault(acc.id, { profile: Buffer.from("x").toString("base64") });
    store.addMail(acc.id, { room: "a", kind: "message", from: { peerId: "p", name: "B" }, messageId: "m", envelope: { iv: "aXY=", ciphertext: "Y3Q=" } });
    const token = store.issueToken(acc.id);
    expect(store.deleteAccount(acc.id)).toBe(true);
    expect(store.get(acc.id)).toBeNull();
    expect(store.resolveToken(token)).toBeNull();
    expect(() => statSync(join(dir, "vault", `${acc.id}.json`))).toThrow();
    expect(() => statSync(join(dir, "mailbox", `${acc.id}.json`))).toThrow();
    store.flush();
    expect(new AccountStore(dir).size).toBe(0);
  });
});

describe("read-only installation", () => {
  it("keeps working in memory when the directory cannot be written", () => {
    const readOnly = new AccountStore(join(dir, "nested", "\0invalid"));
    const r = readOnly.create(credential(), "Alice");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(readOnly.status().persistent).toBe(false);
    expect(readOnly.putVault(r.account.id, { profile: Buffer.from("x").toString("base64") })).toEqual({ ok: true });
    expect(readOnly.getVault(r.account.id).profile?.ct).toBe(Buffer.from("x").toString("base64"));
    expect(readOnly.addMail(r.account.id, { room: "a", kind: "message", from: { peerId: "p", name: "B" }, messageId: "m", envelope: { iv: "aXY=", ciphertext: "Y3Q=" } }).ok).toBe(true);
    expect(readOnly.mailbox(r.account.id)).toHaveLength(1);
  });
});
