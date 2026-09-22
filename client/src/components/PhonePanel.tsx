// Telephony panel (Server-enhanced mode). Talks to /api/telephony/* which the
// operator wires to a provider (Twilio / Telnyx / Vonage…). Dial pad + E.164
// number field, a Call action and an SMS composer, and a small local history.
//
// Self-contained: its own string dictionary (cs/en/de) and its own CSS, so it
// never depends on lib/i18n.ts (mirrors NfcWorkbench). When the module is off
// or unconfigured, it explains what the operator must enable — it never
// pretends to work.

import { useCallback, useEffect, useRef, useState } from "react";
import { Phone, PhoneOutgoing, MessageSquare, Send, Delete, AlertTriangle } from "lucide-react";
import "./phone-panel.css";
import { fetchTelephonyStatus, sendSms, placeCall, type TelephonyConnectorInfo } from "../lib/telephony";

export type PhonePanelProps = {
  lang: "cs" | "en" | "de";
  onSystem?: (message: string) => void;
};

/* ---------- i18n (local, per task) ---------- */

type Lang = PhonePanelProps["lang"];
type Dict = Record<string, string>;

const DICT: Record<Lang, Dict> = {
  cs: {
    disabledTitle: "Telefonní modul je vypnutý",
    disabledBody: "Operátor musí na serveru nastavit ENABLE_TELEPHONY=1 a doplnit klíč poskytovatele (např. TWILIO_AUTH_TOKEN), aby šlo volat a posílat SMS.",
    number: "Číslo (E.164)", placeholderNumber: "+420…", invalidNumber: "Zadej platné číslo ve formátu E.164, např. +420123456789.",
    call: "Volat", sms: "SMS", send: "Odeslat", calling: "Volám…", sending: "Odesílám…",
    callProvider: "Hlasový poskytovatel", smsProvider: "SMS poskytovatel", noProvider: "Žádný poskytovatel není nastaven.",
    placeholderText: "Text zprávy…", history: "Historie", noHistory: "Zatím nic.", clear: "Vyčistit",
    callQueued: "Hovor zařazen:", smsSent: "SMS odeslána:", backspace: "Smazat",
    mediaNote: "Hovor spustí skutečné volání přes poskytovatele; přenos zvuku vyžaduje externí SIP/WebRTC bránu — prohlížeč médium sám nepřenese.",
  },
  en: {
    disabledTitle: "Telephony module is off",
    disabledBody: "An operator must set ENABLE_TELEPHONY=1 on the server and configure a provider key (e.g. TWILIO_AUTH_TOKEN) before calls and SMS work.",
    number: "Number (E.164)", placeholderNumber: "+1…", invalidNumber: "Enter a valid E.164 number, e.g. +14155550123.",
    call: "Call", sms: "SMS", send: "Send", calling: "Calling…", sending: "Sending…",
    callProvider: "Voice provider", smsProvider: "SMS provider", noProvider: "No provider is configured.",
    placeholderText: "Message text…", history: "History", noHistory: "Nothing yet.", clear: "Clear",
    callQueued: "Call queued:", smsSent: "SMS sent:", backspace: "Backspace",
    mediaNote: "Call places a real PSTN call via the provider; the audio path needs an external SIP/WebRTC gateway — the browser cannot carry the media itself.",
  },
  de: {
    disabledTitle: "Telefonie-Modul ist aus",
    disabledBody: "Ein Betreiber muss auf dem Server ENABLE_TELEPHONY=1 setzen und einen Provider-Schlüssel (z. B. TWILIO_AUTH_TOKEN) hinterlegen, damit Anrufe und SMS funktionieren.",
    number: "Nummer (E.164)", placeholderNumber: "+49…", invalidNumber: "Gültige E.164-Nummer eingeben, z. B. +491701234567.",
    call: "Anrufen", sms: "SMS", send: "Senden", calling: "Rufe an…", sending: "Sende…",
    callProvider: "Sprach-Provider", smsProvider: "SMS-Provider", noProvider: "Kein Provider konfiguriert.",
    placeholderText: "Nachrichtentext…", history: "Verlauf", noHistory: "Noch nichts.", clear: "Leeren",
    callQueued: "Anruf eingereiht:", smsSent: "SMS gesendet:", backspace: "Löschen",
    mediaNote: "Anruf startet einen echten PSTN-Anruf über den Provider; der Audiopfad benötigt ein externes SIP/WebRTC-Gateway — der Browser überträgt das Medium nicht selbst.",
  },
};

