// The app's AI & speech endpoints (4.14). Who calls is the account of the
// bearer token (or a guest); the service decides what they may use.
//
//   GET  /api/ai/status        the models this user may use, the state (off,
//                              no model, no limit set, ready), the limits
//   POST /api/ai/chat          { model?, messages, system?, reasoning?, maxTokens?, stream? }
//                              stream: Server-Sent Events delta / reasoning /
//                              citations / done / error
//   POST /api/ai/complete      the pre-4.14 call ({ messages, connector? })
//   GET  /api/speech/status · POST /api/speech/tts · POST /api/speech/stt
//
// Keys never leave the server; nothing said is logged unless the owner turned
// content logging on (for a while, to debug).

import express, { type Express, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { aiConfig } from "./config";
import { AiRefused, chat, modelsFor, stt, tts, type Caller } from "./service";
import { REASONING_LEVELS, type ChatEvent, type Reasoning } from "./types";
import { MAX_MESSAGES, sanitizeMessages } from "./messages";
import { ProviderError } from "./net";
import { switchState } from "../plugins/settings";
import { base64ToBytes, bytesToBase64 } from "../plugins/types";
import { accountStore, usernameOf } from "../accounts/store";
import { clientConfigStore } from "../client-config";
import { groupsFor } from "../../client/src/lib/modules";

const MAX_TTS_CHARS = 4000;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_CLIENT_SYSTEM = 2000;

const limiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, code: "rate", message: "Too many AI / speech requests; slow down." },
});

/** Who sends this request: their account (from the bearer token) and groups, or a guest. */
export function callerOf(req: Request): Caller {
  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const account = token ? accountStore.resolveToken(token) : null;
  const username = account ? usernameOf(account) : null;
  return {
    source: "app",
    actor: username ?? "guest",
    account: account?.id ?? "",
    groups: groupsFor(clientConfigStore.get().groups, username),
    console: false,
  };
}

function reasoningOf(v: unknown): Reasoning | undefined {
  return typeof v === "string" && (REASONING_LEVELS as readonly string[]).includes(v) ? (v as Reasoning) : undefined;
}

function errorBody(err: unknown): { status: number; body: { ok: false; code: string; message: string } } {
  if (err instanceof AiRefused) return { status: err.status, body: { ok: false, code: err.code, message: err.message } };
  if (err instanceof ProviderError) return { status: 502, body: { ok: false, code: "provider", message: err.message } };
  return { status: 500, body: { ok: false, code: "error", message: "The AI call failed." } };
}

/** What the app's assistant may show this user. */
export function aiStatusFor(caller: Caller) {
  const config = aiConfig();
  const on = switchState("ai").enabled;
  const models = on ? modelsFor(caller, "chat", config) : [];
  const forSignedIn = on && models.length === 0 && caller.groups.includes("guest") ? modelsFor({ ...caller, groups: ["user"] }, "chat", config) : [];
  const state = !on ? "off" : models.length === 0 ? (forSignedIn.length ? "sign-in" : "no-model") : config.limits.monthlyTokens === 0 ? "no-limit" : "ready";
  const def = models.find((m) => m.ref === config.defaults.chat) ?? models[0];
  return {
    ok: true as const,
    enabled: state === "ready",
    state,
    models: models.map((m) => ({ ref: m.ref, label: m.model.label || m.model.id, provider: m.provider.label, reasoning: m.model.caps.reasoning !== "none", vision: m.model.caps.vision })),
    default: def?.ref ?? "",
    limits: { maxOutputTokens: config.limits.maxOutputTokens, maxInputChars: config.limits.maxInputChars },
  };
}

