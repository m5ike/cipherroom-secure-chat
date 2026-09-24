// Telephony panel (Server-enhanced mode). Talks to /api/telephony/* which the
// operator wires to a provider (Twilio / Telnyx / Vonage…). Dial pad + E.164
// number field, a Call action and an SMS composer, and a small local history.
//
// Self-contained: its own string dictionary (cs/en/de) and its own CSS, so it
// never depends on lib/i18n.ts (mirrors NfcWorkbench). When the module is off
// or unconfigured, it explains what the operator must enable — it never
// pretends to work.
//
// 4.13: the panel is a layout ("panel.phone", lib/layouts/phone.ts); its
// texts and the calls stay here.

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import "./phone-panel.css";
import { renderLayout } from "./LayoutView";
import { useLayoutBase } from "./LayoutProvider";
import { fetchTelephonyStatus, sendSms, placeCall, type TelephonyConnectorInfo } from "../lib/telephony";

export type PhonePanelProps = {
  lang: "cs" | "en" | "de";
  onSystem?: (message: string) => void;
  /** Where the providers come from (the Layout builder's preview gives its own). */
  loadStatus?: () => Promise<{ enabled: boolean; sms: TelephonyConnectorInfo[]; voice: TelephonyConnectorInfo[] }>;
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

export function PhonePanel(props: PhonePanelProps): React.ReactNode {
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
    void (props.loadStatus ?? fetchTelephonyStatus)().then((s) => {
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

  const { tree, base } = useLayoutBase("panel.phone", lang);
  const value = (e: unknown) => (e as ChangeEvent<HTMLInputElement>).target.value;
  return renderLayout(tree, {
    ...base,
    data: {
      txt: { ...DICT.en, ...DICT[lang] },
      disabled: Boolean(status && !status.enabled),
      number, valid, showInvalid: number.trim().length > 1 && !valid, keys: PAD_KEYS, mode,
      voice: status?.voice ?? [], sms: status?.sms ?? [], voiceConnector, smsConnector, text, hasText: Boolean(text.trim()), busy, history,
    },
    actions: {
      number: (e) => setNumber(value(e).replace(/[^\d+*#]/g, "").slice(0, 20)),
      backspace: () => backspace(),
      tap: (_e, k) => tap(String(k)),
      mode: (_e, m) => setMode(m as "call" | "sms"),
      voiceConnector: (e) => setVoiceConnector(value(e)),
      smsConnector: (e) => setSmsConnector(value(e)),
      text: (e) => setText(value(e)),
      call: () => void doCall(),
      send: () => void doSms(),
      clear: () => setHistory([]),
    },
  });
}

export default PhonePanel;
