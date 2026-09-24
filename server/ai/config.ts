// The AI & speech configuration (4.14), kept in $DATA_DIR/ai/config.json
// (AI_CONFIG_FILE moves it) and read by the app and the admin service alike:
//
//   providers   each with its type, address, key (sealed with the server's
//               storage key — the file alone does not give it away), who may
//               use it (groups) and its models (what they can do, prices)
//   defaults    the chat, speech synthesis and transcription model
//   limits      monthly tokens / USD for the instance (0 tokens = AI off until
//               the owner sets a limit), per user and day, sizes
//   journal     how long calls are kept; whether their content is (for a
//               while, to debug)
//
// A key set in the environment (OPENAI_API_KEY… as before 4.14) still works:
// it shows up as a provider "from the environment" whose key and address
// stay there; its models and groups are set here like any other's.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { sealValue, openValue } from "../storage/keys";
import { PROVIDER_TYPE, PROVIDER_TYPES, isProviderType } from "./catalog";
import { DEFAULT_CAPS, type ModelCaps, type ModelKind, type ProviderType } from "./types";

export type ModelConfig = {
  id: string;
  label: string;
  kind: ModelKind;
  enabled: boolean;
  caps: ModelCaps;
  /** USD per million tokens (TTS: per million characters); null = unknown. */
  price: { in: number; out: number } | null;
  context?: number;
  maxOutput?: number;
  voices?: string[];
  source: "discovered" | "manual" | "env";
};

export type ProviderConfig = {
  id: string;
  type: ProviderType;
  label: string;
  /** "" = the type's usual address. */
  baseUrl: string;
  /** The key, sealed (base64); null = none. Never leaves the server. */
  key: string | null;
  /** The key's last four characters, for the console. */
  keyHint: string;
  enabled: boolean;
  /** Who may use it in the app ("user" = signed in, "guest", own groups). */
  groups: string[];
  models: ModelConfig[];
  source: "console" | "env";
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
  lastTest?: { at: number; ok: boolean; ms: number; message: string };
};

export type AiLimits = {
  /** Tokens a month for the whole instance: null = no limit, 0 = AI off. */
  monthlyTokens: number | null;
  /** USD a month (counted where models have prices): null = no limit. */
  monthlyUsd: number | null;
  userDailyRequests: number | null;
  userDailyTokens: number | null;
  /** The most one answer may be (the app asks for less). */
  maxOutputTokens: number;
  /** The most a conversation sent at once may be. */
  maxInputChars: number;
};

export type AiConfig = {
  version: 1;
  providers: ProviderConfig[];
  /** "provider/model" references. */
  defaults: { chat: string; tts: string; stt: string; voice: string };
  limits: AiLimits;
  journal: { retentionDays: number; content: { on: boolean; until: number; by: string } };
  /** Guidance given to every chat of the app's assistant. */
  assistant: { system: string };
  updatedAt: number;
  updatedBy: string;
};

export const DEFAULT_LIMITS: AiLimits = { monthlyTokens: 0, monthlyUsd: null, userDailyRequests: 200, userDailyTokens: null, maxOutputTokens: 2048, maxInputChars: 24_000 };

export const AI_LIMITS = { providers: 30, models: 400, label: 80, url: 300, key: 400, voices: 200, system: 4000 } as const;

export function defaultAiConfig(): AiConfig {
  return {
    version: 1,
    providers: [],
    defaults: { chat: "", tts: "", stt: "", voice: "" },
    limits: { ...DEFAULT_LIMITS },
    journal: { retentionDays: 30, content: { on: false, until: 0, by: "" } },
    assistant: { system: "" },
    updatedAt: 0,
    updatedBy: "",
  };
}

const env = (name: string | undefined): string => (name ? process.env[name]?.trim() || "" : "");

export function aiDataDir(): string {
  const explicit = process.env.AI_DATA_DIR?.trim();
  if (explicit) return resolve(explicit);
  const data = process.env.DATA_DIR?.trim();
  return data ? resolve(data, "ai") : resolve(process.cwd(), ".m5cet", "ai");
}

export function aiConfigPath(): string {
  const explicit = process.env.AI_CONFIG_FILE?.trim();
  return explicit ? resolve(explicit) : resolve(aiDataDir(), "config.json");
}

