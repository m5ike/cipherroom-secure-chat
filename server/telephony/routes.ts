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
import { checkAccess, requestSubject } from "../access";
import { noteLegacySend, OutboundRefused, planOutbound, type OutboundPlan } from "./control/enforce";
import { placeCall, TelError } from "./engine";

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

/**
 * 5.2: the Telephony & SIP module's rights — "call" / "sms", and where to:
 * "number:+420*" lets only those numbers through, "-number:+1900*" keeps
 * some out. Logged, allowed or refused.
 */
function telephonyRight(req: Request, action: "call" | "sms", to: string): boolean {
  const c = checkAccess("telephony", requestSubject(req), { right: [[action], [`number:${to}`]], path: `${req.method} ${req.path} → ${to}`, ip: (req.ip || "").replace(/^::ffff:/, ""), via: "app" });
  // 6.10 (security review G-04): a module without a rule is "on for everyone with every right" —
  // for these two billable routes that meant anyone on the internet (the app sends no account
  // token here) could call and text any allowed number on the operator's account. They now
  // need a rule the operator wrote (Modules & groups › Telephony & SIP; "guest" for everyone).
  return c.allowed && c.reason !== "unlisted";
}

/** 6.9: the hourly budget's key for an app request — the account, else the address. */
function requestBy(req: Request): { by: string; groups: string[] } {
  const s = requestSubject(req);
  return { by: s.kind === "user" ? `user:${s.name}` : `ip:${(req.ip || "").replace(/^::ffff:/, "")}`, groups: s.groups };
}

/**
 * 6.9: the outbound permissions and rules (control/enforce.ts) for an app
 * request — the plan, or null after answering the refusal (403 a rule / a
 * blocked number / a country, 429 a limit, 503 a missing trunk).
 */
async function planned(res: Response, kind: "call" | "sms", to: string, who: { by: string; groups: string[] }, provider: string): Promise<OutboundPlan | null> {
  try {
    return await planOutbound({ kind, to, by: who.by, groups: who.groups, source: "api", ...(provider ? { provider } : {}) });
  } catch (err) {
    if (!(err instanceof OutboundRefused)) throw err;
    const status = err.code === "telephony-limit" || err.code === "telephony-busy" ? 429 : err.code === "not-configured" ? 503 : 403;
    res.status(status).json({ ok: false, code: err.code, message: err.message });
    return null;
  }
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
    if (!telephonyRight(req, "sms", to)) return res.status(403).json({ ok: false, code: "module-denied", message: `Sending SMS to ${to} is not among your rights (Modules & groups › Telephony & SIP).` });
    const text = typeof body.text === "string" ? body.text.slice(0, MAX_SMS_CHARS) : "";
    if (!text.trim()) return res.status(400).json({ ok: false, message: "text required." });
    const who = requestBy(req);
    if (!(await planned(res, "sms", to, who, ""))) return;
    const connector = getSms(typeof body.connector === "string" ? body.connector : undefined);
    if (!connector || !connector.status().configured) {
      return res.status(503).json({ ok: false, message: connector?.status().reason || "No SMS connector configured." });
    }
    try {
      const result = await pluginLog.time("admin", connector.id, "sms send", () => connector.sendSms({ to, text }));
      noteLegacySend("sms", who.by);
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
    if (!telephonyRight(req, "call", to)) return res.status(403).json({ ok: false, code: "module-denied", message: `Calling ${to} is not among your rights (Modules & groups › Telephony & SIP).` });
    const who = requestBy(req);
    const asked = typeof body.connector === "string" ? body.connector : "";
    const route = await planned(res, "call", to, who, asked);
    if (!route) return;
    // A SIP trunk or a TSA: the engine places it (its own webhooks, the trunk's caller ID).
    if (route.via || route.tsa) {
      try {
        const call = await placeCall({ to, owner: null, by: who.by, groups: who.groups, source: "api", planned: route });
        return res.json({ ok: true, id: call.id, provider: call.provider, status: call.status, ...(route.via ? { trunk: route.via.trunk.id } : {}), ...(route.tsa ? { tsa: route.tsa } : {}) });
      } catch (err) {
        const e = err as { code?: string; name?: string; message?: string };
        const status = e.code === "not-configured" || e.name === "ProviderNotConfigured" ? 503 : err instanceof TelError ? 400 : 502;
        return res.status(status).json({ ok: false, ...(e.code ? { code: e.code } : {}), message: e.message ?? "the call failed" });
      }
    }
    // The rule's provider application, or (pass) today's choice.
    const connector = getVoice(route.provider || asked || undefined);
    if (!connector || !connector.status().configured) {
      return res.status(503).json({ ok: false, message: connector?.status().reason || "No voice connector configured." });
    }
    try {
      const result = await pluginLog.time("admin", connector.id, "call place", () => connector.placeCall({ to }));
      noteLegacySend("call", who.by);
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
