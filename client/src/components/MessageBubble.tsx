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
import { t, type Lang } from "../lib/i18n";
import type { MsgState } from "../lib/chat-types";
import { openSealed, type MsgFlags } from "../lib/message-kinds";
import type { LNode } from "../lib/layout-tree";
import type { MessageKind } from "../lib/layouts/message";
import { DEFAULT_LAYOUTS } from "../lib/layouts";
import { renderLayout, type LayoutEnv } from "./LayoutView";

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
  /** Which key sealed it (sender key / pair key / room key) — a data attribute for tests and styling. */
  sealedWith?: "sender-key" | "pair" | "room";
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
  /** 4.0.5: the layout to draw (Layout builder); default: the app's own. */
  tree?: LNode;
  /** The builder's reusable templates, for "Template" elements. */
  blocks?: Record<string, LNode>;
  /** The head of my own / a system message: avatar, header text, logo. */
  head?: { showAvatar?: boolean; avatar?: string; headerText?: string; showLogo?: boolean };
};

/** The app's own layouts of the three kinds. */
const DEFAULT_MESSAGE_TREES: Record<MessageKind, LNode> = { in: DEFAULT_LAYOUTS["message.in"], out: DEFAULT_LAYOUTS["message.out"], sys: DEFAULT_LAYOUTS["message.sys"] };

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

  const style: CSSProperties = { ...(props.bubbleStyle ?? {}) };
  if (flags?.vanishSeconds) (style as Record<string, string>)["--vp"] = String(remaining);

  // 4.0.5: the bubble is a layout (lib/layouts/message.ts) the operator can
  // redesign in the console; these are the values and actions it may use.
  const att = props.attachment;
  const data: Record<string, unknown> = {
    id,
    mine,
    isSystem,
    senderId: props.senderId,
    senderName: props.senderName,
    sealedWith: props.sealedWith,
    private: isPrivate,
    to: isPrivate ? props.to!.join(", ") : "",
    queued: props.deliveryState === "queued",
    vanishing: Boolean(flags?.vanishSeconds),
    vanished: Boolean(props.vanished),
    vanishedAtText: props.vanished && props.vanishedAt ? ` · ${new Date(props.vanishedAt).toLocaleString(lang)}` : "",
    collapsed: sysCollapsed,
    bubbleStyle: style,
    hasInfo: !isSystem && Boolean(props.onInfo),
    timeLabel: props.timeLabel,
    createdAt: props.createdAt,
    secure: props.secure,
    tap,
    sealed,
    sealedOpen,
    revealed,
    delivery: mine ? props.deliveryState : undefined,
    forwardedFrom: props.forwardedFrom ?? "",
    replyTo: props.replyTo ?? null,
    bodyText,
    attachment: att ? { ...att, isImage: att.kind === "image", isAudio: att.kind !== "image" && att.mime.startsWith("audio/"), sizeText: props.formatSize(att.size) } : null,
    sealCode: sealed && mine ? props.sealCode ?? "" : "",
    codeInput,
    codeError,
    canReply: Boolean(props.onReply),
    canForward: Boolean(props.onForward),
    showActions: !isSystem && !props.vanished && Boolean(props.onReply || props.onForward),
    showAvatar: Boolean(props.head?.showAvatar),
    avatar: props.head?.avatar ?? "",
    headerText: props.head?.headerText ?? "",
    showLogo: Boolean(props.head?.showLogo),
  };
  const hold = (on: boolean) => () => { if (tap) setHolding(on); };
  const env: LayoutEnv = {
    data,
    lang,
    translate: (key) => t(lang, key),
    formats: { links: (s) => props.renderText(s) },
    refs: { root: rootRef as never },
    blocks: props.blocks,
    slots: { badge: () => props.badge },
    actions: {
      info: () => props.onInfo?.(id),
      quoteJump: () => { if (props.replyTo) props.onReplyJump?.(props.replyTo.id); },
      unfold: () => { if (isSystem) sysUnfold(); },
      holdStart: hold(true),
      holdEnd: hold(false),
      codeChange: (e) => { setCodeInput((e as { target: HTMLInputElement }).target.value); setCodeError(false); },
      codeKey: (e) => { if ((e as { key?: string }).key === "Enter") void submitCode(); },
      codeSubmit: () => void submitCode(),
      reply: () => props.onReply?.(),
      forward: () => props.onForward?.(),
    },
  };
  return renderLayout(props.tree ?? DEFAULT_MESSAGE_TREES[isSystem ? "sys" : mine ? "out" : "in"], env);
}
