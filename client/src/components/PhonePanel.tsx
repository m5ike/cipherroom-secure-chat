// Telephony panel (Server-enhanced mode). Talks to /api/telephony/* which the
// operator wires to a provider (Twilio / Telnyx / Vonage…). Dial pad + E.164
// number field, a Call action and an SMS composer, and a small local history.
//
// When the module is off or unconfigured, it explains what the operator must
// enable — it never pretends to work.
//
// 4.13: the panel is a layout ("panel.phone", lib/layouts/phone.ts); its
// texts and the calls stay here.
// 6.13: the texts come from the app's dictionary ("tel.*", lib/i18n-extra.ts
// and i18n/locales/<lang>/web-extra.json) — nine languages instead of the
// panel's own cs / en / de table. The layout still reads them as $txt.<name>.

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import "./phone-panel.css";
import { renderLayout } from "./LayoutView";
import { useLayoutBase } from "./LayoutProvider";
import { fetchTelephonyStatus, sendSms, placeCall, type TelephonyConnectorInfo } from "../lib/telephony";
import { t as translate, type Lang } from "../lib/i18n";

export type PhonePanelProps = {
  lang: Lang;
  onSystem?: (message: string) => void;
  /** Where the providers come from (the Layout builder's preview gives its own). */
  loadStatus?: () => Promise<{ enabled: boolean; sms: TelephonyConnectorInfo[]; voice: TelephonyConnectorInfo[] }>;
};

/* ---------- texts ($txt.<name> in the layout ← "tel.<name>") ---------- */

const TEXT_NAMES = [
  "disabledTitle", "disabledBody", "number", "placeholderNumber", "invalidNumber", "call", "sms", "send", "calling", "sending",
  "callProvider", "smsProvider", "noProvider", "placeholderText", "history", "noHistory", "clear", "callQueued", "smsSent", "backspace", "mediaNote",
] as const;
type TextName = (typeof TEXT_NAMES)[number];

/** The panel's texts in a language (the layout's $txt). */
export function phoneTexts(lang: Lang): Record<TextName, string> {
  return Object.fromEntries(TEXT_NAMES.map((name) => [name, translate(lang, `tel.${name}`)])) as Record<TextName, string>;
}

const E164 = /^\+[1-9]\d{1,14}$/;
const PAD_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

type HistItem = { id: number; kind: "call" | "sms"; to: string; at: number; ok: boolean; detail: string };

export function PhonePanel(props: PhonePanelProps): React.ReactNode {
  const { lang, onSystem } = props;
  const t = useCallback((k: TextName) => translate(lang, `tel.${k}`), [lang]);

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
      txt: phoneTexts(lang),
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
