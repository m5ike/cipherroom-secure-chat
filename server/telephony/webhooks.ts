// Provider webhooks served by the MAIN app at /wh/{provider}/{type}.
//
//   /wh/twilio/sms           inbound SMS            /wh/twilio/sms_status     delivery receipts
//   /wh/twilio/voice         answer URL (TwiML)     /wh/twilio/voice_status   call progress
//   /wh/telnyx/events        every messaging + call-control event
//   /wh/vonage/sms           inbound SMS (SMS API)  /wh/vonage/sms_status     delivery receipts
//   /wh/vonage/answer        answer URL (NCCO)      /wh/vonage/events         voice + Messages API events
//
// Authentication is the provider's own signature, verified here:
//   Twilio   X-Twilio-Signature = base64(HMAC-SHA1(auth token, url + sorted POST params))
//   Telnyx   telnyx-signature-ed25519 over "<timestamp>|<raw body>", public key from the portal
//   Vonage   Authorization: Bearer <HS256 JWT signed with the signature secret>, payload_hash = sha256(body)
//            (legacy SMS API: optional `sig` param = md5 of sorted params + secret)
// When the verification material is present the check is ENFORCED (403 on
// mismatch). When it is absent the event is accepted but stored with
// verified=false and a warning is logged — set TELNYX_PUBLIC_KEY /
// VONAGE_SIGNATURE_SECRET (Twilio uses its auth token) to close that gap.
//
// Events never trigger a billable action; they feed an in-memory event log
// (admin console) and the inbound-DID routing decision from the SIP store.

