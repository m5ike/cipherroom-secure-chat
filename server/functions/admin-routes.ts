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
//                                                 or { adhoc: {lang,files,file,fn} }; live: true answers { runId } at once
//   GET    /admin/functions/runs · /runs/:id
//   GET    /admin/functions/runs/:id/stream      live logs & outputs (SSE)
//   GET    /admin/functions/runs/:id/live        a live run's events from the start, then as they come (SSE)
//   POST   /admin/functions/runs/:id/answer      { interaction, value } — answer m5.prompt / m5.form
//   POST   /admin/functions/flow/compile         { flow, trace? } → the code a visual flow compiles to
//   PUT    /admin/functions/packages/:id/flow    { flow } → the draft gets flow.m5flow.json + the code
//   GET    /admin/functions/sdk                  the SDK spec for the editor

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { functionsStore } from "./store";
import { createPackage, deleteModel, deletePackage, exportPackage, importPackage, publishDraft, saveDraft, saveModel, PackageError, TEMPLATES, DRAFT } from "./packages";
import { answerRun, execute, functionsPublicUrl, runAdhoc, runEvents, RunRefused } from "./runner";
import { checkFlow, compileFlow, parseFlow, FLOW_FILE, type Flow, type FlowError } from "./flow";
import { parseEntry, type Caller, type Model, type RunStatus } from "./types";

const RUN_STATUSES = ["queued", "running", "waiting", "done", "failed", "timed-out", "cancelled"];
import { SDK_SPEC, sdkCompletions, sdkDts } from "./sdk-spec";
import { cronError } from "./cron";
import { tutorialLessons } from "./tutorial";
import { newId } from "./store";
import { layoutGroups } from "../layout-catalog";

const actorOf = (res: Response): string => String(res.locals.adminName ?? "admin");
const consoleCaller = (res: Response): Caller => ({ kind: "console", account: "", name: actorOf(res), groups: ["owner", "operator"], room: null, client: "console", lang: "cs", tz: "UTC" });

function errorOf(err: unknown): { status: number; code: string; message: string } {
  if (err instanceof PackageError) return { status: err.code === "no-package" || err.code === "no-draft" || err.code === "no-model" ? 404 : err.code === "exists" || err.code === "in-use" ? 409 : 400, code: err.code, message: err.message };
  if (err instanceof RunRefused) return { status: 400, code: err.code, message: err.message };
  return { status: 500, code: "error", message: (err as Error).message };
}
const send = (res: Response, err: unknown) => { const e = errorOf(err); res.status(e.status).json({ ok: false, code: e.code, message: e.message }); };

/* ------------------------------------------------------- live console runs (5.1) */

type LiveEvent = { runId?: string; type: string; [k: string]: unknown };
const liveRuns = new Map<string, { events: LiveEvent[]; done: boolean; subs: Set<(ev: LiveEvent) => void> }>();
const LIVE_KEEP_MS = 2 * 60 * 1000;
const LIVE_MAX_EVENTS = 5000;

/** Buffers a run's events from its first one, so the console can subscribe after it started. */
function followLive(runId: string, work: Promise<{ run: unknown; outputs: unknown }>): void {
  const entry = { events: [] as LiveEvent[], done: false, subs: new Set<(ev: LiveEvent) => void>() };
  liveRuns.set(runId, entry);
  const push = (ev: LiveEvent) => { if (entry.events.length < LIVE_MAX_EVENTS) entry.events.push(ev); for (const s of entry.subs) s(ev); };
  const onRun = (ev: LiveEvent) => { if (ev.runId === runId) push(ev); };
  runEvents.on("run", onRun);
  const finish = (ev: LiveEvent) => {
    runEvents.off("run", onRun);
    push(ev);
    entry.done = true;
    setTimeout(() => liveRuns.delete(runId), LIVE_KEEP_MS).unref?.();
  };
  work.then((out) => finish({ runId, type: "result", ok: true, run: out.run, outputs: out.outputs }))
    .catch((err) => { const e = errorOf(err); finish({ runId, type: "result", ok: false, code: e.code, message: e.message }); });
}

function safeIssues(raw: unknown) { try { return checkFlow(parseFlow(raw)); } catch { return []; } }

function overview() {
  const store = functionsStore.status();
  return {
    ok: true as const,
    packages: functionsStore.packages().map((p) => ({ ...p, versions: functionsStore.versions(p.id).filter((v) => v.status === "published").map((v) => v.version), flow: Boolean(functionsStore.version(p.id, DRAFT)?.files[FLOW_FILE]) })),
    models: functionsStore.models().map(modelView),
    schedules: functionsStore.schedules(),
    templates: TEMPLATES.map((t) => ({ id: t.id, name: t.name, language: t.language, description: t.description })),
    groups: layoutGroups(),
    runtime: { persistent: store.persistent, reason: store.reason },
    sdk: SDK_SPEC.map((o) => o.name),
    stats: runStats(),
  };
}

