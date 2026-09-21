import { describe, expect, it } from "vitest";
import {
  buildShareUrl, createShare, formatCode, generateCode, normalizeCode, parseShareFragment,
  randomGuestName, redeemShare, shareTargets, sealPayload, openPayload, CODE_DIGITS,
} from "../client/src/lib/share-link";
import { ShareStore, SHARE_LIMITS } from "../server/share";

// A fetch that talks to the real server-side store, no network involved.
function fetcherFor(store: ShareStore): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (String(input).endsWith("/create")) { const r = store.create(body); return r.ok ? json(201, { ...r, maxAttempts: SHARE_LIMITS.maxAttempts }) : json(r.status, r); }
    if (String(input).endsWith("/redeem")) { const r = store.redeem(body.id, body.proof); return json(r.ok ? 200 : r.status, r); }
    return json(404, {});
  }) as typeof fetch;
}

const ROOM = { room: "brno-secure", passphrase: "tajný klíč 🔐" };

describe("12-digit code", () => {
  it("is 12 decimal digits, formatted XXXX-XXXX-XXXX, and different every time", () => {
    const codes = new Set(Array.from({ length: 200 }, generateCode));
    expect(codes.size).toBe(200);
    for (const code of codes) {
      expect(code).toMatch(/^\d{12}$/);
      expect(formatCode(code)).toMatch(/^\d{4}-\d{4}-\d{4}$/);
      expect(normalizeCode(formatCode(code))).toBe(code);
    }
  });

  it("covers all ten digits roughly evenly (no modulo bias)", () => {
    const counts = new Array(10).fill(0);
    for (let i = 0; i < 2000; i++) for (const ch of generateCode()) counts[Number(ch)]++;
    const expected = (2000 * CODE_DIGITS) / 10;
    for (const c of counts) expect(Math.abs(c - expected) / expected).toBeLessThan(0.1);
  });

  it("normalises user input and rejects the wrong length", () => {
    expect(normalizeCode(" 1234 5678-9012 ")).toBe("123456789012");
    expect(normalizeCode("1234-5678-901")).toBeNull();
    expect(normalizeCode("1234-5678-9012-3")).toBeNull();
  });
});

