// Webhooks, logged and replayable (5.2): what a call carried — method, path,
// query, headers (secrets masked), the body and its variables (JSON, a form,
// multipart with files, text, XML) — and what it got back; the result of an
// async run and its callback. Shared by the webhook routes and the console.

import type { Request } from "express";
import { randomBytes } from "node:crypto";
import { httpRequest } from "./host-net";
import type { WebhookCall } from "./types";

export const LOG_BODY_MAX = 256 * 1024;
// Credentials, shared secrets and signatures, whatever the provider calls them:
// Authorization, Cookie, X-Api-Key, X-Gitlab-Token, X-Telegram-Bot-Api-Secret-Token,
// Stripe-Signature, X-Slack-Signature, X-Twilio-Signature, X-Hub-Signature-256…
const SECRET_HEADERS = /authorization|cookie|token|secret|signature|api-?key|password|passwd|session|credential|(^|-)auth(-|$)/i;

export const newCallId = () => `whc_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
export const maskToken = (t: string) => (t ? `${t.slice(0, 6)}…` : "");

/** Headers as the log keeps them: secrets become "•••• (n chars)". */
export function logHeaders(h: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const value = Array.isArray(v) ? v.join(", ") : String(v ?? "");
    out[k.toLowerCase()] = SECRET_HEADERS.test(k) ? `•••• (${value.length} chars)` : value.slice(0, 2000);
  }
  return out;
}

/** A run's inputs as stored (run record, console): the request headers a webhook passed in `_webhook` masked. */
export function storedInputs(inputs: Record<string, unknown>): Record<string, unknown> {
  const w = inputs._webhook as { headers?: Record<string, unknown> } | undefined;
  if (!w || typeof w !== "object" || !w.headers || typeof w.headers !== "object") return inputs;
  return { ...inputs, _webhook: { ...w, headers: logHeaders(w.headers) } };
}

/** A path with the token masked (/hooks/m/<model>/<token> → …/abc123…). */
export const maskPath = (path: string, token: string) => (token ? path.split(token).join(maskToken(token)) : path);

export type ParsedBody = { kind: "json" | "form" | "multipart" | "text" | "xml" | "binary" | "empty"; value: unknown };

/** The body as variables. Files of a multipart body: { filename, mime, size, data: { $b } } (data up to 1 MB). */
export function parseBody(raw: Buffer, contentType: string): ParsedBody {
  if (!raw.length) return { kind: "empty", value: null };
  const ct = contentType.toLowerCase();
  const text = raw.toString("utf8");
  if (/json/.test(ct)) { try { return { kind: "json", value: JSON.parse(text) }; } catch { return { kind: "text", value: text }; } }
  if (/application\/x-www-form-urlencoded/.test(ct)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of new URLSearchParams(text)) { const cur = out[k]; out[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v]; }
    return { kind: "form", value: out };
  }
  if (/multipart\/form-data/.test(ct)) {
    const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
    if (boundary) return { kind: "multipart", value: parseMultipart(raw, boundary) };
  }
  if (/xml/.test(ct)) return { kind: "xml", value: text };
  // Text unless it does not look like it (NUL bytes / invalid UTF-8).
  if (!text.includes("\u0000") && !text.includes("�")) {
    if (/^\s*[[{]/.test(text)) { try { return { kind: "json", value: JSON.parse(text) }; } catch { /* text */ } }
    return { kind: "text", value: text };
  }
  return { kind: "binary", value: { size: raw.length, data: { $b: raw.subarray(0, 1024 * 1024).toString("base64") } } };
}

function parseMultipart(raw: Buffer, boundary: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const sep = Buffer.from(`--${boundary}`);
  let at = raw.indexOf(sep);
  while (at >= 0) {
    const next = raw.indexOf(sep, at + sep.length);
    if (next < 0) break;
    const part = raw.subarray(at + sep.length, next);
    at = next;
    const headEnd = part.indexOf("\r\n\r\n");
    if (headEnd < 0) continue;
    const head = part.subarray(0, headEnd).toString("utf8");
    let body = part.subarray(headEnd + 4);
    if (body.subarray(-2).toString() === "\r\n") body = body.subarray(0, -2);
    const name = /name="([^"]*)"/i.exec(head)?.[1];
    if (!name) continue;
    const filename = /filename="([^"]*)"/i.exec(head)?.[1];
    const mime = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() || (filename ? "application/octet-stream" : "text/plain");
    const value = filename !== undefined ? { filename, mime, size: body.length, data: { $b: body.subarray(0, 1024 * 1024).toString("base64") } } : body.toString("utf8");
    const cur = out[name];
    out[name] = cur === undefined ? value : Array.isArray(cur) ? [...cur, value] : [cur, value];
  }
  return out;
}

/** What the model gets as inputs: an object body's fields, else { body }. */
export function inputsOf(parsed: ParsedBody, query: Record<string, unknown>): Record<string, unknown> {
  const v = parsed.value;
  const fields = v && typeof v === "object" && !Array.isArray(v) && (parsed.kind === "json" || parsed.kind === "form" || parsed.kind === "multipart") ? v as Record<string, unknown> : parsed.kind === "empty" ? {} : { body: v };
  // Query parameters fill what the body does not (?callback= is the webhook's own).
  const q = Object.fromEntries(Object.entries(query).filter(([k]) => k !== "callback" && k !== "wait"));
  // {"inputs": {…}} — the shape of the run API — works here too.
  const wrapped = parsed.kind === "json" && fields.inputs && typeof fields.inputs === "object" && !Array.isArray(fields.inputs);
  if (wrapped) { const { inputs, ...rest } = fields; return { ...q, ...rest, ...(inputs as Record<string, unknown>) }; }
  return { ...q, ...fields };
}

/** The log's copy of a body: text up to 256 kB, or a note for binary data. */
export function logBody(raw: Buffer, parsed: ParsedBody): string {
  if (parsed.kind === "binary") return `(binary, ${raw.length} bytes)`;
  const text = raw.toString("utf8");
  return text.length > LOG_BODY_MAX ? `${text.slice(0, LOG_BODY_MAX)}\n… (${text.length - LOG_BODY_MAX} more characters)` : text;
}

export const clientIp = (req: Request) => (req.ip || "").replace(/^::ffff:/, "");

/** An empty call record for a request. */
export function callRecord(req: Request, kind: WebhookCall["kind"], modelId: string, token: string, raw: Buffer, logMode: "full" | "meta" | "off" = "full"): WebhookCall & { raw: Buffer; parsedBody: ParsedBody; logMode: "full" | "meta" | "off" } {
  const contentType = String(req.headers["content-type"] || "");
  const parsed = parseBody(raw, contentType);
  const full = logMode === "full";
  return {
    id: newCallId(), at: Date.now(), kind, modelId, hook: maskToken(token), method: req.method, path: maskPath(req.originalUrl.split("?")[0], token),
    query: Object.fromEntries(Object.entries(req.query as Record<string, unknown>).map(([k, v]) => [k, SECRET_HEADERS.test(k) ? `•••• (${String(v).length} chars)` : v])), headers: logHeaders(req.headers as Record<string, unknown>), contentType,
    body: full ? logBody(raw, parsed) : "", bodySize: raw.length, parsed: full ? { kind: parsed.kind, value: parsed.kind === "binary" ? { size: raw.length } : parsed.value } : { kind: parsed.kind, value: null },
    ip: clientIp(req), status: 0, responseHeaders: {}, responseBody: "", runId: "", ms: 0, error: "", replayOf: "", result: null,
    raw, parsedBody: parsed, logMode,
  };
}

/** POSTs a run's result to the caller's callback URL (public addresses only — the SSRF guard). */
export async function postCallback(url: string, payload: unknown): Promise<{ url: string; status: number; error?: string }> {
  try {
    const r = await httpRequest({ method: "POST", url, json: payload, timeoutMs: 15_000, maxBytes: 64 * 1024, headers: { "user-agent": "M5cet-webhook/1.0" } }, () => null);
    return { url, status: Number(r.status) };
  } catch (err) {
    return { url, status: 0, error: (err as Error).message };
  }
}

/** A callback URL the caller may name: ?callback= or X-Callback-URL, http(s) only. */
export function callbackOf(req: Request): string {
  const raw = String(req.query.callback ?? req.headers["x-callback-url"] ?? "").trim();
  return /^https?:\/\/[^\s]+$/i.test(raw) ? raw.slice(0, 1000) : "";
}
