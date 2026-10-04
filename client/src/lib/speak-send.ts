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
// option says so); the message itself goes end to end encrypted.
//
// 6.8: in the web composer it is a checkbox of the send options ("Send as
// voice", SendState.asVoice) — while it is ticked, Send sends the voice
// message instead of the text (composerSendRoute below). The Speech panel
// keeps its own one-off button.

import type { ServerSpeechStatus } from "./speech";

/** 6.10: "declined" — the person did not agree that the server's speech provider reads the text (nothing was sent). */
export type SpeakSendError = "empty" | "no-tts" | "tts-failed" | "declined";

export type SpeakSendDeps = {
  /** /api/speech/status (which voices this user may use). */
  status: () => Promise<ServerSpeechStatus>;
  tts: (text: string, opts: { connector?: string }) => Promise<{ ok: true; blob: Blob; mime: string } | { ok: false; message: string }>;
  /** A chosen server voice (else the first the server offers). */
  connector?: string;
  now?: () => number;
  /**
   * 6.10 (security review G-14): asked before the text leaves for the
   * server, with the speech provider that will read it (its label, e.g. a
   * cloud service) — false sends nothing. App.tsx asks the first time in a
   * room (serverVoiceConsent).
   */
  confirm?: (provider: string) => boolean | Promise<boolean>;
};

/* -------------------------------------- 6.10 (G-14): who reads the text */

const voiceConsent = new Set<string>();
/**
 * Whether the text may go to the server's speech provider in this room: true
 * when the person agreed earlier in this page's life, else `ask()` (and a yes
 * is remembered for the room). The text of a voice message is plaintext to
 * the server and to the provider it uses — the message itself is end to end
 * encrypted — so this is asked, not just written in a hint.
 */
export function serverVoiceConsent(room: string, ask: () => boolean): boolean {
  if (voiceConsent.has(room)) return true;
  if (!ask()) return false;
  voiceConsent.add(room);
  return true;
}
/** Tests (and a sign-out): ask again everywhere. */
export function resetServerVoiceConsent(): void { voiceConsent.clear(); }

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
  // 6.10 (G-14): before the text leaves — say who reads it.
  if (deps.confirm) {
    const provider = status.tts.connectors.find((c) => c.id === connector)?.label || connector;
    if (!(await deps.confirm(provider))) return { ok: false, error: "declined" };
  }
  const r = await deps.tts(clean, { connector }).catch((err: Error) => ({ ok: false as const, message: err.message }));
  if (!r.ok) return { ok: false, error: "tts-failed", message: r.message };
  if (r.blob.size === 0) return { ok: false, error: "tts-failed", message: "empty audio" };
  const mime = (r.mime || r.blob.type || "audio/mpeg").split(";")[0].trim();
  return { ok: true, file: new File([r.blob], voiceFileName(mime, (deps.now ?? Date.now)()), { type: mime }) };
}

/* ---------------------------------------------- 6.8: the composer's Send */

/** Why the composer's text does not go as a voice message (nothing is sent). */
export type VoiceSendBlock = "sealed" | "too-long";

/**
 * 6.8: what Send (the button, Enter) does with the composer's text. "Send as
 * voice" ticked in the send options: a voice message INSTEAD of the text;
 * not ticked: the text. Two combinations are refused rather than bent:
 *  - sealed (individually encrypted): the seal covers a text body only, so
 *    the voice would reach the room unsealed — and the text is never sent in
 *    clear in its place;
 *  - longer than one voice message holds (SPEAK_SEND_MAX): refused rather
 *    than spoken cut short.
 */
export function composerSendRoute(
  text: string,
  send: { asVoice?: boolean; sealed?: boolean },
): { route: "text" } | { route: "voice" } | { route: "refuse"; error: VoiceSendBlock } {
  if (!send.asVoice) return { route: "text" };
  if (send.sealed) return { route: "refuse", error: "sealed" };
  if (text.trim().length > SPEAK_SEND_MAX) return { route: "refuse", error: "too-long" };
  return { route: "voice" };
}

/** 6.8: Send from the composer down the route above — exactly one of the paths runs. */
export async function sendFromComposer(
  text: string,
  send: { asVoice?: boolean; sealed?: boolean },
  paths: { text: () => Promise<unknown>; voice: () => Promise<unknown>; refuse: (error: VoiceSendBlock) => void },
): Promise<"text" | "voice" | "refused"> {
  const r = composerSendRoute(text, send);
  if (r.route === "refuse") { paths.refuse(r.error); return "refused"; }
  if (r.route === "voice") { await paths.voice(); return "voice"; }
  await paths.text();
  return "text";
}

/**
 * 6.8: a voice message too big for a chat message goes as a file transfer —
 * to EVERYONE connected in the room, without tap-to-reveal or vanishing. So a
 * big one is refused when it was meant for chosen people only, or as one of
 * those kinds (the caller says so) rather than sent wider or plainer.
 */
export function voiceTooBigFor(size: number, inlineLimit: number, opts: { toChosen: boolean; tap: boolean; vanish: boolean }): boolean {
  return size > inlineLimit && (opts.toChosen || opts.tap || opts.vanish);
}
