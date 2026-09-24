// The AI & speech service (4.14): every call goes through here — the app's
// assistant, the console's playground and tests, later functions. It picks
// the provider and model, checks the module switch, who may use it (groups)
// and the limits, calls the adapter (streaming or not), counts usage and
// cost, and writes the call into the journal.

import { PROVIDER_TYPE } from "./catalog";
import {
  aiConfig, keyState, parseRef, providerBaseUrl, providerKey, refOf, saveAiConfig,
  type AiConfig, type ModelConfig, type ProviderConfig,
} from "./config";
import { journal, newCallId, type CallRecord, type CallSource, type CallStatus } from "./journal";
import { AnthropicAdapter } from "./providers/anthropic";
import { ElevenLabsAdapter } from "./providers/elevenlabs";
import { OllamaAdapter } from "./providers/ollama";
import { OpenAiAdapter } from "./providers/openai";
import { ProviderError } from "./net";
import {
  estimateTokens, type CallTrace, type ChatEvent, type ChatMessage, type ChatResult, type DiscoveredModel, type ModelKind, type ProviderAdapter, type Reasoning,
} from "./types";
import { switchState } from "../plugins/settings";
import { pluginLog } from "../plugins/log";

/** Who calls. The console (playground, tests) is not held to the switches, groups or limits — but is counted. */
export type Caller = { source: CallSource; actor: string; account: string; groups: string[]; console: boolean };

export type RefuseCode = "off" | "no-model" | "not-allowed" | "no-key" | "budget-unset" | "budget-exhausted" | "user-limit" | "too-long" | "bad-request";

const REFUSE_STATUS: Record<RefuseCode, number> = {
  off: 404, "no-model": 503, "not-allowed": 403, "no-key": 503, "budget-unset": 503, "budget-exhausted": 429, "user-limit": 429, "too-long": 413, "bad-request": 400,
};

/** A call that was not made (and why, in words the app can show). */
export class AiRefused extends Error {
  readonly status: number;
  constructor(readonly code: RefuseCode, message: string) {
    super(message);
    this.name = "AiRefused";
    this.status = REFUSE_STATUS[code];
  }
}

export type ChatInput = {
  /** "provider/model"; empty = the default chat model. */
  model?: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  reasoning?: Reasoning;
  json?: boolean;
  signal?: AbortSignal;
};

export type ChatOutcome = ChatResult & { callId: string; ref: string; ms: number; cost: number | null };

/* ------------------------------------------------------------- adapters */

export function adapterFor(p: ProviderConfig): ProviderAdapter {
  const base = providerBaseUrl(p);
  const key = providerKey(p);
  switch (PROVIDER_TYPE[p.type].protocol) {
    case "anthropic": return new AnthropicAdapter(base, key, p.label);
    case "ollama": return new OllamaAdapter(base, p.label);
    case "elevenlabs": return new ElevenLabsAdapter(base, key, p.label);
    default: return new OpenAiAdapter(p.type, base, key, p.label);
  }
}

/* ------------------------------------------------------------- choosing */

const allowed = (p: ProviderConfig, caller: Caller) => caller.console || p.groups.some((g) => caller.groups.includes(g));

/** The models of a kind this caller may use (enabled, on enabled providers with a key). */
export function modelsFor(caller: Caller, kind: ModelKind, config: AiConfig = aiConfig()): Array<{ ref: string; provider: ProviderConfig; model: ModelConfig }> {
  const out: Array<{ ref: string; provider: ProviderConfig; model: ModelConfig }> = [];
  for (const p of config.providers) {
    if (!p.enabled || !allowed(p, caller)) continue;
    const ks = keyState(p);
    if (ks === "missing" || ks === "unreadable") continue;
    for (const m of p.models) if (m.enabled && m.kind === kind) out.push({ ref: refOf(p.id, m.id), provider: p, model: m });
  }
  return out;
}

