// Invite links UI: the "Share" section of the Room window and the prompt an
// invitee sees. All cryptography lives in lib/share-link.ts.

import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Check, Copy, KeyRound, Link2, Mail, MessageCircle, MessageSquare, MessagesSquare, Phone,
  QrCode, Send, Share2, ShieldCheck, Smartphone, Trash2, type LucideIcon,
} from "lucide-react";
import { t, type Lang } from "../lib/i18n";
import {
  createShare, formatCode, normalizeCode, redeemShare, revokeShare, shareTargets,
  type CreatedShare, type ShareLinkParts, type SharePayload, type ShareTarget,
} from "../lib/share-link";

const TARGET_ICONS: Record<ShareTarget["id"], LucideIcon> = {
  whatsapp: MessageCircle, telegram: Send, viber: Phone, signal: ShieldCheck, messenger: MessageSquare,
  imessage: MessagesSquare, sms: Smartphone, email: Mail, qr: QrCode, copy: Copy, native: Share2,
};

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** Renders the QR matrix as one SVG path — no innerHTML, no remote service. */
export function QrCodeView({ value, size = 208 }: { value: string; size?: number }) {
  const [matrix, setMatrix] = useState<boolean[][] | null>(null);
  useEffect(() => {
    let alive = true;
    // loaded on demand: most sessions never open a QR code
    void import("uqr").then(({ encode }) => { if (alive) setMatrix(encode(value, { ecc: "M", border: 2 }).data); });
    return () => { alive = false; };
  }, [value]);
  const path = useMemo(() => {
    if (!matrix) return "";
    let d = "";
    matrix.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x} ${y}h1v1h-1z`; }));
    return d;
  }, [matrix]);
  if (!matrix) return <div className="qr-box" style={{ width: size, height: size }} aria-busy="true" />;
  return (
    <svg className="qr-box" width={size} height={size} viewBox={`0 0 ${matrix.length} ${matrix.length}`} role="img" aria-label="QR" shapeRendering="crispEdges" data-testid="share-qr">
      <rect width="100%" height="100%" fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

export function ShareSection(props: {
  lang: Lang;
  room: string;
  passphrase: string;
  /** Sharing needs the room key in memory, i.e. an active (or restored) session. */
  ready: boolean;
}) {
  const { lang, room, passphrase, ready } = props;
  const [maxUses, setMaxUses] = useState(1);
  const [ttlSec, setTtlSec] = useState(24 * 3600);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [share, setShare] = useState<CreatedShare | null>(null);
  const [copied, setCopied] = useState<"" | "link" | "code">("");
  const [showQr, setShowQr] = useState(false);

  const flash = (what: "link" | "code") => { setCopied(what); window.setTimeout(() => setCopied(""), 1600); };

  async function create() {
    setBusy(true); setError(""); setShowQr(false);
    try {
      // a new link always gets a new id, a new link key and a new code
      setShare(await createShare({ room, passphrase }, { maxUses, ttlSec }));
    } catch (err) {
      setError(`${t(lang, "share.error")} (${(err as Error).message})`);
    } finally { setBusy(false); }
  }

  async function revoke() {
    if (!share) return;
    await revokeShare(share.id, share.revokeToken);
    setShare(null); setShowQr(false);
  }

  async function onTarget(target: ShareTarget) {
    if (!share) return;
    const text = t(lang, "share.message");
    if (target.id === "qr") { setShowQr((v) => !v); return; }
    if (target.id === "copy") { if (await copyText(share.url)) flash("link"); return; }
    if (target.href) { window.open(target.href, "_blank", "noopener,noreferrer"); return; }
    // Signal and "more…": the system share sheet knows the installed apps.
    if (typeof navigator.share === "function") {
      try { await navigator.share({ title: "M5cet", text, url: share.url }); } catch { /* user dismissed */ }
    } else if (await copyText(share.url)) { flash("link"); }
  }

  return (
    <section className="share-section" data-testid="share-section" aria-label={t(lang, "share.title")}>
      <h3 className="flex items-center gap-2 text-sm font-semibold"><Link2 className="h-4 w-4" aria-hidden="true" />{t(lang, "share.title")}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{t(lang, "share.intro")}</p>

      {!share ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="grid gap-1 text-xs font-medium">
              {t(lang, "share.maxUses")}
              <select data-testid="share-max-uses" className="share-select" value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
                {[1, 2, 3, 5, 10, 25].map((n) => <option key={n} value={n}>{n}×</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-xs font-medium">
              {t(lang, "share.ttl")}
              <select data-testid="share-ttl" className="share-select" value={ttlSec} onChange={(e) => setTtlSec(Number(e.target.value))}>
                <option value={3600}>1 h</option>
                <option value={24 * 3600}>24 h</option>
                <option value={7 * 24 * 3600}>7 d</option>
              </select>
            </label>
          </div>
          <button type="button" data-testid="button-share" disabled={!ready || busy} onClick={() => void create()}
            className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-primary/50 bg-primary/10 px-4 text-sm font-semibold text-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50">
            <Share2 className="h-4 w-4" aria-hidden="true" />
            {busy ? t(lang, "share.creating") : t(lang, "share.create")}
          </button>
          {!ready ? <p className="mt-2 text-xs text-muted-foreground">{t(lang, "share.needSession")}</p> : null}
        </>
      ) : (
        <div className="mt-3 space-y-3" data-testid="share-result">
          <div>
            <div className="text-xs font-medium">{t(lang, "share.link")}</div>
            <div className="mt-1 flex items-center gap-2">
              <input readOnly value={share.url} data-testid="share-url" onFocus={(e) => e.currentTarget.select()}
                className="min-h-10 min-w-0 flex-1 rounded-xl border border-input bg-background px-3 font-mono text-xs outline-none focus:ring-2 focus:ring-ring" />
              <button type="button" className="share-copy" data-testid="share-copy-link" aria-label={t(lang, "share.copyLink")} title={t(lang, "share.copyLink")}
                onClick={() => void copyText(share.url).then((ok) => ok && flash("link"))}>
                {copied === "link" ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
              </button>
            </div>
          </div>

          <div>
            <div className="flex items-center gap-1 text-xs font-medium"><KeyRound className="h-3.5 w-3.5" aria-hidden="true" />{t(lang, "share.code")}</div>
            <div className="mt-1 flex items-center gap-2">
              <output className="share-code" data-testid="share-code">{formatCode(share.code)}</output>
              <button type="button" className="share-copy" data-testid="share-copy-code" aria-label={t(lang, "share.copyCode")} title={t(lang, "share.copyCode")}
                onClick={() => void copyText(formatCode(share.code)).then((ok) => ok && flash("code"))}>
                {copied === "code" ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
              </button>
            </div>
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t(lang, "share.codeHint")}</p>
          </div>

          <div role="group" aria-label={t(lang, "share.via")} className="share-targets">
            {shareTargets(share.url, t(lang, "share.message")).map((target) => {
              const Icon = TARGET_ICONS[target.id];
              const label = target.id === "copy" ? t(lang, "share.copyLink") : target.id === "native" ? t(lang, "share.more") : target.label;
              return (
                <button key={target.id} type="button" className="share-target" data-testid={`share-via-${target.id}`} title={label}
                  aria-pressed={target.id === "qr" ? showQr : undefined} onClick={() => void onTarget(target)}>
                  <Icon className="h-5 w-5" aria-hidden="true" />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>

          {showQr ? <div className="flex justify-center"><QrCodeView value={share.url} /></div> : null}

          <p className="text-xs text-muted-foreground">
            {t(lang, "share.limits").replace("{uses}", String(share.maxUses)).replace("{attempts}", String(share.maxAttempts))
              .replace("{expires}", new Date(share.expiresAt).toLocaleString(lang))}
          </p>
          <div className="flex gap-2">
            <button type="button" data-testid="share-new" onClick={() => void create()} disabled={busy}
              className="inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent">
              <Share2 className="h-4 w-4" aria-hidden="true" />{t(lang, "share.another")}
            </button>
            <button type="button" data-testid="share-revoke" onClick={() => void revoke()}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-destructive/40 px-3 text-sm text-destructive hover:bg-destructive/10">
              <Trash2 className="h-4 w-4" aria-hidden="true" />{t(lang, "share.revoke")}
            </button>
          </div>
        </div>
      )}
      {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
    </section>
  );
}

/** Shown when the app was opened from an invite link. */
export function InvitePrompt(props: {
  lang: Lang;
  parts: ShareLinkParts;
  onAccept: (payload: SharePayload) => void;
  onDismiss: () => void;
}) {
  const { lang, parts, onAccept, onDismiss } = props;
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [dead, setDead] = useState(false);
  const code = normalizeCode(value);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!code || busy) return;
    setBusy(true); setMessage("");
    const outcome = await redeemShare(parts, code);
    setBusy(false);
    if (outcome.ok) { onAccept(outcome.payload); return; }
    if (outcome.reason === "wrong-code") setMessage(t(lang, "invite.wrong").replace("{left}", String(outcome.attemptsLeft ?? 0)));
    else if (outcome.reason === "network") setMessage(t(lang, "invite.network"));
    else { setDead(true); setMessage(t(lang, outcome.reason === "burned" ? "invite.burned" : "invite.gone")); }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3" data-testid="form-invite" autoComplete="off">
      <p className="text-sm text-muted-foreground">{t(lang, "invite.intro")}</p>
      <label className="grid gap-1 text-sm font-medium">
        {t(lang, "invite.code")}
        <input data-testid="input-invite-code" autoFocus inputMode="numeric" autoComplete="one-time-code" placeholder="0000-0000-0000"
          disabled={dead} value={value} onChange={(e) => setValue(formatCode(e.target.value))}
          className="min-h-12 rounded-xl border border-input bg-background px-3 text-center font-mono text-xl tracking-widest outline-none focus:ring-2 focus:ring-ring" />
      </label>
      {message ? <p role="alert" className="text-sm text-destructive" data-testid="invite-message">{message}</p> : null}
      <div className="flex gap-2">
        <button type="submit" data-testid="button-invite-join" disabled={!code || busy || dead}
          className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50">
          {busy ? t(lang, "invite.checking") : t(lang, "invite.join")}
        </button>
        <button type="button" onClick={onDismiss} className="inline-flex min-h-11 items-center rounded-2xl border border-border bg-background px-3 text-sm hover:bg-accent">
          {t(lang, "common.cancel")}
        </button>
      </div>
    </form>
  );
}
