// The app's Functions endpoints (4.15): the chat commands a user may run, and
// running one. Like a messenger's bots — a caller types "/keyword args", the
// client sends it here, the server runs the model in a sandbox process and
// returns the outputs; the client then shows them and, if the model's chat
// visibility is "room", encrypts them into the room as a function-output
// message. The server never reads the room: it gets only what the client
// sends (the command and its arguments), never the conversation.
//
//   GET  /api/functions/commands   the "/keyword" commands this caller may use
//                                  (name, summary, input schema, where it runs)
//   POST /api/functions/run        { keyword|model, inputs, room?, client?, stream? }
//                                  stream: SSE progress / log / output / done / error

import express, { type Express, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { createHmac, timingSafeEqual } from "node:crypto";
import { answerRun, deliverWebhook, endInteractionsFor, execute, functionsPublicUrl, openInteractions, runEvents, triggerDurableWebhook, RunRefused } from "./runner";
import { callRecord, callbackOf, clientIp, inputsOf, LOG_BODY_MAX, maskPath, maskToken, postCallback } from "./webhook-log";
import { accessLog } from "../access-log";
import { startScheduler } from "./scheduler";
import { functionsStore, newId } from "./store";
import { validateInputs } from "./inputs";
import { type Caller, type Model } from "./types";
import { switchState } from "../plugins/settings";
import { accountStore, usernameOf } from "../accounts/store";
import { clientConfigStore } from "../client-config";
import { groupsFor } from "../../client/src/lib/modules";
import { checkAccess, userSubject, type Check, type Needs } from "../access";
import { modelVisible, runNeeds } from "./visibility";
import { seedBuiltins } from "./builtins";

/** Auto mode: how long a webhook waits for the run before answering 202. */
const AUTO_WAIT_MS = Math.max(1000, Number(process.env.WEBHOOK_AUTO_WAIT_MS) || 25_000);

const limiter = rateLimit({ windowMs: 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false, message: { ok: false, code: "rate", message: "Too many function calls; slow down." } });

/** Who calls: their account and groups from the bearer token, the room and
 *  client they name (opaque ids — the server does not read the room). */
export function callerOf(req: Request): Caller {
  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const account = token ? accountStore.resolveToken(token) : null;
  const username = account ? usernameOf(account) : null;
  const body = (req.body || {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);
  return {
    kind: username ? "user" : "guest",
    account: account?.id ?? "",
    name: username ?? "guest",
    groups: groupsFor(clientConfigStore.get().groups, username),
    room: str(body.room, 200),
    client: str(body.client, 200),
    lang: str(body.lang, 8) || "en",
    tz: str(body.tz, 60) || "UTC",
  };
}

/** May this caller run this model from chat? Its own groups, and (5.2) the Functions module's rights. */
function allowed(model: Model, caller: Caller, access?: Check): boolean {
  return modelVisible(model, caller, access ?? null);
}

/** The caller's access to the Functions module (one logged decision per request). */
function moduleAccess(req: Request, caller: Caller, right?: Needs, log = true): Check {
  const subject = caller.kind === "user" || caller.kind === "guest" ? userSubject(caller.kind === "user" ? caller.name : null) : { kind: caller.kind as "webhook", name: caller.kind, groups: [] as string[] };
  return checkAccess("functions", subject, { right, path: `${req.method} ${req.path}`, ip: (req.ip || "").replace(/^::ffff:/, ""), via: "app", log });
}

function commandView(model: Model, caller: Caller) {
  return {
    keyword: model.keyword,
    name: model.name,
    summary: model.summary,
    runtime: model.runtime,
    visibility: model.executors.chat.visibility,
    mine: model.groups.length === 0 || model.groups.some((g) => caller.groups.includes(g)),
    inputs: model.inputs.map((i) => ({ name: i.name, type: i.type, label: i.label, help: i.help, required: Boolean(i.required), default: i.default, values: i.values })),
  };
}

function errorOf(err: unknown): { status: number; code: string; message: string } {
  if (err instanceof RunRefused) return { status: err.code === "bad-input" ? 400 : 422, code: err.code, message: err.message };
  return { status: 500, code: "error", message: "The function could not run." };
}

export function registerFunctionsRoutes(app: Express): void {
  // Open the store at boot so the first request does not race it (an unopened
  // store answers from its empty in-memory fallback).
  void functionsStore.ready();
  // 5.2: /help and the demo commands, installed once (not in tests).
  if (!process.env.VITEST || process.env.FUNCTIONS_BUILTINS === "1") void seedBuiltins("system").catch((err) => console.warn(`[functions] built-in packages: ${(err as Error).message}`));
  // The cron scheduler runs only here (the main service), so a schedule fires once.
  startScheduler();

  app.get("/api/functions/commands", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const on = switchState("functions").enabled;
    if (!on) return res.json({ ok: true, enabled: false, commands: [] });
    await functionsStore.ready();
    const caller = callerOf(req);
    // The list is polled every minute: not an access to log (a run is).
    const access = moduleAccess(req, caller, undefined, false);
    if (!access.allowed) return res.json({ ok: true, enabled: false, reason: "module", commands: [] });
    const commands = functionsStore.models()
      .filter((m) => m.keyword && allowed(m, caller, access))
      .map((m) => commandView(m, caller));
    res.json({ ok: true, enabled: true, commands });
  });

  app.post("/api/functions/run", limiter, express.json({ limit: "1mb" }), async (req: Request, res: Response) => {
    if (!switchState("functions").enabled) return res.status(404).json({ ok: false, code: "off", message: "The functions module is off." });
    await functionsStore.ready();
    const body = (req.body || {}) as Record<string, unknown>;
    const caller = callerOf(req);
    const model = typeof body.model === "string" ? functionsStore.model(body.model)
      : typeof body.keyword === "string" ? functionsStore.modelByKeyword(body.keyword.replace(/^\//, "")) : null;
    const access = model ? moduleAccess(req, caller, runNeeds(model)) : null;
    if (!model || !access?.allowed || !allowed(model, caller, access)) return res.status(404).json({ ok: false, code: "no-command", message: "No such command, or it is not available to you." });
    const inputs = (body.inputs && typeof body.inputs === "object" ? body.inputs : {}) as Record<string, unknown>;

    if (body.stream !== true) {
      try {
        const out = await execute(model, inputs, caller, { executor: "chat" });
        return res.json({ ok: true, runId: out.run.id, status: out.run.status, outputs: out.outputs, error: out.run.error, ms: out.run.ms, visibility: model.executors.chat.visibility });
      } catch (err) {
        const e = errorOf(err);
        return res.status(e.status).json({ ok: false, code: e.code, message: e.message });
      }
    }

    // Streaming: the run's progress, outputs and — the point of it — its live
    // questions (m5.prompt / m5.form) arrive as they happen, and the caller
    // answers them via POST /runs/:id/events. The runId is known up front so
    // the caller can subscribe and answer before the run finishes.
    const runId = newId("run");
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    const sse = (event: string, data: unknown) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const keepAlive = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 15_000);
    const onRun = (ev: Record<string, unknown>) => {
      if (ev.runId !== runId) return;
      if (ev.type === "output") sse("output", ev.output);
      else if (ev.type === "progress") sse("progress", ev);
      else if (ev.type === "interaction") sse("interaction", { runId, ...(ev.interaction as object) });
      else if (ev.type === "log") sse("log", ev);
    };
    runEvents.on("run", onRun);
    // If the caller goes away, cancel the questions so the function stops waiting.
    req.on("close", () => { runEvents.off("run", onRun); clearInterval(keepAlive); endInteractionsFor(runId); });
    try {
      validateInputs(model.inputs, inputs); // a bad argument is a clean error, not a stream
      sse("start", { runId, keyword: model.keyword, name: model.name, visibility: model.executors.chat.visibility });
      const out = await execute(model, inputs, caller, { executor: "chat", runId });
      sse("done", { runId: out.run.id, status: out.run.status, outputs: out.outputs, error: out.run.error, ms: out.run.ms, visibility: model.executors.chat.visibility });
    } catch (err) {
      const e = errorOf(err);
      sse("error", { code: e.code, message: e.message });
    } finally {
      runEvents.off("run", onRun);
      clearInterval(keepAlive);
      res.end();
    }
  });

  // Programmatic API: run a model with its API bearer token, get outputs as JSON.
  app.post("/api/functions/call/:id", limiter, express.json({ limit: "1mb" }), async (req: Request, res: Response) => {
    if (!switchState("functions").enabled) return res.status(404).json({ ok: false, code: "off", message: "The functions module is off." });
    await functionsStore.ready();
    const model = functionsStore.model(String(req.params.id));
    const api = model?.executors.api;
    if (!model || !model.enabled || !api?.enabled || !api.token) return res.status(404).json({ ok: false, message: "No such API function." });
    const header = req.header("authorization") || "";
    const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const apiLog = (decision: "allow" | "deny", reason: string) => accessLog.record({ at: Date.now(), module: "functions", subject: "api", kind: "api", decision, reason, right: `model:${model.keyword || model.id}`, path: `${req.method} ${req.path}`, ip: clientIp(req), via: "app" });
    if (given.length !== api.token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(api.token))) { apiLog("deny", "wrong token"); return res.status(401).json({ ok: false, message: "Wrong or missing API token." }); }
    // 5.2: the module switched off in Modules & groups stops the API too (not only the chat and webhooks).
    if (clientConfigStore.get().modules.functions?.enabled === false) { apiLog("deny", "off"); return res.status(403).json({ ok: false, code: "module-disabled", message: "The Functions module is off." }); }
    apiLog("allow", "token");
    const inputs = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const caller: Caller = { kind: "api", account: "", name: "api", groups: [], room: null, client: "api", lang: "en", tz: "UTC" };
    try {
      const out = await execute(model, inputs, caller, { executor: "api", skipValidation: true });
      res.status(out.run.status === "done" ? 200 : 500).json({ ok: out.run.status === "done", runId: out.run.id, status: out.run.status, outputs: out.outputs, error: out.run.error });
    } catch (err) { const e = errorOf(err); res.status(e.status).json({ ok: false, code: e.code, message: e.message }); }
  });

  // Answer a live question (m5.prompt / m5.form) of a running command.
  app.post("/api/functions/runs/:id/events", limiter, express.json({ limit: "256kb" }), (req: Request, res: Response) => {
    if (!switchState("functions").enabled) return res.status(404).json({ ok: false, code: "off", message: "The functions module is off." });
    const body = (req.body || {}) as Record<string, unknown>;
    const interactionId = typeof body.interactionId === "string" ? body.interactionId : "";
    if (!interactionId) return res.status(400).json({ ok: false, message: "interactionId required." });
    const ok = answerRun(String(req.params.id), interactionId, body.value ?? null);
    if (!ok) return res.status(409).json({ ok: false, code: "no-question", message: "That question is not open (already answered, or timed out)." });
    res.json({ ok: true });
  });

  /* ---------------------------------------------------------- webhooks (5.2: logged, async, replayable) */

  const hookLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false, message: { ok: false, message: "Too many webhook calls." } });
  const hookBody = express.raw({ type: () => true, limit: "5mb" });
  const rawOf = (req: Request): Buffer => (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
  // What a function sees of the request: signatures stay (it may check one itself); credentials do not.
  const hookMeta = (req: Request) => ({ method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !/^(authorization|cookie|proxy-authorization)$/i.test(k))) as Record<string, unknown>, query: req.query as Record<string, unknown> });
  type Call = ReturnType<typeof callRecord>;
  const strip = (c: Call) => { const { raw: _r, parsedBody: _p, logMode: _l, ...rest } = c; return rest; };
  // log: meta — the answer's shape without the outputs.
  const summaryOf = (body: unknown) => { const b = (body ?? {}) as { ok?: unknown; runId?: unknown; status?: unknown; error?: { message?: unknown } | null; message?: unknown }; return { ok: b.ok, runId: b.runId, status: b.status, ...(b.error ? { error: b.error.message } : {}), ...(b.message ? { message: b.message } : {}) }; };
  const answer = (c: Call, res: Response, status: number, body: unknown, log: boolean) => {
    c.status = status;
    c.responseHeaders = { "content-type": "application/json; charset=utf-8" };
    // The log never keeps the token itself (a 202 carries it in statusUrl); log: meta keeps no outputs.
    const token = String(res.req?.params?.token ?? "");
    const text = c.logMode === "full" ? JSON.stringify(body) : JSON.stringify(summaryOf(body));
    c.responseBody = (token ? text.split(token).join(maskToken(token)) : text).slice(0, LOG_BODY_MAX);
    c.ms = Date.now() - c.at;
    const b = body as { ok?: boolean; message?: string; error?: { message?: string } | null };
    if (b?.ok === false) c.error = String(b.error?.message ?? b.message ?? "failed").slice(0, 500);
    if (log) functionsStore.addWebhookCall(strip(c));
    if (!res.headersSent) res.status(status).json(body);
  };
  const moduleOn = () => clientConfigStore.get().modules.functions?.enabled !== false;
  const logAccess = (model: string, decision: "allow" | "deny", reason: string, req: Request) =>
    accessLog.record({ at: Date.now(), module: "functions", subject: "webhook", kind: "webhook", decision, reason, right: model ? `model:${model}` : undefined, path: `${req.method} ${maskPath(req.path, String(req.params.token ?? ""))}`, ip: clientIp(req), via: "app" });

  // A run waiting on m5.webhook.wait(), or a durable webhook (the model's on_event).
  app.post("/hooks/r/:token", hookLimiter, hookBody, async (req: Request, res: Response) => {
    if (!switchState("functions").enabled || !moduleOn()) return res.status(404).json({ ok: false });
    const token = String(req.params.token);
    const durable = functionsStore.webhook(token);
    // A durable webhook follows its model's log setting; a run's own webhook is logged in full.
    const logMode = (durable ? functionsStore.model(durable.modelId)?.executors.webhook?.log : undefined) ?? "full";
    const call = callRecord(req, durable ? "durable" : "run", durable?.modelId ?? "", token, rawOf(req), logMode);
    const log = logMode !== "off";
    const parsed = call.parsedBody;
    const body = parsed.kind === "json" || parsed.kind === "form" || parsed.kind === "multipart" ? parsed.value : call.raw.toString("utf8");
    const payload = { body, text: call.raw.toString("utf8"), kind: parsed.kind, ...hookMeta(req) };
    if (deliverWebhook(token, payload)) { logAccess(durable?.modelId ?? "", "allow", "run webhook", req); return answer(call, res, 200, { ok: true, delivered: "live" }, log); }
    const fired = await triggerDurableWebhook(token, payload);
    if (!fired) return answer(call, res, 404, { ok: false, message: "No run is waiting on that webhook, and it is not a durable one." }, Boolean(durable) && log);
    logAccess(durable?.modelId ?? "", "allow", "durable webhook", req);
    answer(call, res, 200, { ok: true, delivered: "on_event" }, log);
  });

  /** The model and its webhook, when the token matches. */
  const hookModel = (req: Request): { model: Model; hook: NonNullable<Model["executors"]["webhook"]> } | { status: number; message: string } => {
    const model = functionsStore.model(String(req.params.modelId));
    const hook = model?.executors.webhook;
    if (!model || !model.enabled || !hook?.enabled || !hook.token) return { status: 404, message: "No such webhook." };
    const given = String(req.params.token);
    if (given.length !== hook.token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(hook.token))) return { status: 403, message: "Wrong webhook token." };
    return { model, hook };
  };

  // A model reachable as a webhook: run it with the payload (JSON, a form, multipart, text).
  app.all("/hooks/m/:modelId/:token", hookLimiter, hookBody, async (req: Request, res: Response) => {
    if (!switchState("functions").enabled) return res.status(404).json({ ok: false });
    await functionsStore.ready();
    const found = hookModel(req);
    const known = functionsStore.model(String(req.params.modelId));
    const logMode = known?.executors.webhook?.log ?? "full";
    const call = callRecord(req, "model", known?.id ?? "", String(req.params.token), rawOf(req), logMode);
    const log = Boolean(known) && logMode !== "off";
    if (!["POST", "PUT", "PATCH", "GET"].includes(req.method)) return answer(call, res, 405, { ok: false, message: "Use POST (or PUT, PATCH, GET)." }, log);
    if ("status" in found) { if (known) logAccess(known.keyword || known.id, "deny", found.status === 403 ? "wrong token" : "webhook off", req); return answer(call, res, found.status, { ok: false, message: found.message }, log); }
    const { model, hook } = found;
    if (!moduleOn()) { logAccess(model.keyword || model.id, "deny", "off", req); return answer(call, res, 403, { ok: false, code: "module-disabled", message: "The Functions module is off." }, log); }
    if (hook.auth === "hmac" && hook.secret) {
      const sig = String(req.headers["x-signature"] || req.headers["x-hub-signature-256"] || "").replace(/^sha256=/, "");
      const mac = createHmac("sha256", hook.secret).update(call.raw).digest("hex");
      if (sig.length !== mac.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(mac))) { logAccess(model.keyword || model.id, "deny", "bad signature", req); return answer(call, res, 403, { ok: false, message: "Bad signature." }, log); }
    }
    logAccess(model.keyword || model.id, "allow", "token", req);
    const inputs = { ...inputsOf(call.parsedBody, req.query as Record<string, unknown>), _webhook: hookMeta(req) };
    const caller: Caller = { kind: "webhook", account: "", name: "webhook", groups: [], room: null, client: "webhook", lang: "en", tz: "UTC" };
    const runId = newId("run");
    call.runId = runId;
    const mode = req.query.wait === "1" ? "sync" : req.query.wait === "0" ? "async" : hook.mode ?? "sync";
    const callback = hook.callback ? callbackOf(req) : "";
    const statusUrl = `${functionsPublicUrl()}/hooks/m/${model.id}/${hook.token}/runs/${runId}`;
    const resultOf = (out: { run: { status: string; error: unknown; ms: number }; outputs: unknown }) => ({ ok: out.run.status === "done", runId, status: out.run.status, outputs: out.outputs, error: out.run.error });
    const work = execute(model, inputs, caller, { executor: "webhook", skipValidation: true, runId });

    if (mode === "sync") {
      try { const out = await work; answer(call, res, out.run.status === "done" ? 200 : 500, resultOf(out), log); }
      catch (err) { const e = errorOf(err); answer(call, res, e.status, { ok: false, code: e.code, message: e.message }, log); }
      return;
    }
    // async / auto: answer 202 with where to look (at once, or after 25 s), finish in the background.
    let accepted = false;
    const accept = () => { if (accepted || res.headersSent) return; accepted = true; answer(call, res, 202, { ok: true, runId, status: "running", statusUrl, ...(callback ? { callback } : {}) }, log); };
    const timer = mode === "auto" ? setTimeout(accept, AUTO_WAIT_MS) : null;
    timer?.unref?.();
    if (mode === "async") accept();
    work.then(async (out) => {
      if (timer) clearTimeout(timer);
      if (!accepted) return answer(call, res, out.run.status === "done" ? 200 : 500, resultOf(out), log);
      call.result = { status: out.run.status, ms: out.run.ms, outputs: call.logMode === "full" ? out.outputs : [], error: out.run.error };
      if (out.run.status !== "done") call.error = String(out.run.error?.message ?? out.run.status).slice(0, 500);
      if (callback) call.result.callback = await postCallback(callback, resultOf(out));
      if (log) functionsStore.addWebhookCall(strip(call));
    }).catch(async (err) => {
      if (timer) clearTimeout(timer);
      const e = errorOf(err);
      if (!accepted) return answer(call, res, e.status, { ok: false, code: e.code, message: e.message }, log);
      call.result = { status: "failed", ms: Date.now() - call.at, error: { type: e.code, message: e.message } };
      call.error = e.message.slice(0, 500);
      if (callback) call.result.callback = await postCallback(callback, { ok: false, runId, status: "failed", error: { type: e.code, message: e.message } });
      if (log) functionsStore.addWebhookCall(strip(call));
    });
  });

  // An async run's state: status, outputs, and the questions it waits on (m5.prompt / m5.form).
  app.get("/hooks/m/:modelId/:token/runs/:runId", hookLimiter, (req: Request, res: Response) => {
    if (!switchState("functions").enabled) return res.status(404).json({ ok: false });
    const found = hookModel(req);
    if ("status" in found) return res.status(found.status).json({ ok: false, message: found.message });
    const run = functionsStore.run(String(req.params.runId));
    if (!run || run.modelId !== found.model.id || run.executor !== "webhook") return res.status(404).json({ ok: false, message: "No such run." });
    const open = run.status === "running" || run.status === "waiting";
    res.json({ ok: true, runId: run.id, status: run.status, ms: run.ms, outputs: run.outputs, error: run.error, questions: open ? openInteractions(run.id) : [] });
  });

  // Answer an async run's question: { interaction, value }.
  app.post("/hooks/m/:modelId/:token/runs/:runId/answer", hookLimiter, express.json({ limit: "256kb" }), (req: Request, res: Response) => {
    if (!switchState("functions").enabled) return res.status(404).json({ ok: false });
    const found = hookModel(req);
    if ("status" in found) return res.status(found.status).json({ ok: false, message: found.message });
    const run = functionsStore.run(String(req.params.runId));
    // Only the webhook's own runs — never a chat user's question on the same model.
    if (!run || run.modelId !== found.model.id || run.executor !== "webhook") return res.status(404).json({ ok: false, message: "No such run." });
    const body = (req.body ?? {}) as { interaction?: string; value?: unknown };
    const ok = answerRun(run.id, String(body.interaction ?? ""), body.value ?? null);
    if (!ok) return res.status(409).json({ ok: false, message: "That question is not open." });
    res.json({ ok: true });
  });
}
