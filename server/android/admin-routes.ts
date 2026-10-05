// The console's Android API (6.0), /api/admin/android/* in the main service
// (behind the admin guard of admin-api.ts and the "android" module guard).
//
//   GET    /                        overview: store, settings, signing key, FCM, counts
//   PUT    /config                  enrolment, policy, package, FCM (service account sealed)
//   GET    /devices                 enrolled devices;  GET/PATCH/DELETE /devices/:id
//   POST   /devices/:id/commands    ping | status | flash | push | update | lock | wipe | config
//   POST   /commands                the same to several devices (or all)
//   GET    /commands, /events       what was sent, what devices reported
//   GET/POST/DELETE /codes          enrolment codes (the code is shown once); GET /codes/qr
//   GET/PUT /design, POST /design/reset, GET /catalog
//   POST   /design/validate, /design/preview   6.14: the checks without saving; what a build would carry
//   GET/POST /builds, GET /builds/:id, /content, /deploy, POST /builds/:id/publish|withdraw|restore, DELETE
//   GET    /releases, POST /releases/upload (raw APK), PATCH/DELETE /releases/:id,
//          POST /releases/:id/publish|withdraw, GET /releases/:id/apk
//   GET    /passkeys                Passkeys on Android: assetlinks.json as the internet and
//                                   Google see it vs. the certificates known and reported (6.4)
//   POST   /passkeys/trust          {sha256} trust a certificate for passkeys only (settings)
//   DELETE /passkeys/trust/:sha256  stop trusting it
//
// 6.14: devices, commands, events, codes, design and builds are shared with
// iOS (server/mobile/admin.ts); overview, settings (FCM), APK releases and
// passkeys (assetlinks.json) are Android's own, here.

import express, { type Express, type Request, type Response } from "express";
import { EXACT_ROUTER } from "../exact-routing";
import { createReadStream, existsSync } from "node:fs";
import { audit } from "../monitor/audit";
import { adminName } from "../admin-auth";
import { consoleGuard } from "../access";
import { buildInfo } from "../build-info";
import type { Needs } from "../access";
import { androidConfig, parseServiceAccount, publicConfig, sanitizeFcmClient, sanitizePolicy, saveAndroidConfig, sealServiceAccount } from "./config";
import { androidCatalog, androidDesign, savedDesignProblem, DEFAULT_DESIGN, sanitizeDesign, saveAndroidDesign } from "./design";
import { ANDROID_BUILDS, MIN_APP_CODE, versionCodeOf } from "./bundle";
import { sendCommand } from "./commands";
import { fcmReady } from "./fcm";
import { readApk } from "./apk";
import { releaseSignedString, signP1363 } from "./crypto";
import { androidStore, newId, type Device, type Release } from "./store";
import { passkeySelfCheck } from "./passkeys-check";
import { rpPolicyFor } from "../accounts/routes";
import { registerSharedAdminRoutes } from "../mobile/admin";

