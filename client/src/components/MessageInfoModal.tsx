// Per-message info + audit trail. Shows who/when/how, the on-wire ciphertext
// vs the decrypted text, the lifecycle timeline (created → encrypted → sent →
// received → decrypted → displayed → discarded), and — for an attachment —
// save / open / share / forward actions. Everything is derived locally; states
// we cannot observe (e.g. a remote read receipt) are simply absent, never
// invented.

import { Lock, LockOpen, Download, ExternalLink, Share2, Forward, Copy } from "lucide-react";
import { t, type Lang } from "../lib/i18n";

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
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="userinfo-row">
      <span className="userinfo-row__k">{label}</span>
      <span className="userinfo-row__v">{value}</span>
    </div>
  );
}

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

  return (
    <div className="space-y-3">
      <div className="userinfo-grid">
        <Row label={t(lang, "msginfo.sender")} value={info.sender} />
        <Row label={t(lang, "msginfo.recipients")} value={info.recipients.join(", ")} />
        <Row label={t(lang, "msginfo.route")} value={info.route} />
        <Row label={t(lang, "userinfo.ip")} value={info.ip || t(lang, "userinfo.ip.unknown")} />
        <Row label={t(lang, "msginfo.created")} value={new Date(info.createdAt).toLocaleString(lang)} />
        <Row label={t(lang, "userinfo.security")} value={<span className="inline-flex items-center gap-1">{info.secure ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />} {info.secure ? "AES-GCM 256" : t(lang, "msginfo.insecure")}</span>} />
        {info.flags.length > 0 ? <Row label={t(lang, "msginfo.kinds")} value={info.flags.join(" · ")} /> : null}
      </div>

      <div>
        <div className="userinfo-row__k mb-1">{t(lang, "msginfo.audit")}</div>
        <ol className="msg-audit" data-testid="msg-audit">
          {info.audit.map((a, i) => (
            <li key={i}>
              <span className="msg-audit__dot" aria-hidden="true" />
              <span className="msg-audit__state">{t(lang, STATE_LABEL[a.state] || a.state)}</span>
              <span className="msg-audit__time">{new Date(a.at).toLocaleTimeString(lang)}{a.meta ? ` · ${a.meta}` : ""}</span>
            </li>
          ))}
        </ol>
      </div>

      <details className="msg-data">
        <summary>{t(lang, "msginfo.encrypted")}</summary>
        <div className="msg-data__row">
          <code className="userinfo-fp">{info.cipher ? `${info.cipher.slice(0, 220)}${info.cipher.length > 220 ? "…" : ""}` : "—"}</code>
          {info.cipher ? <button type="button" className="ai-chip" onClick={() => void navigator.clipboard?.writeText(info.cipher!)}><Copy className="h-3.5 w-3.5" /> {t(lang, "common.copy")}</button> : null}
        </div>
      </details>
      <details className="msg-data">
        <summary>{t(lang, "msginfo.decrypted")}</summary>
        <code className="userinfo-fp">{info.plaintext ?? t(lang, "msginfo.sealedNote")}</code>
      </details>

      {info.attachment ? (
        <div className="msg-attach-actions">
          <div className="text-xs font-semibold">{info.attachment.name} · {info.attachment.mime} · {fmtBytes(info.attachment.size)}</div>
          <div className="flex flex-wrap gap-2">
            <a className="ai-chip" href={info.attachment.url} download={info.attachment.name}><Download className="h-3.5 w-3.5" /> {t(lang, "msginfo.save")}</a>
            <a className="ai-chip" href={info.attachment.url} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" /> {t(lang, "msginfo.open")}</a>
            <button type="button" className="ai-chip" onClick={() => void shareAttachment()}><Share2 className="h-3.5 w-3.5" /> {t(lang, "msginfo.share")}</button>
            <button type="button" className="ai-chip" onClick={onForward}><Forward className="h-3.5 w-3.5" /> {t(lang, "msginfo.forward")}</button>
          </div>
        </div>
      ) : (
        <button type="button" className="ai-chip" onClick={onForward}><Forward className="h-3.5 w-3.5" /> {t(lang, "msginfo.forward")}</button>
      )}
    </div>
  );
}
