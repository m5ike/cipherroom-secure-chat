// Endpoints for the optional TELEPHONY module.
//
// Client routes (registerTelephonyRoutes) are OFF unless the operator sets
// ENABLE_TELEPHONY=1, are size-capped, validate E.164, and are throttled HARD
// because each call/SMS hits a paid provider and, abused, is toll-fraud/spam.
// They never expose keys and log only metadata.
//
// Admin routes (registerAdminTelephonyRoutes) are exported SEPARATELY so the
// parent can mount them AFTER admin auth. They expose the full connector
// snapshot, default-provider selection (persisted), a real test action, the
// provider webhook list + one-click install, the inbound event log, and the
// SIP trunk console (persistent config only — no media).
//
// Provider webhooks themselves live in webhooks.ts and are mounted on the MAIN
// app (registerWebhookRoutes) at /wh/{provider}/{type}.

import { type Express, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { pluginLog } from "../plugins/log";
import { installProviderWebhooks } from "./connectors";
import {
  telephonyEnabled, getSms, getVoice, publicStatus, registrySnapshot, setDefaultProviders,
} from "./registry";
import { sipStore, type SipTrunkInput } from "./sip";
import { TelephonyNotConfiguredError, isE164, isProvider } from "./types";
import { telephonyEvents } from "./webhooks";

const MAX_SMS_CHARS = 1600;   // ~10 GSM segments; a hard body cap
const MAX_NUMBER_CHARS = 20;
const CALL_MEDIA_NOTE = "Call queued with the provider. The audio/media path is not handled here — a browser cannot speak SIP/RTP; bridging to a WebRTC leg needs an external SIP/WebRTC gateway.";

// Client telephony routes place real, billable calls / SMS, so throttle hard:
// 10 requests / 10 min / IP, on top of the global /api limiter.
const telephonyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // Default key = client IP with correct IPv6 handling (a custom req.ip key
  // would let IPv6 clients rotate addresses to dodge the limit).
  message: { ok: false, message: "Too many telephony requests; slow down." },
});

function readNumber(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().slice(0, MAX_NUMBER_CHARS) : "";
}

/* -------------------------------------------------- client-facing routes */

export function registerTelephonyRoutes(app: Express): void {
  app.get("/api/telephony/status", (_req, res) => {
    res.json({ ok: true, ...publicStatus() });
  });

  app.post("/api/telephony/sms", telephonyLimiter, async (req: Request, res: Response) => {
    if (!telephonyEnabled()) return res.status(404).json({ ok: false, message: "Telephony module disabled. Operator sets ENABLE_TELEPHONY=1." });
    const body = (req.body || {}) as Record<string, unknown>;
    const to = readNumber(body.to);
    if (!isE164(to)) return res.status(400).json({ ok: false, message: "to must be an E.164 number, e.g. +14155550123." });
    const text = typeof body.text === "string" ? body.text.slice(0, MAX_SMS_CHARS) : "";
    if (!text.trim()) return res.status(400).json({ ok: false, message: "text required." });
    const connector = getSms(typeof body.connector === "string" ? body.connector : undefined);
    if (!connector || !connector.status().configured) {
      return res.status(503).json({ ok: false, message: connector?.status().reason || "No SMS connector configured." });
    }
    try {
      const result = await pluginLog.time("admin", connector.id, "sms send", () => connector.sendSms({ to, text }));
      res.json({ ok: true, ...result });
    } catch (err) {
      const code = err instanceof TelephonyNotConfiguredError ? 503 : 502;
      res.status(code).json({ ok: false, message: (err as Error).message });
    }
  });

  app.post("/api/telephony/call", telephonyLimiter, async (req: Request, res: Response) => {
    if (!telephonyEnabled()) return res.status(404).json({ ok: false, message: "Telephony module disabled. Operator sets ENABLE_TELEPHONY=1." });
    const body = (req.body || {}) as Record<string, unknown>;
    const to = readNumber(body.to);
    if (!isE164(to)) return res.status(400).json({ ok: false, message: "to must be an E.164 number, e.g. +14155550123." });
    const connector = getVoice(typeof body.connector === "string" ? body.connector : undefined);
    if (!connector || !connector.status().configured) {
      return res.status(503).json({ ok: false, message: connector?.status().reason || "No voice connector configured." });
    }
    try {
      const result = await pluginLog.time("admin", connector.id, "call place", () => connector.placeCall({ to }));
      res.json({ ok: true, ...result, note: CALL_MEDIA_NOTE });
    } catch (err) {
      const code = err instanceof TelephonyNotConfiguredError ? 503 : 502;
      res.status(code).json({ ok: false, message: (err as Error).message });
    }
  });
}

/* ---------------------------------------------------------- admin routes */
// Mount AFTER admin auth in the parent (e.g. app.use("/admin", requireAuth)).