import { createHash, createHmac, createPublicKey, randomUUID, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Express, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { pluginLog } from "../plugins/log";
import { greetingText, providerWebhookSpecs, publicBaseUrl } from "./connectors";
import { verifyJwtHS256 } from "./jwt";
import { sipStore, type SipRouteDecision } from "./sip";
import { dataDir } from "./store";
import { isProvider, type TelephonyProvider, type WebhookVerify } from "./types";

const env = (name: string): string => (process.env[name]?.trim() || "");

/* ------------------------------------------------------------- event log */
// Webhooks land on the MAIN app while the console lives in the ADMIN process,
// so the log is kept in a small shared file next to the telephony data file
// (bounded, atomic writes, 0600). Memory is only the fallback when that
// location is not writable.

export const eventsFilePath = (): string => join(dataDir(), "telephony-events.json");

function readPersistedEvents(): TelephonyEvent[] {
  try {
    const arr = JSON.parse(readFileSync(eventsFilePath(), "utf8")) as unknown;
    return Array.isArray(arr) ? (arr as TelephonyEvent[]) : [];
  } catch {
    return [];
  }
}

function writePersistedEvents(list: TelephonyEvent[]): boolean {
  try {
    const file = eventsFilePath();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(list), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

export type TelephonyEvent = {
  id: string;
  ts: number;
  provider: TelephonyProvider;
  type: string;
  direction: "inbound" | "status" | "answer";
  from?: string;
  to?: string;
  status?: string;
  providerId?: string;
  text?: string; // inbound SMS body (capped)
  verified: boolean;
  enforced: boolean;
  route: SipRouteDecision | null;
  summary: string;
};

class TelephonyEventLog {
  private buf: TelephonyEvent[] = []; // fallback only (unwritable data dir)
  private max = 500;
  /** Append to the shared file (source of truth); fall back to memory if it cannot be written. */
  record(e: Omit<TelephonyEvent, "id" | "ts">): TelephonyEvent {
    const full: TelephonyEvent = { ...e, id: randomUUID(), ts: Date.now() };
    const next = [...readPersistedEvents(), full].slice(-this.max);
    if (writePersistedEvents(next)) {
      this.buf = [];
    } else {
      this.buf.push(full);
      if (this.buf.length > this.max) this.buf.splice(0, this.buf.length - this.max);
    }
    return full;
  }
  /** Newest last. Reads the shared file so the admin sees what the app received. */
  recent(n = 100): TelephonyEvent[] {
    const persisted = readPersistedEvents();
    const list = persisted.length > 0 ? persisted : this.buf;
    return list.slice(-Math.max(1, Math.min(this.max, n)));
  }
  clear(): void {
    this.buf = [];
    writePersistedEvents([]);
  }
}
export const telephonyEvents = new TelephonyEventLog();

/* ---------------------------------------------------------- verification */

/** Twilio: base64(HMAC-SHA1(token, url + Σ sorted(key+value))). */
export function twilioSignature(url: string, params: Record<string, string>, authToken: string): string {
  const data = url + Object.keys(params).sort().map((k) => `${k}${params[k]}`).join("");
  return createHmac("sha1", authToken).update(data).digest("base64");
}
export function verifyTwilioSignature(url: string, params: Record<string, string>, signature: string, authToken: string): boolean {
  if (!signature || !authToken) return false;
  const a = Buffer.from(twilioSignature(url, params, authToken));
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Telnyx publishes a raw 32-byte Ed25519 public key (base64); wrap it in SPKI DER for node:crypto. */
export function telnyxPublicKeyToPem(publicKeyB64: string): string {
  const raw = Buffer.from(publicKeyB64.trim(), "base64");
  if (raw.length !== 32) throw new Error("Telnyx public key must be 32 raw bytes (base64)");
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" }).export({ type: "spki", format: "pem" }).toString();
}
export function verifyTelnyxSignature(rawBody: Buffer | string, timestamp: string, signatureB64: string, publicKeyB64: string, toleranceSec = 300): boolean {
  try {
    if (!timestamp || !signatureB64 || !publicKeyB64) return false;
    const ts = parseInt(timestamp, 10);
    if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > toleranceSec) return false;
    const pem = telnyxPublicKeyToPem(publicKeyB64);
    const payload = Buffer.concat([Buffer.from(`${timestamp}|`), Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody)]);
    return cryptoVerify(null, payload, pem, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

/** Vonage signed webhooks: HS256 JWT in Authorization, payload_hash = sha256(body). */
export function verifyVonageJwtWebhook(authHeader: string | undefined, rawBody: Buffer | string, secret: string): boolean {
  if (!authHeader || !secret) return false;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!m) return false;
  const claims = verifyJwtHS256(m[1], secret);
  if (!claims) return false;
  const hash = claims.payload_hash;
  if (typeof hash === "string" && hash) {
    const actual = createHash("sha256").update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody)).digest("hex");
    return actual.toLowerCase() === hash.toLowerCase();
  }
  return true;
}

/** Vonage SMS API "signed webhooks" (md5 method): md5("&k=v" sorted, excluding sig, + secret). */
export function vonageLegacySig(params: Record<string, string>, secret: string): string {
  const data = Object.keys(params).filter((k) => k !== "sig").sort()
    .map((k) => `&${k}=${String(params[k]).replace(/[&=]/g, "_")}`).join("") + secret;
  return createHash("md5").update(data).digest("hex").toUpperCase();
}
export function verifyVonageLegacySig(params: Record<string, string>, secret: string): boolean {
  const given = String(params.sig || "").toUpperCase();
  if (!given || !secret) return false;
  const a = Buffer.from(vonageLegacySig(params, secret));
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** What material each provider needs for us to verify its webhooks, and whether it is set. */
export function webhookVerificationStatus(provider: TelephonyProvider): { verify: WebhookVerify; configured: boolean; needs: string } {
  switch (provider) {
    case "twilio": return { verify: "twilio-hmac", configured: env("TWILIO_AUTH_TOKEN").length > 0, needs: "TWILIO_AUTH_TOKEN" };
    case "telnyx": return { verify: "telnyx-ed25519", configured: env("TELNYX_PUBLIC_KEY").length > 0, needs: "TELNYX_PUBLIC_KEY" };
    case "vonage": return { verify: "vonage-jwt", configured: env("VONAGE_SIGNATURE_SECRET").length > 0, needs: "VONAGE_SIGNATURE_SECRET" };
  }
}

/* ------------------------------------------------------------ helpers */

type Params = Record<string, string>;

function stringParams(src: unknown): Params {
  const out: Params = {};
  if (src && typeof src === "object") {
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
      else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    }
  }
  return out;
}

function rawBodyOf(req: Request): Buffer {
  const raw = (req as Request & { rawBody?: unknown }).rawBody;
  if (Buffer.isBuffer(raw)) return raw;
  if (req.body && typeof req.body === "object" && Object.keys(req.body as object).length > 0) return Buffer.from(JSON.stringify(req.body));
  return Buffer.alloc(0);
}

/** The URL the provider signed: PUBLIC_BASE_URL + path, else reconstructed from proxy headers. */
function requestUrl(req: Request): string {
  const base = publicBaseUrl();
  if (base) return `${base}${req.originalUrl}`;
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
  return `${proto}://${host}${req.originalUrl}`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] as string);
}

