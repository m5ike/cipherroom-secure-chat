// What the TSA runtime does to the world (6.9), behind one object: speech
// (AI & speech TTS / STT), a provider's recording, an SMS, a notice into a
// room, an HTTP request, a Functions model, steering a live call, a SIP
// trunk's credentials, the clock. The real ones load their modules lazily (a
// test of the runtime needs none of them); tests replace any of them with
// setTsaDeps(); the main service adds the room notifier (it owns the rooms).

import { httpRequest } from "../../functions/host-net";
import type { CallAction } from "../providers/types";
import { bytesOfDataUrl } from "./files";

export type MemberTarget = { peerId?: string; accountId?: string; name?: string };
export type RoomNotice = { kind: "message"; text: string; level?: string; from?: string };
export type TrunkCredentials = { id: string; host: string; username?: string; password?: string; transport?: "udp" | "tcp" | "tls" };

export type TsaDeps = {
  now(): number;
  random(): number;
  /** Text to speech (AI & speech); `console` for the simulator (the console's own use, counted, not limited). */
  tts(input: { text: string; voice?: string; language?: string; console: boolean; actor: string }): Promise<{ audio: Uint8Array; mime: string }>;
  stt(input: { audio: Uint8Array; mime: string; language?: string; console: boolean; actor: string }): Promise<string>;
  /** A provider's recording (its auth where the URL is the provider's), or a data: URL in the simulator. */
  fetchRecording(provider: string, url: string, opts: { allowData: boolean }): Promise<{ bytes: Uint8Array; mime: string }>;
  sendSms(input: { to: string; from?: string; text: string }): Promise<{ id: string; status: string }>;
  /** Posts a server notice into a room (main service only; null elsewhere). Returns how many got it. */
  notice: ((roomHash: string, n: RoomNotice, target?: MemberTarget) => number) | null;
  http(spec: { method: string; url: string; headers: Record<string, string>; body?: string; timeoutMs: number; maxBytes: number }): Promise<{ status: number; text: string; json?: unknown }>;
  /** Runs a Functions model's execute entry; its result. */
  runFunction(modelId: string, inputs: Record<string, unknown>, opts: { timeoutMs: number; name: string; lang: string }): Promise<unknown>;
  /** Gives a live call new logic now (a stream that plays for N seconds). */
  steer(callId: string, actions: CallAction[]): Promise<void>;
  /** A SIP trunk: host and user always, the password only `withSecret`. */
  trunk(id: string, withSecret: boolean): Promise<TrunkCredentials | null>;
};

const env = (name: string): string => process.env[name]?.trim() || "";

function aiCaller(console: boolean, actor: string) {
  return { source: (console ? "test" : "function") as "test" | "function", actor: actor.slice(0, 80), account: "", groups: ["user"], console };
}

