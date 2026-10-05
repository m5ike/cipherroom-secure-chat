// The console's iOS API (6.14), /api/admin/ios/* in the main service (behind
// the admin guard and the module guard — the Android module's rights: devices,
// push, wipe, builds, releases, publish, settings, so an operator without them
// sees no iOS page either):
//
//   GET    /                        overview: store, settings, signing key (the same as Android's), APNs, counts
//   PUT    /config                  enrolment, policy, bundle id, minimum build, App Store / TestFlight links, APNs switch
//   GET    /devices …               devices, commands, events, codes, design, builds — shared with
//                                   Android (server/mobile/admin.ts; design /validate and /preview too)
//   GET    /releases                release records (no binaries)
//   POST   /releases                {version, build?, channel, store?, url?, notes, minBuild, rollout} → a draft
//   PATCH  /releases/:id            notes, link, channel, minimum build, rollout (version and build while a draft)
//   POST   /releases/:id/publish|withdraw, DELETE /releases/:id
//   POST   /push/test               {device, type: background | alert} — one APNs push now, Apple's answer back
//   GET    /app-site                the apple-app-site-association this server publishes (passkeys)

import express, { type Express, type Request, type Response } from "express";
import { EXACT_ROUTER } from "../exact-routing";
import { audit } from "../monitor/audit";
import { adminName } from "../admin-auth";
import { consoleGuard, type Needs } from "../access";
import { buildInfo } from "../build-info";
import { androidConsoleRight } from "../android/admin-routes";
import { sanitizePolicy } from "../android/config";
import { registerSharedAdminRoutes } from "../mobile/admin";
import { versionCodeOf } from "../mobile/bundle";
import { newId } from "../mobile/store";
import { appleUrl, BUNDLE_ID_RE, iosConfig, saveIosConfig } from "./config";
import { apnsReady } from "./apns";
import { IOS_BUILDS } from "./bundle";
import { sendIosCommand } from "./commands";
import { IOS_DEFAULT_DESIGN, IOS_MIN_APP_CODE, iosCatalog, iosDesign, iosDesignWarnings, sanitizeIosDesign, saveIosDesign, savedIosDesignProblem } from "./design";
import { applyReleaseInput, effectiveMinBuild, inRollout, signIosRelease } from "./releases";
import { appSiteAssociation, iosTeamId } from "./app-site";
import { iosStore, type IosDevice, type IosRelease } from "./store";

