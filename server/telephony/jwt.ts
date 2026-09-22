// Minimal JWT helpers on top of node:crypto — no dependency.
//
//   signJwtRS256   Vonage Voice API auth: a per-request token signed with the
//                  application's RSA private key (VONAGE_JWT_KEY).
//   signJwtHS256 / verifyJwtHS256
//                  Vonage signed webhooks (Authorization: Bearer <jwt>, HS256
//                  over the account's signature secret) — verifying inbound
//                  events, and producing test tokens in the test-suite.

import { createHmac, createSign, createVerify, randomUUID, timingSafeEqual } from "node:crypto";

export function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function encodeParts(header: Record<string, unknown>, claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
}

/** Standard claims added when absent: iat (now), exp (now + ttlSec), jti. */
function withStandardClaims(claims: Record<string, unknown>, ttlSec: number): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iat: now, exp: now + ttlSec, jti: randomUUID(), ...claims };
}

export function signJwtRS256(claims: Record<string, unknown>, privateKeyPem: string, ttlSec = 900): string {
  const signingInput = encodeParts({ alg: "RS256", typ: "JWT" }, withStandardClaims(claims, ttlSec));
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const sig = signer.sign(privateKeyPem);
  return `${signingInput}.${b64url(sig)}`;
}

export function signJwtHS256(claims: Record<string, unknown>, secret: string, ttlSec = 900): string {
  const signingInput = encodeParts({ alg: "HS256", typ: "JWT" }, withStandardClaims(claims, ttlSec));
  const sig = createHmac("sha256", secret).update(signingInput).digest();
  return `${signingInput}.${b64url(sig)}`;
}

export function decodeJwtUnsafe(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(b64urlDecode(parts[0]).toString("utf8")) as Record<string, unknown>,
      payload: JSON.parse(b64urlDecode(parts[1]).toString("utf8")) as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

/** Returns the claims when the HS256 signature is valid and the token is not expired; null otherwise. */
export function verifyJwtHS256(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const decoded = decodeJwtUnsafe(token);
  if (!decoded || decoded.header.alg !== "HS256") return null;
  const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
  const given = b64urlDecode(parts[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const exp = decoded.payload.exp;
  if (typeof exp === "number" && exp < Math.floor(Date.now() / 1000)) return null;
  return decoded.payload;
}

/** Verify an RS256 token against a PEM public key (used by tests to check what we mint). */
export function verifyJwtRS256(token: string, publicKeyPem: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const decoded = decodeJwtUnsafe(token);
  if (!decoded || decoded.header.alg !== "RS256") return null;
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  return verifier.verify(publicKeyPem, b64urlDecode(parts[2])) ? decoded.payload : null;
}
