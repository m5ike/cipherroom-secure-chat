// Per-message info + audit trail. Shows who/when/how, the on-wire ciphertext
// vs the decrypted text, the lifecycle timeline (created → encrypted → sent →
// received → decrypted → displayed → expired), and — for an attachment —
// save / open / share / forward actions. Everything is derived locally; states
// we cannot observe (e.g. a remote read receipt) are simply absent, never
// invented.
//
// 4.13: the view is a layout ("dialog.messageInfo", lib/layouts/dialogs.ts).
// 6.2: every state with its time (the vocabulary the Android app shares —
// message-timeline.ts), receipts per recipient, the size and every kind, and
// hiding or deleting the message in one's own view (message-hide.ts).

import { useEffect, useMemo, useState } from "react";
import { t, type Lang } from "../lib/i18n";
import { renderLayout } from "./LayoutView";
import { useLayoutBase } from "./LayoutProvider";
import { HIDE_CHOICES, isHideChoice, type HideChoice } from "../lib/message-hide";
import { attachmentBlob, shareAttachment } from "../lib/attachment-media";
import type { Receipt } from "../lib/message-timeline";

export type MsgAuditItem = { state: string; at: number; meta?: string };

export type MessageInfo = {
  id: string;
  mine: boolean;
  sender: string;
  senderId: string;
  recipients: string[];
  ip?: string;
  route: string;
  createdAt: number;
  secure: boolean;
  cipher?: string;
  plaintext?: string;
  flags: string[];
  audit: MsgAuditItem[];
  attachment?: { name: string; mime: string; size: number; url: string };
  /** Sender identity line (crypto v2), already worded. */
  identity?: { text: string; tone: "ok" | "warn" | "muted" };
  cryptoVersion?: 1 | 2 | 3 | 4;
  /** Which key sealed it (6.12: "p4-sk", "p4-pair", "p4-mailbox" — protocol 4). */
  sealedWith?: "sender-key" | "pair" | "room" | "p4-sk" | "p4-pair" | "p4-mailbox";
  /** 6.12: my message — every way it went out, already worded (more than one). */
  sealedHow?: string[];
  /** 6.2: every kind, already worded (text, file, location, private…). */
  kinds?: string[];
  /** 6.2: the text's bytes and the file's size. */
  size?: { text: number; file: number };
  /** 6.2: when a message with a lifetime disappears (ms). */
  expiresAt?: number;
  /** 6.2: my message by recipient (message-timeline.ts). */
  receipts?: Receipt[];
  /** 6.2: hidden in this view until (ms; 0 = the next sign-in). */
  hiddenUntil?: number;
};

