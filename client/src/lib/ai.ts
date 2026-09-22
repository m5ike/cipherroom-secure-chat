// Thin client for the optional server-side AI module (/api/ai/*). Available
// only in Server-enhanced mode when the operator has enabled it and configured
// a provider; otherwise fetchAiStatus reports { enabled: false }.

export type AiConnectorInfo = { id: string; label: string; model?: string };
export type AiStatus = { enabled: boolean; connectors: AiConnectorInfo[] };
export type AiMessage = { role: "system" | "user" | "assistant"; content: string };

export async function fetchAiStatus(): Promise<AiStatus> {
  try {
    const res = await fetch("/api/ai/status", { headers: { Accept: "application/json" } });
    if (!res.ok) return { enabled: false, connectors: [] };
    const json = await res.json() as { enabled?: boolean; connectors?: AiConnectorInfo[] };
    return { enabled: Boolean(json.enabled), connectors: Array.isArray(json.connectors) ? json.connectors : [] };
  } catch {
    return { enabled: false, connectors: [] };
  }
}

export type AiCompleteResult = { ok: true; text: string; model: string; connector: string } | { ok: false; message: string };

export async function aiComplete(messages: AiMessage[], connector?: string): Promise<AiCompleteResult> {
  try {
    const res = await fetch("/api/ai/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, connector }),
    });
    const json = await res.json().catch(() => ({})) as { ok?: boolean; text?: string; model?: string; connector?: string; message?: string };
    if (!res.ok || !json.ok) return { ok: false, message: json.message || `HTTP ${res.status}` };
    return { ok: true, text: json.text || "", model: json.model || "", connector: json.connector || "" };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