/** The provider and model for a call: the one asked for, else the default, else the first allowed. */
export function resolve(config: AiConfig, ref: string | undefined, kind: ModelKind, caller: Caller): { provider: ProviderConfig; model: ModelConfig; ref: string } {
  const asked = ref?.trim() ?? "";
  const fallback = kind === "chat" ? config.defaults.chat : kind === "tts" ? config.defaults.tts : kind === "stt" ? config.defaults.stt : "";
  // The default is only a preference: one this caller may not use is skipped (the first allowed one follows).
  if (!asked && fallback) {
    const usable = modelsFor(caller, kind, config).find((m) => m.ref === fallback);
    if (usable) return usable;
  }
  const parsed = asked ? parseRef(asked) : null;
  if (asked && !parsed) throw new AiRefused("no-model", `There is no model ${asked}.`);
  if (parsed) {
    const provider = config.providers.find((p) => p.id === parsed.provider);
    const model = provider?.models.find((m) => m.id === parsed.model && m.kind === kind);
    if (provider && model) {
      if (!caller.console && (!provider.enabled || !model.enabled)) throw new AiRefused("no-model", `The model ${asked} is switched off.`);
      if (!allowed(provider, caller)) throw new AiRefused("not-allowed", `The model ${asked} is not available to you.`);
      const ks = keyState(provider);
      if (ks === "missing") throw new AiRefused("no-key", `${provider.label} has no key yet.`);
      if (ks === "unreadable") throw new AiRefused("no-key", `${provider.label}'s key cannot be opened (was the server's storage key replaced?). Enter it again in the console.`);
      return { provider, model, ref: refOf(provider.id, model.id) };
    }
    if (!caller.console || !provider) throw new AiRefused("no-model", `There is no model ${asked}.`);
    // The console may try a model that is not in the list yet.
    const caps = provider.models[0]?.caps ?? { stream: true, reasoning: provider.type === "anthropic" ? "adaptive" as const : "none" as const, noSampling: false, vision: false, json: false, tools: false };
    return { provider, model: { id: parsed.model, label: "", kind, enabled: false, caps, price: null, source: "manual" }, ref: refOf(provider.id, parsed.model) };
  }
  const first = modelsFor(caller, kind, config)[0];
  if (!first) throw new AiRefused("no-model", kind === "chat" ? "No AI model is available — the operator adds one in the console (AI & speech)." : `No ${kind === "tts" ? "speech synthesis" : "transcription"} model is available.`);
  return first;
}

/** Whether the module is on and has a model of a kind (for the /api/modules manifest). */
export function aiReady(kind: ModelKind): boolean {
  const on = switchState(kind === "chat" ? "ai" : "speech").enabled;
  return on && modelsFor({ source: "app", actor: "", account: "", groups: [], console: true }, kind).length > 0;
}

/* ------------------------------------------------------------- limits */

