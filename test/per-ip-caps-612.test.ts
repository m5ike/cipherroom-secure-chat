// @vitest-environment node
// 6.12 (F-28): per-address caps on top of the global ones — live invitations
// (2 000 in all; one address may hold SHARE_MAX_PER_IP, 50) and file proxy
// transfers (64 in all; one address FILE_PROXY_MAX_PER_IP, 16) — so a single
// client cannot use up what everyone shares.

import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { ShareStore, SHARE_LIMITS, sharePerOwner } from "../server/share";
import { FileProxy, fileProxyPerAddress } from "../server/file-proxy";

afterEach(() => { delete process.env.SHARE_MAX_PER_IP; delete process.env.FILE_PROXY_MAX_PER_IP; });

const b64 = (n: number) => randomBytes(n).toString("base64url");
const invite = () => ({ id: b64(16), proof: b64(32), revokeToken: b64(32), serverKey: b64(32), iv: b64(12), ciphertext: b64(48) });

describe("invitations per address", () => {
  it("one address holds at most SHARE_MAX_PER_IP live invitations; others are not affected", () => {
    process.env.SHARE_MAX_PER_IP = "3";
    expect(sharePerOwner()).toBe(3);
    const store = new ShareStore();
    for (let i = 0; i < 3; i++) expect(store.create(invite(), "203.0.113.7").ok).toBe(true);
    expect(store.create(invite(), "203.0.113.7")).toEqual({ ok: false, status: 429, reason: "too-many-for-address" });
    expect(store.create(invite(), "198.51.100.2").ok).toBe(true);
    // Without an owner (internal callers) the per-address cap does not apply.
    expect(store.create(invite()).ok).toBe(true);
  });

  it("a redeemed or expired invitation frees the slot", () => {
    process.env.SHARE_MAX_PER_IP = "1";
    let now = 1_000_000;
    const store = new ShareStore(() => now);
    const first = invite();
    expect(store.create({ ...first, ttlSec: SHARE_LIMITS.minTtlSec }, "203.0.113.9").ok).toBe(true);
    expect(store.create(invite(), "203.0.113.9").ok).toBe(false);
    expect(store.redeem(first.id, first.proof).ok).toBe(true);
    expect(store.create({ ...invite(), ttlSec: SHARE_LIMITS.minTtlSec }, "203.0.113.9").ok).toBe(true);
    now += SHARE_LIMITS.minTtlSec * 1000 + 1;
    expect(store.create(invite(), "203.0.113.9").ok).toBe(true);
  });

  it("defaults to 50", () => {
    expect(sharePerOwner()).toBe(50);
  });
});

describe("file proxy transfers per address", () => {
  it("one address runs at most FILE_PROXY_MAX_PER_IP transfers, over any number of connections", () => {
    process.env.FILE_PROXY_MAX_PER_IP = "5";
    expect(fileProxyPerAddress()).toBe(5);
    const addresses: Record<string, string> = {};
    const proxy = new FileProxy({ addressOf: (c) => addresses[c] ?? null });
    let n = 0;
    const begin = (conn: string) => proxy.begin(conn, { transferId: `t-${conn}-${n++}`, iv: "iv", ciphertext: "ct" }, 1000);
    // Two connections from one address (four transfers each would be allowed per connection).
    addresses["c-a"] = "203.0.113.7"; addresses["c-b"] = "203.0.113.7"; addresses["c-other"] = "198.51.100.3";
    for (let i = 0; i < 4; i++) expect(begin("c-a").ok).toBe(true);
    expect(begin("c-b").ok).toBe(true);
    expect(begin("c-b")).toEqual({ ok: false, reason: "per-address-cap" });
    expect(begin("c-other").ok).toBe(true);
    // A finished transfer frees a slot.
    proxy.cancel("t-c-a-0");
    expect(begin("c-b").ok).toBe(true);
    expect(proxy.stats().maxPerAddress).toBe(5);
  });

  it("defaults to 16 and the hub's connection addresses", () => {
    expect(fileProxyPerAddress()).toBe(16);
    const proxy = new FileProxy();
    expect(proxy.begin("c-unknown", { transferId: "tx-1", iv: "iv", ciphertext: "ct" }, 10).ok).toBe(true);
  });
});
