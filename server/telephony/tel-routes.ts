// m5.telephony's routes (6.0), on the main service:
//
//   ALL  /wh/tel/<token>/<kind>      a call's or a message's own webhooks (engine.ts)
//   ALL  /wh/tel/in/<provider>       inbound calls to a number lent by the audio bridge
//                                    (Twilio's VoiceUrl; Vonage and Telnyx come through
//                                    their application / connection webhook, hooked below)
//   WS   /media/tel/<token>          the provider's media stream of a bridged call
//   WS   /media/tel/client/<token>   the member's side of it (bridge.ts)
//
// And the console's view of it all (GET /api/admin/telephony/sdk…).

import type { Express, Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { adapter, providerStatuses } from "./providers";
import { publicBaseUrl } from "./connectors";
import type { ProviderId } from "./providers/types";
import { handleCallWebhook, telWebhook, callView, messageView } from "./engine";
import { bridgeView, didPool, inboundBridge, releaseBridge } from "./bridge";
import { setInboundHook, stringParams, verifyRequest } from "./webhooks";
import { telStore } from "./tel-store";
import { isProvider, type TelephonyProvider } from "./types";

const limiter = rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false, message: { ok: false, message: "Too many webhook requests." } });

/** An inbound call (or, Telnyx, any event of a bridge / SDK call) through the provider's own webhook. */
async function inbound(provider: TelephonyProvider, type: string, req: Request) {
  const a = adapter(provider);
  if (!a?.parseCallEvent) return null;
  const isVoice = (provider === "twilio" && type === "voice") || (provider === "vonage" && type === "answer") || (provider === "telnyx" && type === "events");
  if (!isVoice) return null;
  await telStore.ready();
  const events = a.parseCallEvent(req.body, stringParams(req.query));
  for (const ev of events) {
    const known = telStore.callByProviderId(provider, ev.callId);
    if (known) return handleCallWebhook(known, provider === "telnyx" ? "event" : "answer", req.body, stringParams(req.query));
    if (ev.kind === "answer" || ev.direction === "inbound") {
      const r = await inboundBridge(provider as ProviderId, ev);
      if (r) return r.reply;
    }
  }
  return null;
}

export function registerTelEngineRoutes(app: Express): void {
  setInboundHook(inbound);

  // Inbound calls to a lent number (Twilio points the number here on allocation).
  app.all("/wh/tel/in/:provider", limiter, async (req: Request, res: Response) => {
    const provider = String(req.params.provider);
    if (!isProvider(provider)) return res.status(404).json({ ok: false });
    const v = verifyRequest(provider, "voice", req);
    if (v.enforced && !v.verified) return res.status(403).json({ ok: false, message: "signature verification failed" });
    try {
      const r = await inbound(provider, provider === "twilio" ? "voice" : provider === "vonage" ? "answer" : "events", req);
      if (r) return res.status(r.status).type(r.type).send(r.body);
    } catch (err) {
      telStore.record({ kind: "bridge", level: "error", ref: "", provider, summary: `inbound call failed: ${(err as Error).message.slice(0, 200)}`, detail: {} });
    }
    // Nobody to connect: a polite goodbye in the provider's language.
    if (provider === "twilio") return res.type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>');
    if (provider === "vonage") return res.json([]);
    return res.json({ ok: true });
  });

  app.all("/wh/tel/:token/:kind", limiter, async (req: Request, res: Response) => {
    const token = String(req.params.token);
    const kind = String(req.params.kind);
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token) || !["answer", "event", "gather", "record", "status"].includes(kind)) return res.status(404).json({ ok: false });
    try {
      const r = await telWebhook(req as Parameters<typeof telWebhook>[0], token, kind);
      res.status(r.status).type(r.type).send(r.body);
    } catch (err) {
      telStore.record({ kind: "webhook", level: "error", ref: token.slice(0, 6), provider: "", summary: `webhook ${kind} failed: ${(err as Error).message.slice(0, 200)}`, detail: {} });
      res.status(500).json({ ok: false });
    }
  });

  /* ------------------------------------------------ the console's view */

  app.get("/api/admin/telephony/sdk", async (_req, res) => {
    await telStore.ready();
    res.json({
      ok: true, store: telStore.status(), pool: didPool(), providers: providerStatuses(), publicBaseUrl: publicBaseUrl(),
      calls: telStore.calls.list({ limit: 100 }).map(callView),
      messages: telStore.messages.list({ limit: 100 }).map(messageView),
      bridges: telStore.bridges.list({ limit: 100 }).map(bridgeView),
      log: telStore.log.list({ limit: 200 }),
    });
  });
  app.get("/api/admin/telephony/sdk/calls/:id", async (req, res) => {
    await telStore.ready();
    const c = telStore.calls.get(String(req.params.id));
    if (!c) return res.status(404).json({ ok: false });
    res.json({ ok: true, call: { ...callView(c), events: c.events, handlers: c.handlers, owner: c.owner ? { modelId: c.owner.modelId, caller: c.owner.caller.name } : null }, log: telStore.log.list({ device: c.id, limit: 200 }) });
  });
  app.post("/api/admin/telephony/sdk/bridges/:id/release", async (req, res) => {
    res.json({ ok: await releaseBridge(String(req.params.id), "released by the operator") });
  });
}
