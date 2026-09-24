// ElevenLabs text to speech (4.14): the voices of the account are the
// "models" the console lists (voice id and name); the speech model is set
// per provider (eleven_multilingual_v2 unless changed).

import { send, sendJson } from "../net";
import type { DiscoveredModel, ProviderAdapter, TtsRequest, TtsResult } from "../types";

export class ElevenLabsAdapter implements ProviderAdapter {
  readonly type = "elevenlabs" as const;
  constructor(private readonly base: string, private readonly key: string, private readonly name = "ElevenLabs") {}

  private url(path: string): string { return `${(this.base || "https://api.elevenlabs.io").replace(/\/+$/, "")}${path}`; }

  /** The speech models; each lists the account's voices. */
  async models(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    const [models, voices] = await Promise.all([
      sendJson<{ model_id?: string; name?: string; can_do_text_to_speech?: boolean }[]>(this.name, this.url("/v1/models"), { method: "GET", headers: { "xi-api-key": this.key }, signal }),
      sendJson<{ voices?: { voice_id?: string; name?: string }[] }>(this.name, this.url("/v1/voices"), { method: "GET", headers: { "xi-api-key": this.key }, signal }),
    ]);
    const voiceList = (voices.voices ?? []).filter((v) => v.voice_id).map((v) => `${v.voice_id}${v.name ? `:${v.name}` : ""}`);
    return (Array.isArray(models) ? models : []).filter((m) => m.model_id && m.can_do_text_to_speech !== false).map((m) => ({ id: m.model_id!, label: m.name, kind: "tts" as const, voices: voiceList }));
  }

  async tts(req: TtsRequest): Promise<TtsResult> {
    // A voice may be "id:name" (as the console lists them).
    const voice = (req.voice || "21m00Tcm4TlvDq8ikWAM").split(":")[0];
    const { res } = await send(this.name, this.url(`/v1/text-to-speech/${encodeURIComponent(voice)}`), {
      headers: { "xi-api-key": this.key, Accept: "audio/mpeg" },
      json: { text: req.text, model_id: req.model || "eleven_multilingual_v2" },
      signal: req.signal,
    });
    return { audio: new Uint8Array(await res.arrayBuffer()), mime: "audio/mpeg" };
  }
}
