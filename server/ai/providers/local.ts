// The built-in speech engine as a provider (5.1): its "models" are the
// Whisper models and Piper voices downloaded to this server (local-speech.ts).
// Free and offline — no key, no address.

import { installed, synthesize, transcribe, voicesOf } from "../local-speech";
import type { DiscoveredModel, ProviderAdapter, SttRequest, SttResult, TtsRequest, TtsResult } from "../types";

export class LocalSpeechAdapter implements ProviderAdapter {
  readonly type = "local" as const;
  constructor(private readonly name = "Built-in speech") {}

  async models(): Promise<DiscoveredModel[]> {
    return installed().map((m) => ({ id: m.id, label: m.label, kind: m.kind, ...(m.kind === "tts" ? { voices: voicesOf(m.id) } : {}) }));
  }

  async tts(req: TtsRequest): Promise<TtsResult> {
    const out = await synthesize(req.model, req.text, req.voice);
    return { audio: out.audio, mime: out.mime };
  }

  async stt(req: SttRequest): Promise<SttResult> {
    const out = await transcribe(req.model, req.audio, req.mime, req.language);
    return { text: out.text };
  }

  toString(): string { return this.name; }
}