/** What a console request needs of the module (the Android module's rights, the same paths). */
export function iosConsoleRight(req: Request): Needs | null {
  if (req.path === "/push/test") return ["push"];
  return androidConsoleRight(req);
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export const iosDevicePublic = (d: IosDevice) => ({ ...d, signKey: undefined, encKey: undefined, apnsToken: undefined, voipToken: undefined, push: d.apnsToken ? "apns" : "poll", voip: Boolean(d.voipToken) });

export function registerIosAdminRoutes(app: Express): void {
  const r = express.Router(EXACT_ROUTER);
  r.use((_req, _res, next) => { void iosStore.ready().then(() => next(), next); });
  const who = (req: Request) => adminName(req);
  const log = (req: Request, event: string, detail?: Record<string, unknown>, level: "info" | "notice" | "warn" = "notice", target?: string) =>
    audit.add({ category: "admin", level, event: `admin.ios.${event}`, actor: who(req), target, detail });

  /* ------------------------------------------------------------- overview */

  r.get("/", (_req, res) => {
    const c = iosConfig();
    const key = iosStore.signingKey();
    const devices = iosStore.devices.list({ limit: 5000 });
    const design = iosDesign();
    const version = buildInfo().version;
    const active = devices.filter((d) => d.status === "active");
    res.json({
      ok: true, store: iosStore.status(), config: c, apns: apnsReady(),
      publicUrl: (process.env.PUBLIC_BASE_URL?.trim() || "").replace(/\/+$/, ""),
      signing: { kid: key.kid, publicKey: key.publicKey, fingerprint: key.fingerprint },
      counts: {
        devices: devices.length, active: active.length, wiped: devices.filter((d) => d.status === "wiped").length,
        seen24h: devices.filter((d) => d.lastSeen > Date.now() - 86_400_000).length,
        apns: active.filter((d) => d.apnsToken).length, voip: active.filter((d) => d.voipToken).length,
        phones: active.filter((d) => d.idiom === "phone").length, pads: active.filter((d) => d.idiom === "pad").length,
        builds: iosStore.builds.count(), releases: iosStore.releases.count(),
        events24h: iosStore.events.list({ limit: 5000, filter: (e) => e.receivedAt > Date.now() - 86_400_000 }).length,
      },
      app: { version, versionCode: versionCodeOf(version), minAppCode: IOS_MIN_APP_CODE, minBuild: effectiveMinBuild() },
      design: { rev: design.rev, updatedAt: design.updatedAt, updatedBy: design.updatedBy },
      appSite: { teamId: iosTeamId(), bundleId: c.bundleId, published: Boolean(appSiteAssociation()) },
    });
  });

  r.put("/config", (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const c = structuredClone(iosConfig());
    if (typeof b.enrollment === "string") c.enrollment = b.enrollment as typeof c.enrollment;
    if (b.policy !== undefined) c.policy = sanitizePolicy(b.policy);
    if (typeof b.bundleId === "string") {
      if (!BUNDLE_ID_RE.test(b.bundleId.trim())) return res.status(400).json({ ok: false, message: "The bundle id is like cz.m5cet.app." });
      c.bundleId = b.bundleId.trim();
    }
    if (b.minAppBuild !== undefined) c.minAppBuild = Math.max(0, Math.round(Number(b.minAppBuild) || 0));
    for (const key of ["appStoreUrl", "testFlightUrl"] as const) {
      if (typeof b[key] !== "string") continue;
      const v = (b[key] as string).trim();
      if (v && !appleUrl(v)) return res.status(400).json({ ok: false, message: `${key === "appStoreUrl" ? "The App Store" : "The TestFlight"} link must be an https address on apps.apple.com or testflight.apple.com.` });
      c[key] = v ? appleUrl(v) : "";
    }
    const apns = b.apns as Record<string, unknown> | undefined;
    if (apns && typeof apns === "object") {
      if (typeof apns.enabled === "boolean") c.apns.enabled = apns.enabled;
      if (apns.env === "" || apns.env === "production" || apns.env === "sandbox") c.apns.env = apns.env;
      if (typeof apns.topic === "string") {
        if (apns.topic.trim() && !BUNDLE_ID_RE.test(apns.topic.trim())) return res.status(400).json({ ok: false, message: "The APNs topic is the app's bundle id (or empty: APNS_TOPIC / the bundle id)." });
        c.apns.topic = apns.topic.trim();
      }
    }
    const saved = saveIosConfig(c, who(req));
    log(req, "config", { enrollment: saved.enrollment, apns: saved.apns.enabled, lock: saved.policy.lock, minAppBuild: saved.minAppBuild });
    res.json({ ok: true, config: saved, apns: apnsReady() });
  });

  /* ------------------------------------- devices, commands, codes, design, builds */

  registerSharedAdminRoutes(r, {
    id: "ios",
    store: iosStore,
    devicePublic: iosDevicePublic,
    sendCommand: sendIosCommand,
    pushVia: "apns",
    location: () => iosConfig().policy.location,
    design: {
      get: iosDesign, save: saveIosDesign, problem: savedIosDesignProblem, defaults: IOS_DEFAULT_DESIGN,
      sanitize: sanitizeIosDesign, catalog: () => iosCatalog(), warnings: iosDesignWarnings,
    },
    builds: IOS_BUILDS,
    appVersion: () => buildInfo().version,
  });

  /* ------------------------------------------------------------- releases */

  r.get("/releases", (_req, res) => { res.json({ ok: true, releases: iosStore.releases.list({ limit: 500 }) }); });

  r.post("/releases", (req, res) => {
    const { release, problem } = applyReleaseInput({}, req.body);
    if (problem) return res.status(400).json({ ok: false, message: problem });
    if (iosStore.releases.list({ limit: 1, filter: (x) => x.build === release.build && x.status !== "withdrawn" })[0]) return res.status(409).json({ ok: false, message: `Build ${release.build} already has a release.` });
    const now = Date.now();
    const full: IosRelease = {
      id: newId("irel"), version: release.version!, build: release.build!, bundleId: iosConfig().bundleId,
      channel: release.channel!, store: release.store!, url: release.url!, notes: release.notes!, minBuild: release.minBuild!, rollout: release.rollout!,
      status: "draft", createdAt: now, createdBy: who(req), publishedAt: null, updatedAt: now, signature: "",
    };
    full.signature = signIosRelease(full);
    iosStore.releases.put(full);
    log(req, "release.create", { version: full.version, build: full.build, channel: full.channel, store: full.store }, "notice", full.id);
    res.json({ ok: true, release: full });
  });

  const releaseOr404 = (req: Request, res: Response) => {
    const x = iosStore.releases.get(String(req.params.id));
    if (!x) res.status(404).json({ ok: false, message: "No such release." });
    return x;
  };

  r.patch("/releases/:id", (req, res) => {
    const x = releaseOr404(req, res);
    if (!x) return;
    const body = { ...(req.body ?? {}) } as Record<string, unknown>;
    if (x.status !== "draft" && (body.version !== undefined || body.build !== undefined)) return res.status(409).json({ ok: false, message: "The version and build of a published release do not change — make a new release." });
    const { release, problem } = applyReleaseInput(x, body);
    if (problem) return res.status(400).json({ ok: false, message: problem });
    const next = { ...x, ...release, updatedAt: Date.now() } as IosRelease;
    next.signature = signIosRelease(next);
    iosStore.releases.put(next);
    log(req, "release.update", { channel: next.channel, rollout: next.rollout, minBuild: next.minBuild }, "notice", x.id);
    res.json({ ok: true, release: next });
  });

  r.post("/releases/:id/publish", async (req, res) => {
    const x = releaseOr404(req, res);
    if (!x) return;
    const next: IosRelease = { ...x, status: "published", publishedAt: Date.now(), updatedAt: Date.now() };
    iosStore.releases.put(next);
    log(req, "release.publish", { version: x.version, build: x.build, rollout: x.rollout }, "notice", x.id);
    let notified = 0;
    if (req.body?.notify !== false) {
      // Only the devices the release is for now: older builds in the rollout, and every one below its minimum.
      for (const d of iosStore.devices.list({ limit: 5000, filter: (dv) => dv.status === "active" && dv.appCode < x.build && (inRollout(dv.id, x.id, x.rollout) || dv.appCode < x.minBuild) })) {
        await sendIosCommand(d, "update", {}, who(req));
        notified++;
      }
    }
    res.json({ ok: true, release: next, notified });
  });

  r.post("/releases/:id/withdraw", (req, res) => {
    const x = releaseOr404(req, res);
    if (!x) return;
    iosStore.releases.put({ ...x, status: "withdrawn", updatedAt: Date.now() });
    log(req, "release.withdraw", { version: x.version }, "warn", x.id);
    res.json({ ok: true });
  });

  r.delete("/releases/:id", (req, res) => {
    const x = releaseOr404(req, res);
    if (!x) return;
    iosStore.releases.delete(x.id);
    log(req, "release.delete", { version: x.version }, "warn", x.id);
    res.json({ ok: true });
  });

  /* ------------------------------------------------------------------ push */

  // One push now (a background ping, or a visible test flash), with Apple's answer.
  r.post("/push/test", async (req, res) => {
    const d = iosStore.devices.get(str(req.body?.device, 64));
    if (!d) return res.status(404).json({ ok: false, message: "No such device." });
    const type = req.body?.type === "alert" ? "alert" : "background";
    const out = await sendIosCommand(d, type === "alert" ? "flash" : "ping", type === "alert" ? { title: "M5cet", text: "Test from the console", level: "info" } : {}, who(req));
    log(req, "push.test", { type, via: out.via, status: out.apns?.status, reason: out.apns && !out.apns.ok ? out.apns.reason : undefined }, "info", d.id);
    res.json({
      ok: true, via: out.via, command: out.command.id, error: out.error ?? null, apns: apnsReady(),
      result: out.apns ? (out.apns.ok ? { ok: true, status: 200, apnsId: out.apns.apnsId, attempts: out.apns.attempts } : { ok: false, status: out.apns.status, reason: out.apns.reason, attempts: out.apns.attempts }) : null,
    });
  });

  /* -------------------------------------------------------- passkeys (AASA) */

  r.get("/app-site", (_req, res) => {
    const body = appSiteAssociation();
    res.json({ ok: true, teamId: iosTeamId(), bundleId: iosConfig().bundleId, published: Boolean(body), association: body, path: "/.well-known/apple-app-site-association" });
  });

  app.use("/api/admin/ios", consoleGuard("android", iosConsoleRight), r);
}
