// One chat bubble. Handles alignment (mine → right, theirs → left), the avatar
// header, per-user styling, the "private vs everyone" distinction, and the
// three optional message kinds:
//
//   tap     hold-to-reveal curtain
//   vanish  a TTL border-"thermometer": a full 2 px ring at the start that
//           shrinks as the visible time runs out, leaving a 1 px dotted grey
//           edge, then a tombstone. Time only advances while the bubble is
//           genuinely visible (tab focused, in view, and — for a tap message —
//           while it is being held open).
//   sealed  a locked body that needs a per-message code to read.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Lock, Timer, ScrollText, EyeOff, Users, Paperclip, Info, Reply, Forward, CornerUpLeft, Check, CheckCheck, Clock, SendHorizontal } from "lucide-react";
import { t, type Lang } from "../lib/i18n";
import type { MsgState } from "../lib/chat-types";
import { openSealed, type MsgFlags } from "../lib/message-kinds";

export type BubbleAttachment = { kind: "file" | "image"; name: string; mime: string; size: number; dataUrl: string };

export type MessageBubbleProps = {
  id: string;
  senderId: string;
  senderName: string;
  mine: boolean;
  isSystem: boolean;
  secure: boolean;
  createdAt: number;
  timeLabel: string;
  text: string; // ciphertext when sealed && !mine
  attachment?: BubbleAttachment;
  flags?: MsgFlags;
  ownPlaintext?: string; // sender's original text for a sealed message
  sealCode?: string; // sender's code, to display so they can share it
  vanished?: boolean;
  vanishedAt?: number;
  onVanish: (id: string) => void;
  to?: string[]; // present → private message, only to these names
  replyTo?: { id: string; senderName: string; text: string };
  forwardedFrom?: string;
  bubbleStyle?: CSSProperties;
  badge: ReactNode; // <UserBadge/> (others) or plain name label (self/system)
  lang: Lang;
  renderText: (s: string) => ReactNode;
  formatSize: (n: number) => string;
  onInfo?: (id: string) => void;
  onReply?: () => void;
  onForward?: () => void;
  onDisplayed?: (id: string) => void;
  onReplyJump?: (id: string) => void;
  /** System notices only: fold to the first line after N s (0 = never)… */
  systemCollapseAfterSec?: number;
  /** …and stay unfolded for N s after a hover/click. */
  systemExpandForSec?: number;
  /** How far my own message got (away relay): stored → delivered → read. */
  deliveryState?: MsgState;
};

/** The single status mark on my own bubble. */
function DeliveryMark({ state, lang }: { state: MsgState; lang: Lang }) {
  const label = t(lang, `msginfo.state.${state}`);
  const icon = state === "queued"
    ? <SendHorizontal className="h-3 w-3" />
    : state === "stored"
      ? <Clock className="h-3 w-3" />
      : state === "read" || state === "delivered"
        ? <CheckCheck className="h-3 w-3" />
        : <Check className="h-3 w-3" />;
  return (
    <span className={`msg-delivery is-${state}`} title={label} aria-label={label} data-testid="msg-delivery">
      {icon}
    </span>
  );
}

