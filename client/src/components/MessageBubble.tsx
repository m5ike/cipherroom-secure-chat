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
//
// 6.2: files are shown in the bubble (a picture, a video, a sound, a PDF
// card, a text's first lines) and listed in a footer with save / share /
// forward; a position becomes a small map (lib/map-preview.ts). Revealing a
// hold-to-read message and opening a sealed one are reported to the app
// (onRevealed / onOpened) for the message's timeline.
//
// 6.7: the map is no longer in the bubble — a pin (a position message: its
// place chip) opens it in a window with navigation and ride apps
// (LocationSheet); beside a hold-to-read bubble the row holds it open too.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { t, tf, type Lang } from "../lib/i18n";
import type { MsgState } from "../lib/chat-types";
import { openSealed, type MsgFlags } from "../lib/message-kinds";
import type { LNode } from "../lib/layout-tree";
import type { MessageKind } from "../lib/layouts/message";
import { DEFAULT_LAYOUTS } from "../lib/layouts";
import { renderLayout, type LayoutEnv } from "./LayoutView";
import { Markdown } from "./Markdown";
import { FnOutputs } from "./fn/FnOutputs";
import { FnLoading, FnStatusChip } from "./fn/FnLoading";
import { osmLink } from "../lib/maps";
import type { MapPreviewPolicy } from "../lib/client-config";
import { mapView, placeOf } from "../lib/map-preview";
import { LocationSheet } from "./LocationSheet";
import {
  MEDIA_ICON, attachmentBlob, dataUrlBytes, dataUrlToBlob, mediaKindOf, openAttachment, saveAttachment, shareAttachment, textPreview, type MediaKind,
} from "../lib/attachment-media";
import "../bubbles.css";

export type BubbleAttachment = { kind: "file" | "image"; name: string; mime: string; size: number; dataUrl: string; dropped?: boolean };

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
  /** 6.1: the sender's position when writing (a map pin). */
  loc?: { lat: number; lon: number; acc?: number };
  /** 6.2: the operator's map preview (client config › map); without it, the pin link. */
  mapPolicy?: MapPreviewPolicy;
  /** 6.2: hidden in this view (drawn while the conversation shows hidden messages). */
  hidden?: boolean;
  /** 6.2: a hold-to-read message was revealed / a sealed one opened with its code. */
  onRevealed?: (id: string) => void;
  onOpened?: (id: string) => void;
  /** 6.2: a short notice (a file name copied). */
  onNotice?: (text: string) => void;
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

/** 6.7: how long the area beside a hold-to-read bubble is held before it reveals. */
const HOLD_SIDE_MS = 180;

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

/** A file's bytes made playable here: the CSP's media-src takes blob: but not
 *  data:, so an inline file (a data: URL) plays from a blob: URL of its own. */
function usePlayableUrl(url: string | undefined, mime: string, wanted: boolean): string | undefined {
  const convert = wanted && Boolean(url?.startsWith("data:")) && typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
  const [blobUrl, setBlobUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!convert || !url) { setBlobUrl(undefined); return; }
    const blob = dataUrlToBlob(url, mime);
    if (!blob) return;
    const made = URL.createObjectURL(blob);
    setBlobUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [convert, url, mime]);
  if (!wanted) return undefined;
  return convert ? blobUrl : url;
}

