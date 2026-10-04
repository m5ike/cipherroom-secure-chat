// Speak and send (6.7): a text — typed, or dictated into the composer —
// spoken by a voice and sent as a voice message, end-to-end encrypted like a
// recorded one (App.tsx › sendPickedFile: inline when small, the encrypted
// chunked transfer when not).
//
// The voice: the operator's speech module (server text-to-speech — the
// offline Piper voices or a provider; docs/speech.md). The browser's own
// voices (speechSynthesis) play straight to the speakers and cannot be
// recorded, so without the module there is no voice message — a clear error
// instead. The server sees the text it speaks (an explicit choice: the
// button says so); the message itself goes end to end encrypted.

import type { ServerSpeechStatus } from "./speech";

export type SpeakSendError = "empty" | "no-tts" | "tts-failed";

export type SpeakSendDeps = {
  /** /api/speech/status (which voices this user may use). */
  status: () => Promise<ServerSpeechStatus>;
  tts: (text: string, opts: { connector?: string }) => Promise<{ ok: true; blob: Blob; mime: string } | { ok: false; message: string }>;
  /** A chosen server voice (else the first the server offers). */
  connector?: string;
  now?: () => number;
};

/** The longest text spoken into one message (the server's limit is larger; a voice message stays short). */
export const SPEAK_SEND_MAX = 2000;

const EXT: Array<[RegExp, string]> = [[/wav/, "wav"], [/mpeg|mp3/, "mp3"], [/ogg|opus/, "ogg"], [/webm/, "webm"], [/mp4|aac|m4a/, "m4a"], [/flac/, "flac"]];

/** "hlas-<ms>.<ext>" — the name a recorded voice message has, with the type's extension. */
export function voiceFileName(mime: string, now = Date.now()): string {
  const ext = EXT.find(([re]) => re.test(mime))?.[1] ?? "mp3";
  return `hlas-${now}.${ext}`;
}

/** The text as a voice message's audio file — or why not. */
export async function textToVoiceFile(text: string, deps: SpeakSendDeps): Promise<{ ok: true; file: File } | { ok: false; error: SpeakSendError; message?: string }> {
  const clean = text.trim().slice(0, SPEAK_SEND_MAX);
  if (!clean) return { ok: false, error: "empty" };
  const status = await deps.status().catch(() => null);
  if (!status?.tts.enabled || status.tts.connectors.length === 0) return { ok: false, error: "no-tts" };
  const connector = deps.connector && status.tts.connectors.some((c) => c.id === deps.connector) ? deps.connector : status.tts.connectors[0].id;
  const r = await deps.tts(clean, { connector }).catch((err: Error) => ({ ok: false as const, message: err.message }));
  if (!r.ok) return { ok: false, error: "tts-failed", message: r.message };
  if (r.blob.size === 0) return { ok: false, error: "tts-failed", message: "empty audio" };
  const mime = (r.mime || r.blob.type || "audio/mpeg").split(";")[0].trim();
  return { ok: true, file: new File([r.blob], voiceFileName(mime, (deps.now ?? Date.now)()), { type: mime }) };
}