/** Which credentials a recording URL gets: only the provider's own hosts ever see them. */
async function recordingAuth(provider: string, u: URL): Promise<Record<string, string>> {
  const host = u.hostname.toLowerCase();
  if (provider === "twilio" && (host === "api.twilio.com" || host.endsWith(".twilio.com"))) {
    const sid = env("TWILIO_ACCOUNT_SID"), token = env("TWILIO_AUTH_TOKEN");
    return sid && token ? { authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` } : {};
  }
  if (provider === "vonage" && (host.endsWith(".nexmo.com") || host === "api.nexmo.com" || host.endsWith(".vonage.com"))) {
    try {
      const { vonageJwt } = await import("../connectors");
      return { authorization: `Bearer ${vonageJwt(300)}` };
    } catch { return {}; }
  }
  return {};
}

function trunkFromEnv(id: string): { password?: string } | null {
  try {
    const arr = JSON.parse(env("SIP_TRUNKS") || "[]") as Array<{ id?: string; password?: string }>;
    return Array.isArray(arr) ? arr.find((t) => t && t.id === id) ?? null : null;
  } catch { return null; }
}

export const realDeps: TsaDeps = {
  now: () => Date.now(),
  random: () => Math.random(),

  async tts(input) {
    const { tts } = await import("../../ai/service");
    const out = await tts({ text: input.text, format: "wav", ...(input.voice ? { voice: input.voice } : {}) }, aiCaller(input.console, input.actor));
    return { audio: out.audio, mime: out.mime || "audio/wav" };
  },

  async stt(input) {
    const { stt } = await import("../../ai/service");
    const out = await stt({ audio: input.audio, mime: input.mime, ...(input.language ? { language: input.language.slice(0, 2) } : {}) }, aiCaller(input.console, input.actor));
    return String(out.text ?? "").trim();
  },

  async fetchRecording(provider, url, opts) {
    if (url.startsWith("data:")) {
      if (!opts.allowData) throw new Error("a data: URL is only for the simulator");
      const bytes = bytesOfDataUrl(url);
      if (!bytes) throw new Error("the recording is not base64");
      return { bytes: new Uint8Array(bytes), mime: /^data:([^;,]+)/.exec(url)?.[1] || "audio/wav" };
    }
    let u: URL;
    try { u = new URL(url); } catch { throw new Error("the recording URL is not a URL"); }
    if (u.protocol !== "https:") throw new Error("the recording URL is not https");
    // Twilio serves a recording as WAV when asked for it.
    if (provider === "twilio" && /\.twilio\.com$/i.test(u.hostname) && !/\.(wav|mp3)$/i.test(u.pathname)) u.pathname += ".wav";
    const headers = await recordingAuth(provider, u);
    const r = await httpRequest({ method: "GET", url: u.href, headers, timeoutMs: 20_000, maxBytes: 20 * 1024 * 1024 }, () => null);
    const status = Number(r.status);
    if (status < 200 || status >= 300) throw new Error(`the provider answered ${status} for the recording`);
    const body = r.body as { $b?: string } | undefined;
    const bytes = Buffer.from(body?.$b ?? "", "base64");
    const ctype = String((r.headers as Record<string, string> | undefined)?.["content-type"] ?? "").split(";")[0] || (u.pathname.endsWith(".mp3") ? "audio/mpeg" : "audio/wav");
    return { bytes: new Uint8Array(bytes), mime: ctype };
  },

  async sendSms(input) {
    const { sendMessage } = await import("../engine");
    const m = await sendMessage({ channel: "sms", to: input.to, ...(input.from ? { from: input.from } : {}), text: input.text, owner: null });
    return { id: m.id, status: m.status };
  },

  notice: null,

  async http(spec) {
    const r = await httpRequest({ method: spec.method, url: spec.url, headers: spec.headers, ...(spec.body !== undefined ? { body: spec.body } : {}), timeoutMs: spec.timeoutMs, maxBytes: spec.maxBytes, redirect: "error" }, () => null);
    return { status: Number(r.status), text: typeof r.text === "string" ? r.text : "", ...(r.json !== undefined ? { json: r.json } : {}) };
  },

  async runFunction(modelId, inputs, opts) {
    const { functionsStore } = await import("../../functions/store");
    const { execute } = await import("../../functions/runner");
    await functionsStore.ready();
    const model = functionsStore.model(modelId);
    if (!model) throw new Error(`no Functions model "${modelId}"`);
    if (!model.enabled) throw new Error(`the model "${modelId}" is switched off`);
    // m5.caller.kind = "telephony": not a person — the model's own grants apply (Functions › Beyond the caller).
    const caller = { kind: "telephony", account: "", name: opts.name, groups: [], room: null, client: null, lang: opts.lang, tz: "" } as unknown as Parameters<typeof execute>[2];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`the model did not answer within ${Math.round(opts.timeoutMs / 1000)} s`)), opts.timeoutMs); });
    try {
      const r = await Promise.race([execute(model, inputs, caller, { executor: "telephony", skipValidation: true }), late]);
      if (r.run.error) throw new Error(`the model failed: ${r.run.error.message}`.slice(0, 300));
      return r.result ?? null;
    } finally { if (timer) clearTimeout(timer); }
  },

  async steer(callId, actions) {
    const { getCall, execute } = await import("../engine");
    const call = await getCall(callId);
    if (call && !call.endedAt) await execute(call, actions);
  },

  async trunk(id, withSecret) {
    const { sipStore } = await import("../sip");
    sipStore.reloadIfChanged();
    const t = sipStore.get(id);
    if (!t) return null;
    const out: TrunkCredentials = { id: t.id, host: t.port && t.port !== 5060 ? `${t.host}:${t.port}` : t.host, ...(t.authUser || t.username ? { username: t.authUser || t.username } : {}) };
    if (withSecret && t.hasPassword) {
      // sip.ts never returns a password; the trunk's own record has it (the data file, or SIP_TRUNKS).
      const viaStore = (sipStore as unknown as { secret?: (id: string) => string | undefined }).secret?.(id);
      let password = typeof viaStore === "string" ? viaStore : "";
      if (!password) {
        const { loadTelephonyFile } = await import("../store");
        password = loadTelephonyFile().data.trunks.find((x) => x.id === id)?.password ?? trunkFromEnv(id)?.password ?? "";
      }
      if (password) out.password = password;
    }
    return out;
  },
};

let current: TsaDeps = { ...realDeps };

export function tsaDeps(): TsaDeps { return current; }

/** Tests (and the main service's room notifier): replace some of the dependencies. */
export function setTsaDeps(patch: Partial<TsaDeps>): void { current = { ...current, ...patch }; }

export function resetTsaDeps(): void { current = { ...realDeps }; }

/** The main service: how a room message reaches the room (the signaling hub). */
export function setTsaNotifier(fn: TsaDeps["notice"]): void { current = { ...current, notice: fn }; }