const cap = (v: unknown, n = 200) => (typeof v === "string" ? v.slice(0, n) : undefined);

type Verification = { verified: boolean; enforced: boolean };

function verifyRequest(provider: TelephonyProvider, type: string, req: Request): Verification {
  if (provider === "twilio") {
    const token = env("TWILIO_AUTH_TOKEN");
    if (!token) return { verified: false, enforced: false };
    const params = req.method === "POST" ? stringParams(req.body) : {};
    return { verified: verifyTwilioSignature(requestUrl(req), params, String(req.headers["x-twilio-signature"] || ""), token), enforced: true };
  }
  if (provider === "telnyx") {
    const pub = env("TELNYX_PUBLIC_KEY");
    if (!pub) return { verified: false, enforced: false };
    return {
      verified: verifyTelnyxSignature(rawBodyOf(req), String(req.headers["telnyx-timestamp"] || ""), String(req.headers["telnyx-signature-ed25519"] || ""), pub),
      enforced: true,
    };
  }
  // vonage
  const secret = env("VONAGE_SIGNATURE_SECRET");
  if (!secret) return { verified: false, enforced: false };
  if (type === "sms" || type === "sms_status") {
    // Legacy SMS API: only signed when "signed webhooks" is on for the account.
    const params = { ...stringParams(req.query), ...stringParams(req.body) };
    if (!params.sig) return { verified: false, enforced: false };
    return { verified: verifyVonageLegacySig(params, secret), enforced: true };
  }
  return { verified: verifyVonageJwtWebhook(req.headers.authorization, rawBodyOf(req), secret), enforced: true };
}

