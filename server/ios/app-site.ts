// The iOS app and the server's passkeys (6.14): the app signs in with the
// same passkeys as the browser (AuthenticationServices) when the server's
// domain declares it — /.well-known/apple-app-site-association with
// webcredentials: ["<team id>.<bundle id>"] (the app lists
// webcredentials:<domain> in its Associated Domains). Apple's CDN fetches
// the file over https from the domain itself, without redirects, as JSON.
//
// The team id is APNS_TEAM_ID (the push key belongs to the app's team);
// without it the file is not published (404). The WebAuthn origin of an iOS
// app is the web origin, so nothing else changes on the server.

import type { Express } from "express";
import { iosConfig } from "./config";

const TEAM_RE = /^[A-Z0-9]{10}$/;

export function iosTeamId(): string {
  const t = (process.env.APNS_TEAM_ID ?? "").trim();
  return TEAM_RE.test(t) ? t : "";
}

/** The association file, or null when the team is not known. */
export function appSiteAssociation(): { webcredentials: { apps: string[] } } | null {
  const team = iosTeamId();
  if (!team) return null;
  let bundleId = "cz.m5cet.app";
  try { bundleId = iosConfig().bundleId || bundleId; } catch { /* default */ }
  return { webcredentials: { apps: [`${team}.${bundleId}`] } };
}

/** GET /.well-known/apple-app-site-association — before the static files (the SPA fallback would answer HTML). */
export function registerAppSiteAssociation(app: Express): void {
  app.get("/.well-known/apple-app-site-association", (_req, res) => {
    const body = appSiteAssociation();
    if (!body) return res.status(404).json({ ok: false, message: "No iOS app is known to this server (APNS_TEAM_ID)." });
    res.setHeader("Cache-Control", "public, max-age=300");
    res.type("application/json").send(JSON.stringify(body));
  });
}