export function registerAdminTelephonyRoutes(app: Express): void {
  // Full snapshot: connectors + config state (never secrets), defaults and
  // where they come from, persistence status, SIP trunks, webhook URLs.
  app.get("/admin/telephony", (_req, res) => {
    res.json({ ok: true, ...registrySnapshot() });
  });

  // Choose which provider is the default for SMS / voice (persisted; beats
  // SMS_PROVIDER / VOICE_PROVIDER from .env). Empty string clears the choice.
  app.put("/admin/telephony/settings", (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const pick = (v: unknown): string | null | undefined => (v === undefined ? undefined : v === null ? null : typeof v === "string" ? v.trim() : undefined);
    const r = setDefaultProviders({ sms: pick(body.smsProvider), voice: pick(body.voiceProvider) });
    if (!r.ok) return res.status(400).json({ ok: false, message: r.message });
    pluginLog.record({ level: "info", kind: "admin", message: `telephony defaults set: sms=${r.settings.smsProvider ?? "(env/auto)"} voice=${r.settings.voiceProvider ?? "(env/auto)"}` });
    res.json({ ok: true, settings: r.settings, ...(({ defaults, defaultsSource }) => ({ defaults, defaultsSource }))(registrySnapshot()) });
  });

  // Real test of one connector; logs to the shared plugin log stream.
  app.post("/admin/telephony/test", async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const kind = String(body.kind || "");
    const id = typeof body.id === "string" ? body.id : undefined;
    const to = readNumber(body.to);
    if (!isE164(to)) return res.status(400).json({ ok: false, message: "to must be an E.164 number." });
    try {
      if (kind === "sms") {
        const c = getSms(id);
        if (!c) return res.status(404).json({ ok: false, message: "Unknown SMS connector." });
        const text = typeof body.text === "string" && body.text.trim() ? body.text.slice(0, MAX_SMS_CHARS) : "M5cet telephony test.";
        const result = await pluginLog.time("admin", c.id, "sms admin-test", () => c.sendSms({ to, text }));
        return res.json({ ok: true, kind, result });
      }
      if (kind === "call") {
        const c = getVoice(id);
        if (!c) return res.status(404).json({ ok: false, message: "Unknown voice connector." });
        const result = await pluginLog.time("admin", c.id, "call admin-test", () => c.placeCall({ to }));
        return res.json({ ok: true, kind, result, note: CALL_MEDIA_NOTE });
      }
      return res.status(400).json({ ok: false, message: "kind must be sms | call." });
    } catch (err) {
      const code = err instanceof TelephonyNotConfiguredError ? 503 : 502;
      res.status(code).json({ ok: false, message: (err as Error).message });
    }
  });

  // ---- Webhooks: what to point each provider at, and one-click install -----
  app.get("/admin/telephony/webhooks", (_req, res) => {
    const snap = registrySnapshot();
    res.json({ ok: true, publicBaseUrl: snap.publicBaseUrl, providers: snap.webhooks });
  });

  app.post("/admin/telephony/webhooks/install", async (req: Request, res: Response) => {
    const provider = String(((req.body || {}) as Record<string, unknown>).provider || "");
    if (!isProvider(provider)) return res.status(400).json({ ok: false, message: "provider must be twilio | telnyx | vonage." });
    const result = await installProviderWebhooks(provider);
    pluginLog.record({ level: result.ok ? "info" : "warn", kind: "admin", connector: provider, message: `webhook install: ${result.message}` });
    res.status(result.ok ? 200 : 400).json(result);
  });

  // ---- Inbound / status events received on /wh/* ----------------------------
  app.get("/admin/telephony/events", (req, res) => {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    res.json({ ok: true, events: telephonyEvents.recent(limit) });
  });
  app.delete("/admin/telephony/events", (_req, res) => {
    telephonyEvents.clear();
    res.json({ ok: true });
  });

  // ---- SIP trunk console (persistent config + routing only; no media) -------
  app.get("/admin/telephony/sip/trunks", (_req, res) => {
    res.json({ ok: true, trunks: sipStore.list(), persistent: sipStore.persistent, lastSaveError: sipStore.saveError });
  });

  // PUT upserts: an existing id updates that trunk, a new (or absent) id creates
  // one — so an operator can name trunks (e.g. "prague1") from the SIP console.
  // Trunks that come from SIP_TRUNKS in .env are read-only here.
  app.put("/admin/telephony/sip/trunks", (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    const r = id && sipStore.get(id)
      ? sipStore.update(id, body as unknown as Partial<SipTrunkInput>)
      : sipStore.create(body as unknown as SipTrunkInput);
    if (!r.ok) return res.status(r.message.includes(".env") ? 409 : 400).json({ ok: false, message: r.message });
    if (sipStore.saveError) return res.status(200).json({ ok: true, trunk: r.trunk, warning: `saved in memory only — ${sipStore.saveError}` });
    res.json({ ok: true, trunk: r.trunk });
  });

  app.delete("/admin/telephony/sip/trunks", (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const id = typeof body.id === "string" && body.id ? body.id : String(req.query.id ?? "");
    if (!id) return res.status(400).json({ ok: false, message: "id required." });
    const r = sipStore.remove(id);
    if (r === "readonly") return res.status(409).json({ ok: false, message: "trunk is defined in .env (SIP_TRUNKS); remove it there and restart" });
    if (!r) return res.status(404).json({ ok: false, message: "not found" });
    res.json({ ok: true });
  });

  app.post("/admin/telephony/sip/route", (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const did = typeof body.did === "string" ? body.did : "";
    const decision = sipStore.routeInbound(did);
    res.json({ ok: true, did, routed: Boolean(decision), decision });
  });
}