export function monthStart(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
export function dayStart(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Refuses a call the limits do not allow (the console is exempt). */
export function checkLimits(config: AiConfig, caller: Caller, kind: ModelKind, now = Date.now()): void {
  if (caller.console) return;
  const l = config.limits;
  if (kind === "chat") {
    if (l.monthlyTokens === 0) throw new AiRefused("budget-unset", "The AI is off until the server's owner sets a monthly limit (console › AI & speech › Limits).");
    if (l.monthlyTokens !== null || l.monthlyUsd !== null) {
      const month = journal.usage(monthStart(now));
      if (l.monthlyTokens !== null && month.tokens >= l.monthlyTokens) throw new AiRefused("budget-exhausted", "This month's AI limit of the server is used up.");
      if (l.monthlyUsd !== null && month.usd >= l.monthlyUsd) throw new AiRefused("budget-exhausted", "This month's AI budget of the server is used up.");
    }
  }
  if (caller.account && (l.userDailyRequests !== null || l.userDailyTokens !== null)) {
    const day = journal.usage(dayStart(now), caller.account);
    if (l.userDailyRequests !== null && day.requests >= l.userDailyRequests) throw new AiRefused("user-limit", "You have used today's AI requests; more tomorrow.");
    if (kind === "chat" && l.userDailyTokens !== null && day.tokens >= l.userDailyTokens) throw new AiRefused("user-limit", "You have used today's AI tokens; more tomorrow.");
  }
}

function contentLogging(config: AiConfig, now = Date.now()): boolean {
  return config.journal.content.on && config.journal.content.until > now;
}

/** USD for a call, where the model has prices (cached input at a tenth of the input price). */
export function costOf(model: ModelConfig, tokensIn: number, tokensOut: number, cached = 0): number | null {
  if (!model.price) return null;
  return (tokensIn * model.price.in + tokensOut * model.price.out + cached * model.price.in * 0.1) / 1_000_000;
}

/* ------------------------------------------------------------- journal */

function baseRecord(caller: Caller, provider: ProviderConfig | null, model: string, kind: ModelKind): CallRecord {
  return {
    id: newCallId(), ts: Date.now(), source: caller.source, actor: caller.actor || "guest", account: caller.account, provider: provider?.id ?? "", providerType: provider?.type ?? "",
    model, kind, status: "ok", error: "", http: 0, ms: 0, ttft: 0, tokensIn: 0, tokensOut: 0, tokensReasoning: 0, tokensCached: 0, estimated: false,
    cost: null, charsIn: 0, charsOut: 0, stream: false, content: null,
  };
}

function finish(config: AiConfig, rec: CallRecord): void {
  try {
    journal.record(rec);
    journal.maybePrune(config.journal.retentionDays, contentLogging(config));
  } catch (err) {
    console.warn(`[ai] journal: ${(err as Error).message}`);
  }
  pluginLog.record({
    level: rec.status === "ok" ? "info" : rec.status === "refused" || rec.status === "cancelled" ? "warn" : "error",
    kind: rec.kind === "tts" ? "tts" : rec.kind === "stt" ? "stt" : "ai",
    connector: rec.provider,
    message: `${rec.source} ${rec.model} ${rec.status}${rec.error ? `: ${rec.error}` : ""}${rec.kind === "chat" ? ` · ${rec.tokensIn}+${rec.tokensOut} tokens` : ""}`,
    ms: rec.ms,
  });
}

function failure(rec: CallRecord, err: unknown, signal?: AbortSignal): void {
  if (err instanceof AiRefused) { rec.status = "refused"; rec.error = err.message; rec.http = err.status; return; }
  if (signal?.aborted) { rec.status = "cancelled"; rec.error = "cancelled"; return; }
  rec.status = "error";
  rec.error = (err as Error).message.slice(0, 500);
  rec.http = err instanceof ProviderError ? err.status : 0;
}

/** Records a refusal made before a model was chosen (the switch, a missing model). */
function refused(config: AiConfig, caller: Caller, kind: ModelKind, err: AiRefused, ref = ""): never {
  const rec = baseRecord(caller, null, ref, kind);
  failure(rec, err);
  finish(config, rec);
  throw err;
}

/* ------------------------------------------------------------- chat */

export async function chat(input: ChatInput, caller: Caller, onEvent?: (e: ChatEvent) => void, trace?: CallTrace[]): Promise<ChatOutcome> {
  await journal.ready();
  const config = aiConfig();
  if (!caller.console && !switchState("ai").enabled) refused(config, caller, "chat", new AiRefused("off", "The AI module is off. The operator turns it on in the console (AI & speech)."));
  let chosen: ReturnType<typeof resolve>;
  try { chosen = resolve(config, input.model, "chat", caller); } catch (err) { refused(config, caller, "chat", err as AiRefused, input.model ?? ""); }
  const { provider, model, ref } = chosen;
  const rec = baseRecord(caller, provider, model.id, "chat");
  const chars = (input.system?.length ?? 0) + input.messages.reduce((n, m) => n + m.content.length, 0);
  rec.charsIn = chars;
  rec.stream = Boolean(onEvent);
  const started = Date.now();
  try {
    if (!caller.console && chars > config.limits.maxInputChars) throw new AiRefused("too-long", `The conversation is too long (${chars} characters, at most ${config.limits.maxInputChars}); start a new one.`);
    checkLimits(config, caller, "chat");
    const cap = caller.console ? 200_000 : config.limits.maxOutputTokens;
    const maxTokens = Math.max(16, Math.min(input.maxTokens ?? cap, cap, model.maxOutput ?? Number.MAX_SAFE_INTEGER));
    const adapter = adapterFor(provider);
    if (!adapter.chat) throw new AiRefused("no-model", `${provider.label} does not chat.`);
    let first = 0;
    const result = await adapter.chat(
      { model: model.id, system: input.system, messages: input.messages, maxTokens, temperature: input.temperature, reasoning: input.reasoning, json: input.json, caps: model.caps, signal: input.signal },
      onEvent ? (e) => { if (!first) first = Date.now() - started; onEvent(e); } : undefined,
      trace,
    );
    const usage = { ...result.usage };
    if (usage.estimated || (usage.input === 0 && usage.output === 0)) {
      usage.input = estimateTokens(`${input.system ?? ""}${input.messages.map((m) => m.content).join("")}`);
      usage.output = estimateTokens(`${result.reasoning ?? ""}${result.text}`);
      usage.estimated = true;
    }
    rec.ms = Date.now() - started;
    rec.ttft = first;
    rec.tokensIn = usage.input;
    rec.tokensOut = usage.output;
    rec.tokensReasoning = usage.reasoning ?? 0;
    rec.tokensCached = usage.cachedInput ?? 0;
    rec.estimated = Boolean(usage.estimated);
    rec.cost = costOf(model, usage.input, usage.output, usage.cachedInput ?? 0);
    rec.charsOut = result.text.length;
    if (contentLogging(config)) rec.content = JSON.stringify({ system: input.system ?? "", messages: input.messages, reasoning: result.reasoning ?? "", answer: result.text }).slice(0, 200_000);
    finish(config, rec);
    return { ...result, usage, callId: rec.id, ref, ms: rec.ms, cost: rec.cost };
  } catch (err) {
    rec.ms = Date.now() - started;
    failure(rec, err, input.signal);
    if (contentLogging(config)) rec.content = JSON.stringify({ system: input.system ?? "", messages: input.messages }).slice(0, 200_000);
    finish(config, rec);
    throw err;
  }
}

/* ------------------------------------------------------------- speech */

export async function tts(input: { model?: string; text: string; voice?: string; format?: "mp3" | "wav" | "ogg"; signal?: AbortSignal }, caller: Caller) {
  await journal.ready();
  const config = aiConfig();
  if (!caller.console && !switchState("speech").enabled) refused(config, caller, "tts", new AiRefused("off", "The speech module is off."));
  let chosen: ReturnType<typeof resolve>;
  try { chosen = resolve(config, input.model, "tts", caller); } catch (err) { refused(config, caller, "tts", err as AiRefused, input.model ?? ""); }
  const { provider, model, ref } = chosen;
  const rec = baseRecord(caller, provider, model.id, "tts");
  rec.charsIn = input.text.length;
  const started = Date.now();
  try {
    checkLimits(config, caller, "tts");
    const adapter = adapterFor(provider);
    if (!adapter.tts) throw new AiRefused("no-model", `${provider.label} does not synthesize speech.`);
    const voice = input.voice || (config.defaults.tts === ref ? config.defaults.voice : "") || model.voices?.[0] || "";
    const out = await adapter.tts({ model: model.id, text: input.text, voice: voice || undefined, format: input.format, signal: input.signal });
    rec.ms = Date.now() - started;
    rec.cost = model.price ? (input.text.length * model.price.in) / 1_000_000 : null;
    finish(config, rec);
    return { ...out, callId: rec.id, ref, ms: rec.ms };
  } catch (err) {
    rec.ms = Date.now() - started;
    failure(rec, err, input.signal);
    finish(config, rec);
    throw err;
  }
}

export async function stt(input: { model?: string; audio: Uint8Array; mime: string; language?: string; signal?: AbortSignal }, caller: Caller) {
  await journal.ready();
  const config = aiConfig();
  if (!caller.console && !switchState("speech").enabled) refused(config, caller, "stt", new AiRefused("off", "The speech module is off."));
  let chosen: ReturnType<typeof resolve>;
  try { chosen = resolve(config, input.model, "stt", caller); } catch (err) { refused(config, caller, "stt", err as AiRefused, input.model ?? ""); }
  const { provider, model, ref } = chosen;
  const rec = baseRecord(caller, provider, model.id, "stt");
  const started = Date.now();
  try {
    checkLimits(config, caller, "stt");
    const adapter = adapterFor(provider);
    if (!adapter.stt) throw new AiRefused("no-model", `${provider.label} does not transcribe.`);
    const out = await adapter.stt({ model: model.id, audio: input.audio, mime: input.mime, language: input.language, signal: input.signal });
    rec.ms = Date.now() - started;
    rec.charsOut = out.text.length;
    if (contentLogging(config)) rec.content = JSON.stringify({ transcript: out.text }).slice(0, 200_000);
    finish(config, rec);
    return { ...out, callId: rec.id, ref, ms: rec.ms };
  } catch (err) {
    rec.ms = Date.now() - started;
    failure(rec, err, input.signal);
    finish(config, rec);
    throw err;
  }
}

/* ------------------------------------------------------------- the console's tools */

/** Fetches a provider's models and merges them into its list (new ones start switched off). */
export async function discover(providerId: string, actor: string): Promise<{ ok: true; added: number; updated: number; total: number } | { ok: false; message: string }> {
  const config = aiConfig();
  const p = config.providers.find((x) => x.id === providerId);
  if (!p) return { ok: false, message: "No such provider." };
  const adapter = adapterFor(p);
  if (!adapter.models) return { ok: false, message: `${p.label} has no list of models — add them by name.` };
  let found: DiscoveredModel[];
  try { found = await adapter.models(AbortSignal.timeout(30_000)); } catch (err) { return { ok: false, message: (err as Error).message }; }
  let added = 0; let updated = 0;
  const models = [...p.models];
  for (const d of found) {
    const at = models.findIndex((m) => m.id === d.id && m.kind === d.kind);
    if (at >= 0) {
      const m = models[at];
      models[at] = { ...m, label: m.label || d.label || "", caps: m.source === "manual" ? m.caps : { ...m.caps, ...(d.caps ?? {}) }, context: d.context ?? m.context, maxOutput: d.maxOutput ?? m.maxOutput, voices: d.voices ?? m.voices };
      updated += 1;
    } else {
      models.push({ id: d.id, label: d.label ?? "", kind: d.kind, enabled: false, caps: { stream: true, reasoning: "none", noSampling: false, vision: false, json: false, tools: false, ...(d.caps ?? {}) }, price: null, context: d.context, maxOutput: d.maxOutput, voices: d.voices, source: "discovered" });
      added += 1;
    }
  }
  const saved = saveAiConfig({ ...config, providers: config.providers.map((x) => (x.id === p.id ? { ...x, models, updatedAt: Date.now(), updatedBy: actor } : x)) }, actor);
  if (!saved.ok) return saved;
  return { ok: true, added, updated, total: found.length };
}

/** Whether a provider answers: its models list, or a two-word chat. Kept as the provider's last test. */
export async function testProvider(providerId: string, actor: string): Promise<{ ok: boolean; ms: number; message: string; models?: number }> {
  await journal.ready();
  const config = aiConfig();
  const p = config.providers.find((x) => x.id === providerId);
  if (!p) return { ok: false, ms: 0, message: "No such provider." };
  const started = Date.now();
  let result: { ok: boolean; ms: number; message: string; models?: number };
  const ks = keyState(p);
  if (ks === "missing" || ks === "unreadable") {
    result = { ok: false, ms: 0, message: ks === "missing" ? "No key yet." : "The key cannot be opened — enter it again." };
  } else {
    const adapter = adapterFor(p);
    try {
      if (adapter.models && PROVIDER_TYPE[p.type].discovery) {
        const list = await adapter.models(AbortSignal.timeout(20_000));
        result = { ok: true, ms: Date.now() - started, message: `answers — ${list.length} models`, models: list.length };
      } else {
        const m = p.models.find((x) => x.kind === "chat" && x.enabled) ?? p.models.find((x) => x.kind === "chat");
        if (!m) throw new Error("add a model to test with");
        const out = await chat({ model: refOf(p.id, m.id), messages: [{ role: "user", content: "Reply with the single word OK." }], maxTokens: 16, signal: AbortSignal.timeout(30_000) }, { source: "test", actor, account: "", groups: [], console: true });
        result = { ok: true, ms: Date.now() - started, message: `answers — “${out.text.slice(0, 40)}”` };
      }
    } catch (err) {
      result = { ok: false, ms: Date.now() - started, message: (err as Error).message.slice(0, 400) };
    }
  }
  const fresh = aiConfig();
  saveAiConfig({ ...fresh, providers: fresh.providers.map((x) => (x.id === p.id ? { ...x, lastTest: { at: Date.now(), ok: result.ok, ms: result.ms, message: result.message } } : x)) }, actor);
  return result;
}

export type { CallStatus };
