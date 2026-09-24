// Per-message info + audit trail. Shows who/when/how, the on-wire ciphertext
// vs the decrypted text, the lifecycle timeline (created → encrypted → sent →
// received → decrypted → displayed → discarded), and — for an attachment —
// save / open / share / forward actions. Everything is derived locally; states
// we cannot observe (e.g. a remote read receipt) are simply absent, never
// invented.
//
// 4.13: the view is a layout ("dialog.messageInfo", lib/layouts/dialogs.ts).

import { type Lang } from "../lib/i18n";
import { renderLayout } from "./LayoutView";
import { useLayoutBase } from "./LayoutProvider";

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
  cryptoVersion?: 1 | 2 | 3;
  sealedWith?: "sender-key" | "pair" | "room";
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
};

export function MessageInfoView({ info, lang, onForward }: { info: MessageInfo; lang: Lang; onForward: () => void }) {
  async function shareAttachment() {
    const a = info.attachment;
    if (!a) return;
    try {
      const res = await fetch(a.url);
      const blob = await res.blob();
      const file = new File([blob], a.name, { type: a.mime });
      const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean; share?: (d: { files: File[]; title?: string }) => Promise<void> };
      if (nav.share && (!nav.canShare || nav.canShare({ files: [file] }))) await nav.share({ files: [file], title: a.name });
    } catch { /* user cancelled or unsupported */ }
  }

  const { tree, base } = useLayoutBase("dialog.messageInfo", lang);
  const a = info.attachment;
  return renderLayout(tree, {
    ...base,
    data: {
      sender: info.sender, recipients: info.recipients, route: info.route, ip: info.ip, created: new Date(info.createdAt).toLocaleString(lang),
      secure: info.secure, cryptoVersion: info.cryptoVersion ?? 1, sealedWith: info.sealedWith, identity: info.identity ?? null, flags: info.flags,
      audit: info.audit.map((x) => ({ label: STATE_LABEL[x.state] || x.state, time: new Date(x.at).toLocaleTimeString(lang), meta: x.meta ?? "" })),
      cipher: info.cipher ?? "", cipherShort: info.cipher ? `${info.cipher.slice(0, 220)}${info.cipher.length > 220 ? "…" : ""}` : "",
      plaintext: info.plaintext, attachment: a ? { ...a, sizeText: fmtBytes(a.size) } : null,
    },
    actions: {
      copyCipher: () => { if (info.cipher) void navigator.clipboard?.writeText(info.cipher); },
      share: () => void shareAttachment(),
      forward: () => onForward(),
    },
  });
}
