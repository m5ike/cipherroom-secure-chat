// @vitest-environment node
//
// Usernames (4.0): the server names every new account (unique, the account's
// primary key, stored in the passkey), and a P2P session gets one made from
// its nickname. The nickname itself is only what others see.

import { describe, it, expect } from "vitest";
import { generateUsername, isUsername, userHandleFor, usernameFromHandle, USERNAME_RE } from "../server/accounts/username";
import { AccountStore, usernameOf } from "../server/accounts/store";
import { cleanUsername, sessionUsername, slugify } from "../client/src/lib/username";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("account usernames", () => {
  it("are two words and a tail without look-alikes, and unique against the store", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const name = generateUsername((n) => taken.has(n));
      expect(name).toMatch(USERNAME_RE);
      expect(name).not.toMatch(/-[a-z0-9]*[ilo01][a-z0-9]*$/);
      expect(isUsername(name)).toBe(true);
      expect(taken.has(name)).toBe(false);
      taken.add(name);
    }
  });

  it("grow the tail when the short names are taken", () => {
    const name = generateUsername((n) => /-[a-z0-9]{4}$/.test(n));
    expect(name).toMatch(/-[a-z0-9]{5,6}$/);
  });

  it("travel in the passkey as its user handle and come back out of it", () => {
    expect(usernameFromHandle(userHandleFor("bystry-sokol-7k3q"))).toBe("bystry-sokol-7k3q");
    expect(usernameFromHandle(undefined)).toBe("");
  });

  it("are the id of a new account, while an older account's id is its username", () => {
    const dir = mkdtempSync(join(tmpdir(), "m5cet-username-"));
    try {
      const store = new AccountStore(dir);
      const cred = (id: string) => ({ credentialId: id, publicKey: { kty: "EC" } as JsonWebKey, alg: -7, signCount: 0, transports: [] }) as never;
      const username = store.newUsername();
      const created = store.create(cred("c1"), { username });
      expect(created.ok && created.account.id).toBe(username);
      expect(created.ok && usernameOf(created.account)).toBe(username);
      // The same name twice (any case) is refused.
      expect(store.create(cred("c2"), { username: username.toUpperCase() }).ok).toBe(false);
      // Before 4.0: the id from the credential, the typed name only a label.
      const legacy = store.create(cred("c3"), "Alice");
      expect(legacy.ok && usernameOf(legacy.account)).toBe(legacy.ok && legacy.account.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keep only the hash of the key proof and compare in constant time", () => {
    const dir = mkdtempSync(join(tmpdir(), "m5cet-keyproof-"));
    try {
      const store = new AccountStore(dir);
      const cred = { credentialId: "c1", publicKey: { kty: "EC" } as JsonWebKey, alg: -7, signCount: 0, transports: [] } as never;
      const r = store.create(cred, { username: store.newUsername() });
      if (!r.ok) throw new Error(r.reason);
      expect(store.checkKeyProof(r.account.id, "p".repeat(43))).toBe("unset");
      store.setKeyVerifier(r.account.id, "p".repeat(43));
      expect(store.get(r.account.id)!.keyVerifier).not.toContain("ppp");
      expect(store.checkKeyProof(r.account.id, "p".repeat(43))).toBe("ok");
      expect(store.checkKeyProof(r.account.id, "q".repeat(43))).toBe("mismatch");
      // Set once: a later call cannot replace it.
      expect(store.setKeyVerifier(r.account.id, "q".repeat(43))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P2P session usernames", () => {
  it("come from the nickname plus four random characters", () => {
    const name = sessionUsername("Tomáš K.");
    expect(name).toMatch(/^tomas-k-[a-z2-9]{4}$/);
    expect(sessionUsername("Tomáš K.")).not.toBe(name);
    expect(sessionUsername("")).toMatch(/^host-[a-z2-9]{4}$/);
    expect(slugify("  Žluťoučký   kůň! ")).toBe("zlutoucky-kun");
  });

  it("from a peer are taken only when plain", () => {
    expect(cleanUsername("alice-7k3q")).toBe("alice-7k3q");
    expect(cleanUsername("<b>x</b>")).toBe("");
    expect(cleanUsername(42)).toBe("");
  });
});
