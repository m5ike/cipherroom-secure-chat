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

import { rateLimit } from "express-rate-limit";
import { addressGroup } from "./address-group";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { LOCALE_INFO, type Locale } from "../client/src/lib/locales";
import { requestLocale } from "./notify/lang";

export const SHARE_LIMITS = {
  maxLinks: 2000,
  /** 6.12 (F-28): live invitations one address may hold (SHARE_MAX_PER_IP overrides) — so one client cannot fill maxLinks for everyone. */
  maxPerOwner: 50,
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
  /** 6.12: who created it (a hash of the address, in memory only) — for the per-address cap. */
  owner: string;
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

/** 6.12 (F-28): live invitations per address — SHARE_MAX_PER_IP, default SHARE_LIMITS.maxPerOwner (50). */
export function sharePerOwner(): number {
  const n = Math.floor(Number(process.env.SHARE_MAX_PER_IP));
  return Number.isFinite(n) && n >= 1 && n <= SHARE_LIMITS.maxLinks ? n : SHARE_LIMITS.maxPerOwner;
}

export class ShareStore {
  private readonly records = new Map<string, ShareRecord>();
  constructor(private readonly now: () => number = Date.now) {}

  get size(): number { return this.records.size; }

  private gc(): void {
    const t = this.now();
    for (const [id, rec] of this.records) if (rec.expiresAt <= t) this.records.delete(id);
  }

  /** Live invitations created from one address (its owner key). */
  ownedBy(owner: string): number {
    let n = 0;
    for (const rec of this.records.values()) if (rec.owner === owner) n += 1;
    return n;
  }

  /** `owner`: who creates it (the route passes the client address, counted by its group — an IPv6 /64); "" = not counted. */
  create(input: CreateInput, owner = ""): { ok: true; expiresAt: number; maxUses: number } | { ok: false; status: 400 | 409 | 429 | 503; reason: string } {
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
    // 6.12 (review S09): an IPv6 client counts by its /64 (address-group.ts).
    const group = addressGroup(owner);
    const ownerKey = group ? sha256(`m5cet:share-owner:${group}`).toString("base64url") : "";
    if (ownerKey && this.ownedBy(ownerKey) >= sharePerOwner()) return { ok: false, status: 429, reason: "too-many-for-address" };
    if (this.records.size >= SHARE_LIMITS.maxLinks) return { ok: false, status: 503, reason: "full" };

    const createdAt = this.now();
    const expiresAt = createdAt + ttlSec * 1000;
    this.records.set(input.id, {
      owner: ownerKey,
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
  // Per address, on top of the per-invite attempt counter: creating fills
  // the store, redeeming is where a code would be guessed.
  const createLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { ok: false, reason: "rate-limited" } });
  const redeemLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false, message: { ok: false, reason: "rate-limited" } });

  app.post("/api/share/create", createLimiter, (req: Request, res: Response) => {
    // 6.12 (F-28): at most sharePerOwner() live invitations per address, besides the global maxLinks.
    const result = store.create((req.body ?? {}) as CreateInput, String(req.ip ?? "").replace(/^::ffff:/, "") || "unknown");
    if (!result.ok) return res.status(result.status).json({ ok: false, reason: result.reason });
    return res.status(201).json({ ok: true, expiresAt: result.expiresAt, maxUses: result.maxUses, maxAttempts: SHARE_LIMITS.maxAttempts });
  });

  // POST only: crawlers and link-preview fetchers issue GETs and send no body,
  // so they can neither consume a use nor burn an attempt.
  app.post("/api/share/redeem", redeemLimiter, (req: Request, res: Response) => {
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
// 6.13: in the visitor's language (Accept-Language; English when none of the
// nine), with its <html lang> and Content-Language; every text is UTF-8.

type GoodbyeTexts = { title: string; gone: string; history: string };

export const GOODBYE_TEXTS: Record<Locale, GoodbyeTexts> = {
  en: {
    title: "Session cleared",
    gone: "Keys, settings, cache, cookies and the service worker of this site are gone. You can close this tab.",
    history: "A website cannot erase browser history. There is no way back to the chat from here; remove the visit in your browser settings (Ctrl/Cmd + Shift + Delete), and use a private window next time.",
  },
  cs: {
    title: "Relace byla smazána",
    gone: "Klíče, nastavení, mezipaměť, cookies i service worker této stránky jsou pryč. Tuto kartu můžete zavřít.",
    history: "Historii prohlížeče web smazat nemůže. Zpět do chatu odsud nevede; záznam o návštěvě odstraníte v nastavení prohlížeče (Ctrl/Cmd + Shift + Delete), příště použijte anonymní okno.",
  },
  de: {
    title: "Sitzung gelöscht",
    gone: "Schlüssel, Einstellungen, Cache, Cookies und der Service Worker dieser Seite sind entfernt. Sie können diesen Tab schließen.",
    history: "Eine Website kann den Browserverlauf nicht löschen. Von hier führt kein Weg zurück zum Chat; entfernen Sie den Besuch in den Browsereinstellungen (Strg/Cmd + Umschalt + Entf) und verwenden Sie nächstes Mal ein privates Fenster.",
  },
  es: {
    title: "Sesión borrada",
    gone: "Las claves, los ajustes, la caché, las cookies y el service worker de este sitio se han eliminado. Puedes cerrar esta pestaña.",
    history: "Un sitio web no puede borrar el historial del navegador. Desde aquí no se vuelve al chat; elimina la visita en los ajustes del navegador (Ctrl/Cmd + Mayús + Supr) y usa una ventana privada la próxima vez.",
  },
  it: {
    title: "Sessione cancellata",
    gone: "Chiavi, impostazioni, cache, cookie e service worker di questo sito sono stati eliminati. Puoi chiudere questa scheda.",
    history: "Un sito web non può cancellare la cronologia del browser. Da qui non si torna alla chat; elimina la visita nelle impostazioni del browser (Ctrl/Cmd + Maiusc + Canc) e la prossima volta usa una finestra privata.",
  },
  fr: {
    title: "Session effacée",
    gone: "Les clés, les paramètres, le cache, les cookies et le service worker de ce site ont été supprimés. Vous pouvez fermer cet onglet.",
    history: "Un site web ne peut pas effacer l’historique du navigateur. Il n’y a pas de retour au chat depuis ici ; supprimez la visite dans les paramètres du navigateur (Ctrl/Cmd + Maj + Suppr) et utilisez une fenêtre privée la prochaine fois.",
  },
  sk: {
    title: "Relácia bola vymazaná",
    gone: "Kľúče, nastavenia, vyrovnávacia pamäť, cookies aj service worker tejto stránky sú preč. Túto kartu môžete zavrieť.",
    history: "Históriu prehliadača web vymazať nemôže. Späť do chatu odtiaľto cesta nevedie; záznam o návšteve odstránite v nastaveniach prehliadača (Ctrl/Cmd + Shift + Delete), nabudúce použite súkromné okno.",
  },
  sl: {
    title: "Seja je izbrisana",
    gone: "Ključi, nastavitve, predpomnilnik, piškotki in service worker tega spletnega mesta so izbrisani. Ta zavihek lahko zaprete.",
    history: "Spletno mesto ne more izbrisati zgodovine brskalnika. Od tod ni poti nazaj v klepet; obisk odstranite v nastavitvah brskalnika (Ctrl/Cmd + Shift + Delete), naslednjič pa uporabite zasebno okno.",
  },
  fi: {
    title: "Istunto tyhjennetty",
    gone: "Tämän sivuston avaimet, asetukset, välimuisti, evästeet ja service worker on poistettu. Tämän välilehden voi sulkea.",
    history: "Verkkosivusto ei voi poistaa selaimen historiaa. Täältä ei pääse takaisin keskusteluun; poista käynti selaimen asetuksista (Ctrl/Cmd + Vaihto + Delete) ja käytä ensi kerralla yksityistä ikkunaa.",
  },
};

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

/** The page in one language (exported for tests). */
export function goodbyeHtml(lang: Locale): string {
  const t = GOODBYE_TEXTS[lang] ?? GOODBYE_TEXTS.en;
  return `<!doctype html>
<html lang="${LOCALE_INFO[lang].tag}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<title>M5cet · ${escapeHtml(t.title)}</title>
<style>html{color-scheme:dark light}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e7e9ee;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:34rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:.5rem 0;color:#aab0bd}small{color:#7d8494}</style></head>
<body><main>
<h1>${escapeHtml(t.title)}</h1>
<p>${escapeHtml(t.gone)}</p>
<p><small>${escapeHtml(t.history)}</small></p>
</main></body></html>`;
}

export function registerGoodbyeRoute(app: Express): void {
  app.get("/goodbye", (req: Request, res: Response) => {
    const lang = requestLocale(req);
    res.setHeader("Clear-Site-Data", '"cache", "cookies", "storage", "executionContexts"');
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.setHeader("Content-Language", LOCALE_INFO[lang].tag);
    res.setHeader("Vary", "Accept-Language");
    res.type("html").send(goodbyeHtml(lang));
  });
}
