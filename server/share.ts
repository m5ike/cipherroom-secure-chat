// Invite links: the server half of a split-key scheme.
//
// An invite carries room id + room key + a suggested name. The inviter's
// browser encrypts that payload with a key derived from THREE parts:
//
//   linkKey    32 random bytes, only in the URL fragment (#…) — browsers never
//              send a fragment to any server, so it never reaches us, a
//              crawler, or a messenger's link-preview fetcher;
//   serverKey  32 random bytes, stored here and released only to a caller who
//              proves knowledge of the code;
//   code       the 12-digit number shown to the inviter as XXXX-XXXX-XXXX.
//
// Why the server is involved at all: 12 digits are only ~40 bits. A link that
// carried everything needed to decrypt could be brute-forced offline. Here a
// holder of the link still needs serverKey, and we hand that out only after a
// correct proof, at most MAX_ATTEMPTS wrong tries per link (then it burns) and
// at most `maxUses` successful redemptions.
//
// What we can and cannot see: we store ciphertext, serverKey and a hash of the
// proof. Without linkKey that does not decrypt. A GET from a bot or a preview
// fetcher consumes nothing — only a POST with a valid proof counts as a use.
//
// Storage is process memory, like every other store in this server: a restart
// invalidates all outstanding invites. That is deliberate ("persistence: none").

import { createHash, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";

export const SHARE_LIMITS = {
  maxLinks: 2000,
  maxUses: 50,
  minTtlSec: 5 * 60,
  maxTtlSec: 7 * 24 * 60 * 60,
  defaultTtlSec: 24 * 60 * 60,
  maxAttempts: 5,
  maxCiphertextChars: 4096,
} as const;

const B64URL = /^[A-Za-z0-9_-]+$/;
const isB64Url = (v: unknown, len: number): v is string => typeof v === "string" && v.length === len && B64URL.test(v);

// 16 bytes -> 22 chars, 32 bytes -> 43 chars, 12 bytes -> 16 chars (unpadded base64url)
const ID_LEN = 22;
const KEY_LEN = 43;
const IV_LEN = 16;

type ShareRecord = {
  proofHash: Buffer;
  revokeHash: Buffer;
  serverKey: string;
  iv: string;
  ciphertext: string;
  maxUses: number;
  usesLeft: number;
  attemptsLeft: number;
  createdAt: number;
  expiresAt: number;
};

export type CreateInput = {
  id: unknown; proof: unknown; revokeToken: unknown; serverKey: unknown;
  iv: unknown; ciphertext: unknown; maxUses?: unknown; ttlSec?: unknown;
};

export type RedeemResult =
  | { ok: true; serverKey: string; iv: string; ciphertext: string; usesLeft: number; expiresAt: number }
  | { ok: false; status: 404 | 403 | 410; reason: "not-found" | "wrong-code" | "burned"; attemptsLeft?: number };

const sha256 = (value: string) => createHash("sha256").update(value).digest();

export class ShareStore {
  private readonly records = new Map<string, ShareRecord>();
  constructor(private readonly now: () => number = Date.now) {}

  get size(): number { return this.records.size; }

  private gc(): void {
    const t = this.now();
    for (const [id, rec] of this.records) if (rec.expiresAt <= t) this.records.delete(id);
  }

  create(input: CreateInput): { ok: true; expiresAt: number; maxUses: number } | { ok: false; status: 400 | 409 | 503; reason: string } {
    this.gc();
    if (!isB64Url(input.id, ID_LEN)) return { ok: false, status: 400, reason: "bad-id" };
    if (!isB64Url(input.proof, KEY_LEN)) return { ok: false, status: 400, reason: "bad-proof" };
    if (!isB64Url(input.revokeToken, KEY_LEN)) return { ok: false, status: 400, reason: "bad-revoke-token" };
    if (!isB64Url(input.serverKey, KEY_LEN)) return { ok: false, status: 400, reason: "bad-server-key" };
    if (!isB64Url(input.iv, IV_LEN)) return { ok: false, status: 400, reason: "bad-iv" };
    if (typeof input.ciphertext !== "string" || input.ciphertext.length < 24
      || input.ciphertext.length > SHARE_LIMITS.maxCiphertextChars || !B64URL.test(input.ciphertext)) {
      return { ok: false, status: 400, reason: "bad-ciphertext" };
    }
    const maxUses = input.maxUses === undefined ? 1 : Number(input.maxUses);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > SHARE_LIMITS.maxUses) return { ok: false, status: 400, reason: "bad-max-uses" };
    const ttlSec = input.ttlSec === undefined ? SHARE_LIMITS.defaultTtlSec : Number(input.ttlSec);
    if (!Number.isInteger(ttlSec) || ttlSec < SHARE_LIMITS.minTtlSec || ttlSec > SHARE_LIMITS.maxTtlSec) return { ok: false, status: 400, reason: "bad-ttl" };

    if (this.records.has(input.id)) return { ok: false, status: 409, reason: "exists" };
    if (this.records.size >= SHARE_LIMITS.maxLinks) return { ok: false, status: 503, reason: "full" };

    const createdAt = this.now();
    const expiresAt = createdAt + ttlSec * 1000;
    this.records.set(input.id, {
      proofHash: sha256(input.proof),
      revokeHash: sha256(input.revokeToken),
      serverKey: input.serverKey,
      iv: input.iv,
      ciphertext: input.ciphertext,
      maxUses,
      usesLeft: maxUses,
      attemptsLeft: SHARE_LIMITS.maxAttempts,
      createdAt,
      expiresAt,
    });
    return { ok: true, expiresAt, maxUses };
  }

  redeem(id: unknown, proof: unknown): RedeemResult {
    this.gc();
    // Malformed, unknown and expired all look the same from outside, so the
    // endpoint cannot be used to probe which ids exist.
    if (!isB64Url(id, ID_LEN) || !isB64Url(proof, KEY_LEN)) return { ok: false, status: 404, reason: "not-found" };
    const rec = this.records.get(id);
    if (!rec) return { ok: false, status: 404, reason: "not-found" };

    if (!timingSafeEqual(sha256(proof), rec.proofHash)) {
      rec.attemptsLeft -= 1;
      if (rec.attemptsLeft <= 0) {
        this.records.delete(id);
        return { ok: false, status: 410, reason: "burned", attemptsLeft: 0 };
      }
      return { ok: false, status: 403, reason: "wrong-code", attemptsLeft: rec.attemptsLeft };
    }

    rec.usesLeft -= 1;
    const out = { ok: true as const, serverKey: rec.serverKey, iv: rec.iv, ciphertext: rec.ciphertext, usesLeft: rec.usesLeft, expiresAt: rec.expiresAt };
    if (rec.usesLeft <= 0) this.records.delete(id);
    return out;
  }

  revoke(id: unknown, revokeToken: unknown): boolean {
    if (!isB64Url(id, ID_LEN) || !isB64Url(revokeToken, KEY_LEN)) return false;
    const rec = this.records.get(id);
    if (!rec) return false;
    if (!timingSafeEqual(sha256(revokeToken), rec.revokeHash)) return false;
    this.records.delete(id);
    return true;
  }
}

