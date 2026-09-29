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
//   GET/POST /builds, GET /builds/:id, /content, /deploy, POST /builds/:id/publish|withdraw|restore, DELETE
//   GET    /releases, POST /releases/upload (raw APK), PATCH/DELETE /releases/:id,
//          POST /releases/:id/publish|withdraw, GET /releases/:id/apk

import express, { type Express, type Request, type Response } from "express";
import { createReadStream, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { renderSVG } from "uqr";
import { audit } from "../monitor/audit";
import { adminName } from "../admin-auth";
import { consoleGuard } from "../access";
import { buildInfo } from "../build-info";
import type { Needs } from "../access";
import { androidConfig, parseServiceAccount, publicConfig, sanitizeFcmClient, sanitizePolicy, saveAndroidConfig, sealServiceAccount } from "./config";
import { androidCatalog, androidDesign, DEFAULT_DESIGN, DesignError, saveAndroidDesign } from "./design";
import { buildContent, createBuild, deployFile, designOfContent, MIN_APP_CODE, versionCodeOf } from "./bundle";
import { COMMAND_KINDS, sendCommand } from "./commands";
import { fcmReady } from "./fcm";
import { readApk } from "./apk";
import { releaseSignedString, signP1363 } from "./crypto";
import { androidStore, newId, type CommandKind, type Device, type Release } from "./store";

/** What a console request needs of the Android module (Modules & groups). */
export function androidConsoleRight(req: Request): Needs | null {
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
  const r = express.Router();
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

  /* -------------------------------------------------------------- devices */

  r.get("/devices", (req, res) => {
    const status = str(req.query.status, 20);
    const q = str(req.query.q, 80).toLowerCase();
    const list = androidStore.devices.list({ limit: 2000, filter: (d) => (!status || d.status === status) && (!q || `${d.name} ${d.model} ${d.id}`.toLowerCase().includes(q)) });
    res.json({ ok: true, devices: list.map(devicePublic) });
  });

  r.get("/devices/:id", (req, res) => {
    const d = androidStore.devices.get(String(req.params.id));
    if (!d) return res.status(404).json({ ok: false, message: "No such device." });
    res.json({
      ok: true, device: { ...devicePublic(d), kid: d.kid },
      commands: androidStore.commands.list({ device: d.id, limit: 50 }),
      events: androidStore.events.list({ device: d.id, limit: 100 }),
    });
  });

  r.patch("/devices/:id", (req, res) => {
    const d = androidStore.devices.get(String(req.params.id));
    if (!d) return res.status(404).json({ ok: false, message: "No such device." });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const next = { ...d };
    if (typeof b.name === "string") next.name = b.name.trim().slice(0, 80) || d.name;
    if (typeof b.notes === "string") next.notes = b.notes.slice(0, 1000);
    if (b.status === "active" || b.status === "blocked" || b.status === "retired") {
      if (d.status === "wiped" && b.status === "active") return res.status(409).json({ ok: false, message: "A wiped device enrols again with new keys." });
      next.status = b.status;
    }
    androidStore.devices.put(next);
    log(req, "device.update", { status: next.status, name: next.name }, next.status !== d.status ? "warn" : "notice", d.id);
    res.json({ ok: true, device: devicePublic(next) });
  });

  r.delete("/devices/:id", (req, res) => {
    const id = String(req.params.id);
    if (!androidStore.devices.get(id)) return res.status(404).json({ ok: false, message: "No such device." });
    androidStore.devices.delete(id);
    for (const c of androidStore.commands.list({ device: id, limit: 5000 })) androidStore.commands.delete(c.id);
    log(req, "device.delete", {}, "warn", id);
    res.json({ ok: true });
  });

  const kindOf = (v: unknown): CommandKind | null => (typeof v === "string" && (COMMAND_KINDS as readonly string[]).includes(v) ? v as CommandKind : null);

  r.post("/devices/:id/commands", async (req, res) => {
    const d = androidStore.devices.get(String(req.params.id));
    if (!d) return res.status(404).json({ ok: false, message: "No such device." });
    const kind = kindOf(req.body?.kind);
    if (!kind) return res.status(400).json({ ok: false, message: `kind must be one of ${COMMAND_KINDS.join(", ")}` });
    const out = await sendCommand(d, kind, req.body?.payload, who(req));
    log(req, `command.${kind}`, { via: out.via, error: out.error }, kind === "wipe" || kind === "lock" ? "warn" : "info", d.id);
    res.json({ ok: true, command: out.command, via: out.via, error: out.error ?? null });
  });

  r.post("/commands", async (req, res) => {
    const kind = kindOf(req.body?.kind);
    if (!kind) return res.status(400).json({ ok: false, message: `kind must be one of ${COMMAND_KINDS.join(", ")}` });
    if (kind === "wipe") return res.status(400).json({ ok: false, message: "Wipe one device at a time." });
    const ids = Array.isArray(req.body?.devices) ? (req.body.devices as unknown[]).map(String) : null;
    const targets = androidStore.devices.list({ limit: 5000, filter: (d) => d.status === "active" && (!ids || ids.includes(d.id)) });
    const results = [];
    for (const d of targets) {
      const out = await sendCommand(d, kind, req.body?.payload, who(req));
      results.push({ device: d.id, command: out.command.id, via: out.via, error: out.error ?? null });
    }
    log(req, `broadcast.${kind}`, { devices: targets.length, fcm: results.filter((x) => x.via === "fcm").length });
    res.json({ ok: true, results });
  });

  r.get("/commands", (req, res) => {
    res.json({ ok: true, commands: androidStore.commands.list({ device: str(req.query.device, 64) || undefined, limit: Number(req.query.limit) || 200 }) });
  });

  r.get("/events", (req, res) => {
    const type = str(req.query.type, 40);
    const level = str(req.query.level, 10);
    res.json({ ok: true, events: androidStore.events.list({ device: str(req.query.device, 64) || undefined, limit: Number(req.query.limit) || 300, filter: (e) => (!type || e.type === type) && (!level || e.level === level) }) });
  });

  /* ------------------------------------------------------ enrolment codes */

  r.get("/codes", (_req, res) => {
    res.json({ ok: true, codes: androidStore.codes.list({ limit: 500 }).map((c) => ({ ...c, hash: undefined })) });
  });

  r.post("/codes", (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const bytes = randomBytes(12);
    const code = Array.from(bytes, (x) => alphabet[x % alphabet.length]).join("").replace(/(.{4})(?=.)/g, "$1-");
    const uses = Math.max(1, Math.min(10_000, Math.round(Number(b.uses) || 1)));
    const days = Math.max(1, Math.min(365, Math.round(Number(b.days) || 7)));
    const entry = {
      id: newId("enc"), hash: createHash("sha256").update(code.replace(/-/g, "").toUpperCase()).digest("hex"), label: str(b.label, 80),
      usesLeft: uses, used: 0, expiresAt: Date.now() + days * 86_400_000, createdAt: Date.now(), createdBy: who(req),
    };
    androidStore.codes.put(entry);
    log(req, "code.create", { label: entry.label, uses, days });
    res.json({ ok: true, code, entry: { ...entry, hash: undefined } });
  });

  r.delete("/codes/:id", (req, res) => {
    const ok = androidStore.codes.delete(String(req.params.id));
    if (ok) log(req, "code.delete", {}, "notice", String(req.params.id));
    res.status(ok ? 200 : 404).json({ ok });
  });

  /** The enrolment link as a QR code (SVG): m5cet://enroll?server=…&code=…&kid=… */
  r.get("/codes/qr", (req, res) => {
    const server = str(req.query.server, 300);
    if (!/^https?:\/\/[^\s"'<>]+$/.test(server)) return res.status(400).json({ ok: false, message: "server must be the chat's http(s) address" });
    const params = new URLSearchParams({ server, kid: androidStore.signingKey().kid });
    const code = str(req.query.code, 40);
    if (code) params.set("code", code);
    const link = `m5cet://enroll?${params.toString()}`;
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("X-M5-Link", link);
    res.send(renderSVG(link, { ecc: "M", border: 2 }));
  });

  /* --------------------------------------------------------------- design */

  r.get("/catalog", (_req, res) => { res.json({ ok: true, catalog: androidCatalog() }); });

  r.get("/design", (_req, res) => { res.json({ ok: true, design: androidDesign() }); });

  r.put("/design", (req, res) => {
    try {
      const saved = saveAndroidDesign(req.body?.design ?? req.body, who(req));
      log(req, "design.save", { rev: saved.rev });
      res.json({ ok: true, design: saved });
    } catch (err) {
      const problems = err instanceof DesignError ? err.problems : [(err as Error).message];
      res.status(400).json({ ok: false, message: problems[0], problems });
    }
  });

  r.post("/design/reset", (req, res) => {
    const saved = saveAndroidDesign(DEFAULT_DESIGN, who(req));
    log(req, "design.reset", { rev: saved.rev }, "warn");
    res.json({ ok: true, design: saved });
  });

  /* --------------------------------------------------------------- builds */

  r.get("/builds", (_req, res) => { res.json({ ok: true, builds: androidStore.builds.list({ limit: 500 }).map((b) => ({ ...b, cekSealed: undefined })) }); });

  r.post("/builds", (req, res) => {
    try {
      const build = createBuild({ notes: str(req.body?.notes, 2000), channel: str(req.body?.channel, 10), minAppCode: Number(req.body?.minAppCode) || undefined, by: who(req), appVersion: buildInfo().version });
      log(req, "build.create", { number: build.number, version: build.version, channel: build.channel }, "notice", build.id);
      res.json({ ok: true, build: { ...build, cekSealed: undefined } });
    } catch (err) {
      res.status(400).json({ ok: false, message: (err as Error).message });
    }
  });

  const buildOr404 = (req: Request, res: Response) => {
    const b = androidStore.builds.get(String(req.params.id));
    if (!b) res.status(404).json({ ok: false, message: "No such build." });
    return b;
  };

  r.get("/builds/:id", (req, res) => { const b = buildOr404(req, res); if (b) res.json({ ok: true, build: { ...b, cekSealed: undefined } }); });

  r.get("/builds/:id/content", (req, res) => {
    const b = buildOr404(req, res);
    if (!b) return;
    try {
      const { manifest, files } = buildContent(b);
      res.json({ ok: true, manifest, design: designOfContent(files) });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  r.get("/builds/:id/deploy", (req, res) => {
    const b = buildOr404(req, res);
    if (!b) return;
    const wanted = str(req.query.devices, 20_000);
    const devices = androidStore.devices.list({ limit: 5000, filter: (d) => d.status === "active" && (wanted === "" || wanted === "all" || wanted.split(",").includes(d.id)) });
    if (!devices.length) return res.status(400).json({ ok: false, message: "No active device to encrypt the deploy file for." });
    try {
      const file = deployFile(b, devices);
      audit.add({ category: "admin", level: "notice", event: "admin.android.build.deploy-file", actor: who(req), target: b.id, detail: { devices: devices.length } });
      res.setHeader("Content-Type", "application/vnd.m5cet.bundle");
      res.setHeader("Content-Disposition", `attachment; filename="m5cet-${b.version}.m5ab"`);
      res.send(file);
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  r.post("/builds/:id/publish", async (req, res) => {
    const b = buildOr404(req, res);
    if (!b) return;
    const next = { ...b, status: "published" as const, publishedAt: Date.now() };
    androidStore.builds.put(next);
    log(req, "build.publish", { version: b.version }, "notice", b.id);
    let notified = 0;
    if (req.body?.notify !== false) {
      for (const d of androidStore.devices.list({ limit: 5000, filter: (x) => x.status === "active" && x.appCode >= b.minAppCode })) { await sendCommand(d, "update", {}, who(req)); notified++; }
    }
    res.json({ ok: true, build: { ...next, cekSealed: undefined }, notified });
  });

  r.post("/builds/:id/withdraw", (req, res) => {
    const b = buildOr404(req, res);
    if (!b) return;
    androidStore.builds.put({ ...b, status: "withdrawn" });
    log(req, "build.withdraw", { version: b.version }, "warn", b.id);
    res.json({ ok: true });
  });

  r.post("/builds/:id/restore", (req, res) => {
    const b = buildOr404(req, res);
    if (!b) return;
    try {
      const saved = saveAndroidDesign(designOfContent(buildContent(b).files), who(req));
      log(req, "design.restore", { from: b.version }, "notice", b.id);
      res.json({ ok: true, design: saved });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  r.delete("/builds/:id", (req, res) => {
    const b = buildOr404(req, res);
    if (!b) return;
    androidStore.builds.delete(b.id);
    androidStore.removeFile(androidStore.buildFile(b.id));
    log(req, "build.delete", { version: b.version }, "warn", b.id);
    res.json({ ok: true });
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

  app.use("/api/admin/android", consoleGuard("android", androidConsoleRight), r);
}