const E164 = /^\+[1-9]\d{1,14}$/;
const PAD_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

type HistItem = { id: number; kind: "call" | "sms"; to: string; at: number; ok: boolean; detail: string };

export function PhonePanel(props: PhonePanelProps): React.JSX.Element {
  const { lang, onSystem } = props;
  const t = useCallback((k: keyof typeof DICT["en"]) => DICT[lang][k] ?? DICT.en[k] ?? k, [lang]);

  const [status, setStatus] = useState<{ enabled: boolean; sms: TelephonyConnectorInfo[]; voice: TelephonyConnectorInfo[] } | null>(null);
  const [number, setNumber] = useState("+");
  const [mode, setMode] = useState<"call" | "sms">("call");
  const [text, setText] = useState("");
  const [smsConnector, setSmsConnector] = useState("");
  const [voiceConnector, setVoiceConnector] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistItem[]>([]);
  const histId = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void fetchTelephonyStatus().then((s) => {
      if (cancelled) return;
      setStatus(s);
      if (s.sms[0]) setSmsConnector(s.sms[0].id);
      if (s.voice[0]) setVoiceConnector(s.voice[0].id);
    });
    return () => { cancelled = true; };
  }, []);

  const valid = E164.test(number.trim());

  const pushHist = useCallback((h: Omit<HistItem, "id" | "at">) => {
    setHistory((prev) => [{ ...h, id: histId.current++, at: Date.now() }, ...prev].slice(0, 20));
  }, []);

  const tap = useCallback((ch: string) => {
    setNumber((cur) => {
      if (ch === "+") return cur.includes("+") ? cur : `+${cur}`;
      return (cur + ch).slice(0, 20);
    });
  }, []);

  const backspace = useCallback(() => setNumber((cur) => cur.slice(0, -1)), []);

  const doCall = useCallback(async () => {
    if (!valid || busy) return;
    const to = number.trim();
    setBusy(true);
    const res = await placeCall({ to, connector: voiceConnector || undefined });
    setBusy(false);
    if (res.ok) {
      pushHist({ kind: "call", to, ok: true, detail: `${res.provider} · ${res.id || "queued"}` });
      onSystem?.(`${t("callQueued")} ${to}`);
    } else {
      pushHist({ kind: "call", to, ok: false, detail: res.message });
      onSystem?.(`${t("call")}: ${res.message}`);
    }
  }, [valid, busy, number, voiceConnector, pushHist, onSystem, t]);

  const doSms = useCallback(async () => {
    const msg = text.trim();
    if (!valid || busy || !msg) return;
    const to = number.trim();
    setBusy(true);
    const res = await sendSms({ to, text: msg, connector: smsConnector || undefined });
    setBusy(false);
    if (res.ok) {
      pushHist({ kind: "sms", to, ok: true, detail: `${res.provider} · ${res.id || "sent"}` });
      onSystem?.(`${t("smsSent")} ${to}`);
      setText("");
    } else {
      pushHist({ kind: "sms", to, ok: false, detail: res.message });
      onSystem?.(`${t("sms")}: ${res.message}`);
    }
  }, [valid, busy, number, text, smsConnector, pushHist, onSystem, t]);

  if (status && !status.enabled) {
    return (
      <div className="phone">
        <div className="phone__banner phone__banner--warn">
          <div className="phone__banner-head"><AlertTriangle width={16} height={16} /> <strong>{t("disabledTitle")}</strong></div>
          <p>{t("disabledBody")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="phone">
      {/* number display */}
      <div className="phone__display">
        <input
          className="phone__number"
          value={number}
          inputMode="tel"
          onChange={(e) => setNumber(e.target.value.replace(/[^\d+*#]/g, "").slice(0, 20))}
          placeholder={t("placeholderNumber")}
          aria-label={t("number")}
        />
        <button type="button" className="phone__bs" onClick={backspace} aria-label={t("backspace")}>
          <Delete width={18} height={18} />
        </button>
      </div>
      {number.trim().length > 1 && !valid ? <p className="phone__hint phone__hint--err">{t("invalidNumber")}</p> : null}

      {/* dial pad */}
      <div className="phone__pad">
        {PAD_KEYS.map((k) => (
          <button key={k} type="button" className="phone__key" onClick={() => tap(k)}>{k}</button>
        ))}
        <button type="button" className="phone__key phone__key--plus" onClick={() => tap("+")}>+</button>
      </div>

      {/* mode toggle */}
      <div className="phone__tabs" role="tablist">
        <button type="button" role="tab" aria-selected={mode === "call"} className="phone__tab" onClick={() => setMode("call")}>
          <Phone width={14} height={14} /> {t("call")}
        </button>
        <button type="button" role="tab" aria-selected={mode === "sms"} className="phone__tab" onClick={() => setMode("sms")}>
          <MessageSquare width={14} height={14} /> {t("sms")}
        </button>
      </div>

      {mode === "call" ? (
        <div className="phone__section">
          {status?.voice.length ? (
            <label className="phone__label">{t("callProvider")}
              <select className="phone__select" value={voiceConnector} onChange={(e) => setVoiceConnector(e.target.value)} data-testid="phone-voice-connector">
                {status.voice.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </label>
          ) : <p className="phone__hint">{t("noProvider")}</p>}
          <button type="button" className="phone__btn phone__btn--call" disabled={!valid || busy || !status?.voice.length} onClick={() => void doCall()}>
            <PhoneOutgoing width={16} height={16} /> {busy ? t("calling") : t("call")}
          </button>
          <p className="phone__note">{t("mediaNote")}</p>
        </div>
      ) : (
        <div className="phone__section">
          {status?.sms.length ? (
            <label className="phone__label">{t("smsProvider")}
              <select className="phone__select" value={smsConnector} onChange={(e) => setSmsConnector(e.target.value)} data-testid="phone-sms-connector">
                {status.sms.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </label>
          ) : <p className="phone__hint">{t("noProvider")}</p>}
          <textarea
            className="phone__textarea"
            rows={3}
            value={text}
            maxLength={1600}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("placeholderText")}
            data-testid="phone-sms-text"
          />
          <div className="phone__row">
            <span className="phone__count">{text.length}/1600</span>
            <button type="button" className="phone__btn phone__btn--send" disabled={!valid || busy || !text.trim() || !status?.sms.length} onClick={() => void doSms()}>
              <Send width={16} height={16} /> {busy ? t("sending") : t("send")}
            </button>
          </div>
        </div>
      )}

      {/* history */}
      <div className="phone__section">
        <div className="phone__section-title">
          <span>{t("history")}</span>
          {history.length ? <button type="button" className="phone__link" onClick={() => setHistory([])}>{t("clear")}</button> : null}
        </div>
        {history.length === 0 ? <p className="phone__hint">{t("noHistory")}</p> : (
          <ul className="phone__hist">
            {history.map((h) => (
              <li key={h.id} className={`phone__hist-item ${h.ok ? "" : "phone__hist-item--err"}`}>
                {h.kind === "call" ? <Phone width={13} height={13} /> : <MessageSquare width={13} height={13} />}
                <span className="phone__hist-to">{h.to}</span>
                <span className="phone__hist-detail">{h.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default PhonePanel;