/** The first lines of a text file: at once from a data: URL, a moment later from a received blob. */
function useTextPreview(att: BubbleAttachment | undefined, kind: MediaKind | null): { text: string; more: boolean } | null {
  const url = kind === "text" ? att?.dataUrl ?? "" : "";
  const size = att?.size ?? 0;
  const inline = useMemo(() => {
    if (!url.startsWith("data:")) return null;
    const bytes = dataUrlBytes(url, 4096);
    return bytes ? textPreview(bytes, 6, 480, size) : null;
  }, [url, size]);
  const [later, setLater] = useState<{ text: string; more: boolean } | null>(null);
  useEffect(() => {
    setLater(null);
    if (!url.startsWith("blob:") || !att) return;
    const blob = attachmentBlob(att);
    if (!blob) return;
    let live = true;
    void blob.slice(0, 4096).arrayBuffer().then((buf) => { if (live) setLater(textPreview(new Uint8Array(buf), 6, 480, blob.size)); }).catch(() => undefined);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  return inline ?? later;
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

  // 6.2: each reveal of a hold-to-read message is a step of its timeline.
  useEffect(() => {
    if (tap && holding && sealedOpen && !props.vanished) props.onRevealed?.(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tap, holding, sealedOpen]);

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
      props.onOpened?.(id);
    } catch {
      setCodeError(true);
    }
  }

  const isPrivate = Array.isArray(props.to) && props.to.length > 0;
  const bodyText = sealed ? (sealedOpen ? sealText ?? "" : "") : props.text;

  const style: CSSProperties = { ...(props.bubbleStyle ?? {}) };
  if (flags?.vanishSeconds) (style as Record<string, string>)["--vp"] = String(remaining);

  // 6.2: the file — what can be shown of it, and the footer's row.
  const att = props.attachment;
  const mediaKind = att ? mediaKindOf(att) : null;
  const available = Boolean(att && att.dataUrl && !att.dropped);
  const playable = usePlayableUrl(att?.dataUrl, att?.mime ?? "", available && (mediaKind === "audio" || mediaKind === "video"));
  const preview = useTextPreview(available ? att : undefined, mediaKind);
  const [shareMenu, setShareMenu] = useState<number | null>(null);
  const hasPreview = available && (mediaKind === "image" || mediaKind === "video" || mediaKind === "audio" || mediaKind === "pdf" || (mediaKind === "text" && Boolean(preview)));

  // 6.2: the position as a map (null: the policy is off → the pin link).
  const { loc, mapPolicy, senderName } = props;
  const map = useMemo(() => {
    if (!loc || !mapPolicy) return null;
    return mapView(loc, mapPolicy, { caption: tf(lang, "msg.map.caption", { name: senderName }), url: osmLink({ lat: loc.lat, lng: loc.lon, ts: 0 }, 17) });
  }, [loc, mapPolicy, lang, senderName]);
  // 6.7: where the message points (its header position, or a position message's text) — opened in a window.
  const place = useMemo(() => placeOf(props.text, loc, sealed), [props.text, loc, sealed]);
  const [placeOpen, setPlaceOpen] = useState(false);
  // The hold area beside the bubble reveals after a short hold (a scroll starting there reveals nothing).
  const holdTimer = useRef<number | null>(null);
  useEffect(() => () => { if (holdTimer.current !== null) window.clearTimeout(holdTimer.current); }, []);

  async function shareFile() {
    if (!att) return;
    if (shareMenu === 0) { setShareMenu(null); return; }
    if (!(await shareAttachment(att))) setShareMenu(0);
  }

  // 4.0.5: the bubble is a layout (lib/layouts/message.ts) the operator can
  // redesign in the console; these are the values and actions it may use.
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
    fnRunning: Boolean(flags?.fn?.pending),
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
    loc: props.loc ? { lat: props.loc.lat, lon: props.loc.lon, acc: props.loc.acc ?? null, url: osmLink({ lat: props.loc.lat, lng: props.loc.lon, ts: 0 }, 17) } : null,
    replyTo: props.replyTo ?? null,
    bodyText,
    attachment: att
      ? {
          ...att, kind: mediaKind, sizeText: props.formatSize(att.size),
          isImage: mediaKind === "image", isAudio: mediaKind === "audio", isVideo: mediaKind === "video", isPdf: mediaKind === "pdf", isText: mediaKind === "text",
          mediaUrl: playable ?? "", preview: preview?.text ?? "", previewMore: Boolean(preview?.more), hasPreview,
        }
      : null,
    attachments: att && mediaKind
      ? [{ index: 0, name: att.name, mime: att.mime, kind: mediaKind, icon: MEDIA_ICON[mediaKind], sizeText: props.formatSize(att.size), available, dropped: !available }]
      : null,
    shareMenu,
    map,
    place,
    hidden: Boolean(props.hidden),
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
  const hold = (on: boolean) => () => {
    if (holdTimer.current !== null) { window.clearTimeout(holdTimer.current); holdTimer.current = null; }
    if (tap) setHolding(on);
  };
  const holdSoon = () => {
    if (!tap || holdTimer.current !== null) return;
    holdTimer.current = window.setTimeout(() => { holdTimer.current = null; setHolding(true); }, HOLD_SIDE_MS);
  };
  const env: LayoutEnv = {
    data,
    lang,
    translate: (key) => t(lang, key),
    // A command's output ("/keyword") is rendered as Markdown; ordinary text
    // is linkified. Sealed bodies stay linkified until they are opened.
    // 5.3: with its outputs, every one is shown, played or run (buttons, forms, media…).
    formats: { links: (s) => {
      if (!flags?.fn || sealed) return props.renderText(s);
      const fn = flags.fn;
      const result = fn.outputs?.length
        ? <FnOutputs outputs={fn.outputs} meta={fn} createdAt={props.createdAt} />
        : <Markdown text={s} className="md-fn" />;
      // 6.5: a call's own bubble shows the query, then the loading / result / status.
      if (fn.query !== undefined || fn.pending || fn.status) {
        return (
          <div className="fn-call">
            {fn.query ? <div className="fn-call__query">{props.renderText(fn.query)}</div> : null}
            {fn.pending
              ? <FnLoading label={tf(lang, "functions.running", { name: fn.name })} />
              : fn.status
                ? <FnStatusChip status={fn.status} />
                : result}
          </div>
        );
      }
      return result;
    } },
    refs: { root: rootRef as never },
    blocks: props.blocks,
    slots: { badge: () => props.badge },
    actions: {
      info: () => props.onInfo?.(id),
      quoteJump: () => { if (props.replyTo) props.onReplyJump?.(props.replyTo.id); },
      unfold: () => { if (isSystem) sysUnfold(); },
      holdStart: hold(true),
      holdEnd: hold(false),
      holdSideStart: holdSoon,
      place: () => { if (place) setPlaceOpen(true); },
      codeChange: (e) => { setCodeInput((e as { target: HTMLInputElement }).target.value); setCodeError(false); },
      codeKey: (e) => { if ((e as { key?: string }).key === "Enter") void submitCode(); },
      codeSubmit: () => void submitCode(),
      reply: () => props.onReply?.(),
      forward: () => props.onForward?.(),
      // 6.2: the footer's buttons (the argument is the file's index; one file per message today).
      save: () => { if (att) saveAttachment(att); setShareMenu(null); },
      share: () => void shareFile(),
      open: () => { if (att) openAttachment(att); },
      copyName: () => {
        if (att) void navigator.clipboard?.writeText(att.name).then(() => props.onNotice?.(t(lang, "msg.file.nameCopied")), () => undefined);
        setShareMenu(null);
      },
      closeShare: () => setShareMenu(null),
    },
  };
  const bubble = renderLayout(props.tree ?? DEFAULT_MESSAGE_TREES[isSystem ? "sys" : mine ? "out" : "in"], env);
  if (!placeOpen || !place) return bubble;
  return (
    <>
      {bubble}
      <LocationSheet id={id} place={place} senderName={senderName} mine={mine} mapPolicy={mapPolicy} lang={lang} onClose={() => setPlaceOpen(false)} onNotice={props.onNotice} />
    </>
  );
}
