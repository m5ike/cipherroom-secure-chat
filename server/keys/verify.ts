// What the key directory checks before it keeps a device's keys (protocol 4,
// § 7.1, § 7.5, § 12.3). Pure: node:crypto only.
//
//   device certificate v2   Ed25519 by the ACCOUNT key over
//                           join("m5cet/device-cert/2", pk, exp);
//                           now < exp ≤ now + DEVICE_CERT_LIFETIME_MS (+ 5 min skew)
//   mailbox bundle          ECDSA P-256 / SHA-256, raw r||s, by the DEVICE key pk over
//                           join("m5cet/mb/4", id, dh, b64(SHA-256(kem bytes)), exp);
//                           now < exp ≤ now + MAILBOX_LIFETIME_MS (+ 5 min skew);
//                           kem exactly 1184 bytes (ML-KEM-768), dh a P-256 key
//
// Every base64 field must be canonical (decoding and encoding again gives the
// same text) and of the exact size its key or signature has.

import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { DEVICE_CERT_LIFETIME_MS, KEM, LABEL, MAILBOX_LIFETIME_MS, type MailboxBundle } from "../../client/src/lib/p4/contract";

/** Clocks of clients and server differ a little. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/** Canonical standard base64 of at most `maxChars`, else null. */
export function strictB64(v: unknown, maxChars: number): Buffer | null {
  if (typeof v !== "string" || v.length === 0 || v.length > maxChars || v.length % 4 !== 0 || !B64.test(v)) return null;
  const buf = Buffer.from(v, "base64");
  return buf.toString("base64") === v ? buf : null;
}

/** Canonical base64url (no padding) of at most `maxChars`, else null. */
export function strictB64Url(v: unknown, maxChars: number): Buffer | null {
  if (typeof v !== "string" || v.length === 0 || v.length > maxChars || !B64URL.test(v)) return null;
  const buf = Buffer.from(v, "base64url");
  return buf.toString("base64url") === v ? buf : null;
}

/** A P-256 public key from SPKI DER (b64), else null. */
export function p256Key(spkiB64: unknown): KeyObject | null {
  const der = strictB64(spkiB64, 200);
  if (!der) return null;
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1" ? key : null;
  } catch {
    return null;
  }
}

/** An Ed25519 public key from its raw 32 bytes (b64 or b64url), else null. */
export function ed25519Key(raw: unknown): KeyObject | null {
  const bytes = strictB64(raw, 64) ?? strictB64Url(raw, 64);
  if (!bytes || bytes.length !== 32) return null;
  try {
    return createPublicKey({ key: Buffer.concat([SPKI_ED25519, bytes]), format: "der", type: "spki" });
  } catch {
    return null;
  }
}

/** The account key in the form the directory and the log use: raw 32 bytes, standard base64. Null when it is not one. */
export function normalizeAccountKey(raw: unknown): string | null {
  const bytes = strictB64(raw, 64) ?? strictB64Url(raw, 64);
  return bytes && bytes.length === 32 && ed25519Key(raw) ? bytes.toString("base64") : null;
}

export function deviceCertMessage(pk: string, exp: number): Buffer {
  return Buffer.from(`${LABEL.deviceCert}|${pk}|${exp}`, "utf8");
}

export function bundleMessage(b: Pick<MailboxBundle, "id" | "dh" | "kem" | "exp">): Buffer {
  const kemDigest = createHash("sha256").update(Buffer.from(b.kem, "base64")).digest("base64");
  return Buffer.from(`${LABEL.mailboxBundle}|${b.id}|${b.dh}|${kemDigest}|${b.exp}`, "utf8");
}

/** Does `apk` (the account key) certify device key `pk` until `exp`? */
export function verifyDeviceCert(apk: string, pk: string, exp: number, sig: string): boolean {
  const key = ed25519Key(apk);
  const signature = strictB64(sig, 100);
  if (!key || !signature || signature.length !== 64) return false;
  try { return verify(null, deviceCertMessage(pk, exp), key, signature); } catch { return false; }
}