/** What a console request needs of the Android module (Modules & groups). */
export function androidConsoleRight(req: Request): Needs | null {
  // 6.1: positions are personal data — reading them needs the devices right too.
  if (/^\/devices\/[^/]+\/locations$/.test(req.path)) return ["devices"];
  if (req.method === "GET" || req.method === "HEAD") return null;
  const p = req.path;
  if (p === "/config" || p.startsWith("/codes")) return ["settings"];
  if (/^\/devices\/[^/]+\/commands$/.test(p) || p === "/commands") {
    const kind = (req.body as { kind?: unknown } | undefined)?.kind;
    return kind === "wipe" ? ["wipe"] : ["push"];
  }
  if (p.startsWith("/devices")) return ["devices"];
  if (/^\/(builds|releases)\/[^/]+\/(publish|withdraw)$/.test(p)) return ["publish"];
  if (p.startsWith("/releases")) return ["releases"];
  if (p.startsWith("/builds") || p.startsWith("/design")) return ["builds"];
  return ["settings"];
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

const devicePublic = (d: Device) => ({ ...d, signKey: undefined, encKey: undefined, fcmToken: undefined, push: d.fcmToken ? "fcm" : "poll" });

export function registerAndroidAdminRoutes(app: Express): void {
  const r = express.Router(EXACT_ROUTER);
  r.use((_req, _res, next) => { void androidStore.ready().then(() => next(), next); });
  const who = (req: Request) => adminName(req);
  const log = (req: Request, event: string, detail?: Record<string, unknown>, level: "info" | "notice" | "warn" = "notice", target?: string) =>
    audit.add({ category: "admin", level, event: `admin.android.${event}`, actor: who(req), target, detail });

  /* ------------------------------------------------------------- overview */

  r.get("/", (_req, res) => {
    const c = androidConfig();
    const key = androidStore.signingKey();
    const devices = androidStore.devices.list({ limit: 5000 });
    const design = androidDesign();
    res.json({
      ok: true, store: androidStore.status(), config: publicConfig(c), fcm: fcmReady(),
      // The chat's public address for enrolment links and QR codes; the console
      // falls back to its own origin (right when it is served from the same domain).
      publicUrl: (process.env.PUBLIC_BASE_URL?.trim() || "").replace(/\/+$/, ""),
      signing: { kid: key.kid, publicKey: key.publicKey, fingerprint: key.fingerprint },
      counts: {
        devices: devices.length, active: devices.filter((d) => d.status === "active").length, wiped: devices.filter((d) => d.status === "wiped").length,
        seen24h: devices.filter((d) => d.lastSeen > Date.now() - 86_400_000).length,
        builds: androidStore.builds.count(), releases: androidStore.releases.count(),
        events24h: androidStore.events.list({ limit: 5000, filter: (e) => e.receivedAt > Date.now() - 86_400_000 }).length,
      },
      app: { version: buildInfo().version, versionCode: versionCodeOf(buildInfo().version), minAppCode: MIN_APP_CODE },
      design: { rev: design.rev, updatedAt: design.updatedAt, updatedBy: design.updatedBy },
    });
  });

  r.put("/config", (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const c = structuredClone(androidConfig());
    if (typeof b.enrollment === "string") c.enrollment = b.enrollment as typeof c.enrollment;
    if (b.policy !== undefined) c.policy = sanitizePolicy(b.policy);
    if (typeof b.packageName === "string") c.packageName = b.packageName.trim();
    if (Array.isArray(b.certSha256)) c.certSha256 = b.certSha256.map((x) => String(x).toLowerCase().replace(/[^0-9a-f]/g, ""));
    const fcm = b.fcm as Record<string, unknown> | undefined;
    if (fcm && typeof fcm === "object") {
      if (typeof fcm.enabled === "boolean") c.fcm.enabled = fcm.enabled;
      if (fcm.client !== undefined) {
        const client = fcm.client === null ? null : sanitizeFcmClient(fcm.client);
        if (fcm.client !== null && !client) return res.status(400).json({ ok: false, message: "The Firebase app settings are not complete (apiKey, appId, senderId, projectId from google-services.json)." });
        c.fcm.client = client;
      }
      if (typeof fcm.serviceAccount === "string") {
        if (!fcm.serviceAccount.trim()) { c.fcm.serviceAccount = null; c.fcm.serviceAccountEmail = ""; }
        else {
          const sa = parseServiceAccount(fcm.serviceAccount);
          if (!sa) return res.status(400).json({ ok: false, message: "That is not a Google service account key (JSON with type service_account)." });
          c.fcm.serviceAccount = sealServiceAccount(fcm.serviceAccount);
          c.fcm.serviceAccountEmail = sa.client_email;
          if (!c.fcm.projectId) c.fcm.projectId = sa.project_id;
        }
      }
      if (typeof fcm.projectId === "string") c.fcm.projectId = fcm.projectId.trim();
    }
    const saved = saveAndroidConfig(c, who(req));
    log(req, "config", { enrollment: saved.enrollment, fcm: saved.fcm.enabled, lock: saved.policy.lock });
    res.json({ ok: true, config: publicConfig(saved), fcm: fcmReady() });
  });

  /* ------------------------------------- devices, commands, codes, design, builds */

  // 6.14: the same on iOS (server/mobile/admin.ts).
  registerSharedAdminRoutes(r, {
    id: "android",
    store: androidStore,
    devicePublic,
    sendCommand,
    pushVia: "fcm",
    location: () => androidConfig().policy.location,
    design: { get: androidDesign, save: saveAndroidDesign, problem: savedDesignProblem, defaults: DEFAULT_DESIGN, sanitize: (raw) => sanitizeDesign(raw), catalog: () => androidCatalog() },
    builds: ANDROID_BUILDS,
    appVersion: () => buildInfo().version,
  });

  /* ------------------------------------------------------------- releases */

  r.get("/releases", (_req, res) => { res.json({ ok: true, releases: androidStore.releases.list({ limit: 500 }) }); });

  r.post("/releases/upload", (req, res) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length < 64) return res.status(400).json({ ok: false, message: "Send the APK file as the request body (application/vnd.android.package-archive)." });
    let info;
    try { info = readApk(body); } catch (err) { return res.status(400).json({ ok: false, message: `Not a usable APK: ${(err as Error).message}` }); }
    const c = androidConfig();
    if (info.packageName !== c.packageName) return res.status(400).json({ ok: false, message: `The APK is ${info.packageName}; releases must be ${c.packageName} (Android › Settings).` });
    if (c.certSha256.length && !c.certSha256.includes(info.certSha256)) return res.status(400).json({ ok: false, message: `The APK is signed with another certificate (${info.certSha256.slice(0, 16)}…) than the releases before — devices would refuse it.` });
    if (androidStore.releases.list({ limit: 1, filter: (x) => x.versionCode === info!.versionCode && x.status !== "withdrawn" })[0]) return res.status(409).json({ ok: false, message: `Version code ${info.versionCode} is already released.` });
    if (!c.certSha256.length) saveAndroidConfig({ ...c, certSha256: [info.certSha256] }, who(req));
    const id = newId("rel");
    androidStore.writeFileAtomic(androidStore.releaseFile(id), body);
    const release: Release = {
      id, versionName: info.versionName, versionCode: info.versionCode, packageName: info.packageName,
      channel: ["stable", "beta", "dev"].includes(str(req.query.channel, 10)) ? str(req.query.channel, 10) : "stable",
      notes: str(req.query.notes, 2000), apkSha256: info.sha256, certSha256: info.certSha256, size: info.size, minSdk: info.minSdk,
      mandatory: req.query.mandatory === "1", status: "draft", createdAt: Date.now(), createdBy: who(req), publishedAt: null, signature: "", source: "upload",
    };
    release.signature = signP1363(androidStore.signingKey().privateKey, releaseSignedString(release));
    androidStore.releases.put(release);
    log(req, "release.upload", { versionName: release.versionName, versionCode: release.versionCode, size: release.size, cert: release.certSha256.slice(0, 16) }, "notice", id);
    res.json({ ok: true, release });
  });

  const releaseOr404 = (req: Request, res: Response) => {
    const x = androidStore.releases.get(String(req.params.id));
    if (!x) res.status(404).json({ ok: false, message: "No such release." });
    return x;
  };

  r.patch("/releases/:id", (req, res) => {
    const x = releaseOr404(req, res);
    if (!x) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const next = { ...x };
    if (typeof b.notes === "string") next.notes = b.notes.slice(0, 2000);
    if (b.channel === "stable" || b.channel === "beta" || b.channel === "dev") next.channel = b.channel;
    if (typeof b.mandatory === "boolean") next.mandatory = b.mandatory;
    androidStore.releases.put(next);
    log(req, "release.update", { channel: next.channel, mandatory: next.mandatory }, "notice", x.id);
    res.json({ ok: true, release: next });
  });

  r.post("/releases/:id/publish", async (req, res) => {
    const x = releaseOr404(req, res);
    if (!x) return;
    const next = { ...x, status: "published" as const, publishedAt: Date.now() };
    androidStore.releases.put(next);
    log(req, "release.publish", { versionName: x.versionName, versionCode: x.versionCode }, "notice", x.id);
    let notified = 0;
    if (req.body?.notify !== false) {
      for (const d of androidStore.devices.list({ limit: 5000, filter: (dv) => dv.status === "active" && dv.appCode < x.versionCode })) { await sendCommand(d, "update", {}, who(req)); notified++; }
    }
    res.json({ ok: true, release: next, notified });
  });

  r.post("/releases/:id/withdraw", (req, res) => {
    const x = releaseOr404(req, res);
    if (!x) return;
    androidStore.releases.put({ ...x, status: "withdrawn" });
    log(req, "release.withdraw", { versionName: x.versionName }, "warn", x.id);
    res.json({ ok: true });
  });

  r.get("/releases/:id/apk", (req, res) => {
    const x = releaseOr404(req, res);
    if (!x) return;
    const file = androidStore.releaseFile(x.id);
    if (!existsSync(file)) return res.status(404).json({ ok: false, message: "The APK file is missing." });
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    res.setHeader("Content-Disposition", `attachment; filename="m5cet-${x.versionName}.apk"`);
    createReadStream(file).pipe(res);
  });

  r.delete("/releases/:id", (req, res) => {
    const x = releaseOr404(req, res);
    if (!x) return;
    androidStore.releases.delete(x.id);
    androidStore.removeFile(androidStore.releaseFile(x.id));
    log(req, "release.delete", { versionName: x.versionName }, "warn", x.id);
    res.json({ ok: true });
  });

  /* ------------------------------------------------ passkeys on Android (6.4) */

  const passkeyReport = (req: Request) => passkeySelfCheck({
    rpId: rpPolicyFor(req).rpId,
    packageName: androidConfig().packageName,
    port: Number(process.env.PORT) || 5000,
    devices: androidStore.devices.list({ limit: 2000 }),
  });

  r.get("/passkeys", async (req, res) => {
    res.json(await passkeyReport(req));
  });

  // For passkeys only: a trusted certificate goes into assetlinks.json and the
  // WebAuthn app origin, never into the release check (certSha256).
  r.post("/passkeys/trust", async (req, res) => {
    const sha = String((req.body as { sha256?: unknown } | undefined)?.sha256 ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
    if (!/^[0-9a-f]{64}$/.test(sha)) return res.status(400).json({ ok: false, message: "A SHA-256 fingerprint (64 hex digits) is needed." });
    const c = structuredClone(androidConfig());
    if (!c.passkeyCertSha256.includes(sha)) {
      if (c.passkeyCertSha256.length >= 8) return res.status(400).json({ ok: false, message: "Eight trusted certificates at most; remove one first." });
      c.passkeyCertSha256.push(sha);
      saveAndroidConfig(c, who(req));
      log(req, "passkeys.trust", { cert: sha.slice(0, 16) }, "warn");
    }
    res.json(await passkeyReport(req));
  });

  r.delete("/passkeys/trust/:sha", async (req, res) => {
    const sha = String(req.params.sha).toLowerCase();
    const c = structuredClone(androidConfig());
    if (c.passkeyCertSha256.includes(sha)) {
      c.passkeyCertSha256 = c.passkeyCertSha256.filter((x) => x !== sha);
      saveAndroidConfig(c, who(req));
      log(req, "passkeys.untrust", { cert: sha.slice(0, 16) }, "notice");
    }
    res.json(await passkeyReport(req));
  });

  app.use("/api/admin/android", consoleGuard("android", androidConsoleRight), r);
}
