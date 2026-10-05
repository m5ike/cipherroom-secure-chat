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
import { EXACT_ROUTER } from "../exact-routing";
import { functionsStore } from "./store";
import { createPackage, deleteModel, deletePackage, exportPackage, importPackage, publishDraft, saveDraft, saveModel, PackageError, TEMPLATES, DRAFT } from "./packages";
import { answerRun, execute, exportedFunctions, functionsPublicUrl, runAdhoc, runErrorEndpoint, runEvents, RunRefused, type ExecuteResult } from "./runner";
import { argsToInputs, endpointOf, endpointsOf, entryOf, EVENT_FIELDS, eventInputs, fnOfEntry, newWebhookId } from "./endpoints";
import { checkFlow, compileFlow, parseFlow, FLOW_FILE, type Flow, type FlowError } from "./flow";
import { builtinCatalog, installBuiltin } from "./builtins";
import { modelRightNames } from "./visibility";
import type { Check, Needs } from "../access";
import { permits } from "../../client/src/lib/modules";
import { inputsOf, maskToken, newCallId, type ParsedBody } from "./webhook-log";
import { parseEntry, type Caller, type Endpoint, type EndpointType, type Model, type Run, type RunStatus, type WebhookCall } from "./types";

const RUN_STATUSES = ["queued", "running", "waiting", "done", "failed", "timed-out", "cancelled"];
import { ADM_SPEC, SDK_SPEC, sdkCompletions, sdkDts } from "./sdk-spec";
import { cronError } from "./cron";
import { tutorialLessons } from "./tutorial";
import { newId } from "./store";
import { sandboxGateStats, sandboxIsolation } from "./sandbox/pool";
import { isolationState } from "./sandbox/isolation";
import { layoutGroups } from "../layout-catalog";
import { switchState } from "../plugins/settings";
import { isRole, type AdminRole } from "../admin-users";

const actorOf = (res: Response): string => String(res.locals.adminName ?? "admin");
const roleOf = (res: Response): AdminRole => (isRole(res.locals.adminRole) ? res.locals.adminRole : "operator");
const consoleCaller = (res: Response): Caller => ({ kind: "console", account: "", name: actorOf(res), groups: ["owner", "operator"], room: null, client: "console", lang: "cs", tz: "UTC", adminRole: roleOf(res) });

