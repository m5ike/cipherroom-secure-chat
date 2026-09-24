// The kinds of provider an operator can add (4.14), with what each needs:
// an address, a key, which protocol it speaks, which kinds of model it has,
// and the environment variables earlier versions read (a key set there still
// works — it shows up as a read-only provider).

import type { ModelKind, ProviderType } from "./types";

export type Protocol = "anthropic" | "openai" | "ollama" | "elevenlabs";

export type ProviderTypeDef = {
  type: ProviderType;
  label: string;
  protocol: Protocol;
  /** Where it usually is (the console fills it in; local servers are guesses to adjust). */
  baseUrl: string;
  key: "required" | "optional" | "none";
  kinds: ModelKind[];
  /** The provider lists its models (the console can fetch them). */
  discovery: boolean;
  /** Where to get a key / how to run it. */
  hint: string;
  /** Model names to start with when the provider has no list of its own. */
  suggested?: string[];
  /** The variables of earlier versions: a key there makes an "env" provider. */
  env?: { key?: string; baseUrl?: string; model?: string; tts?: string; stt?: string; voice?: string };
};

export const PROVIDER_TYPES: readonly ProviderTypeDef[] = [
  {
    type: "anthropic", label: "Anthropic (Claude)", protocol: "anthropic", baseUrl: "https://api.anthropic.com", key: "required", kinds: ["chat"], discovery: true,
    hint: "A key from console.anthropic.com → API keys.",
    env: { key: "ANTHROPIC_API_KEY", baseUrl: "ANTHROPIC_BASE_URL", model: "ANTHROPIC_MODEL" },
  },
  {
    type: "openai", label: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1", key: "required", kinds: ["chat", "tts", "stt", "embed"], discovery: true,
    hint: "A key from platform.openai.com → API keys.",
    env: { key: "OPENAI_API_KEY", baseUrl: "OPENAI_BASE_URL", model: "OPENAI_MODEL", tts: "OPENAI_TTS_MODEL", stt: "OPENAI_STT_MODEL", voice: "OPENAI_TTS_VOICE" },
  },
  {
    type: "openwebui", label: "Open WebUI", protocol: "openai", baseUrl: "http://127.0.0.1:3000/api", key: "required", kinds: ["chat"], discovery: true,
    hint: "The instance's address with /api, and a key from Settings → Account → API keys.",
  },
  {
    type: "perplexity", label: "Perplexity", protocol: "openai", baseUrl: "https://api.perplexity.ai", key: "required", kinds: ["chat"], discovery: false,
    hint: "A key from perplexity.ai → API. Answers come with their sources.",
    suggested: ["sonar", "sonar-pro", "sonar-reasoning-pro", "sonar-deep-research"],
  },
  {
    type: "ollama", label: "Ollama", protocol: "ollama", baseUrl: "http://127.0.0.1:11434", key: "none", kinds: ["chat", "embed"], discovery: true,
    hint: "A local Ollama (ollama serve); models with `ollama pull`.",
    env: { baseUrl: "OLLAMA_URL", model: "OLLAMA_MODEL" },
  },
  {
    type: "llamacpp", label: "llama.cpp server", protocol: "openai", baseUrl: "http://127.0.0.1:8080/v1", key: "optional", kinds: ["chat"], discovery: true,
    hint: "llama-server -m model.gguf (a key only when started with --api-key).",
  },
  {
    type: "gpt4all", label: "GPT4All", protocol: "openai", baseUrl: "http://127.0.0.1:4891/v1", key: "none", kinds: ["chat"], discovery: true,
    hint: "GPT4All with Settings → Enable Local API Server.",
  },
  {
    type: "huggingface", label: "Hugging Face", protocol: "openai", baseUrl: "https://router.huggingface.co", key: "required", kinds: ["chat", "stt"], discovery: true,
    hint: "A token from huggingface.co → Settings → Access Tokens (Inference Providers). A model may name a provider or a policy: …:fastest, …:cheapest.",
    env: { key: "HF_API_KEY", baseUrl: "HF_BASE_URL", model: "HF_TEXT_MODEL", stt: "HF_ASR_MODEL" },
  },
  {
    type: "openai-compatible", label: "Other OpenAI-compatible (vLLM, LM Studio, LocalAI…)", protocol: "openai", baseUrl: "", key: "optional", kinds: ["chat", "tts", "stt", "embed"], discovery: true,
    hint: "The address up to /v1 of any server with the OpenAI API.",
  },
  {
    type: "elevenlabs", label: "ElevenLabs", protocol: "elevenlabs", baseUrl: "https://api.elevenlabs.io", key: "required", kinds: ["tts"], discovery: true,
    hint: "A key from elevenlabs.io → Profile → API key.",
    env: { key: "ELEVENLABS_API_KEY", model: "ELEVENLABS_MODEL", voice: "ELEVENLABS_VOICE" },
  },
];

export const PROVIDER_TYPE: Readonly<Record<ProviderType, ProviderTypeDef>> = Object.fromEntries(PROVIDER_TYPES.map((d) => [d.type, d])) as Record<ProviderType, ProviderTypeDef>;

export function isProviderType(v: unknown): v is ProviderType {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(PROVIDER_TYPE, v);
}

/** The chat endpoint of an OpenAI-speaking provider. */
export function openAiPaths(type: ProviderType, base: string): { chat: string; models: string; speech: string; transcriptions: string } {
  const b = base.replace(/\/+$/, "");
  // Hugging Face's router: chat under /v1, speech recognition per model (see providers/openai.ts).
  const root = type === "huggingface" ? `${b}/v1` : b;
  return { chat: `${root}/chat/completions`, models: `${root}/models`, speech: `${root}/audio/speech`, transcriptions: `${root}/audio/transcriptions` };
}
