// Client-facing endpoints for the optional AI + speech modules. These are OFF
// unless the operator sets ENABLE_AI / ENABLE_SPEECH, are size-capped, and are
// throttled harder than the general API since each call can hit a paid
// provider. They never expose keys and log only metadata.

import express, { type Express, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { pluginLog } from "./log";
import {
  aiEnabled, speechEnabled, getAi, getTts, getStt, publicSpeechStatus,
} from "./registry";
import { ConnectorNotConfiguredError, base64ToBytes, type AiMessage } from "./types";

const MAX_AI_CHARS = 8000;
const MAX_TTS_CHARS = 2000;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MiB

// Heavy-endpoint limiter: 20 requests / 5 min / IP on top of the global /api one.
const heavyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.ip || "unknown"),
  message: { ok: false, message: "Too many AI/speech requests; slow down." },
});

function sanitizeMessages(raw: unknown): AiMessage[] | null {
  if (!Array.isArray(raw)) return null;
  const out: AiMessage[] = [];
  let total = 0;
  for (const m of raw) {
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if ((role !== "system" && role !== "user" && role !== "assistant") || typeof content !== "string") return null;
    total += content.length;
    if (total > MAX_AI_CHARS) return null;
    out.push({ role, content });
  }
  return out.length > 0 ? out : null;
}

export function registerPluginRoutes(app: Express): void {
  app.get("/api/ai/status", (_req, res) => {
    res.json({ ok: true, ...publicSpeechStatus().ai });
  });

  app.post("/api/ai/complete", heavyLimiter, async (req: Request, res: Response) => {
    if (!aiEnabled()) return res.status(404).json({ ok: false, message: "AI module disabled. Operator sets ENABLE_AI=1." });
    const body = (req.body || {}) as Record<string, unknown>;
    const messages = sanitizeMessages(body.messages);
    if (!messages) return res.status(400).json({ ok: false, message: `messages[] required, <= ${MAX_AI_CHARS} chars total.` });
    const connector = getAi(typeof body.connector === "string" ? body.connector : undefined);
    if (!connector || !connector.status().configured) {
      return res.status(503).json({ ok: false, message: connector?.status().reason || "No AI connector configured." });
    }
    try {
      const result = await pluginLog.time("ai", connector.id, "complete", () => connector.complete({
        messages,
        temperature: typeof body.temperature === "number" ? body.temperature : undefined,
        maxTokens: typeof body.maxTokens === "number" ? Math.min(2048, body.maxTokens) : undefined,
      }));
      res.json({ ok: true, ...result });
    } catch (err) {
      const code = err instanceof ConnectorNotConfiguredError ? 503 : 502;
      res.status(code).json({ ok: false, message: (err as Error).message });
    }
  });

  app.get("/api/speech/status", (_req, res) => {
    const s = publicSpeechStatus();
    res.json({ ok: true, tts: s.tts, stt: s.stt });
  });

  app.post("/api/speech/tts", heavyLimiter, async (req: Request, res: Response) => {
    if (!speechEnabled()) return res.status(404).json({ ok: false, message: "Speech module disabled. Operator sets ENABLE_SPEECH=1." });
    const body = (req.body || {}) as Record<string, unknown>;
    const text = typeof body.text === "string" ? body.text.slice(0, MAX_TTS_CHARS) : "";
    if (!text.trim()) return res.status(400).json({ ok: false, message: "text required." });
    const connector = getTts(typeof body.connector === "string" ? body.connector : undefined);
    if (!connector || !connector.status().configured) {
      return res.status(503).json({ ok: false, message: connector?.status().reason || "No TTS connector configured." });
    }
    try {
      const result = await pluginLog.time("tts", connector.id, "synthesize", () => connector.synthesize({
        text, voice: typeof body.voice === "string" ? body.voice : undefined,
      }));
      res.json({ ok: true, ...result });
    } catch (err) {
      const code = err instanceof ConnectorNotConfiguredError ? 503 : 502;
      res.status(code).json({ ok: false, message: (err as Error).message });
    }
  });

  // STT accepts either raw audio (any Content-Type via express.raw) or a JSON
  // body { audioBase64, mime, language }. Raw keeps large uploads off the JSON
  // parser's small default limit.
  app.post("/api/speech/stt", heavyLimiter, express.raw({ type: (req) => !String(req.headers["content-type"] || "").includes("application/json"), limit: MAX_AUDIO_BYTES }), async (req: Request, res: Response) => {
    if (!speechEnabled()) return res.status(404).json({ ok: false, message: "Speech module disabled. Operator sets ENABLE_SPEECH=1." });
    let audio: Uint8Array | null = null;
    let mime = String(req.headers["content-type"] || "audio/webm");
    let language: string | undefined;
    if (Buffer.isBuffer(req.body)) {
      audio = new Uint8Array(req.body);
    } else if (req.body && typeof req.body === "object") {
      const body = req.body as Record<string, unknown>;
      if (typeof body.audioBase64 === "string") audio = base64ToBytes(body.audioBase64);
      if (typeof body.mime === "string") mime = body.mime;
      if (typeof body.language === "string") language = body.language;
    }
    if (!audio || audio.byteLength === 0) return res.status(400).json({ ok: false, message: "audio body required." });
    if (audio.byteLength > MAX_AUDIO_BYTES) return res.status(413).json({ ok: false, message: "audio too large." });
    const connector = getStt(typeof (req.query.connector) === "string" ? String(req.query.connector) : undefined);
    if (!connector || !connector.status().configured) {
      return res.status(503).json({ ok: false, message: connector?.status().reason || "No STT connector configured." });
    }
    try {
      const result = await pluginLog.time("stt", connector.id, "transcribe", () => connector.transcribe({ audio: audio!, mime, language }));
      res.json({ ok: true, ...result });
    } catch (err) {
      const code = err instanceof ConnectorNotConfiguredError ? 503 : 502;
      res.status(code).json({ ok: false, message: (err as Error).message });
    }
  });
}
