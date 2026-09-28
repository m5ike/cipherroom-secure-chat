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
import { answerRun, endInteractionsFor, execute, runEvents, RunRefused } from "./runner";
import { functionsStore, newId } from "./store";
import { validateInputs } from "./inputs";
import { type Caller, type Model } from "./types";
import { switchState } from "../plugins/settings";
import { accountStore, usernameOf } from "../accounts/store";
import { clientConfigStore } from "../client-config";
import { groupsFor } from "../../client/src/lib/modules";

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

/** May this caller run this model from chat? */
function allowed(model: Model, caller: Caller): boolean {
  if (!model.enabled || !model.executors.chat.enabled) return false;
  if (model.groups.length === 0) return true;
  return model.groups.some((g) => caller.groups.includes(g));
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

  app.get("/api/functions/commands", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const on = switchState("functions").enabled;
    if (!on) return res.json({ ok: true, enabled: false, commands: [] });
    await functionsStore.ready();
    const caller = callerOf(req);
    const commands = functionsStore.models()
      .filter((m) => m.keyword && allowed(m, caller))
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
    if (!model || !allowed(model, caller)) return res.status(404).json({ ok: false, code: "no-command", message: "No such command, or it is not available to you." });
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
}
