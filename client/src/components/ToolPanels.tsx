// The tool dialogs of the chat screen: files, location, speech and the
// connection details.

import { useEffect, useRef, useState } from "react";
import { t, type Lang } from "../lib/i18n";
import { formatBytes } from "../lib/format";
import { detectGeolocation } from "../lib/maps";
import { detectSpeechCaps, fetchServerSpeechStatus, listVoices, serverTts, speak, startRecognition, stopSpeaking, type ServerVoiceInfo, type VoicePreset } from "../lib/speech";
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
  const active = transfers.filter((t) => t.status === "active");
  const recent = transfers.slice(-3);
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        End-to-end encrypted P2P transfer (AES-GCM 256, 32 KiB chunks) with automatic server-relay fallback.
        Hard cap: 10 GiB. Configure your own limit in Settings.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onPickFile}
          disabled={!connected}
          className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          Choose file…
        </button>
      </div>
      {active.length > 0 ? (
        <div className="rounded-2xl border border-border bg-background p-3 text-xs">
          <div className="mb-1 font-semibold">Probíhá {active.length} přenos{active.length > 1 ? "y" : ""}:</div>
          <ul className="space-y-1 font-mono">
            {active.map((t) => (
              <li key={t.id}>
                {t.direction === "out" ? "↑" : "↓"} {t.name} ·
                {t.stats.transport === "p2p" ? " P2P" : " Proxy"} ·
                {Math.round((t.stats.progress ?? 0) * 100)} %
                · {formatBytes(t.stats.size)} ·{" "}
                {Math.round((t.stats.bytesPerSecond ?? 0) / 1024)} kB/s
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {recent.length > 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 p-3 text-[11px] text-muted-foreground">
          {recent.length} přenosů sledováno — podrobnosti v chatu.
        </div>
      ) : null}
      <p className="text-[11px] text-muted-foreground">
        Files  10 GiB cannot transfer today. For very large volumes use the
        storage-provider plugin — see docs/files.md.
      </p>
    </div>
  );
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
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {t(lang, "app.location.hint")}
      </p>
      {!caps.available ? (
        <p className="rounded-xl border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">{caps.reason}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onShareOnce} disabled={!connected || !caps.available} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
          {t(lang, "app.location.once")}
        </button>
        {watching ? (
          <button type="button" onClick={onStopContinuous} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent">{t(lang, "app.location.stop")}</button>
        ) : (
          <button type="button" onClick={onStartContinuous} disabled={!connected || !caps.available} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent disabled:opacity-60">{t(lang, "app.location.continuous")}</button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">{t(lang, "app.location.privacy")}</p>
    </div>
  );
}

export function SpeechPanel({
  recognitionRef, onSendText, onInsertText, serverMode, lang,
}: {
  recognitionRef: React.MutableRefObject<{ stop: () => void } | null>;
  onSendText: (text: string) => void;
  onInsertText: (text: string) => void;
  serverMode: boolean;
  lang: Lang;
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
    void fetchServerSpeechStatus().then((s) => {
      if (cancelled) return;
      if (s.tts.enabled) { setServerVoices(s.tts.connectors); if (s.tts.connectors[0]) setServerVoice(s.tts.connectors[0].id); }
    });
    return () => { cancelled = true; };
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

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <label className="grid gap-1 text-sm">{t(lang, "app.speech.language")}
          <select value={voiceLang} onChange={(e) => setVoiceLang(e.target.value)} className="min-h-10 rounded-xl border border-input bg-background px-2">
            {["cs-CZ","sk-SK","de-DE","en-GB","en-US","pl-PL","fr-FR","es-ES","it-IT","nl-NL","ru-RU"].map((l) => <option key={l}>{l}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-sm">{t(lang, "app.speech.preset")}
          <select value={preset} onChange={(e) => setPreset(e.target.value as VoicePreset)} className="min-h-10 rounded-xl border border-input bg-background px-2">
            {["neutral","male","female","child"].map((p) => <option key={p}>{p}</option>)}
          </select>
        </label>
      </div>
      <label className="grid gap-1 text-sm">{t(lang, "app.speech.voice")}
        <select value={voiceURI} onChange={(e) => setVoiceURI(e.target.value)} className="min-h-10 rounded-xl border border-input bg-background px-2">
          <option value="">{t(lang, "app.speech.auto")}</option>
          {voices.filter((v) => v.lang.toLowerCase().startsWith(voiceLang.toLowerCase().slice(0, 2))).map((v) => (
            <option key={v.voiceURI} value={v.voiceURI}>{v.name} · {v.lang}</option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm">{t(lang, "app.speech.text")}
        <textarea value={text} onChange={(e) => setText(e.target.value)} className="min-h-20 rounded-xl border border-input bg-background px-2 py-1" />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!caps.ttsAvailable} onClick={() => speak({ text, lang: voiceLang, preset, voiceURI: voiceURI || null })} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60">{t(lang, "app.speech.speak")}</button>
        <button type="button" disabled={!caps.ttsAvailable} onClick={stopSpeaking} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent disabled:opacity-60">{t(lang, "app.speech.stop")}</button>
        {!recognitionRef.current ? (
          <button type="button" disabled={!caps.sttAvailable} onClick={startStt} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent disabled:opacity-60">{t(lang, "app.speech.listen")}</button>
        ) : (
          <button type="button" onClick={stopStt} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent">{t(lang, "app.speech.stopListening")}</button>
        )}
        <label className="inline-flex items-center gap-2 text-xs">
          <input type="checkbox" checked={revoice} onChange={(e) => setRevoice(e.target.checked)} />
          {t(lang, "app.speech.revoice")}
        </label>
        <button type="button" disabled={!text.trim()} onClick={() => { onInsertText(text); setText(""); }} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent disabled:opacity-60" data-testid="speech-insert">{t(lang, "speech.insert")}</button>
        <button type="button" onClick={() => { onSendText(text); setText(""); }} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent">{t(lang, "app.speech.send")}</button>
      </div>
      {partial ? <div className="rounded-xl border border-border bg-background p-2 text-xs italic">{partial}</div> : null}
      {serverMode && serverVoices.length > 0 ? (
        <div className="rounded-xl border border-border bg-background p-2 text-xs">
          <div className="mb-1 font-semibold">{t(lang, "speech.server")}</div>
          <div className="flex flex-wrap items-center gap-2">
            <select value={serverVoice} onChange={(e) => setServerVoice(e.target.value)} className="min-h-9 rounded-lg border border-input bg-background px-2">
              {serverVoices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
            <button type="button" disabled={serverBusy || !text.trim()} onClick={() => void speakServer()} className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground disabled:opacity-60">
              {serverBusy ? "…" : t(lang, "speech.server.speak")}
            </button>
          </div>
        </div>
      ) : null}
      {!caps.sttAvailable ? <p className="text-[11px] text-muted-foreground">Speech recognition is Chrome/Edge/Android only. Voice cloning of arbitrary samples is intentionally not implemented — see docs/speech.md.</p> : null}
    </div>
  );
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
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border bg-background p-2 text-xs" data-testid="conn-desired" data-desired={desired}>
        <span className="font-semibold">{t(lang, "conn.desired")}:</span>{" "}
        {t(lang, desired === "connected" ? "conn.desired.connected" : "conn.desired.disconnected")}
      </div>
      <p className="text-xs text-muted-foreground">Heartbeat strategy controls how often the client pings signaling and how aggressively it reconnects after a drop. Browsers throttle background timers; mobile may suspend WebSockets entirely when tab is hidden.</p>
      <label className="grid gap-1 text-sm font-medium">Strategy
        <select
          value={prefs.keepaliveStrategy}
          onChange={(e) => setPrefs({ keepaliveStrategy: e.target.value as KeepaliveStrategy })}
          className="min-h-10 rounded-xl border border-input bg-background px-2"
        >
          <option value="conservative">Conservative (45s ping, reconnect from 1.5s)</option>
          <option value="balanced">Balanced (25s ping, reconnect from 1s)</option>
          <option value="aggressive">Aggressive (12s ping, reconnect from 0.5s)</option>
        </select>
      </label>
      {status ? (
        <div className="rounded-xl border border-border bg-background p-2 text-xs font-mono">
          <div>state: {status.state}</div>
          <div>RTT: {status.rttMs} ms</div>
          <div>strategy: {status.strategy}</div>
          <div>last activity: {status.lastActivityAt ? new Date(status.lastActivityAt).toLocaleTimeString() : "—"}</div>
          <div>last pong: {status.lastPongAt ? new Date(status.lastPongAt).toLocaleTimeString() : "—"}</div>
        </div>
      ) : <p className="text-xs text-muted-foreground">Not connected.</p>}
      <div>
        <h3 className="mb-1 text-xs font-semibold">{t(lang, "conn.log.title")}</h3>
        {log.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t(lang, "conn.log.empty")}</p>
        ) : (
          <ol className="max-h-40 overflow-y-auto rounded-xl border border-border bg-background p-2 font-mono text-[11px] leading-5" data-testid="conn-log">
            {log.map((entry, i) => (
              <li key={`${entry.at}-${i}`}>
                {new Date(entry.at).toLocaleTimeString()} · #{entry.attempt} ·{" "}
                {entry.event === "retry"
                  ? t(lang, "conn.log.retry").replace("{s}", ((entry.delayMs ?? 0) / 1000).toFixed(1))
                  : t(lang, `conn.log.${entry.event}`)}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