function normalize(provider: TelephonyProvider, type: string, req: Request, v: Verification): Omit<TelephonyEvent, "id" | "ts"> {
  const p = { ...stringParams(req.query), ...stringParams(req.body) };
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const base = { provider, type, verified: v.verified, enforced: v.enforced, route: null as SipRouteDecision | null };
  const routeTo = (to?: string) => (to ? sipStore.routeInbound(to) : null);

  if (provider === "twilio") {
    if (type === "sms") return { ...base, direction: "inbound", from: p.From, to: p.To, text: cap(p.Body), providerId: p.MessageSid, route: routeTo(p.To), summary: `SMS from ${p.From} to ${p.To}` };
    if (type === "sms_status") return { ...base, direction: "status", to: p.To, status: p.MessageStatus, providerId: p.MessageSid, summary: `SMS ${p.MessageSid} ${p.MessageStatus}` };
    if (type === "voice") return { ...base, direction: "answer", from: p.From, to: p.To, providerId: p.CallSid, status: p.CallStatus, route: routeTo(p.To), summary: `call answer from ${p.From} to ${p.To}` };
    return { ...base, direction: "status", from: p.From, to: p.To, status: p.CallStatus, providerId: p.CallSid, summary: `call ${p.CallSid} ${p.CallStatus}` };
  }
  if (provider === "telnyx") {
    const data = (body.data && typeof body.data === "object" ? body.data : {}) as Record<string, unknown>;
    const eventType = String(data.event_type || p.event_type || "event");
    const payload = (data.payload && typeof data.payload === "object" ? data.payload : {}) as Record<string, unknown>;
    const fromRaw = payload.from; const toRaw = payload.to;
    const from = typeof fromRaw === "string" ? fromRaw : typeof fromRaw === "object" && fromRaw ? cap((fromRaw as { phone_number?: string }).phone_number) : undefined;
    const to = typeof toRaw === "string" ? toRaw : Array.isArray(toRaw) ? cap((toRaw[0] as { phone_number?: string } | undefined)?.phone_number) : undefined;
    const inbound = eventType === "message.received" || eventType === "call.initiated" && payload.direction === "incoming";
    return {
      ...base, direction: inbound ? "inbound" : "status", from, to, status: eventType,
      providerId: cap(payload.id) || cap(payload.call_control_id), text: inbound ? cap(payload.text) : undefined,
      route: inbound ? routeTo(to) : null, summary: `${eventType}${from ? ` from ${from}` : ""}${to ? ` to ${to}` : ""}`,
    };
  }
  // vonage
  if (type === "sms") return { ...base, direction: "inbound", from: p.msisdn, to: p.to, text: cap(p.text), providerId: p.messageId, route: routeTo(p.to ? `+${p.to.replace(/^\+/, "")}` : undefined) ?? routeTo(p.to), summary: `SMS from ${p.msisdn} to ${p.to}` };
  if (type === "sms_status") return { ...base, direction: "status", from: p.msisdn, to: p.to, status: p.status, providerId: p.messageId, summary: `SMS ${p.messageId} ${p.status}` };
  if (type === "answer") return { ...base, direction: "answer", from: p.from, to: p.to, providerId: p.uuid || p.conversation_uuid, route: routeTo(p.to ? `+${p.to.replace(/^\+/, "")}` : undefined) ?? routeTo(p.to), summary: `call answer from ${p.from} to ${p.to}` };
  const from = cap(p.from) ?? cap((body.from as { number?: string } | undefined)?.number);
  const to = cap(p.to) ?? cap((body.to as { number?: string } | undefined)?.number);
  return { ...base, direction: "status", from, to, status: p.status || p.message_status, providerId: p.uuid || p.message_uuid, summary: `${p.status || p.message_status || "event"}${from ? ` from ${from}` : ""}${to ? ` to ${to}` : ""}` };
}

/* ----------------------------------------------------------------- routes */

const whLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.ip || "unknown"),
  message: { ok: false, message: "Too many webhook requests." },
});

/** Mount on the MAIN app. Providers must be able to reach it (nginx: proxy /wh/ to the app). */
export function registerWebhookRoutes(app: Express): void {
  app.all("/wh/:provider/:type", whLimiter, (req: Request, res: Response) => {
    const provider = String(req.params.provider);
    const type = String(req.params.type);
    if (!isProvider(provider)) return res.status(404).json({ ok: false, message: "unknown provider" });
    const spec = providerWebhookSpecs(provider).find((s) => s.type === type);
    if (!spec) return res.status(404).json({ ok: false, message: "unknown webhook type" });

    const v = verifyRequest(provider, type, req);
    if (v.enforced && !v.verified) {
      pluginLog.record({ level: "warn", kind: "admin", connector: provider, message: `webhook ${type}: signature verification FAILED (rejected)` });
      return res.status(403).json({ ok: false, message: "signature verification failed" });
    }
    const ev = telephonyEvents.record(normalize(provider, type, req, v));
    pluginLog.record({
      level: v.verified ? "info" : "warn", kind: "admin", connector: provider,
      message: `webhook ${type}: ${ev.summary}${v.verified ? "" : " (unverified — set " + webhookVerificationStatus(provider).needs + ")"}${ev.route ? ` → trunk ${ev.route.trunkId}` : ""}`,
    });

    // Provider-specific answer bodies; everything else is a plain 200.
    if (provider === "twilio") {
      res.type("text/xml");
      if (type === "voice") return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(greetingText())}</Say></Response>`);
      return res.send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    }
    if (provider === "vonage" && type === "answer") {
      return res.json([{ action: "talk", text: greetingText() }]);
    }
    return res.json({ ok: true, event: ev.id, verified: ev.verified });
  });
}
