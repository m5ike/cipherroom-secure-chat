// @vitest-environment node
//
// REVIEW 6.12 (server) — F-28 per-address caps (share.ts, file-proxy.ts).
// They count the FULL address; a host on IPv6 has a /64 (2^64 addresses), so
// one client still takes everything everyone shares. Secure behaviour
// asserted; failing tests are `it.skip` with a REVIEW-612 note.

import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { ShareStore, sharePerOwner } from "../server/share";
import { FileProxy, fileProxyPerAddress } from "../server/file-proxy";

const b64 = (n: number) => randomBytes(n).toString("base64url");
const invite = () => ({ id: b64(16), proof: b64(32), revokeToken: b64(32), serverKey: b64(32), iv: b64(12), ciphertext: b64(48) });
const v6 = (i: number) => `2001:db8:aa:bb::${i.toString(16)}`;

describe("F-28 caps from one IPv6 /64", () => {
  // REVIEW-612 S09 (fixed): 40 addresses of one /64 held all 2 000 invitations (maxLinks) — everyone else got 503 "full".
  // The cap now counts an IPv6 client by its /64 (server/address-group.ts).
  it("invitations: addresses of one /64 share the per-address cap", () => {
    const store = new ShareStore();
    for (let i = 0; i < sharePerOwner(); i += 1) expect(store.create(invite(), v6(1)).ok).toBe(true);
    // Same /64, next address: secure = the same cap.
    expect(store.create(invite(), v6(2))).toMatchObject({ ok: false, status: 429 });
  });

  it("(was the evidence) addresses of one /64 no longer fill the global invitation table", () => {
    const store = new ShareStore();
    let created = 0;
    for (let a = 1; a <= 40; a += 1) {
      for (let i = 0; i < sharePerOwner(); i += 1) { if (store.create(invite(), v6(a)).ok) created += 1; }
    }
    expect(created).toBe(sharePerOwner());
    expect(store.create(invite(), "198.51.100.77")).toMatchObject({ ok: true });
  });

  // REVIEW-612 S09 (fixed): same for the file proxy (16 per address of 64 in all → 4 addresses of one /64).
  it("file proxy: addresses of one /64 share the per-address cap", () => {
    const owner = new Map<string, string>();
    const proxy = new FileProxy({ addressOf: (id) => owner.get(id) ?? null });
    const meta = (id: string) => ({ type: "proxy-meta" as const, transferId: id, iv: b64(12), ciphertext: b64(64) });
    let n = 0;
    for (let i = 0; i < fileProxyPerAddress(); i += 1) {
      const conn = `c-${n++}`; owner.set(conn, v6(1));
      expect(proxy.begin(conn, meta(b64(12)) as never, 1000).ok).toBe(true);
    }
    const conn = `c-${n++}`; owner.set(conn, v6(2));
    expect(proxy.begin(conn, meta(b64(12)) as never, 1000)).toMatchObject({ ok: false, reason: "per-address-cap" });
  });
});
