// The composer's voice buttons (6.7): dictation into the message field and
// the voice-message recorder. Dictation (lib/dictation.ts) keeps listening
// until it is stopped — the same button again, a voice recording starting,
// the field being sent or cleared, or the composer going away (leaving the
// room): then the engine is stopped, the last words still land in the field,
// and the microphone is free.

import { useEffect, useMemo, useRef, useState } from "react";
import { Speech, Square } from "lucide-react";
import { t, tf, type Lang } from "../lib/i18n";
import { browserEngine, Dictation, DictatedText, dictationLang, serverEngine, type DictationEngine, type DictationState } from "../lib/dictation";
import { openMic } from "../lib/mic";
import { fetchServerSpeechStatus, serverStt, type ServerSpeechStatus } from "../lib/speech";
import { AudioRecorder } from "./AudioRecorder";

/** The words a dictation error is told in. */
export function dictationMessage(lang: Lang, code: string): string {
  const key = `dict.err.${code}`;
  const text = t(lang, key);
  return text === key ? tf(lang, "dict.err.other", { code }) : text;
}

/** The engine there is: the browser's recogniser, else the server's transcription (when it is offered). */
export function pickDictationEngine(serverSttOn: boolean, w?: unknown): DictationEngine | null {
  return browserEngine(w) ?? (serverSttOn ? serverEngine({ open: () => openMic({ audio: true }), transcribe: (audio) => serverStt(audio) }) : null);
}

/**
 * A dictation bound to a component: stopped (the text finished) when the
 * component goes away or the engine changes.
 */
export function useDictation({ lang, engine, onText, onError }: {
  lang: string;
  engine: DictationEngine | null;
  onText: (text: string, final: boolean) => void;
  onError?: (code: string) => void;
}) {
  const [state, setState] = useState<DictationState>("idle");
  const ref = useRef<Dictation | null>(null);
  const handlers = useRef({ onText, onError });
  handlers.current = { onText, onError };
  useEffect(() => {
    if (!engine) return undefined;
    const d = new Dictation(engine, {
      lang,
      onText: (text, final) => handlers.current.onText(text, final),
      onState: setState,
      onError: (code) => handlers.current.onError?.(code),
    });
    ref.current = d;
    return () => {
      d.stop();
      if (ref.current === d) ref.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new engine is a new dictation; the language follows below
  }, [engine]);
  useEffect(() => { ref.current?.setOptions({ lang }); }, [lang]);
  return {
    state,
    available: Boolean(engine),
    start: () => ref.current?.start() ?? false,
    stop: () => ref.current?.stop(),
    abort: () => ref.current?.abort(),
    toggle: () => ref.current?.toggle(),
  };
}

export function ComposerVoice({ lang, disabled, text, setText, onRecorded, onError, serverMode = false, loadServerStatus = fetchServerSpeechStatus }: {
  lang: Lang;
  disabled?: boolean;
  /** The message field (dictation writes into it). */
  text: string;
  setText: (text: string) => void;
  onRecorded: (file: File) => void;
  onError: (message: string) => void;
  /** Server-enhanced: where the browser has no recogniser, the server's transcription is asked for. */
  serverMode?: boolean;
  loadServerStatus?: () => Promise<ServerSpeechStatus>;
}) {
  const [serverSttOn, setServerSttOn] = useState(false);
  useEffect(() => {
    if (!serverMode || browserEngine()) { setServerSttOn(false); return undefined; }
    let live = true;
    void loadServerStatus().then((s) => { if (live) setServerSttOn(s.stt.enabled); }, () => undefined);
    return () => { live = false; };
  }, [serverMode, loadServerStatus]);
  const engine = useMemo(() => pickDictationEngine(serverSttOn), [serverSttOn]);
  const piecesRef = useRef<DictatedText | null>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const dict = useDictation({
    lang: dictationLang(lang),
    engine,
    onText: (piece, final) => {
      const d = piecesRef.current;
      if (d) setText(d.add(piece, final));
    },
    onError: (code) => onError(dictationMessage(lang, code)),
  });
  const on = dict.state !== "idle";

  // The field was sent or cleared while dictating: stop, and do not bring the old text back.
  useEffect(() => {
    if (on && text.trim() === "" && piecesRef.current && piecesRef.current.value.trim() !== "") {
      piecesRef.current = null;
      dict.abort();
    }
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle() {
    if (!on) piecesRef.current = new DictatedText(textRef.current);
    dict.toggle();
  }

  const label = t(lang, on ? "dict.stop" : "dict.start");
  return (
    <>
      {engine ? (
        <button
          type="button"
          className={`composer-icon-btn${on ? " is-recording" : ""}`}
          onClick={toggle}
          aria-pressed={on}
          aria-label={label}
          title={on ? `${label} · ${t(lang, dict.state === "stopping" && engine.kind === "server" ? "dict.transcribing" : "dict.listening")}` : label}
          data-testid="button-dictate"
          data-state={dict.state}
        >
          {on ? <Square className="h-4 w-4" aria-hidden="true" /> : <Speech className="h-5 w-5" aria-hidden="true" />}
        </button>
      ) : null}
      <AudioRecorder
        lang={lang}
        disabled={disabled}
        onRecorded={onRecorded}
        onError={onError}
        onRecording={(rec) => { if (rec) dict.stop(); }}
      />
    </>
  );
}