export function registerAiRoutes(app: Express): void {
  app.get("/api/ai/status", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const s = aiStatusFor(callerOf(req));
    // Before 4.14 the app read `connectors`: the same list, in the old shape.
    res.json({ ...s, connectors: s.models.map((m) => ({ id: m.ref, label: m.provider, model: m.label })) });
  });

  app.post("/api/ai/chat", limiter, async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const messages = sanitizeMessages(body.messages);
    if (!messages) return res.status(400).json({ ok: false, code: "bad-request", message: `messages[] of user / assistant turns (at most ${MAX_MESSAGES}), ending with the user's.` });
    const caller = callerOf(req);
    const config = aiConfig();
    const own = typeof body.system === "string" ? body.system.slice(0, MAX_CLIENT_SYSTEM) : "";
    const system = [config.assistant.system.trim(), own.trim()].filter(Boolean).join("\n\n") || undefined;
    const controller = new AbortController();
    let finished = false;
    res.on("close", () => { if (!finished) controller.abort(); });
    const input = {
      model: typeof body.model === "string" ? body.model : undefined,
      system,
      messages,
      reasoning: reasoningOf(body.reasoning),
      maxTokens: typeof body.maxTokens === "number" ? Math.floor(body.maxTokens) : undefined,
      signal: controller.signal,
    };
    if (body.stream !== true) {
      try {
        const out = await chat(input, caller);
        finished = true;
        return res.json({ ok: true, text: out.text, reasoning: out.reasoning, model: out.model, ref: out.ref, usage: out.usage, cost: out.cost, ms: out.ms, finish: out.finish, citations: out.citations });
      } catch (err) {
        finished = true;
        const e = errorBody(err);
        return res.status(e.status).json(e.body);
      }
    }
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    // nginx: pass each piece on at once.
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    const send = (event: string, data: unknown) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const keepAlive = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 15_000);
    try {
      const out = await chat(input, caller, (e: ChatEvent) => {
        if (e.type === "text") send("delta", { text: e.text });
        else if (e.type === "reasoning") send("reasoning", { text: e.text });
        else send("citations", { citations: e.citations });
      });
      send("done", { text: out.text, reasoning: out.reasoning, model: out.model, ref: out.ref, usage: out.usage, cost: out.cost, ms: out.ms, finish: out.finish, citations: out.citations });
    } catch (err) {
      const e = errorBody(err);
      send("error", { status: e.status, code: e.body.code, message: e.body.message });
    } finally {
      finished = true;
      clearInterval(keepAlive);
      res.end();
    }
  });

  // Before 4.14: { messages (system / user / assistant), connector? } → { ok, text, model, connector }.
  app.post("/api/ai/complete", limiter, async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const all = Array.isArray(body.messages) ? body.messages as Array<{ role?: unknown; content?: unknown }> : [];
    const system = all.filter((m) => m.role === "system" && typeof m.content === "string").map((m) => m.content as string).join("\n").slice(0, MAX_CLIENT_SYSTEM);
    const messages = sanitizeMessages(all.filter((m) => m.role !== "system"));
    if (!messages) return res.status(400).json({ ok: false, message: "messages[] required, ending with the user's." });
    const config = aiConfig();
    try {
      const out = await chat({
        model: typeof body.connector === "string" && body.connector.includes("/") ? body.connector : undefined,
        system: [config.assistant.system.trim(), system.trim()].filter(Boolean).join("\n\n") || undefined,
        messages,
        maxTokens: typeof body.maxTokens === "number" ? Math.floor(body.maxTokens) : undefined,
      }, callerOf(req));
      res.json({ ok: true, text: out.text, model: out.model, connector: out.ref });
    } catch (err) {
      const e = errorBody(err);
      res.status(e.status).json(e.body);
    }
  });

  app.get("/api/speech/status", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const caller = callerOf(req);
    const on = switchState("speech").enabled;
    const list = (kind: "tts" | "stt") => (on ? modelsFor(caller, kind) : []).map((m) => ({ id: m.ref, label: `${m.provider.label} · ${m.model.label || m.model.id}` }));
    const t = list("tts");
    const s = list("stt");
    res.json({ ok: true, tts: { enabled: on && t.length > 0, connectors: t }, stt: { enabled: on && s.length > 0, connectors: s } });
  });

  app.post("/api/speech/tts", limiter, async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const text = typeof body.text === "string" ? body.text.slice(0, MAX_TTS_CHARS) : "";
    if (!text.trim()) return res.status(400).json({ ok: false, message: "text required." });
    try {
      const out = await tts({ model: typeof body.connector === "string" ? body.connector : undefined, text, voice: typeof body.voice === "string" ? body.voice : undefined }, callerOf(req));
      res.json({ ok: true, audioBase64: bytesToBase64(out.audio), mime: out.mime, connector: out.ref });
    } catch (err) {
      const e = errorBody(err);
      res.status(e.status).json(e.body);
    }
  });

  // Raw audio (any content type), or JSON { audioBase64, mime, language }.
  app.post("/api/speech/stt", limiter, express.raw({ type: (r) => !String(r.headers["content-type"] || "").includes("application/json"), limit: MAX_AUDIO_BYTES }), async (req: Request, res: Response) => {
    let audio: Uint8Array | null = null;
    let mime = String(req.headers["content-type"] || "audio/webm");
    let language: string | undefined;
    if (Buffer.isBuffer(req.body)) audio = new Uint8Array(req.body);
    else if (req.body && typeof req.body === "object") {
      const b = req.body as Record<string, unknown>;
      if (typeof b.audioBase64 === "string") audio = base64ToBytes(b.audioBase64);
      if (typeof b.mime === "string") mime = b.mime;
      if (typeof b.language === "string") language = b.language.slice(0, 16);
    }
    if (!audio || audio.byteLength === 0) return res.status(400).json({ ok: false, message: "audio body required." });
    if (audio.byteLength > MAX_AUDIO_BYTES) return res.status(413).json({ ok: false, message: "audio too large." });
    try {
      const out = await stt({ model: typeof req.query.connector === "string" ? req.query.connector : undefined, audio, mime, language }, callerOf(req));
      res.json({ ok: true, text: out.text, connector: out.ref });
    } catch (err) {
      const e = errorBody(err);
      res.status(e.status).json(e.body);
    }
  });
}