/** Did device key `pk` sign this bundle? */
export function verifyBundleSignature(pk: string, bundle: MailboxBundle): boolean {
  const key = p256Key(pk);
  const signature = strictB64(bundle.sig, 100);
  if (!key || !signature || signature.length !== 64) return false;
  try { return verify("sha256", bundleMessage(bundle), { key, dsaEncoding: "ieee-p1363" }, signature); } catch { return false; }
}

export type BundleRequest = { pk: string; apk?: string; cert: { v: 2; exp: number; sig: string }; bundle: MailboxBundle };
export type CheckFailure = { ok: false; status: number; code: string; message: string };

const bad = (code: string, message: string): CheckFailure => ({ ok: false, status: 400, code, message });
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** The shape and sizes of PUT /api/keys/bundle's body, and the bundle's own signature (not yet the certificate: that needs the account key). */
export function parseBundleRequest(body: unknown, now = Date.now()): { ok: true; value: BundleRequest } | CheckFailure {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("bad-request", "The body is { pk, cert: { v: 2, exp, sig }, bundle }.");
  const b = body as Record<string, unknown>;
  const pk = typeof b.pk === "string" ? b.pk : "";
  if (!p256Key(pk)) return bad("bad-pk", "pk is the device's P-256 signing key, SPKI in base64.");

  let apk: string | undefined;
  if (b.apk !== undefined) {
    const n = normalizeAccountKey(b.apk);
    if (!n) return bad("bad-apk", "apk is the account's Ed25519 key, 32 bytes in base64.");
    apk = n;
  }

  const c = b.cert as Record<string, unknown> | undefined;
  if (!c || typeof c !== "object" || Array.isArray(c) || c.v !== 2 || !isTime(c.exp) || typeof c.sig !== "string") {
    return bad("bad-cert", "cert is { v: 2, exp, sig } — a version 2 device certificate.");
  }
  const sig = strictB64(c.sig, 100);
  if (!sig || sig.length !== 64) return bad("bad-cert", "cert.sig is an Ed25519 signature (64 bytes, base64).");
  if (c.exp <= now) return bad("cert-expired", "The device certificate has expired.");
  if (c.exp > now + DEVICE_CERT_LIFETIME_MS + CLOCK_SKEW_MS) return bad("cert-too-long", "A device certificate is valid for at most 90 days.");

  const m = b.bundle as Record<string, unknown> | undefined;
  if (!m || typeof m !== "object" || Array.isArray(m)) return bad("bad-bundle", "bundle is { id, dh, kem, exp, sig }.");
  const idBytes = strictB64Url(m.id, 16);
  if (!idBytes || idBytes.length !== 8) return bad("bad-bundle", "bundle.id is 8 random bytes in base64url.");
  if (!p256Key(m.dh)) return bad("bad-bundle", "bundle.dh is a P-256 key, SPKI in base64.");
  const kem = strictB64(m.kem, Math.ceil(KEM.ek / 3) * 4);
  if (!kem || kem.length !== KEM.ek) return bad("bad-bundle", `bundle.kem is an ML-KEM-768 encapsulation key (${KEM.ek} bytes, base64).`);
  if (!isTime(m.exp)) return bad("bad-bundle", "bundle.exp is a time in ms.");
  if (m.exp <= now) return bad("bundle-expired", "The mailbox bundle has expired.");
  if (m.exp > now + MAILBOX_LIFETIME_MS + CLOCK_SKEW_MS) return bad("bundle-too-long", "A mailbox bundle lives at most 7 days.");
  const bsig = strictB64(m.sig, 100);
  if (!bsig || bsig.length !== 64) return bad("bad-bundle", "bundle.sig is an ECDSA P-256 signature, raw r||s (64 bytes, base64).");
  const bundle: MailboxBundle = { id: String(m.id), dh: String(m.dh), kem: String(m.kem), exp: m.exp, sig: String(m.sig) };
  if (!verifyBundleSignature(pk, bundle)) return bad("bad-bundle-signature", "The bundle's signature does not verify with pk.");

  return { ok: true, value: { pk, ...(apk ? { apk } : {}), cert: { v: 2, exp: c.exp, sig: String(c.sig) }, bundle } };
}