/* ------------------------------------------------------------- sanitizing */

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const GROUP_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MODEL_ID_RE = /^[\w.:@/+-]{1,160}$/;

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null);

export function sanitizeCaps(raw: unknown, base: ModelCaps = DEFAULT_CAPS): ModelCaps {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const bool = (k: keyof ModelCaps) => (typeof r[k] === "boolean" ? (r[k] as boolean) : (base[k] as boolean));
  return {
    stream: bool("stream"),
    reasoning: r.reasoning === "none" || r.reasoning === "budget" || r.reasoning === "adaptive" ? r.reasoning : base.reasoning,
    noSampling: bool("noSampling"),
    vision: bool("vision"),
    json: bool("json"),
    tools: bool("tools"),
  };
}

export function sanitizeModel(raw: unknown): ModelConfig | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = str(r.id, 160);
  if (!MODEL_ID_RE.test(id)) return null;
  const kind: ModelKind = r.kind === "tts" || r.kind === "stt" || r.kind === "embed" ? r.kind : "chat";
  const p = r.price as Record<string, unknown> | null | undefined;
  const pin = p ? num(p.in, 0, 10_000) : null;
  const pout = p ? num(p.out, 0, 10_000) : null;
  const voices = Array.isArray(r.voices) ? r.voices.filter((v): v is string => typeof v === "string").map((v) => v.slice(0, 120)).slice(0, AI_LIMITS.voices) : undefined;
  return {
    id,
    label: str(r.label, AI_LIMITS.label),
    kind,
    enabled: r.enabled === true,
    caps: sanitizeCaps(r.caps),
    price: pin !== null || pout !== null ? { in: pin ?? 0, out: pout ?? 0 } : null,
    context: num(r.context, 0, 100_000_000) ?? undefined,
    maxOutput: num(r.maxOutput, 0, 10_000_000) ?? undefined,
    voices: voices && voices.length ? voices : undefined,
    source: r.source === "discovered" || r.source === "env" ? r.source : "manual",
  };
}

export function sanitizeGroups(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ["user"];
  return [...new Set(raw.filter((g): g is string => typeof g === "string" && GROUP_RE.test(g)))].slice(0, 40);
}

/** An http(s) address without credentials; "" when it is not one. */
export function sanitizeBaseUrl(raw: unknown): string {
  const v = str(raw, AI_LIMITS.url);
  if (!v) return "";
  try {
    const u = new URL(v);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) return "";
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

function sanitizeProvider(raw: unknown): ProviderConfig | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = str(r.id, 40);
  if (!ID_RE.test(id) || !isProviderType(r.type)) return null;
  const models: ModelConfig[] = [];
  const seen = new Set<string>();
  for (const m of Array.isArray(r.models) ? r.models : []) {
    const clean = sanitizeModel(m);
    if (clean && !seen.has(`${clean.kind}:${clean.id}`)) { seen.add(`${clean.kind}:${clean.id}`); models.push(clean); }
    if (models.length >= AI_LIMITS.models) break;
  }
  const lt = r.lastTest as Record<string, unknown> | undefined;
  return {
    id,
    type: r.type,
    label: str(r.label, AI_LIMITS.label) || PROVIDER_TYPE[r.type].label,
    baseUrl: sanitizeBaseUrl(r.baseUrl),
    key: typeof r.key === "string" && /^[A-Za-z0-9+/=]{20,2000}$/.test(r.key) ? r.key : null,
    keyHint: str(r.keyHint, 8),
    enabled: r.enabled !== false,
    groups: sanitizeGroups(r.groups),
    models,
    source: r.source === "env" ? "env" : "console",
    createdAt: num(r.createdAt, 0, 1e15) ?? 0,
    updatedAt: num(r.updatedAt, 0, 1e15) ?? 0,
    updatedBy: str(r.updatedBy, 120),
    lastTest: lt && typeof lt.at === "number" ? { at: lt.at, ok: lt.ok === true, ms: num(lt.ms, 0, 1e9) ?? 0, message: str(lt.message, 400) } : undefined,
  };
}

