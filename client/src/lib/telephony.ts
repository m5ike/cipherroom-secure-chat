// Thin client for the optional server-side TELEPHONY module (/api/telephony/*).
// Available only in Server-enhanced mode when the operator has enabled it
// (ENABLE_TELEPHONY=1) and configured a provider; otherwise fetchTelephonyStatus
// reports { enabled: false }. Every function returns a tagged result and NEVER
// throws — the UI always gets a { ok } shape it can render.

export type TelephonyConnectorInfo = { id: string; label: string };
export type TelephonyStatus = { enabled: boolean; sms: TelephonyConnectorInfo[]; voice: TelephonyConnectorInfo[] };

export async function fetchTelephonyStatus(): Promise<TelephonyStatus> {
  try {
    const res = await fetch("/api/telephony/status", { headers: { Accept: "application/json" } });
    if (!res.ok) return { enabled: false, sms: [], voice: [] };
    const json = await res.json() as { enabled?: boolean; sms?: TelephonyConnectorInfo[]; voice?: TelephonyConnectorInfo[] };
    return {
      enabled: Boolean(json.enabled),
      sms: Array.isArray(json.sms) ? json.sms : [],
      voice: Array.isArray(json.voice) ? json.voice : [],
    };
  } catch {
    return { enabled: false, sms: [], voice: [] };
  }
}

export type SendSmsResult = { ok: true; id: string; provider: string } | { ok: false; message: string };

export async function sendSms(args: { to: string; text: string; connector?: string }): Promise<SendSmsResult> {
  try {
    const res = await fetch("/api/telephony/sms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const json = await res.json().catch(() => ({})) as { ok?: boolean; id?: string; provider?: string; message?: string };
    if (!res.ok || !json.ok) return { ok: false, message: json.message || `HTTP ${res.status}` };
    return { ok: true, id: json.id || "", provider: json.provider || "" };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export type PlaceCallResult = { ok: true; id: string; provider: string; note?: string } | { ok: false; message: string };

export async function placeCall(args: { to: string; connector?: string }): Promise<PlaceCallResult> {
  try {
    const res = await fetch("/api/telephony/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const json = await res.json().catch(() => ({})) as { ok?: boolean; id?: string; provider?: string; note?: string; message?: string };
    if (!res.ok || !json.ok) return { ok: false, message: json.message || `HTTP ${res.status}` };
    return { ok: true, id: json.id || "", provider: json.provider || "", note: json.note };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
