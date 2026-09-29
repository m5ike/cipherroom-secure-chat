// Firebase Cloud Messaging, HTTP v1 (6.0) — no Firebase SDK on the server:
// the service account signs a JWT (RS256), Google trades it for an OAuth
// access token (cached until shortly before it expires), and each message is
// one POST. Only DATA messages are sent (the app decides what to show), and
// their content is already encrypted for the device and signed (commands.ts).

import { signJwtRS256 } from "../telephony/jwt";
import { androidConfig, openServiceAccount, parseServiceAccount } from "./config";

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
/** Tests: replace the network. */
export function setFcmFetch(f: Fetch | null): void { fetchImpl = f ?? ((...args) => fetch(...args)); token = null; }

let token: { value: string; until: number; email: string } | null = null;

export type FcmResult = { ok: true; name: string } | { ok: false; status: number; error: string; unregistered: boolean };

function serviceAccount() {
  const json = openServiceAccount(androidConfig().fcm.serviceAccount);
  return json ? parseServiceAccount(json) : null;
}

export function fcmReady(): { ready: boolean; reason: string } {
  const c = androidConfig();
  if (!c.fcm.enabled) return { ready: false, reason: "FCM is switched off" };
  const sa = serviceAccount();
  if (!sa) return { ready: false, reason: "no service account (Android › Push)" };
  if (!c.fcm.client) return { ready: false, reason: "no Firebase app settings for the devices (Android › Push)" };
  return { ready: true, reason: "" };
}

async function accessToken(): Promise<string> {
  const sa = serviceAccount();
  if (!sa) throw new Error("no FCM service account");
  if (token && token.email === sa.client_email && token.until > Date.now() + 60_000) return token.value;
  const assertion = signJwtRS256({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri }, sa.private_key, 3600);
  const res = await fetchImpl(sa.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!res.ok || !body.access_token) throw new Error(`Google refused the service account: ${body.error_description || body.error || res.status}`);
  token = { value: body.access_token, until: Date.now() + (body.expires_in ?? 3600) * 1000, email: sa.client_email };
  return token.value;
}

export type FcmOptions = { priority: "high" | "normal"; ttlSeconds: number; collapseKey?: string };

/** One data message to one registration token. */
export async function fcmSend(registrationToken: string, data: Record<string, string>, opts: FcmOptions): Promise<FcmResult> {
  const sa = serviceAccount();
  const project = androidConfig().fcm.projectId || sa?.project_id || "";
  if (!sa || !project) return { ok: false, status: 0, error: "FCM is not configured", unregistered: false };
  let bearer: string;
  try { bearer = await accessToken(); } catch (err) { return { ok: false, status: 0, error: (err as Error).message, unregistered: false }; }
  const message = {
    token: registrationToken,
    data,
    android: {
      priority: opts.priority === "high" ? "HIGH" : "NORMAL",
      ttl: `${Math.max(0, Math.round(opts.ttlSeconds))}s`,
      ...(opts.collapseKey ? { collapse_key: opts.collapseKey } : {}),
    },
  };
  try {
    const res = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(project)}/messages:send`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({})) as { name?: string; error?: { message?: string; status?: string; details?: Array<{ errorCode?: string }> } };
    if (res.ok && body.name) return { ok: true, name: body.name };
    if (res.status === 401) token = null;
    const code = body.error?.details?.find((d) => d.errorCode)?.errorCode ?? body.error?.status ?? "";
    return { ok: false, status: res.status, error: `${code || res.status}: ${body.error?.message ?? "FCM refused the message"}`, unregistered: res.status === 404 || code === "UNREGISTERED" || (res.status === 400 && code === "INVALID_ARGUMENT" && /token/i.test(body.error?.message ?? "")) };
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message, unregistered: false };
  }
}
