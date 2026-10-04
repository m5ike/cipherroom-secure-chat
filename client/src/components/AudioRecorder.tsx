// Composer microphone: records a voice message with MediaRecorder and hands
// the finished audio file back to the composer, which sends it over the same
// encrypted channel as any other attachment (inline if small, chunked if not).
// No audio is uploaded anywhere on its own — it rides the E2EE transport.
// 6.7: the microphone comes from mic.ts (through the voice changer when it is
// on); leaving the room while recording drops the recording and lets go of
// the microphone — nothing is sent then.

import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { t, type Lang } from "../lib/i18n";
import { micAvailable, openMic, releaseMic } from "../lib/mic";

function pickMimeType(): string | undefined {
  const R = typeof MediaRecorder !== "undefined" ? MediaRecorder : undefined;
  if (!R || !R.isTypeSupported) return undefined;
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) {
    if (R.isTypeSupported(m)) return m;
  }
  return undefined;
}

export function AudioRecorder({ onRecorded, onError, onRecording, disabled, lang }: {
  onRecorded: (file: File) => void;
  onError: (message: string) => void;
  /** 6.7: a recording began / ended (the composer stops dictation meanwhile). */
  onRecording?: (on: boolean) => void;
  disabled?: boolean;
  lang: Lang;
}) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const discardRef = useRef(false);
  const startingRef = useRef(false);

  useEffect(() => {
    discardRef.current = false;
    return () => {
      // Unmounted mid-recording: drop it (never send behind the user's back) and free the microphone.
      discardRef.current = true;
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      try { if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop(); } catch { /* ignore */ }
      recRef.current = null;
      releaseMic(streamRef.current);
      streamRef.current = null;
    };
  }, []);

  async function start() {
    if (startingRef.current || recRef.current) return;
    if (!micAvailable() || typeof MediaRecorder === "undefined") {
      onError(t(lang, "chat.audio.unsupported"));
      return;
    }
    startingRef.current = true;
    try {
      const stream = await openMic({ audio: true });
      if (discardRef.current) { releaseMic(stream); return; }
      streamRef.current = stream;
      const mime = pickMimeType();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        releaseMic(stream);
        if (streamRef.current === stream) streamRef.current = null;
        if (discardRef.current) return;
        const type = rec.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm";
        const file = new File([blob], `hlas-${Date.now()}.${ext}`, { type });
        if (file.size > 0) onRecorded(file);
      };
      rec.start();
      recRef.current = rec;
      setRecording(true);
      onRecording?.(true);
      setSeconds(0);
      timerRef.current = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch (err) {
      onError((err as Error).message || t(lang, "chat.audio.denied"));
    } finally {
      startingRef.current = false;
    }
  }

  function stop() {
    if (timerRef.current !== null) { window.clearInterval(timerRef.current); timerRef.current = null; }
    try { recRef.current?.stop(); } catch { /* ignore */ }
    recRef.current = null;
    setRecording(false);
    onRecording?.(false);
  }

  if (recording) {
    const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
    const ss = String(seconds % 60).padStart(2, "0");
    return (
      <button type="button" className="composer-icon-btn is-recording" onClick={stop} aria-label={t(lang, "chat.audio.stop")} title={t(lang, "chat.audio.stop")} data-testid="button-audio-stop">
        <Square className="h-4 w-4" aria-hidden="true" />
        <span className="composer-rec-time">{mm}:{ss}</span>
      </button>
    );
  }
  return (
    <button type="button" className="composer-icon-btn" onClick={() => void start()} disabled={disabled} aria-label={t(lang, "chat.audio.record")} title={t(lang, "chat.audio.record")} data-testid="button-audio-record">
      <Mic className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}