/** 6.2: what the window may do with the message (hide / delete in this view). */
export type MessageInfoActions = {
  onHide?: (choice: HideChoice) => void;
  onUnhide?: () => void;
  onDelete?: () => void;
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

const STATE_LABEL: Record<string, string> = {
  created: "msginfo.state.created",
  encrypted: "msginfo.state.encrypted",
  sent: "msginfo.state.sent",
  received: "msginfo.state.received",
  decrypted: "msginfo.state.decrypted",
  displayed: "msginfo.state.displayed",
  discarded: "msginfo.state.discarded",
  queued: "msginfo.state.queued",
  // Away relay (a signed-in recipient who was not connected).
  stored: "msginfo.state.stored",
  forwarded: "msginfo.state.forwarded",
  delivered: "msginfo.state.delivered",
  read: "msginfo.state.read",
  // 6.2
  revealed: "msginfo.state.revealed",
  opened: "msginfo.state.opened",
  expired: "msginfo.state.expired",
  hidden: "msginfo.state.hidden",
  unhidden: "msginfo.state.unhidden",
};

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** A step's time: with seconds, and with the date when it was not today. */
function stepTime(at: number, lang: Lang, now: number): string {
  return sameDay(at, now)
    ? new Date(at).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : new Date(at).toLocaleString(lang, { day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** A step's note: a hide's end and why a hide ended are worded; anything else as recorded. */
function stepMeta(state: string, meta: string | undefined, lang: Lang, now: number): string {
  if (!meta) return "";
  if (state === "hidden" && /^\d+$/.test(meta)) {
    const until = Number(meta);
    return until === 0 ? t(lang, "msginfo.meta.untilSignIn") : t(lang, "msginfo.meta.until").replace("{time}", stepTime(until, lang, now));
  }
  if (state === "unhidden") return meta === "time" ? t(lang, "msginfo.meta.timeUp") : meta === "sign-in" ? t(lang, "msginfo.meta.signIn") : meta;
  return meta;
}

const RECEIPT_STEPS = ["stored", "forwarded", "delivered", "read"] as const;

export function MessageInfoView({ info, lang, onForward, actions = {} }: { info: MessageInfo; lang: Lang; onForward: () => void; actions?: MessageInfoActions }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [shareMenu, setShareMenu] = useState(false);
  const a = info.attachment;

  // 6.2: the file as a blob: URL of this page — saving and opening work for an
  // inline file too (a data: URL may not be opened as a page), revoked on close.
  const url = a?.url ?? "";
  const mime = a?.mime ?? "";
  const blob = useMemo(() => (url.startsWith("data:") ? attachmentBlob({ kind: "file", name: "", mime, size: 0, dataUrl: url }) : null), [url, mime]);
  const [fileUrl, setFileUrl] = useState(url);
  useEffect(() => {
    if (!blob || typeof URL.createObjectURL !== "function") { setFileUrl(url); return; }
    const made = URL.createObjectURL(blob);
    setFileUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [url, blob]);

  async function shareAttachmentNow() {
    if (!a) return;
    if (shareMenu) { setShareMenu(false); return; }
    const ok = await shareAttachment({ kind: "file", name: a.name, mime: a.mime, size: a.size, dataUrl: a.url });
    if (!ok) setShareMenu(true);
  }

  const { tree, base } = useLayoutBase("dialog.messageInfo", lang);
  const now = Date.now();
  const sizeParts = info.size
    ? [info.size.text > 0 ? t(lang, "msginfo.size.text").replace("{size}", fmtBytes(info.size.text)) : "", info.size.file > 0 ? t(lang, "msginfo.size.file").replace("{size}", fmtBytes(info.size.file)) : ""].filter(Boolean)
    : [];
  const receipts = (info.receipts ?? []).map((r) => ({
    name: r.name,
    steps: RECEIPT_STEPS.filter((s) => r[s] !== undefined).map((s) => ({ state: s, label: STATE_LABEL[s], time: stepTime(r[s] as number, lang, now) })),
  }));
  const canManage = Boolean(actions.onHide || actions.onDelete);
  const hiddenText = info.hiddenUntil === undefined
    ? ""
    : info.hiddenUntil === 0 ? t(lang, "msginfo.hidden.untilSignIn") : t(lang, "msginfo.hidden.until").replace("{time}", stepTime(info.hiddenUntil, lang, now));
  return renderLayout(tree, {
    ...base,
    data: {
      sender: info.sender, recipients: info.recipients, route: info.route, ip: info.ip, created: new Date(info.createdAt).toLocaleString(lang),
      secure: info.secure, cryptoVersion: info.cryptoVersion ?? 1, sealedWith: info.sealedWith, identity: info.identity ?? null, flags: info.flags,
      sealedHowText: (info.sealedHow ?? []).join(" · "),
      kinds: info.kinds ?? info.flags,
      sizeText: sizeParts.join(" · "),
      expiresText: info.expiresAt ? stepTime(info.expiresAt, lang, now) : "",
      audit: info.audit.map((x) => ({ state: x.state, label: STATE_LABEL[x.state] || x.state, time: stepTime(x.at, lang, now), meta: stepMeta(x.state, x.meta, lang, now) })),
      receipts: receipts.length ? receipts : null,
      cipher: info.cipher ?? "", cipherShort: info.cipher ? `${info.cipher.slice(0, 220)}${info.cipher.length > 220 ? "…" : ""}` : "",
      plaintext: info.plaintext, attachment: a ? { ...a, url: fileUrl, sizeText: fmtBytes(a.size) } : null,
      shareMenu,
      canManage,
      hiddenText,
      hideChoices: actions.onHide ? HIDE_CHOICES.map((c) => ({ id: c.id, label: `msginfo.hide.${c.id}` })) : [],
      confirmDelete,
    },
    actions: {
      copyCipher: () => { if (info.cipher) void navigator.clipboard?.writeText(info.cipher); },
      share: () => void shareAttachmentNow(),
      copyName: () => { if (a) void navigator.clipboard?.writeText(a.name); setShareMenu(false); },
      forward: () => onForward(),
      hide: (_e, arg) => { if (isHideChoice(arg)) actions.onHide?.(arg); },
      unhide: () => actions.onUnhide?.(),
      delete: () => { if (actions.onDelete) setConfirmDelete(true); },
      deleteConfirm: () => { setConfirmDelete(false); actions.onDelete?.(); },
      deleteCancel: () => setConfirmDelete(false),
    },
  });
}
