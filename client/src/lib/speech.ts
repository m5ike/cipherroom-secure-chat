// Browser Speech module — TTS, STT, and speech→text→speak ("revoice").
// All processing happens in the browser via Web Speech APIs. No audio
// is uploaded.
//
// Limitations:
//   - SpeechRecognition is Chrome/Edge/Android-only at the moment. Firefox
//     and most desktop Safari versions do not support it (we expose
//     capability flags so the UI can hide controls).
//   - "Voice changer" is approximate — we adjust pitch/rate and let the user
//     pick male/female/child-ish voices when they exist on the OS. True
//     voice cloning requires a server-side model and explicit consent and
//     is intentionally NOT implemented here. See docs/speech.md.

export type SpeechCaps = {
  ttsAvailable: boolean;
  sttAvailable: boolean;
};

export function detectSpeechCaps(): SpeechCaps {
  const ttsAvailable = typeof window !== "undefined" && "speechSynthesis" in window;
  const W = typeof window !== "undefined" ? (window as unknown as Record<string, unknown>) : {};
  const sttAvailable = Boolean(W.SpeechRecognition || W.webkitSpeechRecognition);
  return { ttsAvailable, sttAvailable };
}

export type VoicePreset = "neutral" | "male" | "female" | "child";

export type TTSOptions = {
  text: string;
  lang?: string;
  voiceURI?: string | null;
  preset?: VoicePreset;
  rate?: number;
  pitch?: number;
  volume?: number;
};

export function listVoices(): SpeechSynthesisVoice[] {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
  return window.speechSynthesis.getVoices();
}

export function pickVoiceForPreset(lang: string, preset: VoicePreset): SpeechSynthesisVoice | null {
  const voices = listVoices().filter((v) => !lang || v.lang.toLowerCase().startsWith(lang.toLowerCase().slice(0, 2)));
  if (voices.length === 0) return null;
  // Heuristic: voice names sometimes contain "Male"/"Female"/"Child"/female
  // first names. We don't pretend to be perfect — we just bias toward what
  // the UA exposes. Falls back to first available voice for the language.
  const wantMale = preset === "male";
  const wantFemale = preset === "female";
  const wantChild = preset === "child";
  const FEMALE = /female|samantha|zira|karen|tessa|kate|fiona|moira|veronika|petra|anna|ema|ева|jana|lucie/i;
  const MALE = /male|david|alex|daniel|fred|tom|mark|jiří|petr|honza|ivan/i;
  const CHILD = /child|kid|junior|petite/i;

  const score = (v: SpeechSynthesisVoice) => {
    const n = `${v.name} ${v.voiceURI}`;
    if (wantChild && CHILD.test(n)) return 3;
    if (wantFemale && FEMALE.test(n)) return 3;
    if (wantMale && MALE.test(n)) return 3;
    if (wantMale && FEMALE.test(n)) return 0;
    if (wantFemale && MALE.test(n)) return 0;
    return 1;
  };
  return [...voices].sort((a, b) => score(b) - score(a))[0] || null;
}

export function speak(opts: TTSOptions): { utterance: SpeechSynthesisUtterance; cancel: () => void } | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  const u = new SpeechSynthesisUtterance(opts.text);
  if (opts.lang) u.lang = opts.lang;
  if (opts.voiceURI) {
    const v = listVoices().find((vv) => vv.voiceURI === opts.voiceURI);
    if (v) u.voice = v;
  } else if (opts.preset && opts.lang) {
    const v = pickVoiceForPreset(opts.lang, opts.preset);
    if (v) u.voice = v;
  }
  // Preset bias for pitch/rate when no specific voice is available.
  if (opts.preset === "child") {
    u.pitch = Math.min(2, (opts.pitch ?? 1.6));
    u.rate = opts.rate ?? 1.05;
  } else if (opts.preset === "male") {
    u.pitch = Math.max(0, (opts.pitch ?? 0.8));
  } else if (opts.preset === "female") {
    u.pitch = Math.min(2, (opts.pitch ?? 1.2));
  }
  if (typeof opts.rate === "number") u.rate = opts.rate;
  if (typeof opts.pitch === "number") u.pitch = opts.pitch;
  if (typeof opts.volume === "number") u.volume = opts.volume;
  window.speechSynthesis.speak(u);
  return { utterance: u, cancel: () => window.speechSynthesis.cancel() };
}

export function stopSpeaking() {
  if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
}

// Speech recognition wrapper. The W3C type is not in lib.dom by default.
type AnyRecognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((ev: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>; resultIndex: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

export type RecognitionHandle = {
  stop: () => void;
};

export type RecognitionCallbacks = {
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
  onEnd?: () => void;
};

export function startRecognition(lang: string, cb: RecognitionCallbacks, continuous = true): RecognitionHandle | null {
  const W = window as unknown as Record<string, new () => AnyRecognition>;
  const Ctor = (W.SpeechRecognition || W.webkitSpeechRecognition) as (new () => AnyRecognition) | undefined;
  if (!Ctor) {
    cb.onError?.("SpeechRecognition not supported in this browser.");
    return null;
  }
  const rec = new Ctor();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = continuous;
  rec.onresult = (ev) => {
    let interim = "";
    let final = "";
    for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
      const r = ev.results[i];
      if (r.isFinal) final += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (interim) cb.onPartial?.(interim);
    if (final) cb.onFinal?.(final);
  };
  rec.onerror = (ev) => {
    const message = (ev as { error?: string })?.error || "speech-error";
    cb.onError?.(message);
  };
  rec.onend = () => { cb.onEnd?.(); };
  try {
    rec.start();
  } catch (err) {
    cb.onError?.((err as Error).message);
    return null;
  }
  return { stop: () => { try { rec.stop(); } catch { /* ignore */ } } };
}
