// The key directory over HTTP (protocol 4, § 7.5).
//
//   PUT /api/keys/bundle   (Bearer: an account session)
//     { pk, cert: { v: 2, exp, sig }, bundle: { id, dh, kem, exp, sig }, apk? }
//     → 200 { ok: true, device: DirectoryDevice, kt: { acct: index|null, dev: index|null } }
//     → 400 { ok: false, code, message }  bad-request, bad-pk, bad-apk, bad-cert, cert-expired,
//           cert-too-long, bad-bundle, bundle-expired, bundle-too-long, bad-bundle-signature,
//           bad-cert-signature
//     → 409 no-account-key, apk-mismatch, stale-bundle, too-many-devices
//     → 503 kt-failed, kt-busy, directory-full;  401 signed-out / locked
//
// `apk` (optional) is the account key (raw Ed25519, base64): needed only when
// the server does not know it yet (it learns it from PUT /api/account/identity).
// Other members read the directory over the hub (`key-bundles`, signaling/hub.ts).
// Its own rate-limit bucket: 60 uploads per 15 minutes per client address.

import type { Express, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { accountAuth, type AuthedRequest } from "../accounts/routes";
import { tokenHash, type AccountStore } from "../accounts/store";
import type { KeyServices } from "./service";

export function registerKeyRoutes(app: Express, accounts: AccountStore, keys: () => KeyServices): void {
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, code: "rate-limited", message: "Too many key uploads; wait a few minutes." },
  });

  app.put("/api/keys/bundle", limiter, accountAuth(accounts, false), (req: AuthedRequest, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const result = keys().putBundle(req.account!, req.token ? tokenHash(req.token) : null, req.body);
    if (!result.ok) return res.status(result.status).json({ ok: false, code: result.code, message: result.message });
    res.json(result);
  });
}
