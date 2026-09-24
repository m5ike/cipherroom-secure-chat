// The tool dialogs of the chat screen: files, location, speech and the
// connection details.
//
// 4.13: each is a layout ("panel.files", "panel.location", "panel.speech",
// "panel.connection" — lib/layouts/tools.ts); what they do stays here.

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { renderLayout } from "./LayoutView";
import { useLayoutBase } from "./LayoutProvider";
import { t, type Lang } from "../lib/i18n";
import { formatBytes } from "../lib/format";
import { detectGeolocation } from "../lib/maps";
import { detectSpeechCaps, fetchServerSpeechStatus, listVoices, serverTts, speak, startRecognition, stopSpeaking, type ServerSpeechStatus, type ServerVoiceInfo, type VoicePreset } from "../lib/speech";
import type { ConnectionStatus, KeepaliveStrategy } from "../lib/connection-keeper";
import type { Preferences } from "../lib/preferences";
import type { DesiredState } from "../lib/session-cache";

export type FilesPanelTransfer = {
  id: string;
  name: string;
  size: number;
  direction: "in" | "out";
  status: "active" | "completed" | "cancelled" | "error";
  stats: import("../lib/file-transfer").TransferStats;
};

export function FilesPanel({
  connected, enabled, maxBytes, onPickFile, transfers,
}: {
  connected: boolean;
  enabled: boolean;
  maxBytes: number;
  onPickFile: () => void;
  transfers: FilesPanelTransfer[];
}) {
  const { tree, base } = useLayoutBase("panel.files", "en");
  const active = transfers.filter((t) => t.status === "active");
  const recent = transfers.slice(-3);
  return renderLayout(tree, {
    ...base,
    data: {
      connected,
      active: active.map((t) => ({
        id: t.id,
        line: `${t.direction === "out" ? "↑" : "↓"} ${t.name} ·${t.stats.transport === "p2p" ? " P2P" : " Proxy"} ·${Math.round((t.stats.progress ?? 0) * 100)} % · ${formatBytes(t.stats.size)} · ${Math.round((t.stats.bytesPerSecond ?? 0) / 1024)} kB/s`,
      })),
      recent,
    },
    actions: { pickFile: () => onPickFile() },
  });
}

export function LocationPanel({
  connected, onShareOnce, onStartContinuous, onStopContinuous, watching, lang,
}: {
  connected: boolean;
  onShareOnce: () => void;
  onStartContinuous: () => void;
  onStopContinuous: () => void;
  watching: boolean;
  lang: Lang;
}) {
  const caps = detectGeolocation();
  const { tree, base } = useLayoutBase("panel.location", lang);
  return renderLayout(tree, {
    ...base,
    data: { connected, available: caps.available, reason: caps.reason, watching },
    actions: { shareOnce: () => onShareOnce(), startContinuous: () => onStartContinuous(), stop: () => onStopContinuous() },
  });
}

