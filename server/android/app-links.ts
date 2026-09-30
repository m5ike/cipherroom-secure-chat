// The Android app and the server's passkeys (6.1). The app signs in with the
// same passkeys as the browser (Credential Manager); for that the server's
// domain declares the app (Digital Asset Links, /.well-known/assetlinks.json)
// and the WebAuthn check accepts the app's origin,
// "android:apk-key-hash:<base64url of the SHA-256 of its signing certificate>".
//
// Only certificates the server knows: those of the releases (Android ›
// Releases learns them, androidConfig().certSha256) and, for development
// builds, ANDROID_DEBUG_CERT_SHA256 (hex, comma separated) or — 6.4 — the
// ones the operator trusted for passkeys in the console
// (androidConfig().passkeyCertSha256, never valid for a release). Exact
// values — never a pattern. Without any, no assetlinks.json (404) and no app
// origin.

import type { Express } from "express";
import { androidConfig } from "./config";

const HEX64 = /^[0-9a-f]{64}$/;

export type CertSource = "release" | "env" | "trusted";

/** Every known fingerprint (hex) and where it comes from. */
export function androidCertSources(): Map<string, CertSource[]> {
  const out = new Map<string, CertSource[]>();
  const add = (raw: unknown, source: CertSource) => {
    const hex = String(raw).trim().toLowerCase().replace(/:/g, "");
    if (!HEX64.test(hex)) return;
    const list = out.get(hex) ?? [];
    if (!list.includes(source)) list.push(source);
    out.set(hex, list);
  };
  let release: string[] = [];
  let trusted: string[] = [];
  try { release = androidConfig().certSha256; trusted = androidConfig().passkeyCertSha256 ?? []; } catch { /* no config yet */ }
  for (const raw of release) add(raw, "release");
  for (const raw of (process.env.ANDROID_DEBUG_CERT_SHA256 ?? "").split(",")) add(raw, "env");
  for (const raw of trusted) add(raw, "trusted");
  return out;
}

/** Hex SHA-256 fingerprints of the certificates the app may be signed with. */
export function androidCertFingerprints(): string[] {
  return [...androidCertSources().keys()];
}

/** The WebAuthn origins of the app's builds. */
export function androidAppOrigins(): string[] {
  return androidCertFingerprints().map((hex) => `android:apk-key-hash:${Buffer.from(hex, "hex").toString("base64url")}`);
}

/** The Digital Asset Links statement, or null when no certificate is known. */
export function assetLinks(): unknown[] | null {
  const certs = androidCertFingerprints();
  if (!certs.length) return null;
  let packageName = "cz.m5cet.app";
  try { packageName = androidConfig().packageName || packageName; } catch { /* default */ }
  return [{
    relation: ["delegate_permission/common.get_login_creds", "delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: packageName,
      sha256_cert_fingerprints: certs.map((hex) => hex.toUpperCase().match(/../g)!.join(":")),
    },
  }];
}

/** GET /.well-known/assetlinks.json — before the static files (the SPA fallback would answer HTML). */
export function registerAppLinks(app: Express): void {
  app.get("/.well-known/assetlinks.json", (_req, res) => {
    const body = assetLinks();
    if (!body) return res.status(404).json({ ok: false, message: "No Android app is known to this server." });
    res.setHeader("Cache-Control", "public, max-age=300");
    res.type("application/json").send(JSON.stringify(body));
  });
}
