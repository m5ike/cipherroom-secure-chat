// The send button and its options. The three message kinds (tap / vanish /
// sealed) are toggled from a popover that opens either by tapping the small
// chevron or by long-pressing the send button. Any combination — none, one,
// two or all three — is allowed.

import { useEffect, useRef, useState } from "react";
import { Send, ChevronUp, Timer, EyeOff, ScrollText, Dice5 } from "lucide-react";
import { t, type Lang } from "../lib/i18n";
import { VANISH_PRESETS, generateSealCode } from "../lib/message-kinds";

export type SendState = {
  tap: boolean;
  vanishSeconds: number; // 0 = off
  sealed: boolean;
  sealCode: string; // "" → a random code is generated at send time
};

export const DEFAULT_SEND_STATE: SendState = { tap: false, vanishSeconds: 0, sealed: false, sealCode: "" };

export function activeCount(s: SendState): number {
  return (s.tap ? 1 : 0) + (s.vanishSeconds > 0 ? 1 : 0) + (s.sealed ? 1 : 0);
}

export function SendOptions({
  value, onChange, onSend, canSend, lang,
}: {
  value: SendState;
  onChange: (next: SendState) => void;
  onSend: () => void;
  canSend: boolean;
  lang: Lang;
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
        disabled={!canSend}
        aria-label={t(lang, "common.send")}
        title={t(lang, "common.send")}
        onPointerDown={startLong}
        onPointerUp={endLong}
        onPointerLeave={endLong}
        onPointerCancel={endLong}
        onClick={onSendClick}
      >
        <Send className="h-4 w-4" aria-hidden="true" />
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
