// The voice changer's window (6.7): switch it on for this client, choose a
// preset or custom values, and test it — a few seconds recorded through the
// same microphone path the calls and voice messages use (mic.ts), then
// played back here. Nothing is sent anywhere. Its look is the
// "panel.voiceChanger" layout (lib/layouts/voice.ts).

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { renderLayout } from "./LayoutView";
import { useLayoutBase } from "./LayoutProvider";
import { t, tf, type Lang } from "../lib/i18n";
import { NEUTRAL_FX, VOICE_FX_LIMITS, VOICE_FX_PRESET_IDS, isFxPreset, type VoiceFxParams } from "../lib/voice-fx";
import { DEFAULT_VOICE_FX, getVoiceFx, onVoiceFxChange, setVoiceFx, type VoiceFxSettings } from "../lib/voice-fx-settings";
import { lastFallback, micAvailable, openGraphs, openMic, releaseMic, voiceFxActive, voiceFxSupported } from "../lib/mic";

export const VOICE_FX_TEST_MS = 4000;

type Testing = "idle" | "recording" | "playing";

/** The settings as the store has them (live), or a fixed sample (the Layout builder's preview). */
function useSettings(sample?: VoiceFxSettings): [VoiceFxSettings, (patch: Partial<VoiceFxSettings>) => void] {
  const [local, setLocal] = useState<VoiceFxSettings>(() => sample ?? getVoiceFx());
  useEffect(() => (sample ? undefined : onVoiceFxChange(setLocal)), [sample]);
  const change = (patch: Partial<VoiceFxSettings>) => {
    if (sample) setLocal((cur) => ({ ...cur, ...patch, custom: { ...cur.custom, ...(patch.custom ?? {}) } }));
    else setVoiceFx(patch);
  };
  return [local, change];
}

export function VoiceChangerPanel({ lang, allowed, supported = voiceFxSupported(), sample }: {
  lang: Lang;
  /** The operator's module, for this user. */
  allowed: boolean;
  supported?: boolean;
  /** Fixed settings (the preview): nothing is saved. */
  sample?: VoiceFxSettings;
}) {
  const [settings, change] = useSettings(sample);
  const [testing, setTesting] = useState<Testing>("idle");
  const [error, setError] = useState("");
  const [live, setLive] = useState(() => openGraphs());
  const testRef = useRef<{ stream: MediaStream | null; recorder: MediaRecorder | null; audio: HTMLAudioElement | null; url: string; timer: number | null; cancelled: boolean } | null>(null);

  // How many microphones go through it now (a call, a recording).
  useEffect(() => {
    const id = window.setInterval(() => setLive(openGraphs()), 1000);
    return () => window.clearInterval(id);
  }, []);

  function cancelTest() {
    const run = testRef.current;
    testRef.current = null;
    if (!run) return;
    run.cancelled = true;
    if (run.timer !== null) window.clearTimeout(run.timer);
    try { if (run.recorder && run.recorder.state !== "inactive") run.recorder.stop(); } catch { /* stopped */ }
    releaseMic(run.stream);
    if (run.audio) { run.audio.pause(); run.audio.src = ""; }
    if (run.url) URL.revokeObjectURL(run.url);
    setTesting("idle");
  }

  // Leaving the window ends the test and lets go of the microphone.
  useEffect(() => () => cancelTest(), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function startTest() {
    if (testRef.current || !micAvailable() || typeof MediaRecorder === "undefined") return;
    setError("");
    const run = { stream: null as MediaStream | null, recorder: null as MediaRecorder | null, audio: null as HTMLAudioElement | null, url: "", timer: null as number | null, cancelled: false };
    testRef.current = run;
    setTesting("recording");
    try {
      const stream = await openMic({ audio: true });
      if (run.cancelled) { releaseMic(stream); return; }
      run.stream = stream;
      if (voiceFxActive() && lastFallback()) setError(tf(lang, "vfx.fallback", { reason: lastFallback() ?? "" }));
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream);
      run.recorder = recorder;
      recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        releaseMic(stream);
        run.stream = null;
        if (run.cancelled) return;
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        run.url = URL.createObjectURL(blob);
        const audio = new Audio(run.url);
        run.audio = audio;
        audio.onended = () => { if (testRef.current === run) cancelTest(); };
        setTesting("playing");
        void audio.play().catch((err: Error) => { setError(err.message); cancelTest(); });
      };
      recorder.start();
      run.timer = window.setTimeout(() => { run.timer = null; try { recorder.stop(); } catch { /* stopped */ } }, VOICE_FX_TEST_MS);
    } catch (err) {
      setError((err as Error).message || t(lang, "chat.audio.denied"));
      if (testRef.current === run) cancelTest();
    }
  }

  const { tree, base } = useLayoutBase("panel.voiceChanger", lang);
  const value = (e: unknown) => (e as ChangeEvent<HTMLInputElement | HTMLSelectElement>).target;
  const params: VoiceFxParams = settings.custom;
  return renderLayout(tree, {
    ...base,
    data: {
      allowed,
      supported,
      micAvailable: micAvailable(),
      on: settings.on,
      active: allowed && settings.on,
      preset: settings.preset,
      presets: VOICE_FX_PRESET_IDS.map((id) => ({ id, label: t(lang, `vfx.p.${id}`) })),
      custom: settings.preset === "custom",
      params,
      testing,
      live,
      liveText: tf(lang, "vfx.live", { n: live }),
      error,
    },
    actions: {
      toggle: (e) => change({ on: (value(e) as HTMLInputElement).checked }),
      preset: (e) => { const v = value(e).value; if (isFxPreset(v)) change({ preset: v }); },
      param: (e, key) => {
        const k = String(key) as keyof VoiceFxParams;
        if (!(k in VOICE_FX_LIMITS)) return;
        const n = Number(value(e).value);
        if (Number.isFinite(n)) change({ custom: { ...settings.custom, [k]: n } });
      },
      reset: () => change({ custom: { ...NEUTRAL_FX, ...DEFAULT_VOICE_FX.custom } }),
      test: () => void startTest(),
      stopTest: () => cancelTest(),
    },
  });
}