/** Runs in the last 24 hours, by outcome (the console's header). */
function runStats() {
  const since = Date.now() - 24 * 3600 * 1000;
  const runs = functionsStore.runs({ limit: 1000 }).filter((r) => r.queuedAt >= since);
  const failed = runs.filter((r) => r.status === "failed" || r.status === "timed-out").length;
  const ms = runs.filter((r) => r.status === "done").map((r) => r.ms);
  return { runs24h: runs.length, failed24h: failed, avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0 };
}

function entryOk(m: Model): boolean {
  const p = parseEntry(m.entry);
  if (!p) return false;
  const v = functionsStore.versionByName(p.pkg, p.version);
  return Boolean(v && v.status === "published" && Object.prototype.hasOwnProperty.call(v.files, p.file));
}

/** The model as the console sees it: whether its entry resolves, and — when the
 *  webhook executor is on — the URL to call it (a path when no public URL is set). */
function modelView(m: Model): Model & { entryOk: boolean; webhookUrl: string | null } {
  const hook = m.executors.webhook;
  const webhookUrl = hook?.enabled && hook.token ? `${functionsPublicUrl()}/hooks/m/${m.id}/${hook.token}` : null;
  return { ...m, entryOk: entryOk(m), webhookUrl };
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
  r.get("/tutorial", (_req, res) => res.json({ ok: true, lessons: tutorialLessons() }));

  /* -------- packages -------- */
  r.get("/packages/:id", (req, res) => {
    const pkg = functionsStore.package(req.params.id);
    if (!pkg) return res.status(404).json({ ok: false, message: "No such package." });
    const draft = functionsStore.version(pkg.id, DRAFT);
    res.json({ ok: true, package: pkg, draft, versions: functionsStore.versions(pkg.id) });
  });
  r.post("/packages", operator, (req, res) => {
    try { res.json({ ok: true, package: createPackage(String(req.body.name ?? ""), req.body.language === "py" ? "py" : "js", String(req.body.description ?? ""), actorOf(res), req.body.template ? String(req.body.template) : undefined) }); }
    catch (err) { send(res, err); }
  });
  r.get("/packages/:id/export", (req, res) => {
    try {
      const bundle = exportPackage(String(req.params.id));
      res.setHeader("Content-Disposition", `attachment; filename="${bundle.name}.m5pkg.json"`);
      res.json(bundle);
    } catch (err) { send(res, err); }
  });
  r.post("/packages/import", operator, (req, res) => {
    try { res.json({ ok: true, package: importPackage(req.body?.bundle ?? req.body, actorOf(res), req.body?.name ? String(req.body.name) : undefined) }); }
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
    res.json({ ok: true, model: modelView(model) });
  });
  r.post("/models", operator, (req, res) => {
    try { res.json({ ok: true, model: modelView(saveModel(req.body ?? {}, actorOf(res))) }); }
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
    // live: answer at once with the run id; the console follows /runs/:id/live
    // (logs, outputs, questions to answer, the result) instead of waiting.
    const live = req.body.live === true;
    const runId = live ? newId("run") : undefined;
    const done = (p: Promise<{ run: unknown; outputs: unknown; value: unknown }>) => {
      if (!live) return void p.then((out) => res.json({ ok: true, ...out })).catch((err) => send(res, err));
      followLive(runId!, p);
      res.json({ ok: true, runId });
    };
    // Inline code (the tutorial, the builder): run files directly, no package needed.
    const adhoc = req.body.adhoc as { lang?: string; files?: Record<string, string>; file?: string; fn?: string } | undefined;
    if (adhoc && adhoc.files) {
      const lang = adhoc.lang === "py" ? "py" : "js";
      const file = String(adhoc.file || (lang === "py" ? "index.py" : "index.js"));
      return void done(runAdhoc({ lang, files: adhoc.files, deps: {}, entry: { file, fn: String(adhoc.fn || "execute") }, inputs, limits: req.body.limits, runId }, caller));
    }
    const draft = req.body.draft as { packageId: string; file: string; fn: string } | undefined;
    if (draft) {
      const pkg = functionsStore.package(draft.packageId);
      const version = pkg ? functionsStore.version(pkg.id, DRAFT) : null;
      if (!pkg || !version) return res.status(404).json({ ok: false, message: "No draft to run." });
      const deps: Record<string, { version: string; main: string; files: Record<string, string> }> = {};
      for (const [name, ver] of Object.entries(version.manifest.dependencies ?? {})) { const dv = functionsStore.versionByName(name, ver); if (dv) deps[name] = { version: ver, main: dv.manifest.main, files: dv.files }; }
      return void done(runAdhoc({ lang: pkg.language, files: version.files, deps, entry: { file: String(draft.file || version.manifest.main), fn: String(draft.fn || "execute") }, inputs, limits: req.body.limits, runId }, caller));
    }
    const model = functionsStore.model(String(req.body.modelId ?? ""));
    if (!model) return res.status(404).json({ ok: false, message: "No such model." });
    done(execute(model, inputs, caller, { executor: "console", test: true, runId }));
  });

  // A live run's events, replayed from the start, then as they come (SSE).
  r.get("/runs/:id/live", (req, res) => {
    const entry = liveRuns.get(String(req.params.id));
    if (!entry) return res.status(404).json({ ok: false, message: "No live run with that id (it ended a while ago?)." });
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    (res as unknown as { flushHeaders?: () => void }).flushHeaders?.();
    const write = (ev: unknown) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* gone */ } };
    for (const ev of entry.events) write(ev);
    if (entry.done) return void res.end();
    const sub = (ev: LiveEvent) => { write(ev); if (ev.type === "result") { cleanup(); res.end(); } };
    entry.subs.add(sub);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* gone */ } }, 15_000);
    const cleanup = () => { clearInterval(ping); entry.subs.delete(sub); };
    req.on("close", cleanup);
  });

  // The console answers a question (m5.prompt / m5.form) of its own run.
  r.post("/runs/:id/answer", operator, (req, res) => {
    const body = (req.body ?? {}) as { interaction?: string; value?: unknown };
    const ok = answerRun(String(req.params.id), String(body.interaction ?? ""), body.value ?? null);
    if (!ok) return res.status(404).json({ ok: false, message: "That question is no longer open." });
    res.json({ ok: true });
  });

  /* -------- the visual builder (5.1) -------- */
  r.post("/flow/compile", (req, res) => {
    try {
      const flow = parseFlow(req.body?.flow);
      const c = compileFlow(flow, { trace: req.body?.trace === true });
      res.json({ ok: true, code: c.code, file: c.file, issues: c.issues, inputs: c.inputs });
    } catch (err) { res.status(400).json({ ok: false, code: "bad-flow", message: (err as Error).message, node: (err as FlowError).node ?? null, issues: safeIssues(req.body?.flow) }); }
  });
  // Saves a flow into a package's draft: the flow file plus the code it compiles to.
  r.put("/packages/:id/flow", operator, (req, res) => {
    const pkg = functionsStore.package(String(req.params.id));
    if (!pkg) return res.status(404).json({ ok: false, message: "No such package." });
    let flow: Flow;
    let code: ReturnType<typeof compileFlow>;
    try { flow = parseFlow(req.body?.flow); code = compileFlow(flow); }
    catch (err) { return res.status(400).json({ ok: false, code: "bad-flow", message: (err as Error).message, node: (err as FlowError).node ?? null }); }
    if (flow.lang !== pkg.language) return res.status(400).json({ ok: false, code: "bad-language", message: `The package is ${pkg.language === "py" ? "Python" : "JavaScript"}; switch the flow's language or save it to another package.` });
    const current = functionsStore.version(pkg.id, DRAFT);
    const files = { ...(current?.files ?? {}), [FLOW_FILE]: JSON.stringify(flow, null, 2) + "\n", [code.file]: code.code };
    try { res.json({ ok: true, draft: saveDraft(pkg.id, files, current?.manifest.dependencies, actorOf(res)), inputs: code.inputs }); }
    catch (err) { send(res, err); }
  });

  /* -------- schedules (cron) -------- */
  r.post("/schedules", operator, (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const model = functionsStore.model(String(b.modelId ?? ""));
    if (!model) return res.status(404).json({ ok: false, message: "No such model." });
    const err = cronError(String(b.cron ?? ""));
    if (err) return res.status(400).json({ ok: false, code: "bad-cron", message: err });
    const id = b.id && functionsStore.schedule(String(b.id)) ? String(b.id) : newId("sch");
    const prev = functionsStore.schedule(id);
    const schedule = { id, modelId: model.id, cron: String(b.cron), tz: typeof b.tz === "string" ? b.tz : "UTC", inputs: (b.inputs && typeof b.inputs === "object" ? b.inputs : {}) as Record<string, unknown>, enabled: b.enabled !== false, lastRun: prev?.lastRun ?? null, createdAt: prev?.createdAt ?? Date.now(), createdBy: actorOf(res) };
    functionsStore.saveSchedule(schedule);
    res.json({ ok: true, schedule });
  });
  r.delete("/schedules/:id", operator, (req, res) => { functionsStore.deleteSchedule(String(req.params.id)); res.json({ ok: true }); });
  r.post("/schedules/:id/run", operator, (req, res) => {
    const s = functionsStore.schedule(String(req.params.id));
    const model = s && functionsStore.model(s.modelId);
    if (!s || !model) return res.status(404).json({ ok: false, message: "No such schedule." });
    execute(model, s.inputs, consoleCaller(res), { executor: "schedule", test: true, skipValidation: true })
      .then((out) => res.json({ ok: true, run: out.run, outputs: out.outputs })).catch((err) => send(res, err));
  });

  r.get("/runs", (req, res) => {
    void functionsStore.ready().then(() => res.json({ ok: true, runs: functionsStore.runs({ modelId: req.query.model ? String(req.query.model) : undefined, status: RUN_STATUSES.includes(String(req.query.status)) ? (String(req.query.status) as RunStatus) : undefined, limit: Math.min(Number(req.query.limit) || 100, 500) }) }));
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
