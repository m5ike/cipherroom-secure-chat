// 6.9: plain REST calls the console's tests make to the providers (account,
// balance, numbers, webhook settings, SIP domains) — read-only except where a
// test creates its own resource (the test SIP address). Credentials from the
// environment at call time, a 15 s timeout, and no secret ever in a URL, a
// result or an error message.

const TIMEOUT_MS = 15_000;
const env = (name: string): string => process.env[name]?.trim() || "";

export type ApiAnswer = { ok: boolean; status: number; json: Record<string, unknown>; text: string; ms: number };

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "ApiError"; }
}

/** One request. Never throws for an HTTP error (ok: false); throws ApiError when there is no answer. */
export async function api(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, auth: string, body?: { form?: URLSearchParams; json?: unknown }): Promise<ApiAnswer> {
  const headers: Record<string, string> = { Accept: "application/json", Authorization: auth };
  let payload: string | URLSearchParams | undefined;
  if (body?.form) { headers["Content-Type"] = "application/x-www-form-urlencoded"; payload = body.form; }
  if (body?.json !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body.json); }
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const e = err as Error;
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new ApiError(504, `no answer within ${TIMEOUT_MS / 1000} s`);
    throw new ApiError(502, `request failed: ${String(e?.message ?? err).slice(0, 160)}`);
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* not JSON */ }
  return { ok: res.ok, status: res.status, json, text: text.slice(0, 2000), ms: Date.now() - t0 };
}

/** A provider's error answer in one short line (its own message, never our request). */
export function apiMessage(a: ApiAnswer): string {
  const j = a.json;
  const telnyx = (j.errors as Array<{ title?: string; detail?: string }> | undefined)?.[0];
  const msg = (typeof j.message === "string" && j.message)
    || (telnyx && [telnyx.title, telnyx.detail].filter(Boolean).join(": "))
    || [j.title, j.detail].filter((x) => typeof x === "string" && x).join(": ")
    || (typeof j["error-code-label"] === "string" ? j["error-code-label"] as string : "")
    || a.text.slice(0, 160);
  return `HTTP ${a.status}${msg ? `: ${String(msg).slice(0, 200)}` : ""}`;
}

/* --------------------------------------------------------------- per provider */

export const TWILIO_API = "https://api.twilio.com/2010-04-01";
export const TELNYX_API = "https://api.telnyx.com/v2";
export const VONAGE_REST = "https://rest.nexmo.com";
export const VONAGE_API = "https://api.nexmo.com";

export type Creds = { auth: string; base: string; missing: string[] };

/** Twilio: Basic AccountSid:AuthToken; base = the account's URL. */
export function twilioCreds(): Creds {
  const sid = env("TWILIO_ACCOUNT_SID"); const token = env("TWILIO_AUTH_TOKEN");
  const missing = [!sid && "TWILIO_ACCOUNT_SID", !token && "TWILIO_AUTH_TOKEN"].filter(Boolean) as string[];
  return { auth: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`, base: `${TWILIO_API}/Accounts/${encodeURIComponent(sid)}`, missing };
}

/** Telnyx: Bearer API key. */
export function telnyxCreds(): Creds {
  const key = env("TELNYX_API_KEY");
  return { auth: `Bearer ${key}`, base: TELNYX_API, missing: key ? [] : ["TELNYX_API_KEY"] };
}

/** Vonage account APIs (balance, numbers, applications, PSIP): Basic api_key:api_secret. */
export function vonageCreds(): Creds {
  const key = env("VONAGE_API_KEY"); const secret = env("VONAGE_API_SECRET");
  const missing = [!key && "VONAGE_API_KEY", !secret && "VONAGE_API_SECRET"].filter(Boolean) as string[];
  return { auth: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`, base: VONAGE_REST, missing };
}

export const credsOf = (provider: string): Creds | null =>
  provider === "twilio" ? twilioCreds() : provider === "telnyx" ? telnyxCreds() : provider === "vonage" ? vonageCreds() : null;
