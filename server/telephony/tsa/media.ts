// What the providers fetch while a TSA runs (6.9), on the MAIN service:
//
//   GET /wh/tsa/audio/<token>   speech synthesized by AI & speech for a TTS
//                               node (telephony.db, expires after 2 hours)
//   GET /wh/tsa/file/<id>       an audio file uploaded in the console (Play)
//
// Both are capabilities — a random token / file id nobody can guess — and
// serve nothing else. Mounting this module also loads the runtime, so the
// main service answers telHooks.tsa (start / resume) for the webhooks that
// land here, and gives room messages the signaling hub to post through.

import type { Express, Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { tsaDb } from "./db";
import { setTsaNotifier, type TsaDeps } from "./deps";
import { readAudioFile } from "./files";
import "./runtime";

const limiter = rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false, message: { ok: false, message: "Too many requests." } });

export function registerTsaMediaRoutes(app: Express, opts: { notice?: TsaDeps["notice"] } = {}): void {
  if (opts.notice) setTsaNotifier(opts.notice);

  app.get("/wh/tsa/audio/:token", limiter, async (req: Request, res: Response) => {
    const token = String(req.params.token).replace(/\.(wav|mp3)$/, "");
    if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) return res.status(404).end();
    await tsaDb.ready();
    const row = tsaDb.audio.get(token);
    if (!row || row.expiresAt <= Date.now()) return res.status(404).end();
    const bytes = Buffer.from(row.data, "base64");
    res.setHeader("Cache-Control", "private, max-age=600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.type(row.mime || "audio/wav").send(bytes);
  });

  app.get("/wh/tsa/file/:id", limiter, (req: Request, res: Response) => {
    const id = String(req.params.id).replace(/\.(wav|mp3)$/, "");
    const f = readAudioFile(id);
    if (!f) return res.status(404).end();
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.type(f.file.mime).send(f.bytes);
  });
}