function useTabVisible(): boolean {
  const [v, setV] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const on = () => setV(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return v;
}

function useInView(ref: React.RefObject<HTMLElement | null>): boolean {
  const [v, setV] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((es) => setV(es[0]?.isIntersecting ?? true), { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return v;
}

/** Returns remaining fraction (1→0). Advances only while `active`. Calls
 *  onDone once the visible time reaches the TTL. */
function useVanishRing(totalSec: number | undefined, active: boolean, onDone: () => void): number {
  const [remaining, setRemaining] = useState(1);
  const accRef = useRef(0);
  const lastRef = useRef<number | null>(null);
  const shownRef = useRef(1);
  const doneRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (!totalSec || doneRef.current) return;
    if (typeof requestAnimationFrame === "undefined") return;
    const totalMs = totalSec * 1000;
    let raf = 0;
    lastRef.current = null;
    const loop = (ts: number) => {
      if (doneRef.current) return;
      if (active) {
        if (lastRef.current !== null) accRef.current += ts - lastRef.current;
        lastRef.current = ts;
      } else {
        lastRef.current = null;
      }
      const rem = Math.max(0, 1 - accRef.current / totalMs);
      if (Math.abs(rem - shownRef.current) > 0.008 || rem === 0) { shownRef.current = rem; setRemaining(rem); }
      if (accRef.current >= totalMs) { doneRef.current = true; onDoneRef.current(); return; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [totalSec, active]);
  return remaining;
}

export function MessageBubble(props: MessageBubbleProps) {
  const { flags, mine, isSystem, lang, id } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const tabVisible = useTabVisible();
  const inView = useInView(rootRef);

  const [holding, setHolding] = useState(false); // tap: finger down
  const [sealText, setSealText] = useState<string | null>(props.mine && props.ownPlaintext !== undefined ? props.ownPlaintext : null);
  const [codeInput, setCodeInput] = useState("");
  const [codeError, setCodeError] = useState(false);

  const sealed = Boolean(flags?.sealed);
  const sealedOpen = !sealed || sealText !== null;
  const tap = Boolean(flags?.tap);
  const revealed = sealedOpen && (!tap || holding);

  // Vanish counts only while the reader can actually see the content.
  const counting = Boolean(flags?.vanishSeconds) && tabVisible && inView && revealed && !props.vanished;
  const remaining = useVanishRing(flags?.vanishSeconds, counting, () => props.onVanish(id));

  // Record "displayed" once the bubble is genuinely on screen.
  const displayedRef = useRef(false);
  useEffect(() => {
    if (!isSystem && tabVisible && inView && !displayedRef.current) { displayedRef.current = true; props.onDisplayed?.(id); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabVisible, inView, isSystem, id]);

  // System notices fold to their first line after a while; hover/click unfolds
  // them briefly, then they fade back.
  const [sysCollapsed, setSysCollapsed] = useState(false);
  const sysArmedRef = useRef(false);
  const sysTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const after = props.systemCollapseAfterSec ?? 0;
    if (!isSystem || after <= 0) return;
    const t = window.setTimeout(() => { sysArmedRef.current = true; setSysCollapsed(true); }, after * 1000);
    return () => { window.clearTimeout(t); if (sysTimerRef.current !== null) window.clearTimeout(sysTimerRef.current); };
  }, [isSystem, props.systemCollapseAfterSec]);
  function sysUnfold() {
    if (!isSystem || !sysArmedRef.current) return;
    setSysCollapsed(false);
    if (sysTimerRef.current !== null) window.clearTimeout(sysTimerRef.current);
    sysTimerRef.current = window.setTimeout(() => setSysCollapsed(true), (props.systemExpandForSec ?? 20) * 1000);
  }

  async function submitCode() {
    if (!flags?.sealed) return;
    try {
      const opened = await openSealed(props.text, flags.sealed, codeInput.trim());
      setSealText(opened);
      setCodeError(false);
    } catch {
      setCodeError(true);
    }
  }

  const isPrivate = Array.isArray(props.to) && props.to.length > 0;
  const bodyText = sealed ? (sealedOpen ? sealText ?? "" : "") : props.text;

  const wrapCls = `flex ${mine ? "justify-end" : "justify-start"}`;
  const bubbleCls = [
    "msg-bubble",
    isSystem ? "msg-bubble--system" : mine ? "msg-bubble--mine" : "msg-bubble--theirs",
    // Still waiting for its recipient: lighter, and marked as sending.
    props.deliveryState === "queued" ? "msg-bubble--queued" : "",
    isPrivate ? "msg-bubble--private" : "",
    flags?.vanishSeconds ? "vanish-ring" : "",
    props.vanished ? "msg-bubble--vanished" : "",
    sysCollapsed ? "msg-bubble--sys-collapsed" : "",
  ].filter(Boolean).join(" ");

  const style: CSSProperties = { ...(props.bubbleStyle ?? {}) };
  if (flags?.vanishSeconds) (style as Record<string, string>)["--vp"] = String(remaining);

  return (
    <article ref={rootRef} data-testid={`message-${id}`} className={wrapCls}>
      <div
        className={bubbleCls}
        style={style}
        data-private={isPrivate ? "1" : undefined}
        data-collapsed={sysCollapsed ? "1" : undefined}
        onMouseEnter={isSystem ? sysUnfold : undefined}
        onClick={isSystem ? sysUnfold : undefined}
      >
        {!isSystem && props.onInfo ? (
          <button type="button" className="msg-info-btn" onClick={() => props.onInfo!(id)} aria-label={t(lang, "msginfo.title")} title={t(lang, "msginfo.title")} data-testid={`msg-info-${id}`}>
            <Info className="h-3.5 w-3.5" />
          </button>
        ) : null}
        <div className="msg-bubble__head">
          {props.badge}
          <span className="msg-bubble__time">{props.timeLabel}</span>
          {props.secure ? <Lock className="h-3 w-3 opacity-70" aria-label={t(lang, "userinfo.secure")} /> : null}
          {tap ? <Timer className="h-3 w-3 opacity-70" aria-label={t(lang, "msgkind.tap")} /> : null}
          {flags?.vanishSeconds ? <EyeOff className="h-3 w-3 opacity-70" aria-label={t(lang, "msgkind.vanish")} /> : null}
          {sealed ? <ScrollText className="h-3 w-3 opacity-70" aria-label={t(lang, "msgkind.sealed")} /> : null}
          {mine && props.deliveryState ? <DeliveryMark state={props.deliveryState} lang={lang} /> : null}
        </div>

        {props.forwardedFrom ? (
          <div className="msg-fwd"><Forward className="h-3 w-3" /> {t(lang, "msginfo.forwardedFrom")}: {props.forwardedFrom}</div>
        ) : null}

        {props.replyTo ? (
          <button type="button" className="msg-quote" onClick={() => props.onReplyJump?.(props.replyTo!.id)} data-testid={`msg-quote-${id}`}>
            <CornerUpLeft className="h-3 w-3" />
            <span className="msg-quote__inner">
              <span className="msg-quote__name">{props.replyTo.senderName}</span>
              <span className="msg-quote__text">{props.replyTo.text}</span>
            </span>
          </button>
        ) : null}

        {isPrivate ? (
          <div className="msg-bubble__private-tag"><Lock className="h-3 w-3" /> {t(lang, "recipients.privateTo")}: {props.to!.join(", ")}</div>
        ) : null}

        {props.vanished ? (
          <p className="msg-bubble__tombstone">
            {t(lang, "msgkind.vanish.gone")}
            {props.vanishedAt ? ` · ${new Date(props.vanishedAt).toLocaleString(lang)}` : ""}
          </p>
        ) : sealed && !sealedOpen ? (
          <div className="msg-seal">
            <p className="msg-seal__hint"><ScrollText className="h-4 w-4" /> {t(lang, "msgkind.sealed.locked")}</p>
            <div className="msg-seal__row">
              <input
                className="msg-seal__input"
                value={codeInput}
                onChange={(e) => { setCodeInput(e.target.value); setCodeError(false); }}
                onKeyDown={(e) => { if (e.key === "Enter") void submitCode(); }}
                placeholder={t(lang, "msgkind.sealed.code")}
                data-testid={`seal-code-${id}`}
                autoComplete="off"
              />
              <button type="button" className="msg-seal__btn" onClick={() => void submitCode()}>{t(lang, "msgkind.sealed.unlock")}</button>
            </div>
            {codeError ? <p className="msg-seal__err">{t(lang, "msgkind.sealed.wrong")}</p> : null}
          </div>
        ) : (
          <>
            {tap && !revealed ? (
              <button
                type="button"
                className="msg-tap"
                onPointerDown={() => setHolding(true)}
                onPointerUp={() => setHolding(false)}
                onPointerLeave={() => setHolding(false)}
                onPointerCancel={() => setHolding(false)}
                data-testid={`tap-${id}`}
              >
                <Timer className="h-4 w-4" /> {t(lang, "msgkind.tap.hold")}
              </button>
            ) : (
              <div
                className={isSystem ? "msg-sys__body" : undefined}
                onPointerDown={tap ? () => setHolding(true) : undefined}
                onPointerUp={tap ? () => setHolding(false) : undefined}
                onPointerLeave={tap ? () => setHolding(false) : undefined}
                onPointerCancel={tap ? () => setHolding(false) : undefined}
              >
                {bodyText ? <p className="msg-bubble__text">{props.renderText(bodyText)}{isSystem ? <span className="msg-sys__more" aria-hidden="true">…</span> : null}</p> : null}
                {props.attachment ? (
                  <div className="msg-bubble__attach">
                    {props.attachment.kind === "image" ? (
                      <img src={props.attachment.dataUrl} alt={props.attachment.name} className="msg-bubble__img" />
                    ) : props.attachment.mime.startsWith("audio/") ? (
                      <audio controls src={props.attachment.dataUrl} className="msg-bubble__audio" />
                    ) : (
                      <a href={props.attachment.dataUrl} download={props.attachment.name} className="msg-bubble__file">
                        <Paperclip className="h-3 w-3" /> {props.attachment.name}
                      </a>
                    )}
                    <div className="msg-bubble__meta">{props.attachment.mime} · {props.formatSize(props.attachment.size)}</div>
                  </div>
                ) : null}
              </div>
            )}
            {sealed && mine && props.sealCode ? (
              <p className="msg-seal__code">{t(lang, "msgkind.sealed.yourcode")}: <strong>{props.sealCode}</strong></p>
            ) : null}
          </>
        )}

        {!isSystem && !props.vanished && (props.onReply || props.onForward) ? (
          <div className="msg-actions">
            {props.onReply ? (
              <button type="button" className="msg-act" onClick={props.onReply} data-testid={`msg-reply-${id}`}><Reply className="h-3.5 w-3.5" /> {t(lang, "msginfo.reply")}</button>
            ) : null}
            {props.onForward ? (
              <button type="button" className="msg-act" onClick={props.onForward} data-testid={`msg-forward-${id}`}><Forward className="h-3.5 w-3.5" /> {t(lang, "msginfo.forward")}</button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

/** The little recipient hint shown by the composer for the current selection. */
export function RecipientHint({ names, everyone, lang }: { names: string[]; everyone: boolean; lang: Lang }) {
  if (everyone) return <span className="recipient-hint"><Users className="h-3 w-3" /> {t(lang, "recipients.everyone")}</span>;
  if (names.length === 0) return <span className="recipient-hint is-warn">{t(lang, "recipients.none")}</span>;
  return <span className="recipient-hint is-private"><Lock className="h-3 w-3" /> {names.join(", ")}</span>;
}
