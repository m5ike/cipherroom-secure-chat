// Invite links UI: the "Share" section of the Room window, the "Share a
// connection" window of My connections, and the prompt an invitee sees. All
// cryptography lives in lib/share-link.ts.
//
// 4.13: each view is a layout ("part.shareResult", "panel.share",
// "panel.shareConnection", "part.invite" — lib/layouts/share.ts).

import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import { t, type Lang } from "../lib/i18n";
import { renderLayout } from "./LayoutView";
import { useLayoutBase } from "./LayoutProvider";
import {
  createShare, formatCode, normalizeCode, redeemShare, revokeShare, shareTargets,
  type CreatedShare, type ShareLinkParts, type SharePayload, type ShareTarget,
} from "../lib/share-link";

const TARGET_ICONS: Record<ShareTarget["id"], string> = {
  whatsapp: "message-circle", telegram: "send", viber: "phone", signal: "shield-check", messenger: "message-square",
  imessage: "messages-square", sms: "smartphone", email: "mail", qr: "qr-code", copy: "copy", native: "share-2",
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

const USES = [1, 2, 3, 5, 10, 25] as const;
const TTLS = [3600, 24 * 3600, 7 * 24 * 3600] as const;
const ttlLabel = (sec: number) => (sec < 24 * 3600 ? `${sec / 3600} h` : sec < 7 * 24 * 3600 ? "24 h" : "7 d");

/** Creating, revoking and re-creating one invite; shared by both share views. */
function useShare(lang: Lang, input: () => { room: string; passphrase: string; name?: string; server?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [share, setShare] = useState<CreatedShare | null>(null);
  async function create(options: { maxUses: number; ttlSec: number }) {
    setBusy(true); setError("");
    try {
      // a new link always gets a new id, a new link key and a new code
      setShare(await createShare(input(), options));
    } catch (err) {
      setError(`${t(lang, "share.error")} (${(err as Error).message})`);
    } finally { setBusy(false); }
  }
  async function revoke() {
    if (!share) return;
    await revokeShare(share.id, share.revokeToken);
    setShare(null);
  }
  return { busy, error, share, create, revoke };
}

/** A created invite: link, code, where to send it, QR, limits, new / revoke. */
export function ShareResult({ lang, share, busy, onAnother, onRevoke }: {
  lang: Lang; share: CreatedShare; busy: boolean; onAnother: () => void; onRevoke: () => void;
}) {
  const [copied, setCopied] = useState<"" | "link" | "code">("");
  const [showQr, setShowQr] = useState(false);
  const flash = (what: "link" | "code") => { setCopied(what); window.setTimeout(() => setCopied(""), 1600); };

  async function onTarget(target: ShareTarget) {
    const text = t(lang, "share.message");
    if (target.id === "qr") { setShowQr((v) => !v); return; }
    if (target.id === "copy") { if (await copyText(share.url)) flash("link"); return; }
    if (target.href) { window.open(target.href, "_blank", "noopener,noreferrer"); return; }
    // Signal and "more…": the system share sheet knows the installed apps.
    if (typeof navigator.share === "function") {
      try { await navigator.share({ title: "M5cet", text, url: share.url }); } catch { /* user dismissed */ }
    } else if (await copyText(share.url)) { flash("link"); }
  }

  const { tree, base } = useLayoutBase("part.shareResult", lang);
  const targets = shareTargets(share.url, t(lang, "share.message"));
  return renderLayout(tree, {
    ...base,
    data: {
      url: share.url,
      code: formatCode(share.code),
      copied,
      showQr,
      targets: targets.map((target) => ({ id: target.id, icon: TARGET_ICONS[target.id], label: target.id === "copy" ? t(lang, "share.copyLink") : target.id === "native" ? t(lang, "share.more") : target.label })),
      limits: t(lang, "share.limits").replace("{uses}", String(share.maxUses)).replace("{attempts}", String(share.maxAttempts)).replace("{expires}", new Date(share.expiresAt).toLocaleString(lang)),
      busy,
    },
    actions: {
      selectAll: (e) => (e as { currentTarget: HTMLInputElement }).currentTarget.select(),
      copyLink: () => void copyText(share.url).then((ok) => ok && flash("link")),
      copyCode: () => void copyText(formatCode(share.code)).then((ok) => ok && flash("code")),
      target: (_e, id) => { const target = targets.find((x) => x.id === id); if (target) void onTarget(target); },
      another: () => onAnother(),
      revoke: () => onRevoke(),
    },
    slots: { qr: () => <QrCodeView value={share.url} /> },
  });
}

export function ShareSection(props: {
  lang: Lang;
  room: string;
  passphrase: string;
  /** Sharing needs the room key in memory, i.e. an active (or restored) session. */
  ready: boolean;
  /** The signaling server of the session, when it is not this one. */
  server?: string;
}) {
  const { lang, room, passphrase, ready, server } = props;
  const [maxUses, setMaxUses] = useState(1);
  const [ttlSec, setTtlSec] = useState(24 * 3600);
  const { busy, error, share, create, revoke } = useShare(lang, () => ({ room, passphrase, server }));
  const options = { maxUses, ttlSec };

  const { tree, base } = useLayoutBase("panel.share", lang);
  return renderLayout(tree, {
    ...base,
    data: { created: Boolean(share), ready, busy, error, uses: USES, maxUses, ttls: TTLS.map((sec) => ({ sec, label: ttlLabel(sec) })), ttlSec },
    actions: {
      maxUses: (e) => setMaxUses(Number((e as ChangeEvent<HTMLSelectElement>).target.value)),
      ttl: (e) => setTtlSec(Number((e as ChangeEvent<HTMLSelectElement>).target.value)),
      create: () => void create(options),
    },
    slots: { result: () => (share ? <ShareResult lang={lang} share={share} busy={busy} onAnother={() => void create(options)} onRevoke={() => void revoke()} /> : null) },
  });
}

/**
 * "Share a connection" (My connections › share): the same invite as the Room
 * window — room, key and a name, sealed under a 12-digit code, limited uses
 * and lifetime — made from a saved connection. It needs no live session (the
 * key is stored), names the guest if you like, and carries the connection's
 * signaling server when it is not this one.
 */
export function ShareConnection(props: {
  lang: Lang;
  connection: { label: string; color: string; room: string; passphrase: string; server: string };
  onDone: () => void;
}) {
  const { lang, connection } = props;
  const [maxUses, setMaxUses] = useState<number>(1);
  const [ttlSec, setTtlSec] = useState<number>(24 * 3600);
  const [guest, setGuest] = useState("");
  const { busy, error, share, create, revoke } = useShare(lang, () => ({
    room: connection.room, passphrase: connection.passphrase, name: guest.trim() || undefined, server: connection.server || undefined,
  }));
  const options = { maxUses, ttlSec };
  const host = connection.server ? new URL(connection.server).host : "";

  const { tree, base } = useLayoutBase("panel.shareConnection", lang);
  return renderLayout(tree, {
    ...base,
    data: {
      label: connection.label, color: connection.color, room: connection.room, host, created: Boolean(share), busy, error,
      uses: USES.map((v) => ({ value: v, label: `${v}×` })), maxUses, ttls: TTLS.map((v) => ({ value: v, label: ttlLabel(v) })), ttlSec, guest,
    },
    actions: {
      maxUses: (_e, v) => setMaxUses(Number(v)),
      ttl: (_e, v) => setTtlSec(Number(v)),
      guest: (e) => setGuest((e as ChangeEvent<HTMLInputElement>).target.value.replace(/[^\p{L}\p{N} ._-]/gu, "")),
      create: () => void create(options),
      done: () => props.onDone(),
    },
    slots: { result: () => (share ? <ShareResult lang={lang} share={share} busy={busy} onAnother={() => void create(options)} onRevoke={() => void revoke()} /> : null) },
  });
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

  const { tree, base } = useLayoutBase("part.invite", lang);
  return renderLayout(tree, {
    ...base,
    data: { value, code, busy, dead, message },
    actions: {
      code: (e) => setValue(formatCode((e as ChangeEvent<HTMLInputElement>).target.value)),
      submit: (e) => void submit(e as FormEvent),
      dismiss: () => onDismiss(),
    },
  });
}