describe("link format", () => {
  it("keeps every secret in the fragment, which browsers never send to a server", async () => {
    const share = await createShare(ROOM, { maxUses: 1, ttlSec: 3600 }, { origin: "https://chat.example", fetcher: fetcherFor(new ShareStore()) });
    const u = new URL(share.url);
    expect(u.origin + u.pathname + u.search).toBe("https://chat.example/");   // what a crawler / preview bot requests
    expect(u.hash).toMatch(/^#j=[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(share.url).not.toContain(share.code);
    expect(share.url).not.toContain("brno-secure");
  });

  it("parses what it builds and rejects anything else", () => {
    const parts = { id: "A".repeat(22), linkKey: crypto.getRandomValues(new Uint8Array(32)) };
    const parsed = parseShareFragment(new URL(buildShareUrl("https://x.example/", parts)).hash);
    expect(parsed?.id).toBe(parts.id);
    expect(Array.from(parsed!.linkKey)).toEqual(Array.from(parts.linkKey));
    for (const bad of ["", "#", "#j=short.key", "#j=" + "A".repeat(22), "#x=" + "A".repeat(22) + "." + "B".repeat(43), "#j=" + "A".repeat(22) + "." + "B".repeat(44)]) {
      expect(parseShareFragment(bad)).toBeNull();
    }
  });
});

describe("invite end to end (client crypto + server gate)", () => {
  it("the right code opens it; every share gets a fresh code and link", async () => {
    const store = new ShareStore(); const fetcher = fetcherFor(store);
    const a = await createShare(ROOM, { maxUses: 1, ttlSec: 3600 }, { origin: "https://h", fetcher });
    const b = await createShare(ROOM, { maxUses: 1, ttlSec: 3600 }, { origin: "https://h", fetcher });
    expect(a.code).not.toBe(b.code); expect(a.url).not.toBe(b.url);

    const out = await redeemShare(parseShareFragment(new URL(a.url).hash)!, formatCode(a.code), { fetcher });
    expect(out.ok && out.payload).toMatchObject({ room: "brno-secure", passphrase: "tajný klíč 🔐" });
    expect(out.ok && out.payload.name).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
  }, 30_000);

  it("is limited to X connections", async () => {
    const store = new ShareStore(); const fetcher = fetcherFor(store);
    const share = await createShare(ROOM, { maxUses: 2, ttlSec: 3600 }, { origin: "https://h", fetcher });
    const parts = parseShareFragment(new URL(share.url).hash)!;
    expect((await redeemShare(parts, share.code, { fetcher })).ok).toBe(true);
    expect((await redeemShare(parts, share.code, { fetcher })).ok).toBe(true);
    expect(await redeemShare(parts, share.code, { fetcher })).toMatchObject({ ok: false, reason: "not-found" });
  }, 30_000);

  it("a wrong code gets nothing, and five of them burn the link", async () => {
    const store = new ShareStore(); const fetcher = fetcherFor(store);
    const share = await createShare(ROOM, { maxUses: 5, ttlSec: 3600 }, { origin: "https://h", fetcher });
    const parts = parseShareFragment(new URL(share.url).hash)!;
    const wrong = share.code === "000000000000" ? "111111111111" : "000000000000";
    for (let i = 0; i < SHARE_LIMITS.maxAttempts - 1; i++) expect(await redeemShare(parts, wrong, { fetcher })).toMatchObject({ ok: false, reason: "wrong-code" });
    expect(await redeemShare(parts, wrong, { fetcher })).toMatchObject({ ok: false, reason: "burned" });
    expect(await redeemShare(parts, share.code, { fetcher })).toMatchObject({ ok: false, reason: "not-found" });
  }, 60_000);

  it("what the server stores does not decrypt without the link key — nor with a wrong code", async () => {
    const id = "A".repeat(22);
    const linkKey = crypto.getRandomValues(new Uint8Array(32)); const serverKey = crypto.getRandomValues(new Uint8Array(32));
    const payload = { v: 1 as const, room: "r", passphrase: "p", name: "n", createdAt: 1 };
    const sealed = await sealPayload("123456789012", id, linkKey, serverKey, payload);
    expect(await openPayload("123456789012", id, linkKey, serverKey, sealed.iv, sealed.ciphertext)).toEqual(payload);
    // the server's view: serverKey + ciphertext, but some other link key
    await expect(openPayload("123456789012", id, crypto.getRandomValues(new Uint8Array(32)), serverKey, sealed.iv, sealed.ciphertext)).rejects.toThrow();
    // a link thief's view: linkKey, but no server key
    await expect(openPayload("123456789012", id, linkKey, crypto.getRandomValues(new Uint8Array(32)), sealed.iv, sealed.ciphertext)).rejects.toThrow();
    // everything but the code
    await expect(openPayload("123456789013", id, linkKey, serverKey, sealed.iv, sealed.ciphertext)).rejects.toThrow();
    // ciphertext moved to another invite id
    await expect(openPayload("123456789012", "B".repeat(22), linkKey, serverKey, sealed.iv, sealed.ciphertext)).rejects.toThrow();
  }, 60_000);
});

describe("share targets and names", () => {
  it("puts only the link into messenger deep links — never the code", () => {
    const targets = shareTargets("https://h/#j=abc", "Pozvánka");
    expect(targets.map((t) => t.id)).toEqual(expect.arrayContaining(["whatsapp", "viber", "email", "sms", "telegram", "signal", "imessage", "messenger", "qr", "copy", "native"]));
    for (const t of targets) if (t.href) { expect(t.href).toContain(encodeURIComponent("https://h/#j=abc")); expect(t.href).toMatch(/^(https:\/\/(wa\.me|t\.me)\/|viber:|fb-messenger:|sms:|mailto:)/); }
  });

  it("generates guest names the signaling server accepts as-is", () => {
    for (let i = 0; i < 50; i++) expect(randomGuestName()).toMatch(/^[a-zA-Z0-9 ._-]{1,48}$/);
  });
});
