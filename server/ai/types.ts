// The AI & speech layer (4.14): one interface for every provider — chat with
// streaming, reasoning and usage; the models a provider offers; speech.
// Adapters (providers/*) speak each provider's HTTP API; the service
// (service.ts) picks one, checks who may use it and the limits, and records
// every call in the journal.

export type ProviderType =
  | "anthropic" | "openai" | "openwebui" | "perplexity" | "ollama" | "llamacpp" | "gpt4all" | "huggingface" | "openai-compatible" | "elevenlabs";

export type ModelKind = "chat" | "tts" | "stt" | "embed";

/** How much a model thinks before it answers ("off": the provider's least). */
export type Reasoning = "off" | "low" | "medium" | "high";
export const REASONING_LEVELS: readonly Reasoning[] = ["off", "low", "medium", "high"];

/** What a model can do (from the provider's model list, or set in the console). */
export type ModelCaps = {
  stream: boolean;
  /** Reasoning control: none, a token budget ("enabled"), or adaptive with effort. */
  reasoning: "none" | "budget" | "adaptive";
  /** The model refuses sampling parameters (temperature, top_p). */
  noSampling: boolean;
  vision: boolean;
  json: boolean;
  tools: boolean;
};

export const DEFAULT_CAPS: ModelCaps = { stream: true, reasoning: "none", noSampling: false, vision: false, json: false, tools: false };

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type ChatRequest = {
  model: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  reasoning?: Reasoning;
  /** Ask for a JSON answer where the provider can enforce it. */
  json?: boolean;
  caps?: ModelCaps;
  signal?: AbortSignal;
};

export type Usage = {
  input: number;
  output: number;
  reasoning?: number;
  cachedInput?: number;
  /** Counted here (about 4 characters a token): the provider did not say. */
  estimated?: boolean;
};

export type Citation = { url: string; title?: string };

export type ChatResult = {
  text: string;
  reasoning?: string;
  usage: Usage;
  model: string;
  finish: string;
  citations?: Citation[];
};

/** What a streaming call reports as it goes. */
export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "citations"; citations: Citation[] };

/** A request as it went out (without the key), and how it came back — the console's playground shows it. */
export type CallTrace = { url: string; body: unknown; status: number; attempts: number };

export type DiscoveredModel = {
  id: string;
  label?: string;
  kind: ModelKind;
  caps?: Partial<ModelCaps>;
  context?: number;
  maxOutput?: number;
  voices?: string[];
};

export type TtsRequest = { model: string; text: string; voice?: string; format?: "mp3" | "wav" | "ogg"; signal?: AbortSignal };
export type TtsResult = { audio: Uint8Array; mime: string };
export type SttRequest = { model: string; audio: Uint8Array; mime: string; language?: string; signal?: AbortSignal };
export type SttResult = { text: string };

/** One provider, ready to call (built from its configuration and key). */
export interface ProviderAdapter {
  readonly type: ProviderType;
  chat?(req: ChatRequest, onEvent?: (e: ChatEvent) => void, trace?: CallTrace[]): Promise<ChatResult>;
  models?(signal?: AbortSignal): Promise<DiscoveredModel[]>;
  tts?(req: TtsRequest): Promise<TtsResult>;
  stt?(req: SttRequest): Promise<SttResult>;
}

/** About 4 characters a token — only when a provider reports no usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