export function sanitizeLimits(raw: unknown): AiLimits {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const opt = (k: keyof AiLimits, max: number) => (r[k] === null ? null : num(r[k], 0, max) ?? (DEFAULT_LIMITS[k] as number | null));
  return {
    monthlyTokens: opt("monthlyTokens", 1e13),
    monthlyUsd: opt("monthlyUsd", 1e9),
    userDailyRequests: opt("userDailyRequests", 1e9),
    userDailyTokens: opt("userDailyTokens", 1e13),
    maxOutputTokens: Math.round(num(r.maxOutputTokens, 16, 200_000) ?? DEFAULT_LIMITS.maxOutputTokens),
    maxInputChars: Math.round(num(r.maxInputChars, 500, 2_000_000) ?? DEFAULT_LIMITS.maxInputChars),
  };
}

export function sanitizeAiConfig(raw: unknown): AiConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const base = defaultAiConfig();
  const providers: ProviderConfig[] = [];
  const ids = new Set<string>();
  for (const p of Array.isArray(r.providers) ? r.providers : []) {
    const clean = sanitizeProvider(p);
    if (clean && !ids.has(clean.id)) { ids.add(clean.id); providers.push(clean); }
    if (providers.length >= AI_LIMITS.providers) break;
  }
  const d = (r.defaults && typeof r.defaults === "object" ? r.defaults : {}) as Record<string, unknown>;
  const j = (r.journal && typeof r.journal === "object" ? r.journal : {}) as Record<string, unknown>;
  const c = (j.content && typeof j.content === "object" ? j.content : {}) as Record<string, unknown>;
  const a = (r.assistant && typeof r.assistant === "object" ? r.assistant : {}) as Record<string, unknown>;
  return {
    version: 1,
    providers,
    defaults: { chat: str(d.chat, 220), tts: str(d.tts, 220), stt: str(d.stt, 220), voice: str(d.voice, 120) },
    limits: r.limits === undefined ? base.limits : sanitizeLimits(r.limits),
    journal: {
      retentionDays: Math.round(num(j.retentionDays, 1, 3650) ?? base.journal.retentionDays),
      content: { on: c.on === true, until: num(c.until, 0, 1e15) ?? 0, by: str(c.by, 120) },
    },
    assistant: { system: typeof a.system === "string" ? a.system.slice(0, AI_LIMITS.system) : "" },
    updatedAt: num(r.updatedAt, 0, 1e15) ?? 0,
    updatedBy: str(r.updatedBy, 120),
  };
}

/* ------------------------------------------------------------- the store */

let cache: { sig: string; file: string; config: AiConfig } | null = null;

