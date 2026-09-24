// Text-to-speech and speech-to-text connectors. Same rules as the AI ones:
// keys live in the environment, are never returned, and a connector without
// its key reports not-configured and refuses to run.

import { hfBase } from "./ai";
import { postRaw } from "../http";
import {
  ConnectorNotConfiguredError, bytesToBase64,
  type TtsConnector, type TtsInput, type TtsResult,
  type SttConnector, type SttInput, type SttResult, type ConnectorStatus,
} from "../types";

const env = (name: string): string => (process.env[name]?.trim() || "");

/** OpenAI TTS (tts-1 / tts-1-hd). */
export class OpenAiTtsConnector implements TtsConnector {
  readonly id = "openai";
  readonly kind = "tts" as const;
  readonly label = "OpenAI TTS";
  readonly needs = ["OPENAI_API_KEY", "OPENAI_TTS_MODEL", "OPENAI_TTS_VOICE"];
  private key() { return env("OPENAI_API_KEY"); }
  private base() { return env("OPENAI_BASE_URL") || "https://api.openai.com/v1"; }
  private model() { return env("OPENAI_TTS_MODEL") || "tts-1"; }
  private voice() { return env("OPENAI_TTS_VOICE") || "alloy"; }
  status(): ConnectorStatus {
    const ok = this.key().length > 0;
    return { id: this.id, kind: this.kind, label: this.label, configured: ok, model: `${this.model()} · ${this.voice()}`, needs: this.needs, reason: ok ? undefined : "Set OPENAI_API_KEY." };
  }
  async synthesize(input: TtsInput): Promise<TtsResult> {
    if (!this.key()) throw new ConnectorNotConfiguredError(this.id, "Set OPENAI_API_KEY.");
    const res = await postRaw("OpenAI TTS", `${this.base().replace(/\/$/, "")}/audio/speech`, { "Content-Type": "application/json", Authorization: `Bearer ${this.key()}` },
      JSON.stringify({ model: this.model(), voice: input.voice || this.voice(), input: input.text, response_format: input.format || "mp3" }));
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { audioBase64: bytesToBase64(bytes), mime: input.format === "wav" ? "audio/wav" : input.format === "ogg" ? "audio/ogg" : "audio/mpeg", connector: this.id };
  }
}

/** ElevenLabs TTS. Voice id comes from ELEVENLABS_VOICE or the request. */
export class ElevenLabsTtsConnector implements TtsConnector {
  readonly id = "elevenlabs";
  readonly kind = "tts" as const;
  readonly label = "ElevenLabs";
  readonly needs = ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE", "ELEVENLABS_MODEL"];
  private key() { return env("ELEVENLABS_API_KEY"); }
  private voice() { return env("ELEVENLABS_VOICE") || "21m00Tcm4TlvDq8ikWAM"; }
  private model() { return env("ELEVENLABS_MODEL") || "eleven_multilingual_v2"; }
  status(): ConnectorStatus {
    const ok = this.key().length > 0;
    return { id: this.id, kind: this.kind, label: this.label, configured: ok, model: this.model(), needs: this.needs, reason: ok ? undefined : "Set ELEVENLABS_API_KEY." };
  }
  async synthesize(input: TtsInput): Promise<TtsResult> {
    if (!this.key()) throw new ConnectorNotConfiguredError(this.id, "Set ELEVENLABS_API_KEY.");
    const voice = input.voice || this.voice();
    const res = await postRaw("ElevenLabs", `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`, { "Content-Type": "application/json", "xi-api-key": this.key(), Accept: "audio/mpeg" },
      JSON.stringify({ text: input.text, model_id: this.model() }));
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { audioBase64: bytesToBase64(bytes), mime: "audio/mpeg", connector: this.id };
  }
}

/** OpenAI Whisper transcription. */
export class OpenAiSttConnector implements SttConnector {
  readonly id = "openai";
  readonly kind = "stt" as const;
  readonly label = "OpenAI Whisper";
  readonly needs = ["OPENAI_API_KEY", "OPENAI_STT_MODEL"];
  private key() { return env("OPENAI_API_KEY"); }
  private base() { return env("OPENAI_BASE_URL") || "https://api.openai.com/v1"; }
  private model() { return env("OPENAI_STT_MODEL") || "whisper-1"; }
  status(): ConnectorStatus {
    const ok = this.key().length > 0;
    return { id: this.id, kind: this.kind, label: this.label, configured: ok, model: this.model(), needs: this.needs, reason: ok ? undefined : "Set OPENAI_API_KEY." };
  }
  async transcribe(input: SttInput): Promise<SttResult> {
    if (!this.key()) throw new ConnectorNotConfiguredError(this.id, "Set OPENAI_API_KEY.");
    const form = new FormData();
    const ext = input.mime.includes("ogg") ? "ogg" : input.mime.includes("wav") ? "wav" : input.mime.includes("mp4") || input.mime.includes("m4a") ? "m4a" : "webm";
    // Copy into a fresh ArrayBuffer-backed view for Blob.
    form.append("file", new Blob([new Uint8Array(input.audio)], { type: input.mime || "audio/webm" }), `audio.${ext}`);
    form.append("model", this.model());
    if (input.language) form.append("language", input.language);
    const res = await postRaw("OpenAI STT", `${this.base().replace(/\/$/, "")}/audio/transcriptions`, { Authorization: `Bearer ${this.key()}` }, form);
    const json = await res.json() as { text?: string };
    return { text: (json.text || "").trim(), connector: this.id };
  }
}

/**
 * HuggingFace ASR (e.g. openai/whisper-large-v3) through the router's
 * hf-inference provider: https://router.huggingface.co/hf-inference/models/<model>
 * with the audio as the body (the old api-inference.huggingface.co is retired).
 */
export class HuggingFaceSttConnector implements SttConnector {
  readonly id = "huggingface";
  readonly kind = "stt" as const;
  readonly label = "HuggingFace ASR";
  readonly needs = ["HF_API_KEY", "HF_ASR_MODEL", "HF_BASE_URL"];
  private key() { return env("HF_API_KEY"); }
  private model() { return env("HF_ASR_MODEL") || "openai/whisper-large-v3"; }
  status(): ConnectorStatus {
    const ok = this.key().length > 0;
    return { id: this.id, kind: this.kind, label: this.label, configured: ok, model: this.model(), needs: this.needs, reason: ok ? undefined : "Set HF_API_KEY." };
  }
  async transcribe(input: SttInput): Promise<SttResult> {
    if (!this.key()) throw new ConnectorNotConfiguredError(this.id, "Set HF_API_KEY.");
    const model = this.model().split("/").map(encodeURIComponent).join("/");
    const res = await postRaw("HuggingFace ASR", `${hfBase()}/hf-inference/models/${model}`, { Authorization: `Bearer ${this.key()}`, "Content-Type": input.mime || "audio/webm" }, new Uint8Array(input.audio));
    const json = await res.json() as { text?: string };
    return { text: (json.text || "").trim(), connector: this.id };
  }
}

export function buildTtsConnectors(): TtsConnector[] {
  return [new OpenAiTtsConnector(), new ElevenLabsTtsConnector()];
}
export function buildSttConnectors(): SttConnector[] {
  return [new OpenAiSttConnector(), new HuggingFaceSttConnector()];
}
