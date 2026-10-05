// The tool dialogs of the chat screen: files, location, speech and the
// connection details.
//
// 4.13: each is a layout ("panel.files", "panel.location", "panel.speech",
// "panel.connection" — lib/layouts/tools.ts); what they do stays here.

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { renderLayout } from "./LayoutView";
import { useLayoutBase } from "./LayoutProvider";
import { t, type Lang } from "../lib/i18n";
import { formatBytes, formatClock, formatSpeed } from "../lib/format";
import { formatNumber } from "../lib/i18n-intl";
import { detectGeolocation } from "../lib/maps";
import { detectSpeechCaps, fetchServerSpeechStatus, listVoices, serverTts, speak, stopSpeaking, type ServerSpeechStatus, type ServerVoiceInfo, type VoicePreset } from "../lib/speech";
import { browserEngine, dictationLang } from "../lib/dictation";
import { dictationMessage, useDictation } from "./ComposerVoice";
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
  connected, enabled, maxBytes, onPickFile, transfers, lang = "en",
}: {
  connected: boolean;
  enabled: boolean;
  maxBytes: number;
  onPickFile: () => void;
  transfers: FilesPanelTransfer[];
  /** 6.13: the panel spoke English only. */
  lang?: Lang;
}) {
  const { tree, base } = useLayoutBase("panel.files", lang);
  const active = transfers.filter((t) => t.status === "active");
  const recent = transfers.slice(-3);
  return renderLayout(tree, {
    ...base,
    data: {
      connected,
      active: active.map((t) => ({
        id: t.id,
        line: `${t.direction === "out" ? "↑" : "↓"} ${t.name} ·${t.stats.transport === "p2p" ? " P2P" : " Proxy"} · ${formatNumber(t.stats.progress ?? 0, lang, { style: "percent" })} · ${formatBytes(t.stats.size, lang)} · ${formatSpeed(t.stats.bytesPerSecond ?? 0, lang)}`,
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
  recognitionRef, onSendText, onInsertText, onSendVoice, serverMode, lang, loadServerStatus = fetchServerSpeechStatus,
}: {
  recognitionRef: React.MutableRefObject<{ stop: () => void } | null>;
  onSendText: (text: string) => void;
  onInsertText: (text: string) => void;
  /** 6.7: the text as a voice message (the server's voice); true when it went. */
  onSendVoice?: (text: string) => Promise<boolean>;
  serverMode: boolean;
  lang: Lang;
  /** Where the server voices come from (the Layout builder's preview gives its own). */
  loadServerStatus?: () => Promise<ServerSpeechStatus>;
}) {
  const caps = detectSpeechCaps();
  const [text, setText] = useState("");
  // 6.13: starts in the app's language (its BCP 47 tag; English as en-US like dictation).
  const [voiceLang, setVoiceLang] = useState(() => dictationLang(lang));
  const [preset, setPreset] = useState<VoicePreset>("neutral");
  const [voiceURI, setVoiceURI] = useState<string>("");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [partial, setPartial] = useState("");
  const [revoice, setRevoice] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  // 6.7: dictation that stops when asked (and when the window closes), the text finished.
  const engine = useMemo(() => browserEngine(), []);
  const revoiceRef = useRef({ revoice, voiceLang, preset, voiceURI });
  revoiceRef.current = { revoice, voiceLang, preset, voiceURI };
  const dict = useDictation({
    lang: voiceLang,
    engine,
    onText: (piece, final) => {
      if (!final) { setPartial(piece); return; }
      setPartial("");
      setText((prev) => `${prev} ${piece}`.trim());
      const r = revoiceRef.current;
      if (r.revoice) speak({ text: piece, lang: r.voiceLang, preset: r.preset, voiceURI: r.voiceURI || null });
    },
    onError: (code) => setPartial(`(${dictationMessage(lang, code)})`),
  });
  const listening = dict.state !== "idle";
  useEffect(() => {
    recognitionRef.current = listening ? { stop: () => dict.stop() } : null;
    if (!listening) setPartial((p) => (p.startsWith("(") ? p : ""));
  }, [listening]); // eslint-disable-line react-hooks/exhaustive-deps
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
    dict.start();
  }
  function stopStt() {
    dict.stop();
  }

  async function sendVoice() {
    if (!onSendVoice || !text.trim() || voiceBusy) return;
    dict.stop();
    setVoiceBusy(true);
    const sent = await onSendVoice(text).catch(() => false);
    setVoiceBusy(false);
    if (sent) setText("");
  }

  const { tree, base } = useLayoutBase("panel.speech", lang);
  const value = (e: unknown) => (e as ChangeEvent<HTMLInputElement>).target.value;
  return renderLayout(tree, {
    ...base,
    data: {
      langs: ["cs-CZ", "sk-SK", "sl-SI", "de-DE", "en-GB", "en-US", "fr-FR", "es-ES", "it-IT", "fi-FI", "pl-PL", "nl-NL", "ru-RU"],
      presets: ["neutral", "male", "female", "child"],
      voices: voices.filter((v) => v.lang.toLowerCase().startsWith(voiceLang.toLowerCase().slice(0, 2))).map((v) => ({ uri: v.voiceURI, name: v.name, lang: v.lang })),
      voiceLang, preset, voiceURI, text, hasText: Boolean(text.trim()),
      ttsAvailable: caps.ttsAvailable, sttAvailable: caps.sttAvailable, listening, revoice, partial,
      serverMode, serverVoices: serverVoices.map((v) => ({ id: v.id, label: v.label })), serverVoice, serverBusy,
      sendVoiceOn: Boolean(onSendVoice), voiceBusy,
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
      insert: () => { dict.stop(); onInsertText(text); setText(""); },
      send: () => { if (!text.trim()) return; dict.stop(); onSendText(text.trim()); setText(""); },
      serverVoice: (e) => setServerVoice(value(e)),
      speakServer: () => void speakServer(),
      sendVoice: () => void sendVoice(),
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
        lastActivity: formatClock(status.lastActivityAt, lang),
        lastPong: formatClock(status.lastPongAt, lang),
      } : null,
      log: log.map((entry, i) => ({
        key: `${entry.at}-${i}`,
        time: formatClock(entry.at, lang),
        attempt: entry.attempt,
        text: entry.event === "retry" ? t(lang, "conn.log.retry").replace("{s}", formatNumber((entry.delayMs ?? 0) / 1000, lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 })) : t(lang, `conn.log.${entry.event}`),
      })),
    },
    actions: { strategy: (e) => setPrefs({ keepaliveStrategy: (e as ChangeEvent<HTMLSelectElement>).target.value as KeepaliveStrategy }) },
  });
}
