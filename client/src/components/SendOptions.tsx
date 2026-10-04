// The send button and its options. The three message kinds (tap / vanish /
// sealed) are toggled from a popover that opens either by tapping the small
// chevron or by long-pressing the send button. Any combination — none, one,
// two or all three — is allowed.
//
// 6.8: "Send as voice" is a checkbox of the same popover (asVoice): while it
// is ticked, Send sends the text as a voice message (the server's text to
// speech) instead of the text — the send button shows a speaker and says so.
// Like the kinds it stays on for the next messages until it is unticked or
// cleared. Tap and vanish apply to the voice message; sealed does not (the
// app refuses that combination — speak-send.ts › composerSendRoute).

import { useEffect, useRef, useState } from "react";
import { Send, ChevronUp, Timer, EyeOff, ScrollText, Dice5, Volume2 } from "lucide-react";
import { t, type Lang } from "../lib/i18n";
import { VANISH_PRESETS, generateSealCode } from "../lib/message-kinds";

export type SendState = {
  tap: boolean;
  vanishSeconds: number; // 0 = off
  sealed: boolean;
  sealCode: string; // "" → a random code is generated at send time
  /** 6.8: Send sends the text as a voice message instead (off by default). */
  asVoice: boolean;
};

export const DEFAULT_SEND_STATE: SendState = { tap: false, vanishSeconds: 0, sealed: false, sealCode: "", asVoice: false };

export function activeCount(s: SendState): number {
  return (s.tap ? 1 : 0) + (s.vanishSeconds > 0 ? 1 : 0) + (s.sealed ? 1 : 0) + (s.asVoice ? 1 : 0);
}

export function SendOptions({
  value, onChange, onSend, canSend, lang, voiceOption = false, voiceBusy = false,
}: {
  value: SendState;
  onChange: (next: SendState) => void;
  /** Send — the text, or (6.8, asVoice ticked) the voice message: the app decides. */
  onSend: () => void;
  canSend: boolean;
  lang: Lang;
  /** 6.8: offer "Send as voice" (the text spoken by the server's voice, sent as a voice message). */
  voiceOption?: boolean;
  /** The text is being turned into a voice message right now. */
  voiceBusy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const longRef = useRef<number | null>(null);
  const longFiredRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  function startLong() {
    longFiredRef.current = false;
    longRef.current = window.setTimeout(() => { longFiredRef.current = true; setOpen(true); }, 450);
  }
  function endLong() {
    if (longRef.current !== null) { window.clearTimeout(longRef.current); longRef.current = null; }
  }
  function onSendClick() {
    if (longFiredRef.current) { longFiredRef.current = false; return; } // was a long-press
    onSend();
  }

  const count = activeCount(value);
  const voice = voiceOption && value.asVoice;
  const sendLabel = voice ? t(lang, voiceBusy ? "speakSend.busy" : "speakSend.button") : t(lang, "common.send");

  return (
    <div className="composer-send-group">
      <button
        type="button"
        className="composer-opts"
        aria-label={t(lang, "msgkind.options")}
        aria-expanded={open}
        title={t(lang, "msgkind.options")}
        data-testid="button-send-options"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronUp className="h-4 w-4" aria-hidden="true" />
        {count > 0 ? <span className="composer-opts__dot" aria-hidden="true">{count}</span> : null}
      </button>

      <button
        data-testid="button-send"
        className="composer-send"
        type="button"
        disabled={!canSend || (voice && voiceBusy)}
        aria-label={sendLabel}
        title={sendLabel}
        aria-busy={voice && voiceBusy ? true : undefined}
        data-voice={voice ? "on" : undefined}
        onPointerDown={startLong}
        onPointerUp={endLong}
        onPointerLeave={endLong}
        onPointerCancel={endLong}
        onClick={onSendClick}
      >
        {voice ? <Volume2 className="h-4 w-4" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
      </button>

      {open ? (
        <>
          <div className="user-pop__backdrop" onMouseDown={() => setOpen(false)} />
          <div className="send-pop" role="menu" onMouseDown={(e) => e.stopPropagation()} data-testid="send-pop">
            <p className="send-pop__title">{t(lang, "msgkind.title")}</p>

            <label className="send-pop__row">
              <input type="checkbox" checked={value.tap} onChange={(e) => onChange({ ...value, tap: e.target.checked })} data-testid="opt-tap" />
              <Timer className="h-4 w-4" />
              <span><strong>{t(lang, "msgkind.tap")}</strong><em>{t(lang, "msgkind.tap.desc")}</em></span>
            </label>

            <label className="send-pop__row">
              <input type="checkbox" checked={value.vanishSeconds > 0} onChange={(e) => onChange({ ...value, vanishSeconds: e.target.checked ? 15 : 0 })} data-testid="opt-vanish" />
              <EyeOff className="h-4 w-4" />
              <span><strong>{t(lang, "msgkind.vanish")}</strong><em>{t(lang, "msgkind.vanish.desc")}</em></span>
            </label>
            {value.vanishSeconds > 0 ? (
              <select
                className="send-pop__select"
                value={value.vanishSeconds}
                onChange={(e) => onChange({ ...value, vanishSeconds: Number(e.target.value) })}
                data-testid="opt-vanish-secs"
              >
                {VANISH_PRESETS.map((p) => <option key={p.seconds} value={p.seconds}>{t(lang, p.labelKey)}</option>)}
              </select>
            ) : null}

            <label className="send-pop__row">
              <input type="checkbox" checked={value.sealed} onChange={(e) => onChange({ ...value, sealed: e.target.checked })} data-testid="opt-sealed" />
              <ScrollText className="h-4 w-4" />
              <span><strong>{t(lang, "msgkind.sealed")}</strong><em>{t(lang, "msgkind.sealed.desc")}</em></span>
            </label>
            {value.sealed ? (
              <div className="send-pop__seal">
                <input
                  className="send-pop__code"
                  value={value.sealCode}
                  onChange={(e) => onChange({ ...value, sealCode: e.target.value })}
                  placeholder={t(lang, "msgkind.sealed.codeOrRandom")}
                  data-testid="opt-sealed-code"
                  autoComplete="off"
                />
                <button type="button" className="send-pop__dice" title={t(lang, "msgkind.sealed.random")} onClick={() => onChange({ ...value, sealCode: generateSealCode() })}>
                  <Dice5 className="h-4 w-4" />
                </button>
              </div>
            ) : null}

            {voiceOption ? (
              <>
                <label className="send-pop__row">
                  <input type="checkbox" checked={value.asVoice} onChange={(e) => onChange({ ...value, asVoice: e.target.checked })} data-testid="opt-send-voice" />
                  <Volume2 className="h-4 w-4" />
                  <span><strong>{t(lang, "speakSend.button")}</strong><em>{t(lang, "speakSend.optHint")}</em></span>
                </label>
                {value.asVoice && value.sealed ? (
                  <p className="send-pop__warn" role="alert" data-testid="opt-send-voice-sealed">{t(lang, "speakSend.err.sealed")}</p>
                ) : null}
              </>
            ) : null}

            <div className="send-pop__foot">
              <button type="button" className="send-pop__clear" onClick={() => onChange({ ...DEFAULT_SEND_STATE })}>{t(lang, "msgkind.clear")}</button>
              <button type="button" className="send-pop__done" onClick={() => setOpen(false)}>{t(lang, "common.close")}</button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