function errorOf(err: unknown): { status: number; code: string; message: string } {
  if (err instanceof PackageError) return { status: err.code === "no-package" || err.code === "no-draft" || err.code === "no-model" ? 404 : err.code === "exists" || err.code === "in-use" ? 409 : err.code === "owner-only" ? 403 : 400, code: err.code, message: err.message };
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
function followLive(runId: string, work: Promise<{ run: unknown; outputs: unknown; handled?: { outputs: unknown[] } }>): void {
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
  // 5.3: a failure the error entry point answered shows its answer too.
  work.then((out) => finish({ runId, type: "result", ok: true, run: out.run, outputs: out.handled ? [...(out.outputs as unknown[]), ...out.handled.outputs] : out.outputs, handled: Boolean(out.handled) }))
    .catch((err) => { const e = errorOf(err); finish({ runId, type: "result", ok: false, code: e.code, message: e.message }); });
}

function safeIssues(raw: unknown) { try { return checkFlow(parseFlow(raw)); } catch { return []; } }

function overview(reveal: Reveal = () => true) {
  const store = functionsStore.status();
  return {
    ok: true as const,
    packages: functionsStore.packages().map((p) => ({ ...p, versions: functionsStore.versions(p.id).filter((v) => v.status === "published").map((v) => v.version), flow: Boolean(functionsStore.version(p.id, DRAFT)?.files[FLOW_FILE]) })),
    models: functionsStore.models().map((m) => modelView(m, reveal)),
    schedules: functionsStore.schedules(),
    templates: TEMPLATES.map((t) => ({ id: t.id, name: t.name, language: t.language, description: t.description })),
    groups: layoutGroups(),
    // 6.12: at rest (F-18), the sandbox isolation (F-03) and its slots (F-28).
    runtime: { persistent: store.persistent, reason: store.reason, encrypted: store.encrypted, warning: store.warning, isolation: isolationState(), sandboxes: sandboxGateStats() },
    sdk: SDK_SPEC.map((o) => o.name),
    stats: runStats(),
    // 5.2: the service itself — off, nothing runs from the chat, webhooks or the API.
    service: switchState("functions"),
  };
}

/** A webhook call's variables as paths: body.user.name, query.id, header.x-github-event (5.2). */
function flatVariables(call: WebhookCall): Array<{ path: string; value: string; type: string }> {
  const out: Array<{ path: string; value: string; type: string }> = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (out.length >= 400) return;
    if (v !== null && typeof v === "object" && depth < 8) {
      const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
      if (entries.length && !(v && typeof v === "object" && "$b" in (v as object))) { for (const [k, x] of entries) walk(x, path ? `${path}.${k}` : k, depth + 1); return; }
    }
    out.push({ path, value: typeof v === "string" ? v.slice(0, 500) : JSON.stringify(v)?.slice(0, 500) ?? "null", type: v === null ? "null" : Array.isArray(v) ? "array" : typeof v });
  };
  if (call.parsed) walk(call.parsed.value, "body", 0);
  walk(call.query, "query", 0);
  for (const [k, v] of Object.entries(call.headers)) out.push({ path: `header.${k}`, value: v, type: "string" });
  return out;
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
type EndpointView = Endpoint & { url?: string | null; hidden?: boolean; hasSecret?: boolean };
function modelView(m: Model, reveal: Reveal = () => true): Model & { entryOk: boolean; webhookUrl: string | null; secretsHidden?: boolean; endpoints: EndpointView[] } {
  const hookUrl = (ep: Endpoint) => (ep.enabled !== false && ep.token ? `${functionsPublicUrl()}/hooks/m/${m.id}/${ep.token}` : null);
  if (!reveal(m)) {
    // Without the right to change the model's webhooks: no token, secret or API token (a save keeps them).
    const ex = { ...m.executors };
    if (ex.webhook) { const { token: _t, secret: _s, ...w } = ex.webhook; ex.webhook = w; }
    if (ex.api) { const { token: _t, ...a } = ex.api; ex.api = a; }
    const endpoints = endpointsOf(m).map((ep) => { const { token: _t, secret: _s, ...rest } = ep; return { ...rest, ...(ep.type === "webhook" ? { url: null, hidden: Boolean(ep.token), hasSecret: Boolean(ep.secret) } : {}) }; });
    return { ...m, executors: ex, endpoints, entryOk: entryOk(m), webhookUrl: null, secretsHidden: true };
  }
  const endpoints = endpointsOf(m).map((ep) => (ep.type === "webhook" ? { ...ep, url: hookUrl(ep), hasSecret: Boolean(ep.secret) } : ep));
  const first = endpoints.find((e) => e.type === "webhook");
  return { ...m, endpoints, entryOk: entryOk(m), webhookUrl: first ? hookUrl(first) : null };
}

/** Whose eyes a model's webhook token, HMAC secret and API token are for: who may change its webhooks. */
type Reveal = (m: Model) => boolean;
function revealFor(res: Response): Reveal {
  if (String(res.locals.adminRole ?? "") === "auditor") return () => false;
  const c = res.locals.moduleRights as Check | undefined;
  if (!c) return () => true; // no module guard in front (tests, the main service's own use)
  return (m) => c.reason === "owner" || permits(c.rights, ["webhooks", "edit"], modelRightNames(m));
}

/**
 * 5.2: what a console request needs in the Functions module — reading: the
 * module; the webhook log and replays: "webhooks" (or "edit"); test runs:
 * "run" (or "edit"); publishing: "publish"; other changes: "edit" — and
 * the package or model it touches ("package:netkit", "model:dns*"), resolved
 * here, so a grant limited to some packages or models holds everywhere.
 * Inline code (tutorial, builder) and imports have no item: they need an
 * action the grant names.
 */
export function functionsConsoleRight(req: Request): Needs | null {
  const path = req.path;
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const read = req.method === "GET" || req.method === "HEAD";
  const id = (re: RegExp) => { const m = re.exec(path)?.[1]; return m ? decodeURIComponent(m) : ""; };
  const modelNames = (modelId: string): string[] => { const m = modelId ? functionsStore.model(modelId) : null; return m ? modelRightNames(m) : []; };
  const pkgNames = (pkgId: string): string[] => { const p = pkgId ? functionsStore.package(pkgId) : null; return p ? [`package:${p.name}`] : []; };
  const needs = (actions: string[], ...items: string[][]): Needs => [actions, ...items.filter((x) => x.length)];

  if (path.startsWith("/webhooks")) {
    if (read) return [["webhooks", "edit"]];
    const call = id(/^\/webhooks\/calls\/([^/]+)\/replay$/);
    if (call) return needs(["webhooks", "edit"], modelNames(functionsStore.webhookCall(call)?.modelId ?? ""));
    if (path === "/webhooks/calls") return needs(["webhooks", "edit"], modelNames(String(req.query.model ?? "")));
    // Switching a model's public URL on, its mode, auth or token: a change to the model.
    return needs(["edit"], modelNames(id(/^\/webhooks\/([^/]+)(?:\/[^/]+)?$/)));
  }
  if (read) return null;
  if (path === "/flow/compile") return null; // pure: turns a flow into code, runs nothing
  // 5.3: a click / form / reply in a console run's result — a run of that model (or draft).
  if (path === "/event") {
    const chain = functionsStore.chain(String(body.chain ?? ""));
    if (chain && chain.source.kind === "draft") return needs(["run", "edit"], pkgNames(chain.source.packageId));
    return needs(["run", "edit"], modelNames(chain?.modelId ?? ""));
  }
  if (path === "/run") {
    if (body.adhoc) return [["edit"]];
    const draft = body.draft as { packageId?: string } | undefined;
    if (draft) return needs(["run", "edit"], pkgNames(String(draft.packageId ?? "")));
    return needs(["run", "edit"], modelNames(String(body.modelId ?? "")));
  }
  const runId = id(/^\/runs\/([^/]+)\/answer$/);
  if (runId) { const run = functionsStore.run(runId); return run?.modelId ? needs(["run", "edit"], modelNames(run.modelId)) : [["run", "edit"]]; }
  if (path === "/schedules") return needs(["edit"], modelNames(String(body.modelId ?? "")));
  const sch = id(/^\/schedules\/([^/]+)/);
  if (sch) return needs(/\/run$/.test(path) ? ["run", "edit"] : ["edit"], modelNames(functionsStore.schedule(sch)?.modelId ?? ""));
  const builtin = id(/^\/builtins\/([^/]+)\/install$/);
  if (builtin) return needs(["edit"], [`package:${builtin}`]);
  if (path === "/packages") return needs(["edit"], typeof body.name === "string" && body.name ? [`package:${body.name}`] : []);
  if (path === "/packages/import") return [["edit"]];
  const pkg = id(/^\/packages\/([^/]+)/);
  if (pkg) return needs(/\/publish$/.test(path) ? ["publish"] : ["edit"], pkgNames(pkg));
  if (path === "/models" || path.startsWith("/models/")) {
    // The model as it is, and — for a save — what it becomes (keyword, package): both must be allowed.
    const current = modelNames(id(/^\/models\/([^/]+)/) || String(body.id ?? ""));
    if (req.method === "DELETE") return needs(["edit"], current);
    const entryPkg = typeof body.entry === "string" ? /^([^@]+)@/.exec(body.entry)?.[1] ?? "" : "";
    const next = [...(typeof body.keyword === "string" && body.keyword ? [`model:${body.keyword}`] : []), ...(entryPkg ? [`package:${entryPkg}`] : [])];
    return needs(["edit"], current, next);
  }
  return [["edit"]];
}

export function registerFunctionsAdminRoutes(app: Express): void {
  void functionsStore.ready(); // open the store at boot; hot paths await it too
  // 6.12 (F-03): decide how sandboxes are isolated now, so the overview says so before the first run.
  if (!process.env.VITEST) void sandboxIsolation().catch(() => undefined);
  const r = express.Router(EXACT_ROUTER);
  r.use(express.json({ limit: "8mb" }));

  const operator = (_req: Request, res: Response, next: NextFunction) => {
    if (res.locals.adminRole === "operator" || res.locals.adminRole === "owner") { next(); return; }
    res.status(403).json({ ok: false, message: `This needs the operator role; you are ${String(res.locals.adminRole ?? "not signed in")}.` });
  };

  r.get("/", (_req, res) => { void functionsStore.ready().then(() => res.json(overview(revealFor(res)))); });
  r.get("/sdk", (_req, res) => res.json({ ok: true, spec: SDK_SPEC, adm: ADM_SPEC, completions: sdkCompletions(), dts: sdkDts() }));
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
    res.json({ ok: true, model: modelView(model, revealFor(res)) });
  });
  r.post("/models", operator, (req, res) => {
    try { res.json({ ok: true, model: modelView(saveModel(req.body ?? {}, actorOf(res), roleOf(res)), revealFor(res)) }); }
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
      const file = String(draft.file || version.manifest.main);
      // 5.3: a click or a form in the result runs the draft's function of that name.
      return void done(runAdhoc({ lang: pkg.language, files: version.files, deps, entry: { file, fn: String(draft.fn || "execute") }, inputs, limits: req.body.limits, runId, source: { packageId: pkg.id, file } }, caller));
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

  /* -------- entry points (5.3) -------- */

  // The functions a package version exports, per file (the entry point pickers).
  r.get("/exports", (req, res) => {
    const name = String(req.query.package ?? ""), version = String(req.query.version ?? "");
    const pkg = functionsStore.packageByName(name);
    const v = pkg ? functionsStore.version(pkg.id, version || DRAFT) : null;
    if (!pkg || !v) return res.status(404).json({ ok: false, message: "No such package version." });
    const files: Record<string, string[]> = {};
    for (const [file, text] of Object.entries(v.files)) if (/\.(m?js|py)$/.test(file) && !file.startsWith("tests/")) files[file] = exportedFunctions(pkg.language, text);
    res.json({ ok: true, package: name, version: v.version, language: pkg.language, main: v.manifest.main, files, fields: EVENT_FIELDS });
  });

  // A model's processing sessions (m5.model): the recent ones, or one with its calls.
  r.get("/chains", (req, res) => {
    const id = String(req.query.id ?? "");
    if (id) { const c = functionsStore.chain(id); return c ? res.json({ ok: true, chain: c }) : res.status(404).json({ ok: false, message: "No such processing session." }); }
    res.json({ ok: true, chains: functionsStore.chains(String(req.query.model ?? ""), Number(req.query.limit) || 30).map((c) => ({ id: c.id, modelId: c.modelId, calls: c.calls.length, types: c.calls.map((x) => x.type), last: c.calls.at(-1)?.status ?? "", createdAt: c.createdAt, updatedAt: c.updatedAt })) });
  });

  // 5.3: a click, a submitted form or a reply in a console run's result (a model's, or a draft's), or a
  // browser error — the entry point of that type runs in the same processing session; { live } streams it.
  r.post("/event", operator, (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const chain = functionsStore.chain(String(b.chain ?? ""));
    if (!chain) return res.status(410).json({ ok: false, code: "expired", message: "That processing session is over — run it again." });
    const type = String(b.type ?? "") as EndpointType;
    if (!["response", "button", "form", "error"].includes(type)) return res.status(400).json({ ok: false, message: "type: response, button, form or error." });
    const caller = consoleCaller(res);
    const origin = chain.calls[Number.isInteger(b.call) ? Number(b.call) : chain.calls.length - 1] ?? chain.calls.at(-1);
    const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
    const event = { type: type === "response" ? "reply" : b.source === "js" ? "js" : type === "button" ? "click" : type === "form" ? "submit" : "error", at: Date.now(), by: caller.name, console: true };
    const e = (b.error && typeof b.error === "object" ? b.error : {}) as Record<string, unknown>;
    const system = (ep: Endpoint | null): { source: Record<string, unknown>; sys: Record<string, unknown> } => {
      if (type === "response") { const text = str(b.text, 16_000); return { source: ep ? argsToInputs(ep.inputs, text) : {}, sys: { text, message: { text: str((b.message as { text?: unknown } | undefined)?.text, 2000), call: origin?.id ?? 0 }, event } }; }
      if (type === "button") { const data = b.data === undefined ? null : b.data; return { source: data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {}, sys: { name: str(b.name, 64), data, event } }; }
      if (type === "form") { const values = b.values && typeof b.values === "object" && !Array.isArray(b.values) ? b.values as Record<string, unknown> : {}; return { source: values, sys: { name: str(b.name, 64), values, event } }; }
      return { source: {}, sys: { error: { type: str(e.type, 60) || "RenderError", message: str(e.message, 2000) }, failed: { call: origin?.id ?? 0, type: origin?.type ?? "execute", parms: origin?.parms ?? {}, ...(typeof b.output === "number" ? { output: b.output } : {}) }, source: "client" } };
    };
    const live = b.live === true && type !== "error";
    const runId = newId("run");
    let work: Promise<ExecuteResult>;
    try {
      if (chain.source.kind === "draft") {
        // A draft: its function of that name (button, form, response, error).
        const src = chain.source;
        const { sys } = system(null);
        if (!src.packageId && src.inline) {
          // Inline code (the tutorial, the builder): its function of that name.
          work = runAdhoc({ lang: src.inline.lang, files: src.inline.files, entry: { file: src.file, fn: type }, inputs: sys, runId, chainId: chain.id, type }, caller);
          if (!live) return void work.then((out) => res.json({ ok: true, run: out.run, outputs: out.handled ? [...out.outputs, ...out.handled.outputs] : out.outputs, chain: out.chain, call: out.call })).catch((err) => send(res, err));
          followLive(runId, work as never);
          return res.json({ ok: true, runId });
        }
        const pkg = functionsStore.package(src.packageId);
        const draft = pkg ? functionsStore.version(pkg.id, DRAFT) : null;
        if (!pkg || !draft) return res.status(409).json({ ok: false, message: "This code is not in a package any more — run it again." });
        const file = src.file || draft.manifest.main;
        const deps: Record<string, { version: string; main: string; files: Record<string, string> }> = {};
        for (const [name, ver] of Object.entries(draft.manifest.dependencies ?? {})) { const dv = functionsStore.versionByName(name, ver); if (dv) deps[name] = { version: ver, main: dv.manifest.main, files: dv.files }; }
        work = runAdhoc({ lang: pkg.language, files: draft.files, deps, entry: { file, fn: type }, inputs: sys, runId, source: { packageId: pkg.id, file }, chainId: chain.id, type }, caller);
      } else {
        const model = functionsStore.model(chain.modelId);
        if (!model) return res.status(404).json({ ok: false, message: "The model is gone." });
        const ep = endpointOf(model, type);
        if (type === "error") {
          if (!ep) return res.json({ ok: true, outputs: [], message: "The model has no error entry point." });
          work = runErrorEndpoint(model, ep, chain.id, system(ep).sys as never, caller, { executor: "console", test: true }).then((h) => { if (!h) throw new RunRefused("error-endpoint", "The error entry point could not run."); return { run: h.run, outputs: h.outputs, value: null, values: [], result: null, chain: chain.id, call: h.run.callId ?? 0 }; });
        } else {
          if (!ep) return res.status(404).json({ ok: false, code: "no-endpoint", message: `The model has no ${type} entry point.` });
          const { source, sys } = system(ep);
          work = execute(model, eventInputs(ep, source, sys), caller, { executor: "console", test: true, endpoint: ep, chainId: chain.id, skipValidation: true, runId });
        }
      }
    } catch (err) { return send(res, err); }
    if (!live) return void work.then((out) => res.json({ ok: true, run: out.run, outputs: out.handled ? [...out.outputs, ...out.handled.outputs] : out.outputs, chain: out.chain, call: out.call })).catch((err) => send(res, err));
    followLive(runId, work as never);
    res.json({ ok: true, runId });
  });

  /* -------- built-in packages (5.2): /help and the demos -------- */
  r.get("/builtins", (_req, res) => { void functionsStore.ready().then(() => res.json({ ok: true, builtins: builtinCatalog() })); });
  r.post("/builtins/:name/install", operator, (req, res) => {
    try { res.json({ ok: true, results: installBuiltin(String(req.params.name), actorOf(res)), builtins: builtinCatalog() }); }
    catch (err) { send(res, err); }
  });

  /* -------- webhooks (5.2): the list, the log, replay and debugging -------- */
  r.get("/webhooks", (_req, res) => {
    const reveal = revealFor(res);
    void functionsStore.ready().then(() => {
      const stats = new Map(functionsStore.webhookStats().map((x) => [x.modelId, x]));
      const byHook = new Map(functionsStore.webhookHookStats().map((x) => [`${x.modelId}\0${x.hook}`, x]));
      // 5.3: one row per webhook entry point; a model without one gets a row to create it.
      const endpoints = functionsStore.models().flatMap((m) => {
        const hooks = endpointsOf(m).filter((e) => e.type === "webhook");
        const row = (h: Endpoint | null) => ({
          modelId: m.id, endpoint: h?.id ?? null, hookName: h?.name ?? "", name: m.name, keyword: m.keyword, modelEnabled: m.enabled, enabled: Boolean(h && h.enabled !== false && h.token),
          url: h && h.enabled !== false && h.token && reveal(m) ? `${functionsPublicUrl()}/hooks/m/${m.id}/${h.token}` : null, hidden: Boolean(h && h.enabled !== false && h.token && !reveal(m)),
          mode: h?.mode ?? "sync", auth: h?.auth ?? "none", callback: Boolean(h?.callback), log: h?.log ?? "full", entry: h ? entryOf(m, h) : m.entry, fn: h?.fn ?? "", inputs: h ? h.inputs : m.inputs,
          stats: h?.token ? byHook.get(`${m.id}\0${maskToken(h.token)}`) ?? null : hooks.length ? null : stats.get(m.id) ?? null,
        });
        return hooks.length ? hooks.map(row) : [row(null)];
      });
      const durable = functionsStore.durableWebhooks().map((w) => ({ hook: maskToken(w.token), modelId: w.modelId, entry: w.entry, once: w.once, expiresAt: w.expiresAt, createdAt: w.createdAt, caller: w.caller?.name ?? "" }));
      res.json({ ok: true, publicUrl: functionsPublicUrl(), autoWaitMs: Number(process.env.WEBHOOK_AUTO_WAIT_MS) || 25_000, endpoints, durable, other: stats.get("") ?? null });
    });
  });
  r.get("/webhooks/calls", (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    res.json({ ok: true, calls: functionsStore.webhookCalls({ modelId: q.model || undefined, kind: q.kind || undefined, status: q.status === "ok" || q.status === "error" ? q.status : undefined, limit: Number(q.limit) || 100, before: Number(q.before) || undefined }).map((c) => ({ ...c, body: c.body.slice(0, 300), responseBody: c.responseBody.slice(0, 300), parsed: c.parsed ? { kind: c.parsed.kind } : null })) });
  });
  r.get("/webhooks/calls/:id", (req, res) => {
    const call = functionsStore.webhookCall(String(req.params.id));
    if (!call) return res.status(404).json({ ok: false, message: "No such webhook call." });
    const model = call.modelId ? functionsStore.model(call.modelId) : null;
    const pkg = model ? parseEntry(model.entry)?.pkg ?? "" : "";
    res.json({ ok: true, call, variables: flatVariables(call), model: model ? { id: model.id, name: model.name, keyword: model.keyword, entry: model.entry, packageId: pkg ? functionsStore.packageByName(pkg)?.id ?? null : null } : null, run: call.runId ? functionsStore.run(call.runId) : null, logs: call.runId ? functionsStore.logs(call.runId).slice(0, 500) : [] });
  });
  r.delete("/webhooks/calls", operator, (req, res) => {
    res.json({ ok: true, deleted: functionsStore.deleteWebhookCalls(req.query.model ? String(req.query.model) : undefined) });
  });
  // A webhook entry point's settings — `endpoint` names it (default: the first; `create: true` adds one,
  // running `fn` or the execute function).
  r.put("/webhooks/:modelId", operator, (req, res) => {
    const m = functionsStore.model(String(req.params.modelId));
    if (!m) return res.status(404).json({ ok: false, message: "No such model." });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const eps = endpointsOf(m).map((e) => ({ ...e }));
    let hook = b.create === true ? null : eps.find((e) => e.type === "webhook" && (typeof b.endpoint !== "string" || e.id === b.endpoint)) ?? null;
    if (!hook) {
      if (typeof b.endpoint === "string" && b.create !== true) return res.status(404).json({ ok: false, message: "No such webhook entry point." });
      const exec = eps.find((e) => e.type === "execute");
      hook = { id: newWebhookId(), type: "webhook", name: typeof b.name === "string" && b.name ? b.name : `Webhook ${eps.filter((e) => e.type === "webhook").length + 1}`, fn: typeof b.fn === "string" && b.fn ? b.fn : exec?.fn ?? fnOfEntry(m.entry), inputs: [], enabled: false };
      eps.push(hook);
    }
    Object.assign(hook, {
      ...(typeof b.enabled === "boolean" ? { enabled: b.enabled } : {}), ...(b.mode === "sync" || b.mode === "async" || b.mode === "auto" ? { mode: b.mode } : {}),
      ...(typeof b.callback === "boolean" ? { callback: b.callback } : {}), ...(b.log === "full" || b.log === "meta" || b.log === "off" ? { log: b.log } : {}),
      ...(b.auth === "none" || b.auth === "hmac" ? { auth: b.auth } : {}), ...(typeof b.secret === "string" && b.secret ? { secret: b.secret.slice(0, 200) } : {}),
      ...(typeof b.name === "string" && b.name.trim() ? { name: b.name.trim() } : {}), ...(typeof b.fn === "string" && b.fn ? { fn: b.fn } : {}),
      ...(b.rotate === true ? { token: "rotate" } : {}),
    });
    try { res.json({ ok: true, endpoint: hook.id, model: modelView(saveModel({ id: m.id, endpoints: eps }, actorOf(res), roleOf(res)), revealFor(res)) }); }
    catch (err) { send(res, err); }
  });
  r.delete("/webhooks/:modelId/:endpoint", operator, (req, res) => {
    const m = functionsStore.model(String(req.params.modelId));
    if (!m) return res.status(404).json({ ok: false, message: "No such model." });
    const eps = endpointsOf(m).filter((e) => !(e.type === "webhook" && e.id === req.params.endpoint));
    try { res.json({ ok: true, model: modelView(saveModel({ id: m.id, endpoints: eps }, actorOf(res), roleOf(res)), revealFor(res)) }); }
    catch (err) { send(res, err); }
  });
  // Replays a logged call — on the published version, or on the package's draft (to debug the script) — as a live run.
  r.post("/webhooks/calls/:id/replay", operator, (req, res) => {
    const call = functionsStore.webhookCall(String(req.params.id));
    if (!call) return res.status(404).json({ ok: false, message: "No such webhook call." });
    const model = call.modelId ? functionsStore.model(call.modelId) : null;
    if (!model) return res.status(404).json({ ok: false, message: "The call has no model to replay on." });
    // A run's own webhook or a durable one goes to a waiting run / on_event, not to the model's entry.
    if (call.kind !== "model" && call.kind !== "replay") return res.status(409).json({ ok: false, message: "Only calls of a model's webhook can be replayed (this one went to a run's own or a durable webhook)." });
    if (call.parsed?.kind === "binary") return res.status(409).json({ ok: false, message: "The log keeps only the size of a binary body — nothing to replay." });
    if (!call.parsed || (call.parsed.value === null && call.parsed.kind !== "empty")) return res.status(409).json({ ok: false, message: "The log kept no body for this call (log: meta) — nothing to replay." });
    const target = (req.body ?? {}).target === "draft" ? "draft" : "published";
    // 5.3: the webhook entry point the call came through (its masked token), else the first.
    const hooks = endpointsOf(model).filter((e) => e.type === "webhook");
    const hookEp = hooks.find((e) => e.token && maskToken(e.token) === call.hook) ?? hooks[0] ?? null;
    const inputs = { ...inputsOf({ kind: call.parsed.kind as ParsedBody["kind"], value: call.parsed.value }, call.query), _webhook: { method: call.method, headers: call.headers, query: call.query, replayOf: call.id, ...(hookEp ? { endpoint: hookEp.id, name: hookEp.name ?? "" } : {}) } };
    const caller: Caller = { kind: "webhook", account: "", name: `replay by ${actorOf(res)}`, groups: [], room: null, client: "console", lang: "en", tz: "UTC" };
    const runId = newId("run");
    let work: Promise<{ run: Run; outputs: unknown; value: unknown }>;
    if (target === "draft") {
      const entry = parseEntry(model.entry);
      const pkg = entry ? functionsStore.packageByName(entry.pkg) : null;
      const draft = pkg ? functionsStore.version(pkg.id, DRAFT) : null;
      if (!entry || !pkg || !draft) return res.status(404).json({ ok: false, message: "The model's package has no draft." });
      const deps: Record<string, { version: string; main: string; files: Record<string, string> }> = {};
      for (const [name, ver] of Object.entries(draft.manifest.dependencies ?? {})) { const dv = functionsStore.versionByName(name, ver); if (dv) deps[name] = { version: ver, main: dv.manifest.main, files: dv.files }; }
      const [file, fn] = (hookEp?.fn ?? `${entry.file}#${entry.fn}`).split("#");
      work = runAdhoc({ lang: pkg.language, files: draft.files, deps, entry: { file, fn }, inputs, runId, limits: model.limits, source: { packageId: pkg.id, file }, type: "webhook" }, caller) as never;
    } else {
      work = execute(model, inputs, caller, { executor: "webhook", test: true, skipValidation: true, runId, ...(hookEp ? { endpoint: hookEp } : {}) }) as never;
    }
    const rec: WebhookCall = { ...call, id: newCallId(), at: Date.now(), kind: "replay", replayOf: call.id, runId, status: 0, responseBody: "", responseHeaders: {}, result: null, ms: 0, error: "", path: `${call.path} (replay: ${target})` };
    functionsStore.addWebhookCall(rec);
    work.then((out) => {
      rec.status = out.run.status === "done" ? 200 : 500;
      rec.responseBody = JSON.stringify({ ok: out.run.status === "done", runId, status: out.run.status, outputs: out.outputs, error: out.run.error }).slice(0, 256 * 1024);
      rec.ms = Date.now() - rec.at;
      if (out.run.status !== "done") rec.error = String(out.run.error?.message ?? out.run.status).slice(0, 500);
      functionsStore.addWebhookCall(rec);
    }).catch((err) => { rec.status = 500; rec.error = (err as Error).message; rec.ms = Date.now() - rec.at; functionsStore.addWebhookCall(rec); });
    followLive(runId, work);
    res.json({ ok: true, runId, target, replay: rec.id });
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