function fileSig(file: string): string {
  try { const st = statSync(file); return `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { return ""; }
}

/** The configuration as stored, with the providers of the environment added. */
export function aiConfig(): AiConfig {
  const file = aiConfigPath();
  const sig = fileSig(file);
  if (cache && cache.sig === sig && cache.file === file) return cache.config;
  let stored = defaultAiConfig();
  try { stored = sanitizeAiConfig(JSON.parse(readFileSync(file, "utf8"))); } catch { /* none yet, or unreadable → defaults */ }
  const config = withEnvProviders(stored);
  cache = { sig, file, config };
  return config;
}

/** Saves (atomic, 0600). The environment's providers keep only what is set here. */
export function saveAiConfig(next: AiConfig, actor: string): { ok: true; config: AiConfig } | { ok: false; message: string } {
  const clean = sanitizeAiConfig({ ...next, updatedAt: Date.now(), updatedBy: actor.slice(0, 120) });
  const file = aiConfigPath();
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
    cache = null;
    return { ok: true, config: aiConfig() };
  } catch (err) {
    return { ok: false, message: `cannot write ${file}: ${(err as Error).message}` };
  }
}

/** The environment's providers (as before 4.14), merged with what the console set for them. */
function withEnvProviders(stored: AiConfig): AiConfig {
  const providers = [...stored.providers.filter((p) => p.source !== "env" || envPresent(p.type))];
  for (const def of PROVIDER_TYPES) {
    if (!def.env || !envPresent(def.type)) continue;
    const id = `env-${def.type}`;
    let p = providers.find((x) => x.id === id);
    if (!p) {
      p = {
        id, type: def.type, label: `${def.label} (environment)`, baseUrl: "", key: null, keyHint: "", enabled: true, groups: ["user"],
        models: [], source: "env", createdAt: 0, updatedAt: 0, updatedBy: "",
      };
      providers.push(p);
    }
    // The models the environment names are there (enabled) unless the console changed them.
    const named: Array<[string, ModelKind]> = [[env(def.env.model), "chat"], [env(def.env.tts), "tts"], [env(def.env.stt), "stt"]];
    if (def.type === "openai") {
      if (!env(def.env.model)) named.push(["gpt-4o-mini", "chat"]);
      if (!env(def.env.tts)) named.push(["tts-1", "tts"]);
      if (!env(def.env.stt)) named.push(["whisper-1", "stt"]);
    }
    if (def.type === "anthropic" && !env(def.env.model)) named.push(["claude-sonnet-5", "chat"]);
    if (def.type === "ollama" && !env(def.env.model)) named.push(["llama3.1", "chat"]);
    if (def.type === "huggingface") {
      if (!env(def.env.model)) named.push(["meta-llama/Llama-3.1-8B-Instruct", "chat"]);
      if (!env(def.env.stt)) named.push(["openai/whisper-large-v3", "stt"]);
    }
    if (def.type === "elevenlabs" && !env(def.env.model)) named.push(["eleven_multilingual_v2", "tts"]);
    for (const [model, kind] of named) {
      if (!model || p.models.some((m) => m.id === model && m.kind === kind)) continue;
      p.models.push({ id: model, label: "", kind, enabled: true, caps: { ...DEFAULT_CAPS, reasoning: def.type === "anthropic" ? "adaptive" : "none" }, price: null, source: "env" });
    }
  }
  return { ...stored, providers };
}

function envPresent(type: ProviderType): boolean {
  const e = PROVIDER_TYPE[type].env;
  if (!e) return false;
  // Ollama has no key: its address is what makes it present.
  return type === "ollama" ? Boolean(env(e.baseUrl)) : Boolean(env(e.key));
}

/* ------------------------------------------------------------- keys */

const aad = (providerId: string) => `m5cet-ai-credential:${providerId}`;

/** Seals a key for a provider (throws when the server's storage key cannot be loaded). */
export function sealKey(providerId: string, key: string): { key: string; keyHint: string } {
  const clean = key.trim().slice(0, AI_LIMITS.key);
  return { key: sealValue(clean, aad(providerId)).toString("base64"), keyHint: clean.length > 8 ? clean.slice(-4) : "" };
}

/** The key a provider calls with: sealed in the console, or from the environment. */
export function providerKey(p: ProviderConfig): string {
  if (p.source === "env") return env(PROVIDER_TYPE[p.type].env?.key);
  if (!p.key) return "";
  return openValue(Buffer.from(p.key, "base64"), aad(p.id)) ?? "";
}

/** The address a provider calls: set here, from the environment, or the type's usual one. */
export function providerBaseUrl(p: ProviderConfig): string {
  if (p.source === "env") {
    const fromEnv = env(PROVIDER_TYPE[p.type].env?.baseUrl);
    if (fromEnv) return fromEnv.replace(/\/+$/, "");
  }
  return p.baseUrl || PROVIDER_TYPE[p.type].baseUrl;
}

/** Whether the key a provider needs is there (and opens). */
export function keyState(p: ProviderConfig): "ok" | "missing" | "unreadable" | "not-needed" {
  const need = PROVIDER_TYPE[p.type].key;
  const k = (() => { try { return providerKey(p); } catch { return ""; } })();
  if (k) return "ok";
  if (p.source === "console" && p.key) return "unreadable";
  return need === "required" ? "missing" : "not-needed";
}

/* ------------------------------------------------------------- references */

/** "provider/model" → its parts (a model id may contain "/"). */
export function parseRef(ref: string): { provider: string; model: string } | null {
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1) return null;
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

export function refOf(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

/** A new provider id from its label or type. */
export function newProviderId(config: AiConfig, base: string): string {
  const slug = base.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").replace(/[\s_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "provider";
  let id = slug;
  for (let i = 2; config.providers.some((p) => p.id === id); i++) id = `${slug}-${i}`;
  return id;
}