export function SpeechPanel({
  recognitionRef, onSendText, onInsertText, serverMode, lang, loadServerStatus = fetchServerSpeechStatus,
}: {
  recognitionRef: React.MutableRefObject<{ stop: () => void } | null>;
  onSendText: (text: string) => void;
  onInsertText: (text: string) => void;
  serverMode: boolean;
  lang: Lang;
  /** Where the server voices come from (the Layout builder's preview gives its own). */
  loadServerStatus?: () => Promise<ServerSpeechStatus>;
}) {
  const caps = detectSpeechCaps();
  const [text, setText] = useState("");
  const [voiceLang, setVoiceLang] = useState("cs-CZ");
  const [preset, setPreset] = useState<VoicePreset>("neutral");
  const [voiceURI, setVoiceURI] = useState<string>("");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [partial, setPartial] = useState("");
  const [revoice, setRevoice] = useState(false);
  // Server voices (ElevenLabs / OpenAI …), only in Server-enhanced mode.
  const [serverVoices, setServerVoices] = useState<ServerVoiceInfo[]>([]);
  const [serverVoice, setServerVoice] = useState<string>("");
  const [serverBusy, setServerBusy] = useState(false);
  const serverAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    function load() { setVoices(listVoices()); }
    load();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.addEventListener("voiceschanged", load);
      return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
    }
  }, []);

  useEffect(() => {
    if (!serverMode) return;
    let cancelled = false;
    void loadServerStatus().then((s) => {
      if (cancelled) return;
      if (s.tts.enabled) { setServerVoices(s.tts.connectors); if (s.tts.connectors[0]) setServerVoice(s.tts.connectors[0].id); }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- where they come from is fixed for a panel
  }, [serverMode]);

  async function speakServer() {
    if (!text.trim() || !serverVoice) return;
    setServerBusy(true);
    const r = await serverTts(text, { connector: serverVoice });
    setServerBusy(false);
    if (r.ok) {
      if (!serverAudioRef.current) serverAudioRef.current = new Audio();
      serverAudioRef.current.src = r.url;
      void serverAudioRef.current.play();
    }
  }

  function startStt() {
    setPartial("");
    recognitionRef.current = startRecognition(voiceLang, {
      onPartial: setPartial,
      onFinal: (txt) => {
        setText((prev) => `${prev} ${txt}`.trim());
        if (revoice) speak({ text: txt, lang: voiceLang, preset, voiceURI: voiceURI || null });
      },
      onError: (msg) => setPartial(`(error: ${msg})`),
      onEnd: () => setPartial(""),
    }, true);
  }
  function stopStt() {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
  }

  const { tree, base } = useLayoutBase("panel.speech", lang);
  const value = (e: unknown) => (e as ChangeEvent<HTMLInputElement>).target.value;
  return renderLayout(tree, {
    ...base,
    data: {
      langs: ["cs-CZ", "sk-SK", "de-DE", "en-GB", "en-US", "pl-PL", "fr-FR", "es-ES", "it-IT", "nl-NL", "ru-RU"],
      presets: ["neutral", "male", "female", "child"],
      voices: voices.filter((v) => v.lang.toLowerCase().startsWith(voiceLang.toLowerCase().slice(0, 2))).map((v) => ({ uri: v.voiceURI, name: v.name, lang: v.lang })),
      voiceLang, preset, voiceURI, text, hasText: Boolean(text.trim()),
      ttsAvailable: caps.ttsAvailable, sttAvailable: caps.sttAvailable, listening: Boolean(recognitionRef.current), revoice, partial,
      serverMode, serverVoices: serverVoices.map((v) => ({ id: v.id, label: v.label })), serverVoice, serverBusy,
    },
    actions: {
      voiceLang: (e) => setVoiceLang(value(e)),
      preset: (e) => setPreset(value(e) as VoicePreset),
      voice: (e) => setVoiceURI(value(e)),
      text: (e) => setText(value(e)),
      speak: () => speak({ text, lang: voiceLang, preset, voiceURI: voiceURI || null }),
      stopSpeaking: () => stopSpeaking(),
      listen: () => startStt(),
      stopListening: () => stopStt(),
      revoice: (e) => setRevoice((e as ChangeEvent<HTMLInputElement>).target.checked),
      insert: () => { onInsertText(text); setText(""); },
      send: () => { onSendText(text); setText(""); },
      serverVoice: (e) => setServerVoice(value(e)),
      speakServer: () => void speakServer(),
    },
  });
}

export type ConnLogEvent = "connecting" | "open" | "closed" | "retry" | "failed" | "stopped";

export function ConnectionPanel({
  status, prefs, setPrefs, lang, desired, log,
}: {
  status: ConnectionStatus | null;
  prefs: Preferences;
  setPrefs: (p: Partial<Preferences>) => void;
  lang: Lang;
  desired: DesiredState;
  log: Array<{ at: number; attempt: number; event: ConnLogEvent; delayMs?: number }>;
}) {
  const { tree, base } = useLayoutBase("panel.connection", lang);
  return renderLayout(tree, {
    ...base,
    data: {
      desired,
      strategy: prefs.keepaliveStrategy,
      status: status ? {
        state: status.state, rttMs: status.rttMs, strategy: status.strategy,
        lastActivity: status.lastActivityAt ? new Date(status.lastActivityAt).toLocaleTimeString() : "—",
        lastPong: status.lastPongAt ? new Date(status.lastPongAt).toLocaleTimeString() : "—",
      } : null,
      log: log.map((entry, i) => ({
        key: `${entry.at}-${i}`,
        time: new Date(entry.at).toLocaleTimeString(),
        attempt: entry.attempt,
        text: entry.event === "retry" ? t(lang, "conn.log.retry").replace("{s}", ((entry.delayMs ?? 0) / 1000).toFixed(1)) : t(lang, `conn.log.${entry.event}`),
      })),
    },
    actions: { strategy: (e) => setPrefs({ keepaliveStrategy: (e as ChangeEvent<HTMLSelectElement>).target.value as KeepaliveStrategy }) },
  });
}
