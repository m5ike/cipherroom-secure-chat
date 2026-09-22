// Connector contracts for the optional server-side AI / speech modules.
//
// A "connector" wraps one provider (OpenAI, Anthropic, HuggingFace, Ollama,
// ElevenLabs, …). It is created from operator-supplied environment config and
// reports whether it is usable. NO API KEY IS EVER hard-coded or returned to a
// client: keys live only in the server process env, connectors read them, and
// status() exposes only whether the key is present, never its value.

export type ConnectorKind = "ai" | "tts" | "stt";

export type ConnectorStatus = {
  id: string;
  kind: ConnectorKind;
  label: string;
  configured: boolean;
  /** Human reason when not configured (which env var to set). */
  reason?: string;
  /** The model/voice the connector will use, if resolvable without a secret. */
  model?: string;
  /** Names of the env vars this connector reads (never their values). */
  needs: string[];
};

export type AiMessage = { role: "system" | "user" | "assistant"; content: string };
export type AiInput = { messages: AiMessage[]; model?: string; temperature?: number; maxTokens?: number };
export type AiResult = { text: string; model: string; connector: string };

export type TtsInput = { text: string; voice?: string; format?: "mp3" | "wav" | "ogg" };
export type TtsResult = { audioBase64: string; mime: string; connector: string };

export type SttInput = { audio: Uint8Array; mime: string; language?: string };
export type SttResult = { text: string; connector: string };

export interface BaseConnector {
  readonly id: string;
  readonly kind: ConnectorKind;
  readonly label: string;
  readonly needs: string[];
  status(): ConnectorStatus;
}

export interface AiConnector extends BaseConnector {
  readonly kind: "ai";
  complete(input: AiInput): Promise<AiResult>;
}

export interface TtsConnector extends BaseConnector {
  readonly kind: "tts";
  synthesize(input: TtsInput): Promise<TtsResult>;
}

export interface SttConnector extends BaseConnector {
  readonly kind: "stt";
  transcribe(input: SttInput): Promise<SttResult>;
}

export type AnyConnector = AiConnector | TtsConnector | SttConnector;

/** Thrown when a connector is invoked without its required configuration. */
export class ConnectorNotConfiguredError extends Error {
  constructor(public connectorId: string, reason: string) {
    super(reason);
    this.name = "ConnectorNotConfiguredError";
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  // Node has Buffer; this module only runs server-side.
  return Buffer.from(bytes).toString("base64");
}
export function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
