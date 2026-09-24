// The console's AI & speech endpoints (4.14), under the admin service's
// authentication (which puts the administrator's name and role into
// res.locals). Reading needs an auditor, changing an operator; keys,
// addresses, prices, limits and content logging need the owner.
//
//   GET    /admin/ai                          everything the page shows (no keys)
//   PUT    /admin/ai/switches                 { ai?, speech? }
//   POST   /admin/ai/providers                { type, label?, baseUrl?, key?, groups?, model? }      owner
//   PUT    /admin/ai/providers/:id            { label?, enabled?, groups?, baseUrl?, key? }          key / address: owner
//   DELETE /admin/ai/providers/:id                                                                  owner
//   POST   /admin/ai/providers/:id/test       does it answer
//   POST   /admin/ai/providers/:id/discover   fetch its models
//   PUT    /admin/ai/providers/:id/models     { models }                                            prices: owner
//   PUT    /admin/ai/defaults                 { chat?, tts?, stt?, voice?, system? }
//   PUT    /admin/ai/limits                   { …limits }                                           owner
//   PUT    /admin/ai/journal                  { retentionDays?, content?: { on, hours } }           owner
//   POST   /admin/ai/playground               { model, system?, messages, reasoning?, … stream? }
//   POST   /admin/ai/speech/tts · /stt        try speech
//   GET    /admin/ai/calls · /calls/:id · /calls.csv · /summary · /stream (SSE)
//   DELETE /admin/ai/calls                                                                          owner

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { PROVIDER_TYPE, PROVIDER_TYPES, isProviderType } from "./catalog";
import {
  aiConfig, aiConfigPath, keyState, newProviderId, providerBaseUrl, saveAiConfig, sanitizeBaseUrl, sanitizeGroups, sanitizeLimits, sanitizeModel, sealKey,
  type AiConfig, type ModelConfig, type ProviderConfig,
} from "./config";
import { journal, type CallRecord } from "./journal";
import { AiRefused, chat, dayStart, discover, monthStart, stt, testProvider, tts, type Caller } from "./service";
import { REASONING_LEVELS, DEFAULT_CAPS, type ChatEvent, type Reasoning, type CallTrace } from "./types";
import { sanitizeMessages } from "./messages";
import { ProviderError } from "./net";
import { setPluginSwitches, switchState } from "../plugins/settings";
import { pluginLog } from "../plugins/log";
import { base64ToBytes, bytesToBase64 } from "../plugins/types";
import { checkMasterKey } from "../storage/keys";
import { layoutGroups } from "../layout-catalog";

const actorOf = (res: Response): string => String(res.locals.adminName ?? "admin");
const isOwner = (res: Response): boolean => res.locals.adminRole === "owner";

/** Owner only (the admin service's authentication ran before and set the role). */
function owner(_req: Request, res: Response, next: NextFunction): void {
  if (isOwner(res)) { next(); return; }
  res.status(403).json({ ok: false, message: `This needs the owner role; you are ${String(res.locals.adminRole ?? "not signed in")}.` });
}

function consoleCaller(res: Response, source: "playground" | "test" = "playground"): Caller {
  return { source, actor: actorOf(res), account: "", groups: [], console: true };
}

/** A provider as the console sees it: no key, whether it has one, where it calls. */
function publicProvider(p: ProviderConfig) {
  const { key: _key, ...rest } = p;
  return { ...rest, hasKey: Boolean(p.key) || (p.source === "env" && keyState(p) === "ok"), keyState: keyState(p), effectiveBaseUrl: providerBaseUrl(p), envKey: p.source === "env" ? PROVIDER_TYPE[p.type].env?.key ?? "" : "" };
}

function overview() {
  const config = aiConfig();
  const credentials = checkMasterKey();
  const contentActive = config.journal.content.on && config.journal.content.until > Date.now();
  return {
    ok: true as const,
    types: PROVIDER_TYPES,
    switches: { ai: switchState("ai"), speech: switchState("speech") },
    providers: config.providers.map(publicProvider),
    defaults: config.defaults,
    assistant: config.assistant,
    limits: config.limits,
    journal: { ...config.journal, content: { ...config.journal.content, active: contentActive }, store: journal.status() },
    usage: { month: journal.usage(monthStart()), today: journal.usage(dayStart()), monthStart: monthStart() },
    groups: layoutGroups(),
    store: { file: aiConfigPath(), credentials: credentials.ok ? { ok: true, source: credentials.source } : { ok: false, reason: credentials.reason } },
    updatedAt: config.updatedAt,
    updatedBy: config.updatedBy,
  };
}

