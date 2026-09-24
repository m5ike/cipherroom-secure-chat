// The console's Functions endpoints (4.15), under the admin service's
// authentication (res.locals.adminName / adminRole). Reading needs an
// auditor, changing an operator.
//
//   GET    /admin/functions                      overview: packages, models, runtime, sdk
//   GET    /admin/functions/packages/:id         a package with its versions and draft files
//   POST   /admin/functions/packages             { name, language, description? }
//   PUT    /admin/functions/packages/:id/draft   { files, dependencies? }
//   POST   /admin/functions/packages/:id/publish { bump } ("patch"|"minor"|"major"|"1.2.3")
//   DELETE /admin/functions/packages/:id
//   GET    /admin/functions/models · /models/:id
//   POST   /admin/functions/models               save (create or update)
//   DELETE /admin/functions/models/:id
//   POST   /admin/functions/run                  a test run: { modelId, inputs } or { draft: {packageId,file,fn}, inputs }
//   GET    /admin/functions/runs · /runs/:id
//   GET    /admin/functions/runs/:id/stream      live logs & outputs (SSE)
//   GET    /admin/functions/sdk                  the SDK spec for the editor

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { functionsStore } from "./store";
import { createPackage, deleteModel, deletePackage, publishDraft, saveDraft, saveModel, PackageError, DRAFT } from "./packages";
import { execute, runAdhoc, runEvents, RunRefused } from "./runner";
import { parseEntry, type Caller, type Model } from "./types";
import { SDK_SPEC, sdkCompletions, sdkDts } from "./sdk-spec";
import { layoutGroups } from "../layout-catalog";

const actorOf = (res: Response): string => String(res.locals.adminName ?? "admin");
const consoleCaller = (res: Response): Caller => ({ kind: "console", account: "", name: actorOf(res), groups: ["owner", "operator"], room: null, client: "console", lang: "cs", tz: "UTC" });

function errorOf(err: unknown): { status: number; code: string; message: string } {
  if (err instanceof PackageError) return { status: err.code === "no-package" || err.code === "no-draft" || err.code === "no-model" ? 404 : err.code === "exists" || err.code === "in-use" ? 409 : 400, code: err.code, message: err.message };
  if (err instanceof RunRefused) return { status: 400, code: err.code, message: err.message };
  return { status: 500, code: "error", message: (err as Error).message };
}
const send = (res: Response, err: unknown) => { const e = errorOf(err); res.status(e.status).json({ ok: false, code: e.code, message: e.message }); };

function overview() {
  const store = functionsStore.status();
  return {
    ok: true as const,
    packages: functionsStore.packages().map((p) => ({ ...p, versions: functionsStore.versions(p.id).filter((v) => v.status === "published").map((v) => v.version) })),
    models: functionsStore.models().map((m) => ({ ...m, entryOk: entryOk(m) })),
    groups: layoutGroups(),
    runtime: { persistent: store.persistent, reason: store.reason },
    sdk: SDK_SPEC.map((o) => o.name),
  };
}

function entryOk(m: Model): boolean {
  const p = parseEntry(m.entry);
  if (!p) return false;
  const v = functionsStore.versionByName(p.pkg, p.version);
  return Boolean(v && v.status === "published" && Object.prototype.hasOwnProperty.call(v.files, p.file));
}