export const shareStore = new ShareStore();

export function registerShareRoutes(app: Express, store: ShareStore = shareStore): void {
  app.post("/api/share/create", (req: Request, res: Response) => {
    const result = store.create((req.body ?? {}) as CreateInput);
    if (!result.ok) return res.status(result.status).json({ ok: false, reason: result.reason });
    return res.status(201).json({ ok: true, expiresAt: result.expiresAt, maxUses: result.maxUses, maxAttempts: SHARE_LIMITS.maxAttempts });
  });

  // POST only: crawlers and link-preview fetchers issue GETs and send no body,
  // so they can neither consume a use nor burn an attempt.
  app.post("/api/share/redeem", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { id?: unknown; proof?: unknown };
    const result = store.redeem(body.id, body.proof);
    if (!result.ok) return res.status(result.status).json({ ok: false, reason: result.reason, attemptsLeft: result.attemptsLeft });
    return res.json(result);
  });

  app.post("/api/share/revoke", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { id?: unknown; revokeToken?: unknown };
    return res.json({ ok: store.revoke(body.id, body.revokeToken) });
  });
}

// ---------------------------------------------------------------------------
// "Clear & Quit" landing page
// ---------------------------------------------------------------------------

// The client wipes what script can reach, then navigates here. Clear-Site-Data
// finishes the job for what script cannot: HttpOnly cookies, the HTTP cache,
// and any storage or service worker left behind. No script on this page.
const GOODBYE_HTML = `<!doctype html>
<html lang="cs"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<title>M5cet</title>
<style>html{color-scheme:dark light}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e7e9ee;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:34rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:.5rem 0;color:#aab0bd}small{color:#7d8494}</style></head>
<body><main>
<h1>Relace byla smazána · Session cleared</h1>
<p>Klíče, nastavení, mezipaměť, cookies i service worker této stránky jsou pryč. Tuto kartu můžete zavřít.</p>
<p>Keys, settings, cache, cookies and the service worker of this site are gone. You can close this tab.</p>
<p><small>Historii prohlížeče web smazat nemůže. Zpět do chatu odsud nevede; záznam o návštěvě odstraníte v nastavení prohlížeče (Ctrl/Cmd + Shift + Delete), příště použijte anonymní okno.<br>
A website cannot erase browser history. Remove the visit in your browser settings, or use a private window next time.</small></p>
</main></body></html>`;

export function registerGoodbyeRoute(app: Express): void {
  app.get("/goodbye", (_req: Request, res: Response) => {
    res.setHeader("Clear-Site-Data", '"cache", "cookies", "storage", "executionContexts"');
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.type("html").send(GOODBYE_HTML);
  });
}