function save(res: Response, next: AiConfig, actor: string, note: string): void {
  const r = saveAiConfig(next, actor);
  if (!r.ok) { res.status(500).json({ ok: false, message: r.message }); return; }
  pluginLog.record({ level: "info", kind: "admin", message: `${note} (${actor})` });
  res.json(overview());
}

function errorOf(err: unknown): { status: number; message: string; code: string } {
  if (err instanceof AiRefused) return { status: err.status, message: err.message, code: err.code };
  if (err instanceof ProviderError) return { status: 502, message: err.message, code: "provider" };
  return { status: 500, message: (err as Error).message, code: "error" };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  // A leading = + - @ would be a formula in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function registerAiAdminRoutes(app: Express): void {
  app.get("/admin/ai", async (_req, res) => {
    await journal.ready();
    // Content logging that has run out: what it kept goes now.
    const c = aiConfig().journal.content;
    if (!(c.on && c.until > Date.now())) journal.dropContentBefore(Date.now() + 1);
    res.json(overview());
  });

  // Before 4.14 the console read /admin/plugins and switched with /admin/plugins/switches.
  app.get("/admin/plugins", async (_req, res) => { await journal.ready(); res.json(overview()); });

  const switches = (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const change: { ai?: boolean; speech?: boolean } = {};
    if (typeof body.ai === "boolean") change.ai = body.ai;
    if (typeof body.speech === "boolean") change.speech = body.speech;
    if (!Object.keys(change).length) return res.status(400).json({ ok: false, message: "Send { ai: true|false } and/or { speech: true|false }." });
    const actor = actorOf(res);
    const r = setPluginSwitches(change, actor);
    if (!r.ok) return res.status(409).json({ ok: false, message: r.message });
    pluginLog.record({ level: "info", kind: "admin", message: `${Object.entries(change).map(([k, v]) => `${k} ${v ? "on" : "off"}`).join(", ")} (${actor})` });
    res.json(overview());
  };
  app.put("/admin/ai/switches", switches);
  app.put("/admin/plugins/switches", switches);

  /* ------------------------------------------------------------- providers */

  app.post("/admin/ai/providers", owner, (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    if (!isProviderType(body.type)) return res.status(400).json({ ok: false, message: "Unknown provider type." });
    const def = PROVIDER_TYPE[body.type];
    const config = aiConfig();
    if (config.providers.length >= 30) return res.status(400).json({ ok: false, message: "At most 30 providers." });
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : def.label;
    const id = newProviderId(config, typeof body.label === "string" && body.label.trim() ? body.label : body.type);
    const baseUrl = typeof body.baseUrl === "string" ? sanitizeBaseUrl(body.baseUrl) : "";
    if (typeof body.baseUrl === "string" && body.baseUrl.trim() && !baseUrl) return res.status(400).json({ ok: false, message: "The address must be an http(s) URL without a user name or password." });
    if (!def.baseUrl && !baseUrl) return res.status(400).json({ ok: false, message: "This kind of provider needs its address." });
    let sealed: { key: string; keyHint: string } | null = null;
    if (typeof body.key === "string" && body.key.trim()) {
      try { sealed = sealKey(id, body.key); } catch (err) { return res.status(500).json({ ok: false, message: `The key cannot be stored: ${(err as Error).message}` }); }
    }
    const now = Date.now();
    const actor = actorOf(res);
    const models: ModelConfig[] = (def.suggested ?? []).map((m) => ({ id: m, label: "", kind: "chat", enabled: false, caps: { ...DEFAULT_CAPS }, price: null, source: "manual" }));
    const first = typeof body.model === "string" ? sanitizeModel({ id: body.model, kind: def.kinds[0], enabled: true }) : null;
    if (first) {
      const at = models.findIndex((m) => m.id === first.id);
      if (at >= 0) models[at] = { ...models[at], enabled: true }; else models.unshift({ ...first, caps: { ...first.caps, reasoning: body.type === "anthropic" ? "adaptive" : "none" } });
    }
    const provider: ProviderConfig = {
      id, type: body.type, label, baseUrl, key: sealed?.key ?? null, keyHint: sealed?.keyHint ?? "", enabled: true, groups: body.groups === undefined ? ["user"] : sanitizeGroups(body.groups),
      models, source: "console", createdAt: now, updatedAt: now, updatedBy: actor,
    };
    save(res, { ...config, providers: [...config.providers, provider] }, actor, `provider ${id} added`);
  });

  app.put("/admin/ai/providers/:id", (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const config = aiConfig();
    const p = config.providers.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ ok: false, message: "No such provider." });
    const sensitive = "key" in body || "baseUrl" in body;
    if (sensitive && !isOwner(res)) return res.status(403).json({ ok: false, message: "Keys and addresses are the owner's to change." });
    if (sensitive && p.source === "env") return res.status(409).json({ ok: false, message: `This provider's key and address come from the environment (${PROVIDER_TYPE[p.type].env?.key ?? ""}) — change them there.` });
    const next: ProviderConfig = { ...p, updatedAt: Date.now(), updatedBy: actorOf(res) };
    if (typeof body.label === "string" && body.label.trim()) next.label = body.label.trim().slice(0, 80);
    if (typeof body.enabled === "boolean") next.enabled = body.enabled;
    if (body.groups !== undefined) next.groups = sanitizeGroups(body.groups);
    if ("baseUrl" in body) {
      const url = typeof body.baseUrl === "string" ? sanitizeBaseUrl(body.baseUrl) : "";
      if (typeof body.baseUrl === "string" && body.baseUrl.trim() && !url) return res.status(400).json({ ok: false, message: "The address must be an http(s) URL without a user name or password." });
      if (!url && !PROVIDER_TYPE[p.type].baseUrl) return res.status(400).json({ ok: false, message: "This kind of provider needs its address." });
      next.baseUrl = url;
    }
    if ("key" in body) {
      if (body.key === null || body.key === "") { next.key = null; next.keyHint = ""; }
      else if (typeof body.key === "string") {
        try { Object.assign(next, sealKey(p.id, body.key)); } catch (err) { return res.status(500).json({ ok: false, message: `The key cannot be stored: ${(err as Error).message}` }); }
      }
    }
    save(res, { ...config, providers: config.providers.map((x) => (x.id === p.id ? next : x)) }, actorOf(res), `provider ${p.id} changed${"key" in body ? " (key)" : ""}`);
  });

  app.delete("/admin/ai/providers/:id", owner, (req, res) => {
    const config = aiConfig();
    const p = config.providers.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ ok: false, message: "No such provider." });
    if (p.source === "env") return res.status(409).json({ ok: false, message: `This provider comes from the environment (${PROVIDER_TYPE[p.type].env?.key ?? ""}) — remove it there. It can be switched off here.` });
    const drop = (ref: string) => (ref.startsWith(`${p.id}/`) ? "" : ref);
    save(res, { ...config, providers: config.providers.filter((x) => x.id !== p.id), defaults: { ...config.defaults, chat: drop(config.defaults.chat), tts: drop(config.defaults.tts), stt: drop(config.defaults.stt) } }, actorOf(res), `provider ${p.id} removed`);
  });

  app.post("/admin/ai/providers/:id/test", async (req, res) => {
    const r = await testProvider(String(req.params.id), actorOf(res));
    res.json({ ...overview(), test: r });
  });

  app.post("/admin/ai/providers/:id/discover", async (req, res) => {
    const r = await discover(String(req.params.id), actorOf(res));
    if (!r.ok) return res.status(502).json({ ok: false, message: r.message });
    res.json({ ...overview(), discovered: r });
  });

  app.put("/admin/ai/providers/:id/models", (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const config = aiConfig();
    const p = config.providers.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ ok: false, message: "No such provider." });
    if (!Array.isArray(body.models)) return res.status(400).json({ ok: false, message: "Send { models: [...] }." });
    const models: ModelConfig[] = [];
    const seen = new Set<string>();
    for (const raw of body.models) {
      const m = sanitizeModel(raw);
      if (!m || seen.has(`${m.kind}:${m.id}`)) continue;
      seen.add(`${m.kind}:${m.id}`);
      models.push(m);
    }
    const priceOf = (list: ModelConfig[], m: ModelConfig) => JSON.stringify(list.find((x) => x.id === m.id && x.kind === m.kind)?.price ?? null);
    if (!isOwner(res) && models.some((m) => priceOf(p.models, m) !== JSON.stringify(m.price) && !(m.price === null && !p.models.some((x) => x.id === m.id && x.kind === m.kind)))) {
      return res.status(403).json({ ok: false, message: "Prices count toward the budget: the owner sets them." });
    }
    save(res, { ...config, providers: config.providers.map((x) => (x.id === p.id ? { ...x, models, updatedAt: Date.now(), updatedBy: actorOf(res) } : x)) }, actorOf(res), `models of ${p.id} changed`);
  });

  /* ------------------------------------------------------------- settings */

  app.put("/admin/ai/defaults", (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const config = aiConfig();
    const d = { ...config.defaults };
    for (const k of ["chat", "tts", "stt", "voice"] as const) if (typeof body[k] === "string") d[k] = (body[k] as string).slice(0, 220);
    const assistant = typeof body.system === "string" ? { system: body.system.slice(0, 4000) } : config.assistant;
    save(res, { ...config, defaults: d, assistant }, actorOf(res), "defaults changed");
  });

  app.put("/admin/ai/limits", owner, (req, res) => {
    const config = aiConfig();
    save(res, { ...config, limits: sanitizeLimits({ ...config.limits, ...((req.body || {}) as object) }) }, actorOf(res), "limits changed");
  });

  app.put("/admin/ai/journal", owner, async (req, res) => {
    await journal.ready();
    const body = (req.body || {}) as Record<string, unknown>;
    const config = aiConfig();
    const j = { ...config.journal, content: { ...config.journal.content } };
    if (typeof body.retentionDays === "number") j.retentionDays = Math.max(1, Math.min(3650, Math.round(body.retentionDays)));
    const c = body.content as { on?: unknown; hours?: unknown } | undefined;
    if (c && typeof c.on === "boolean") {
      const hours = typeof c.hours === "number" ? Math.max(1, Math.min(168, c.hours)) : 24;
      j.content = c.on ? { on: true, until: Date.now() + hours * 3_600_000, by: actorOf(res) } : { on: false, until: 0, by: actorOf(res) };
      // Switched off: what was kept goes now.
      if (!c.on) journal.dropContentBefore(Date.now() + 1);
    }
    journal.prune(j.retentionDays);
    save(res, { ...config, journal: j }, actorOf(res), `journal: ${j.retentionDays} days, content ${j.content.on ? "on" : "off"}`);
  });

  /* ------------------------------------------------------------- playground */

  app.post("/admin/ai/playground", async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const messages = sanitizeMessages(body.messages);
    if (!messages) return res.status(400).json({ ok: false, message: "messages[] of user / assistant turns, ending with the user's." });
    const controller = new AbortController();
    let finished = false;
    res.on("close", () => { if (!finished) controller.abort(); });
    const trace: CallTrace[] = [];
    const input = {
      model: typeof body.model === "string" ? body.model : undefined,
      system: typeof body.system === "string" && body.system.trim() ? body.system.slice(0, 20_000) : undefined,
      messages,
      reasoning: typeof body.reasoning === "string" && (REASONING_LEVELS as readonly string[]).includes(body.reasoning) ? body.reasoning as Reasoning : undefined,
      maxTokens: typeof body.maxTokens === "number" ? Math.floor(body.maxTokens) : 1024,
      temperature: typeof body.temperature === "number" ? Math.min(2, Math.max(0, body.temperature)) : undefined,
      json: body.json === true,
      signal: controller.signal,
    };
    const caller = consoleCaller(res);
    if (body.stream !== true) {
      try {
        const out = await chat(input, caller, undefined, trace);
        finished = true;
        return res.json({ ok: true, ...out, trace });
      } catch (err) {
        finished = true;
        const e = errorOf(err);
        return res.status(e.status).json({ ok: false, code: e.code, message: e.message, trace });
      }
    }
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    const send = (event: string, data: unknown) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    try {
      const out = await chat(input, caller, (e: ChatEvent) => {
        if (e.type === "text") send("delta", { text: e.text });
        else if (e.type === "reasoning") send("reasoning", { text: e.text });
        else send("citations", { citations: e.citations });
      }, trace);
      send("done", { ...out, trace });
    } catch (err) {
      const e = errorOf(err);
      send("error", { status: e.status, code: e.code, message: e.message, trace });
    } finally {
      finished = true;
      res.end();
    }
  });

  app.post("/admin/ai/speech/tts", async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const text = typeof body.text === "string" ? body.text.slice(0, 4000) : "";
    if (!text.trim()) return res.status(400).json({ ok: false, message: "text required." });
    try {
      const out = await tts({ model: typeof body.model === "string" ? body.model : undefined, text, voice: typeof body.voice === "string" ? body.voice : undefined }, consoleCaller(res));
      res.json({ ok: true, audioBase64: bytesToBase64(out.audio), mime: out.mime, ref: out.ref, ms: out.ms });
    } catch (err) {
      const e = errorOf(err);
      res.status(e.status).json({ ok: false, code: e.code, message: e.message });
    }
  });

  app.post("/admin/ai/speech/stt", express.raw({ type: (r) => !String(r.headers["content-type"] || "").includes("application/json"), limit: 20 * 1024 * 1024 }), async (req, res) => {
    let audio: Uint8Array | null = null;
    let mime = String(req.headers["content-type"] || "audio/webm");
    if (Buffer.isBuffer(req.body)) audio = new Uint8Array(req.body);
    else if (req.body && typeof req.body === "object" && typeof (req.body as { audioBase64?: unknown }).audioBase64 === "string") {
      audio = base64ToBytes((req.body as { audioBase64: string }).audioBase64);
      if (typeof (req.body as { mime?: unknown }).mime === "string") mime = (req.body as { mime: string }).mime;
    }
    if (!audio || !audio.byteLength) return res.status(400).json({ ok: false, message: "audio required." });
    try {
      const out = await stt({ model: typeof req.query.model === "string" ? req.query.model : undefined, audio, mime, language: typeof req.query.language === "string" ? req.query.language : undefined }, consoleCaller(res));
      res.json({ ok: true, text: out.text, ref: out.ref, ms: out.ms });
    } catch (err) {
      const e = errorOf(err);
      res.status(e.status).json({ ok: false, code: e.code, message: e.message });
    }
  });

  /* ------------------------------------------------------------- journal */

  const query = (req: Request) => ({
    limit: Number(req.query.limit) || 100,
    before: Number(req.query.before) || undefined,
    after: Number(req.query.after) || undefined,
    source: typeof req.query.source === "string" ? req.query.source : undefined,
    status: typeof req.query.status === "string" ? req.query.status : undefined,
    provider: typeof req.query.provider === "string" ? req.query.provider : undefined,
    model: typeof req.query.model === "string" ? req.query.model : undefined,
    q: typeof req.query.q === "string" ? req.query.q.slice(0, 80) : undefined,
  });
  const withoutContent = (r: CallRecord) => ({ ...r, content: undefined, hasContent: r.content !== null });

  app.get("/admin/ai/calls", async (req, res) => {
    await journal.ready();
    res.json({ ok: true, calls: journal.list(query(req)).map(withoutContent), store: journal.status() });
  });

  app.get("/admin/ai/calls.csv", async (req, res) => {
    await journal.ready();
    const rows = journal.list({ ...query(req), limit: 1000 });
    const cols: Array<keyof CallRecord> = ["id", "ts", "source", "actor", "provider", "providerType", "model", "kind", "status", "error", "http", "ms", "ttft", "tokensIn", "tokensOut", "tokensReasoning", "tokensCached", "estimated", "cost", "charsIn", "charsOut", "stream"];
    const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(c === "ts" ? new Date(r.ts).toISOString() : r[c])).join(","))].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="m5cet-ai-calls-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(`${csv}\n`);
  });

  app.get("/admin/ai/calls/:id", async (req, res) => {
    await journal.ready();
    const r = journal.get(String(req.params.id));
    if (!r) return res.status(404).json({ ok: false, message: "No such call." });
    // What was said is the owner's to read.
    res.json({ ok: true, call: isOwner(res) ? r : withoutContent(r) });
  });

  app.get("/admin/ai/summary", async (req, res) => {
    await journal.ready();
    const days = Math.max(1, Math.min(366, Number(req.query.days) || 30));
    res.json({ ok: true, days, ...journal.summary(days), month: journal.usage(monthStart()), today: journal.usage(dayStart()) });
  });

  app.delete("/admin/ai/calls", owner, async (req, res) => {
    await journal.ready();
    journal.clear();
    pluginLog.record({ level: "warn", kind: "admin", message: `AI journal cleared (${actorOf(res)})` });
    res.json({ ok: true });
  });

  // New calls as they happen — from this service and the app's (read from the journal).
  app.get("/admin/ai/stream", async (req, res) => {
    await journal.ready();
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    let last = Date.now();
    const seen = new Set<string>();
    const tick = () => {
      const fresh = journal.list({ after: last - 2000, limit: 200 }).reverse();
      for (const r of fresh) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        last = Math.max(last, r.ts);
        res.write(`event: call\ndata: ${JSON.stringify(withoutContent(r))}\n\n`);
      }
      if (seen.size > 5000) seen.clear();
    };
    let ticks = 0;
    const timer = setInterval(() => { try { tick(); if (++ticks % 15 === 0) res.write(": ping\n\n"); } catch { /* gone */ } }, 1000);
    req.on("close", () => clearInterval(timer));
  });
}
