// The console's API that both mobile apps share (Android 6.0, iOS 6.14),
// /api/admin/<platform>/* — mounted by android/admin-routes.ts and
// ios/admin-routes.ts behind the admin guard and the module guard:
//
//   GET    /devices                 enrolled devices;  GET/PATCH/DELETE /devices/:id
//   GET/DELETE /devices/:id/locations   the device's track (each read audited)
//   POST   /devices/:id/commands    ping | status | flash | push | update | lock | wipe | config
//   POST   /commands                the same to several devices (or all)
//   GET    /commands, /events       what was sent, what devices reported
//   GET/POST/DELETE /codes          enrolment codes (the code is shown once); GET /codes/qr
//   GET    /catalog                 the design language (elements, actions, screens…)
//   GET/PUT /design, POST /design/reset
//   POST   /design/validate         6.14: the checks without saving (problems, the platform's warnings)
//   POST   /design/preview          6.14: what a build of it would carry (files, sizes, oldest app) — nothing stored
//   GET/POST /builds, GET /builds/:id, /content, /deploy, POST /builds/:id/publish|withdraw|restore, DELETE
//
// Each platform adds its own: overview, settings, releases, push transport.

import type { Request, Response, Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { renderSVG } from "uqr";
import { audit } from "../monitor/audit";
import { adminName } from "../admin-auth";
import { DesignError, designRev, type AndroidDesign } from "../android/design";
import { buildContentFor, compileDesign, createBuildFor, deployFileFor, designOfContent, type BuildTarget } from "./bundle";
import { COMMAND_KINDS } from "./commands";
import { newId, type BaseDevice, type Command, type CommandKind, type MobilePlatformId, type MobileStore } from "./store";

export type AdminPlatform<D extends BaseDevice, R extends { id: string }> = {
  id: MobilePlatformId;
  store: MobileStore<D, R>;
  /** A device as the console sees it (never its keys or push tokens). */
  devicePublic: (d: D) => Record<string, unknown>;
  /** Sends (or queues) a control message. */
  sendCommand: (d: D, kind: CommandKind, payload: unknown, by: string) => Promise<{ command: Command; via: string; error?: string }>;
  /** The push transport's name in the broadcast's log ("fcm", "apns"). */
  pushVia: string;
  location: () => { track: boolean; days: number; minSeconds: number };
  design: {
    get: () => AndroidDesign;
    save: (raw: unknown, by: string) => AndroidDesign;
    problem: () => string | null;
    defaults: AndroidDesign;
    sanitize: (raw: unknown) => AndroidDesign;
    catalog: () => Record<string, unknown>;
    /** What the platform cannot do of a valid design (6.14 iOS, docs/ios-architecture.md §5). */
    warnings?: (d: AndroidDesign) => string[];
  };
  builds: BuildTarget<D, R>;
  appVersion: () => string;
};

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function registerSharedAdminRoutes<D extends BaseDevice, R extends { id: string }>(r: Router, p: AdminPlatform<D, R>): void {
  const store = p.store;
  const who = (req: Request) => adminName(req);
  const log = (req: Request, event: string, detail?: Record<string, unknown>, level: "info" | "notice" | "warn" = "notice", target?: string) =>
    audit.add({ category: "admin", level, event: `admin.${p.id}.${event}`, actor: who(req), target, detail });

  /* -------------------------------------------------------------- devices */

  r.get("/devices", (req, res) => {
    const status = str(req.query.status, 20);
    const q = str(req.query.q, 80).toLowerCase();
    const list = store.devices.list({ limit: 2000, filter: (d) => (!status || d.status === status) && (!q || `${d.name} ${d.model} ${d.id}`.toLowerCase().includes(q)) });
    res.json({ ok: true, devices: list.map(p.devicePublic) });
  });

  r.get("/devices/:id", (req, res) => {
    const d = store.devices.get(String(req.params.id));
    if (!d) return res.status(404).json({ ok: false, message: "No such device." });
    res.json({
      ok: true, device: { ...p.devicePublic(d), kid: d.kid },
      commands: store.commands.list({ device: d.id, limit: 50 }),
      events: store.events.list({ device: d.id, limit: 100 }),
    });
  });

  r.patch("/devices/:id", (req, res) => {
    const d = store.devices.get(String(req.params.id));
    if (!d) return res.status(404).json({ ok: false, message: "No such device." });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const next = { ...d };
    if (typeof b.name === "string") next.name = b.name.trim().slice(0, 80) || d.name;
    if (typeof b.notes === "string") next.notes = b.notes.slice(0, 1000);
    if (b.status === "active" || b.status === "blocked" || b.status === "retired") {
      if (d.status === "wiped" && b.status === "active") return res.status(409).json({ ok: false, message: "A wiped device enrols again with new keys." });
      next.status = b.status;
    }
    store.devices.put(next);
    log(req, "device.update", { status: next.status, name: next.name }, next.status !== d.status ? "warn" : "notice", d.id);
    res.json({ ok: true, device: p.devicePublic(next) });
  });

  r.delete("/devices/:id", (req, res) => {
    const id = String(req.params.id);
    if (!store.devices.get(id)) return res.status(404).json({ ok: false, message: "No such device." });
    store.devices.delete(id);
    for (const c of store.commands.list({ device: id, limit: 5000 })) store.commands.delete(c.id);
    for (const pt of store.locations.list({ device: id, limit: 100_000 })) store.locations.delete(pt.id);
    log(req, "device.delete", {}, "warn", id);
    res.json({ ok: true });
  });

  // 6.1: the device's track (newest first) — each read is audited.
  r.get("/devices/:id/locations", (req, res) => {
    const d = store.devices.get(String(req.params.id));
    if (!d) return res.status(404).json({ ok: false, message: "No such device." });
    const limit = Math.max(1, Math.min(5000, Number(req.query.limit) || 500));
    const since = Number(req.query.since) || 0;
    const before = Number(req.query.before) || undefined;
    const points = store.locations.list({ device: d.id, limit, before, filter: (pt) => pt.at >= since });
    log(req, "device.locations.read", { points: points.length }, "notice", d.id);
    res.json({ ok: true, points, policy: p.location() });
  });

  r.delete("/devices/:id/locations", (req, res) => {
    const d = store.devices.get(String(req.params.id));
    if (!d) return res.status(404).json({ ok: false, message: "No such device." });
    let n = 0;
    for (const pt of store.locations.list({ device: d.id, limit: 100_000 })) { store.locations.delete(pt.id); n++; }
    log(req, "device.locations.delete", { points: n }, "warn", d.id);
    res.json({ ok: true, deleted: n });
  });

  const kindOf = (v: unknown): CommandKind | null => (typeof v === "string" && (COMMAND_KINDS as readonly string[]).includes(v) ? v as CommandKind : null);

  r.post("/devices/:id/commands", async (req, res) => {
    const d = store.devices.get(String(req.params.id));
    if (!d) return res.status(404).json({ ok: false, message: "No such device." });
    const kind = kindOf(req.body?.kind);
    if (!kind) return res.status(400).json({ ok: false, message: `kind must be one of ${COMMAND_KINDS.join(", ")}` });
    const out = await p.sendCommand(d, kind, req.body?.payload, who(req));
    log(req, `command.${kind}`, { via: out.via, error: out.error }, kind === "wipe" || kind === "lock" ? "warn" : "info", d.id);
    res.json({ ok: true, command: out.command, via: out.via, error: out.error ?? null });
  });

  r.post("/commands", async (req, res) => {
    const kind = kindOf(req.body?.kind);
    if (!kind) return res.status(400).json({ ok: false, message: `kind must be one of ${COMMAND_KINDS.join(", ")}` });
    if (kind === "wipe") return res.status(400).json({ ok: false, message: "Wipe one device at a time." });
    const ids = Array.isArray(req.body?.devices) ? (req.body.devices as unknown[]).map(String) : null;
    const targets = store.devices.list({ limit: 5000, filter: (d) => d.status === "active" && (!ids || ids.includes(d.id)) });
    const results = [];
    for (const d of targets) {
      const out = await p.sendCommand(d, kind, req.body?.payload, who(req));
      results.push({ device: d.id, command: out.command.id, via: out.via, error: out.error ?? null });
    }
    log(req, `broadcast.${kind}`, { devices: targets.length, [p.pushVia]: results.filter((x) => x.via === p.pushVia).length });
    res.json({ ok: true, results });
  });

  r.get("/commands", (req, res) => {
    res.json({ ok: true, commands: store.commands.list({ device: str(req.query.device, 64) || undefined, limit: Number(req.query.limit) || 200 }) });
  });

  r.get("/events", (req, res) => {
    const type = str(req.query.type, 40);
    const level = str(req.query.level, 10);
    res.json({ ok: true, events: store.events.list({ device: str(req.query.device, 64) || undefined, limit: Number(req.query.limit) || 300, filter: (e) => (!type || e.type === type) && (!level || e.level === level) }) });
  });

  /* ------------------------------------------------------ enrolment codes */

  r.get("/codes", (_req, res) => {
    res.json({ ok: true, codes: store.codes.list({ limit: 500 }).map((c) => ({ ...c, hash: undefined })) });
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
    store.codes.put(entry);
    log(req, "code.create", { label: entry.label, uses, days });
    res.json({ ok: true, code, entry: { ...entry, hash: undefined } });
  });

  r.delete("/codes/:id", (req, res) => {
    const ok = store.codes.delete(String(req.params.id));
    if (ok) log(req, "code.delete", {}, "notice", String(req.params.id));
    res.status(ok ? 200 : 404).json({ ok });
  });

  /** The enrolment link as a QR code (SVG): m5cet://enroll?server=…&code=…&kid=… (the same link opens either app). */
  r.get("/codes/qr", (req, res) => {
    const server = str(req.query.server, 300);
    if (!/^https?:\/\/[^\s"'<>]+$/.test(server)) return res.status(400).json({ ok: false, message: "server must be the chat's http(s) address" });
    const params = new URLSearchParams({ server, kid: store.signingKey().kid });
    const code = str(req.query.code, 40);
    if (code) params.set("code", code);
    const link = `m5cet://enroll?${params.toString()}`;
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("X-M5-Link", link);
    res.send(renderSVG(link, { ecc: "M", border: 2 }));
  });

  /* --------------------------------------------------------------- design */

  r.get("/catalog", (_req, res) => { res.json({ ok: true, catalog: p.design.catalog() }); });

  // 6.7: `problem` — the saved design is not in use (it fails the checks); the console says so.
  r.get("/design", (_req, res) => { const design = p.design.get(); const problem = p.design.problem(); res.json({ ok: true, design, ...(problem ? { problem } : {}) }); });

  r.put("/design", (req, res) => {
    try {
      const saved = p.design.save(req.body?.design ?? req.body, who(req));
      log(req, "design.save", { rev: saved.rev });
      res.json({ ok: true, design: saved });
    } catch (err) {
      const problems = err instanceof DesignError ? err.problems : [(err as Error).message];
      res.status(400).json({ ok: false, message: problems[0], problems });
    }
  });

  r.post("/design/reset", (req, res) => {
    const saved = p.design.save(p.design.defaults, who(req));
    log(req, "design.reset", { rev: saved.rev }, "warn");
    res.json({ ok: true, design: saved });
  });

  // 6.14: the checks of a save, without saving — and what the platform would not do of it.
  r.post("/design/validate", (req, res) => {
    try {
      const clean = p.design.sanitize(req.body?.design ?? req.body);
      res.json({ ok: true, valid: true, problems: [], warnings: p.design.warnings?.(clean) ?? [], rev: designRev(clean), minAppCode: Math.max(p.builds.minAppCode, p.builds.designMinAppCode(clean)) });
    } catch (err) {
      const problems = err instanceof DesignError ? err.problems : [(err as Error).message];
      res.json({ ok: true, valid: false, problems, warnings: [] });
    }
  });

  // 6.14: what a build of the design (the posted one, else the saved one) would carry — compiled, not encrypted, not stored.
  r.post("/design/preview", (req, res) => {
    let design: AndroidDesign;
    try {
      const raw = req.body?.design;
      design = raw === undefined ? p.design.get() : p.design.sanitize(raw);
    } catch (err) {
      const problems = err instanceof DesignError ? err.problems : [(err as Error).message];
      return res.status(400).json({ ok: false, message: problems[0], problems });
    }
    const minAppCode = Math.max(p.builds.minAppCode, p.builds.designMinAppCode(design));
    const { plaintext, manifest } = compileDesign(design, { id: "preview", number: 0, version: `${p.appVersion()}-preview`, channel: "stable", created: Date.now(), minAppCode, notes: "" });
    res.json({ ok: true, manifest, size: plaintext.length, minAppCode, designRev: manifest.designRev, warnings: p.design.warnings?.(design) ?? [] });
  });

  /* --------------------------------------------------------------- builds */

  r.get("/builds", (_req, res) => { res.json({ ok: true, builds: store.builds.list({ limit: 500 }).map((b) => ({ ...b, cekSealed: undefined })) }); });

  r.post("/builds", (req, res) => {
    try {
      const build = createBuildFor(p.builds, { notes: str(req.body?.notes, 2000), channel: str(req.body?.channel, 10), minAppCode: Number(req.body?.minAppCode) || undefined, by: who(req), appVersion: p.appVersion() });
      log(req, "build.create", { number: build.number, version: build.version, channel: build.channel }, "notice", build.id);
      res.json({ ok: true, build: { ...build, cekSealed: undefined } });
    } catch (err) {
      res.status(400).json({ ok: false, message: (err as Error).message });
    }
  });

  const buildOr404 = (req: Request, res: Response) => {
    const b = store.builds.get(String(req.params.id));
    if (!b) res.status(404).json({ ok: false, message: "No such build." });
    return b;
  };

  r.get("/builds/:id", (req, res) => { const b = buildOr404(req, res); if (b) res.json({ ok: true, build: { ...b, cekSealed: undefined } }); });

  r.get("/builds/:id/content", (req, res) => {
    const b = buildOr404(req, res);
    if (!b) return;
    try {
      const { manifest, files } = buildContentFor(p.builds, b);
      res.json({ ok: true, manifest, design: designOfContent(files, p.design.defaults) });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  r.get("/builds/:id/deploy", (req, res) => {
    const b = buildOr404(req, res);
    if (!b) return;
    const wanted = str(req.query.devices, 20_000);
    const devices = store.devices.list({ limit: 5000, filter: (d) => d.status === "active" && (wanted === "" || wanted === "all" || wanted.split(",").includes(d.id)) });
    if (!devices.length) return res.status(400).json({ ok: false, message: "No active device to encrypt the deploy file for." });
    try {
      const file = deployFileFor(p.builds, b, devices);
      audit.add({ category: "admin", level: "notice", event: `admin.${p.id}.build.deploy-file`, actor: who(req), target: b.id, detail: { devices: devices.length } });
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
    store.builds.put(next);
    log(req, "build.publish", { version: b.version }, "notice", b.id);
    let notified = 0;
    if (req.body?.notify !== false) {
      for (const d of store.devices.list({ limit: 5000, filter: (x) => x.status === "active" && x.appCode >= b.minAppCode })) { await p.sendCommand(d, "update", {}, who(req)); notified++; }
    }
    res.json({ ok: true, build: { ...next, cekSealed: undefined }, notified });
  });

  r.post("/builds/:id/withdraw", (req, res) => {
    const b = buildOr404(req, res);
    if (!b) return;
    store.builds.put({ ...b, status: "withdrawn" });
    log(req, "build.withdraw", { version: b.version }, "warn", b.id);
    res.json({ ok: true });
  });

  r.post("/builds/:id/restore", (req, res) => {
    const b = buildOr404(req, res);
    if (!b) return;
    try {
      const saved = p.design.save(designOfContent(buildContentFor(p.builds, b).files, p.design.defaults), who(req));
      log(req, "design.restore", { from: b.version }, "notice", b.id);
      res.json({ ok: true, design: saved });
    } catch (err) {
      res.status(500).json({ ok: false, message: (err as Error).message });
    }
  });

  r.delete("/builds/:id", (req, res) => {
    const b = buildOr404(req, res);
    if (!b) return;
    store.builds.delete(b.id);
    store.removeFile(store.buildFile(b.id));
    log(req, "build.delete", { version: b.version }, "warn", b.id);
    res.json({ ok: true });
  });
}