export function registerFunctionsAdminRoutes(app: Express): void {
  void functionsStore.ready(); // open the store at boot; hot paths await it too
  const r = express.Router();
  r.use(express.json({ limit: "8mb" }));

  const operator = (_req: Request, res: Response, next: NextFunction) => {
    if (res.locals.adminRole === "operator" || res.locals.adminRole === "owner") { next(); return; }
    res.status(403).json({ ok: false, message: `This needs the operator role; you are ${String(res.locals.adminRole ?? "not signed in")}.` });
  };

  r.get("/", (_req, res) => { void functionsStore.ready().then(() => res.json(overview())); });
  r.get("/sdk", (_req, res) => res.json({ ok: true, spec: SDK_SPEC, completions: sdkCompletions(), dts: sdkDts() }));

  /* -------- packages -------- */
  r.get("/packages/:id", (req, res) => {
    const pkg = functionsStore.package(req.params.id);
    if (!pkg) return res.status(404).json({ ok: false, message: "No such package." });
    const draft = functionsStore.version(pkg.id, DRAFT);
    res.json({ ok: true, package: pkg, draft, versions: functionsStore.versions(pkg.id) });
  });
  r.post("/packages", operator, (req, res) => {
    try { res.json({ ok: true, package: createPackage(String(req.body.name ?? ""), req.body.language === "py" ? "py" : "js", String(req.body.description ?? ""), actorOf(res)) }); }
    catch (err) { send(res, err); }
  });
  r.put("/packages/:id/draft", operator, (req, res) => {
    try { res.json({ ok: true, draft: saveDraft(String(req.params.id), req.body.files ?? {}, req.body.dependencies, actorOf(res)) }); }
    catch (err) { send(res, err); }
  });
  r.post("/packages/:id/publish", operator, (req, res) => {
    try { res.json({ ok: true, version: publishDraft(String(req.params.id), String(req.body.bump ?? "patch"), actorOf(res)) }); }
    catch (err) { send(res, err); }
  });
  r.delete("/packages/:id", operator, (req, res) => {
    try { deletePackage(String(req.params.id), actorOf(res)); res.json({ ok: true }); }
    catch (err) { send(res, err); }
  });

  /* -------- models -------- */
  r.get("/models/:id", (req, res) => {
    const model = functionsStore.model(req.params.id);
    if (!model) return res.status(404).json({ ok: false, message: "No such model." });
    res.json({ ok: true, model: { ...model, entryOk: entryOk(model) } });
  });
  r.post("/models", operator, (req, res) => {
    try { res.json({ ok: true, model: saveModel(req.body ?? {}, actorOf(res)) }); }
    catch (err) { send(res, err); }
  });
  r.delete("/models/:id", operator, (req, res) => {
    try { deleteModel(String(req.params.id)); res.json({ ok: true }); }
    catch (err) { send(res, err); }
  });

  /* -------- runs -------- */
  r.post("/run", operator, (req, res) => {
    const inputs = (req.body.inputs ?? {}) as Record<string, unknown>;
    const caller = consoleCaller(res);
    const draft = req.body.draft as { packageId: string; file: string; fn: string } | undefined;
    const done = (p: Promise<{ run: unknown; outputs: unknown; value: unknown }>) => p.then((out) => res.json({ ok: true, ...out })).catch((err) => send(res, err));
    if (draft) {
      const pkg = functionsStore.package(draft.packageId);
      const version = pkg ? functionsStore.version(pkg.id, DRAFT) : null;
      if (!pkg || !version) return res.status(404).json({ ok: false, message: "No draft to run." });
      const deps: Record<string, { version: string; main: string; files: Record<string, string> }> = {};
      for (const [name, ver] of Object.entries(version.manifest.dependencies ?? {})) { const dv = functionsStore.versionByName(name, ver); if (dv) deps[name] = { version: ver, main: dv.manifest.main, files: dv.files }; }
      return void done(runAdhoc({ lang: pkg.language, files: version.files, deps, entry: { file: String(draft.file || version.manifest.main), fn: String(draft.fn || "execute") }, inputs, limits: req.body.limits }, caller));
    }
    const model = functionsStore.model(String(req.body.modelId ?? ""));
    if (!model) return res.status(404).json({ ok: false, message: "No such model." });
    void done(execute(model, inputs, caller, { executor: "console", test: true }));
  });

  r.get("/runs", (req, res) => {
    void functionsStore.ready().then(() => res.json({ ok: true, runs: functionsStore.runs({ modelId: req.query.model ? String(req.query.model) : undefined, limit: Number(req.query.limit) || 100 }) }));
  });
  r.get("/runs/:id", (req, res) => {
    const run = functionsStore.run(req.params.id);
    if (!run) return res.status(404).json({ ok: false, message: "No such run." });
    res.json({ ok: true, run, logs: functionsStore.logs(req.params.id) });
  });
  r.get("/runs/:id/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    (res as unknown as { flushHeaders?: () => void }).flushHeaders?.();
    const runId = req.params.id;
    for (const l of functionsStore.logs(runId)) res.write(`data: ${JSON.stringify({ type: "log", ...l })}\n\n`);
    const onRun = (ev: { runId: string }) => { if (ev.runId === runId) { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* gone */ } } };
    runEvents.on("run", onRun);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* gone */ } }, 15_000);
    req.on("close", () => { clearInterval(ping); runEvents.off("run", onRun); });
  });

  app.use("/admin/functions", r);
}
