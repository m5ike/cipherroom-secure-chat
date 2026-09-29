// Meta adapter for m5.telephony: Messenger through the Graph Send API.
//   POST https://graph.facebook.com/{version}/{page-id}/messages
//   Authorization: Bearer <page access token>   (never ?access_token= in the URL)
//   {recipient:{id:PSID}, messaging_type:"RESPONSE"|"UPDATE"|"MESSAGE_TAG", message:{text}|{attachment}, tag?}
// → {recipient_id, message_id}. The 24-hour window applies; outside it only
// the HUMAN_AGENT tag still works (Meta removed the other tags in 2026).

import {
  ProviderError, ProviderNotConfigured,
  type Capability, type ChatChannel, type ChatMessageInput, type ChatMessageResult, type ProviderAdapter, type ProviderStatus,
} from "./types";

const TIMEOUT_MS = 15_000;
const PAGE = "META_PAGE_ID";
const TOKEN = "META_PAGE_TOKEN";
const VERSION = "META_GRAPH_VERSION";
const DEFAULT_VERSION = "v26.0";

const env = (name: string): string => process.env[name]?.trim() || "";
const cut = (s: string): string => (s.length > 300 ? `${s.slice(0, 299)}…` : s);

const MESSAGING_TYPES = ["RESPONSE", "UPDATE", "MESSAGE_TAG"];

export class MetaAdapter implements ProviderAdapter {
  readonly id = "meta" as const;
  readonly label = "Meta (Messenger)";
  readonly channels: ChatChannel[] = ["messenger"];

  status(): ProviderStatus {
    const missing = [PAGE, TOKEN].filter((n) => !env(n));
    const capabilities: Capability[] = ["messenger"];
    return {
      id: this.id, label: this.label, capabilities, configured: missing.length ? [] : ["messenger"],
      needs: { messenger: [PAGE, TOKEN, VERSION] },
      reason: missing.length ? `Set ${missing.join(", ")} (messenger).` : undefined,
    };
  }

  async sendChat(input: ChatMessageInput): Promise<ChatMessageResult> {
    const bad = (m: string) => new ProviderError(this.id, 400, cut(`Meta: ${m}`));
    if (input.channel !== "messenger") throw bad(`the ${input.channel} channel is not supported here (Messenger only).`);
    const psid = String(input.to ?? "").trim();
    if (!psid) throw bad(`"to" must be the recipient's page-scoped id (PSID).`);
    const type = (input.category || (input.tag ? "MESSAGE_TAG" : "RESPONSE")).toUpperCase();
    if (!MESSAGING_TYPES.includes(type)) throw bad(`category must be RESPONSE, UPDATE or MESSAGE_TAG (got "${cut(type)}").`);
    if (type === "MESSAGE_TAG" && !input.tag) throw bad("MESSAGE_TAG needs a tag (HUMAN_AGENT).");
    let message: Record<string, unknown>;
    if (input.media) {
      message = { attachment: { type: input.media.type, payload: { url: input.media.url, is_reusable: false } } };
    } else if (input.text) {
      message = { text: input.text };
    } else {
      throw bad("text or media is required (templates are not sent through this adapter).");
    }
    const token = env(TOKEN);
    const page = input.from || env(PAGE);
    if (!token || !page) {
      throw new ProviderNotConfigured(this.id, "messenger", `Meta Messenger is not configured: set ${[!page ? PAGE : "", !token ? TOKEN : ""].filter(Boolean).join(" and ")}.`);
    }
    const version = env(VERSION) || DEFAULT_VERSION;
    const body: Record<string, unknown> = { recipient: { id: psid }, messaging_type: type, message };
    if (input.tag) body.tag = input.tag;

    let res: Response;
    try {
      res = await fetch(`https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(page)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const e = err as Error;
      if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new ProviderError(this.id, 504, `Meta: no answer within ${TIMEOUT_MS / 1000} s.`);
      throw new ProviderError(this.id, 502, cut(`Meta: request failed: ${e?.message || String(err)}`));
    }
    const text = await res.text();
    if (!res.ok) {
      // {"error":{"message":"…","type":"OAuthException","code":100,"error_subcode":…,"fbtrace_id":"…"}}
      let message = text || res.statusText;
      let code: string | undefined;
      try {
        const e = (JSON.parse(text) as { error?: { message?: string; code?: number | string } }).error;
        if (e?.message) message = e.message;
        if (e?.code !== undefined) code = String(e.code);
      } catch { /* not JSON */ }
      throw new ProviderError(this.id, res.status, cut(`Meta ${res.status}: ${message}`), code);
    }
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ProviderError(this.id, 502, cut(`Meta ${res.status}: the answer is not JSON: ${text}`));
    }
    return { id: String(j.message_id ?? ""), provider: this.id, channel: "messenger", status: "sent", raw: j };
  }
}
