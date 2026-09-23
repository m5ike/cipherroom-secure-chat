// The signed-in user in the interface:
//   SignedInBadge        the unlocked-key badge next to the logo
//   AccountInfoModal     what the server holds: credentials, sizes, dates,
//                        counts, away state and the server-side activity log
//   ChatRetentionSection the "chat data and history" choice in Connection,
//                        with the passkey sign-in the server option needs

import { useEffect, useState } from "react";
import { KeyRound, LockKeyholeOpen, RefreshCw, Trash2, Save, LogOut, Moon, Plus, LifeBuoy, MonitorSmartphone, Fingerprint } from "lucide-react";
import { keyFingerprint } from "../lib/identity";
import { t, type Lang } from "../lib/i18n";
import type { AccountSummary, AccountStatus } from "../lib/account";
import type { ChatRetention } from "../lib/chat-history";

function bytes(n: number): string {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function when(at: number, lang: Lang): string {
  if (!at) return t(lang, "acc.never");
  try { return new Date(at).toLocaleString(lang === "cs" ? "cs-CZ" : lang === "de" ? "de-DE" : "en-GB"); } catch { return String(at); }
}

const ALG_NAMES: Record<number, string> = { [-7]: "ES256", [-8]: "Ed25519", [-257]: "RS256" };

/** The badge in the top bar: an unlocked key, the user's name, a live dot. */
// The header badge lives in SignedInBadge.tsx (always loaded); this panel loads on demand.
export { SignedInBadge } from "./SignedInBadge";

function Row({ label, value, mono }: { label: React.ReactNode; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="acc-row">
      <span className="acc-row__label">{label}</span>
      <span className={`acc-row__value${mono ? " font-mono text-[11px]" : ""}`}>{value}</span>
    </div>
  );
}

/** The account's passkeys, recovery code, devices and identity (3.1). */
export type AccountActions = {
  onAddPasskey?: (label: string) => void;
  onRemovePasskey?: (credentialId: string) => void;
  /** Resolves to the new code, shown once. */
  onCreateRecovery?: () => Promise<string | null>;
  onRemoveRecovery?: () => void;
  onEndSession?: (id: string) => void;
};

function PasskeysSection({ account, busy, lang, actions }: { account: AccountSummary; busy: boolean; lang: Lang; actions: AccountActions }) {
  const [label, setLabel] = useState("");
  const passkeys = account.passkeys ?? [{ credentialId: account.credentialId, alg: account.alg, createdAt: account.createdAt, lastUsedAt: account.lastLoginAt, label: "", primary: true }];
  return (
    <section className="acc-card" data-testid="account-passkeys">
      <h4 className="acc-card__title"><KeyRound className="h-4 w-4" />{t(lang, "acc.passkeys")}</h4>
      <p className="text-xs text-muted-foreground">{t(lang, "acc.passkeys.desc")}</p>
      <ul className="acc-list">
        {passkeys.map((p) => (
          <li key={p.credentialId} data-testid="passkey-row">
            <span>
              <strong>{p.label || `${ALG_NAMES[p.alg] ?? p.alg} · ${p.credentialId.slice(0, 8)}…`}</strong>
              {p.primary ? <em className="acc-chip">{t(lang, "acc.passkeys.primary")}</em> : null}
              <small>{t(lang, "acc.sessions.lastUsed").replace("{date}", when(p.lastUsedAt, lang))}</small>
            </span>
            {passkeys.length > 1 && actions.onRemovePasskey ? (
              <button type="button" className="acc-btn acc-btn--small" disabled={busy} onClick={() => { if (window.confirm(t(lang, "acc.passkeys.removeConfirm"))) actions.onRemovePasskey!(p.credentialId); }}>
                <Trash2 className="h-3.5 w-3.5" />{t(lang, "acc.passkeys.remove")}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {actions.onAddPasskey ? (
        <div className="flex flex-wrap items-center gap-2">
          <input className="acc-input" value={label} maxLength={40} placeholder={t(lang, "acc.passkeys.label")} onChange={(e) => setLabel(e.target.value)} data-testid="passkey-label" />
          <button type="button" className="acc-btn" disabled={busy} onClick={() => { actions.onAddPasskey!(label.trim()); setLabel(""); }} data-testid="passkey-add">
            <Plus className="h-4 w-4" />{t(lang, "acc.passkeys.add")}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function RecoverySection({ account, busy, lang, actions }: { account: AccountSummary; busy: boolean; lang: Lang; actions: AccountActions }) {
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const set = account.recovery?.set === true;
  return (
    <section className="acc-card" data-testid="account-recovery">
      <h4 className="acc-card__title"><LifeBuoy className="h-4 w-4" />{t(lang, "acc.recovery")}</h4>
      <p className="text-xs text-muted-foreground">{t(lang, "acc.recovery.desc")}</p>
      <Row label={t(lang, "acc.recovery")} value={set ? t(lang, "acc.recovery.set").replace("{date}", when(account.recovery?.createdAt ?? 0, lang)) : t(lang, "acc.recovery.none")} />
      {code ? (
        <div className="acc-code" data-testid="recovery-code-box">
          <p className="text-xs">{t(lang, "acc.recovery.show")}</p>
          <code data-testid="recovery-code">{code}</code>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="acc-btn acc-btn--small" onClick={() => { void navigator.clipboard?.writeText(code).then(() => setCopied(true)); }}>{copied ? t(lang, "acc.recovery.copied") : t(lang, "acc.recovery.copy")}</button>
            <button type="button" className="acc-btn acc-btn--small" onClick={() => { setCode(null); setCopied(false); }}>{t(lang, "acc.recovery.done")}</button>
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {actions.onCreateRecovery ? (
          <button type="button" className="acc-btn" disabled={busy} data-testid="recovery-create" onClick={() => { void actions.onCreateRecovery!().then((c) => { if (c) setCode(c); }); }}>
            <LifeBuoy className="h-4 w-4" />{t(lang, set ? "acc.recovery.replace" : "acc.recovery.create")}
          </button>
        ) : null}
        {set && actions.onRemoveRecovery ? (
          <button type="button" className="acc-btn acc-btn--danger" disabled={busy} onClick={actions.onRemoveRecovery}>{t(lang, "acc.recovery.remove")}</button>
        ) : null}
      </div>
    </section>
  );
}

function SessionsSection({ account, busy, lang, actions }: { account: AccountSummary; busy: boolean; lang: Lang; actions: AccountActions }) {
  const sessions = account.sessions ?? [];
  if (sessions.length === 0) return null;
  return (
    <section className="acc-card" data-testid="account-sessions">
      <h4 className="acc-card__title"><MonitorSmartphone className="h-4 w-4" />{t(lang, "acc.sessions")}</h4>
      <ul className="acc-list">
        {sessions.map((s) => (
          <li key={s.id} data-testid="session-row">
            <span>
              <strong>{s.client || "—"}</strong>
              {s.current ? <em className="acc-chip">{t(lang, "acc.sessions.current")}</em> : null}
              <small>{[s.ip, t(lang, "acc.sessions.lastUsed").replace("{date}", when(s.lastUsedAt, lang))].filter(Boolean).join(" · ")}</small>
            </span>
            {!s.current && actions.onEndSession ? (
              <button type="button" className="acc-btn acc-btn--small" disabled={busy} onClick={() => actions.onEndSession!(s.id)}>
                <LogOut className="h-3.5 w-3.5" />{t(lang, "acc.sessions.end")}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function IdentityRow({ account, lang }: { account: AccountSummary; lang: Lang }) {
  const [fp, setFp] = useState("");
  const key = account.identity?.publicKey ?? "";
  useEffect(() => {
    let live = true;
    if (key) void keyFingerprint(key).then((v) => { if (live) setFp(v); }).catch(() => undefined);
    return () => { live = false; };
  }, [key]);
  if (!key) return null;
  return (
    <section className="acc-card" data-testid="account-identity">
      <h4 className="acc-card__title"><Fingerprint className="h-4 w-4" />{t(lang, "acc.identity")}</h4>
      <p className="text-xs text-muted-foreground">{t(lang, "acc.identity.desc")}</p>
      <Row label={t(lang, "acc.identity")} value={fp || "…"} mono />
    </section>
  );
}

export function AccountInfoModal({
  account, status, busy, message, lang, onRefresh, onSaveNow, onSignOut, onDelete, actions = {},
}: {
  account: AccountSummary;
  status: AccountStatus | null;
  busy: boolean;
  message: string;
  lang: Lang;
  onRefresh: () => void;
  onSaveNow: () => void;
  onSignOut: () => void;
  onDelete: () => void;
  actions?: AccountActions;
}) {
  const v = account.vault;
  return (
    <div className="space-y-4" data-testid="account-info">
      <p className="text-xs text-muted-foreground">{t(lang, "acc.desc")}</p>
      {status && !status.persistent ? (
        <p className="rounded-xl border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">{t(lang, "acc.notPersistent")}</p>
      ) : null}

      <section className="acc-card">
        <h4 className="acc-card__title"><KeyRound className="h-4 w-4" />{t(lang, "acc.credentials")}</h4>
        <Row label={t(lang, "acc.id")} value={account.id} mono />
        <Row label={t(lang, "acc.credential")} value={`${account.credentialId.slice(0, 16)}…`} mono />
        <Row label={t(lang, "acc.alg")} value={ALG_NAMES[account.alg] ?? String(account.alg)} />
        <Row label={t(lang, "acc.created")} value={when(account.createdAt, lang)} />
        <Row label={t(lang, "acc.lastLogin")} value={when(account.lastLoginAt, lang)} />
        <Row label={t(lang, "acc.logins")} value={account.loginCount} />
      </section>

      <section className="acc-card">
        <h4 className="acc-card__title">{t(lang, "acc.storage")}</h4>
        <Row label={t(lang, "acc.size")} value={bytes(v.profileBytes + v.chatBytes)} />
        <Row label={t(lang, "acc.messages")} value={v.messages} />
        <Row label={t(lang, "acc.messageBytes")} value={bytes(v.messageBytes)} />
        <Row label={t(lang, "acc.rooms")} value={v.rooms} />
        <Row label={t(lang, "acc.profile")} value={`${bytes(v.profileBytes)} · ${when(v.profileUpdatedAt, lang)}`} />
        <Row label={t(lang, "acc.updated")} value={when(v.chatUpdatedAt, lang)} />
        <Row label={t(lang, "acc.mailbox")} value={`${account.mailbox.pending} · ${bytes(account.mailbox.bytes)}`} />
        <Row label={t(lang, "acc.pushDevices")} value={account.pushDevices} />
        {account.away.length > 0 ? (
          <Row
            label={<span className="inline-flex items-center gap-1"><Moon className="h-3.5 w-3.5" />{t(lang, "acc.away")}</span>}
            value={account.away.map((a) => t(lang, "acc.awayIn").replace("{room}", a.room).replace("{since}", when(a.since, lang))).join(", ")}
          />
        ) : null}
      </section>

      <PasskeysSection account={account} busy={busy} lang={lang} actions={actions} />
      <RecoverySection account={account} busy={busy} lang={lang} actions={actions} />
      <SessionsSection account={account} busy={busy} lang={lang} actions={actions} />
      <IdentityRow account={account} lang={lang} />

      <section className="acc-card">
        <h4 className="acc-card__title">{t(lang, "acc.activity")}</h4>
        <ul className="acc-log" data-testid="account-audit">
          {account.audit.length === 0 ? <li className="text-xs text-muted-foreground">—</li> : null}
          {account.audit.map((entry, i) => (
            <li key={`${entry.at}-${i}`}>
              <time>{when(entry.at, lang)}</time>
              <span>{t(lang, `acc.ev.${entry.kind}`) === `acc.ev.${entry.kind}` ? entry.kind : t(lang, `acc.ev.${entry.kind}`)}</span>
              {entry.meta ? <em>{Object.entries(entry.meta).map(([k, val]) => `${k}: ${val}`).join(" · ")}</em> : null}
            </li>
          ))}
        </ul>
      </section>

      {message ? <p className="text-xs" data-testid="account-msg">{message}</p> : null}

      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={onRefresh} className="acc-btn" data-testid="account-refresh">
          <RefreshCw className="h-4 w-4" />{t(lang, "acc.refresh")}
        </button>
        <button type="button" disabled={busy} onClick={onSaveNow} className="acc-btn" data-testid="account-save">
          <Save className="h-4 w-4" />{t(lang, "acc.saveNow")}
        </button>
        <button type="button" disabled={busy} onClick={onSignOut} className="acc-btn" data-testid="account-signout">
          <LogOut className="h-4 w-4" />{t(lang, "acc.signOut")}
        </button>
        <button type="button" disabled={busy} onClick={onDelete} className="acc-btn acc-btn--danger" data-testid="account-delete">
          <Trash2 className="h-4 w-4" />{t(lang, "acc.delete")}
        </button>
      </div>
    </div>
  );
}

/** "Chat data and history" — the three retention modes and the passkey the
 *  server-side one needs. */
export function ChatRetentionSection({
  value, onChange, account, status, supported, busy, message, lang, onSignIn, onRegister, onSignOutAndWipe, onRecover,
}: {
  value: ChatRetention;
  onChange: (next: ChatRetention) => void;
  account: AccountSummary | null;
  status: AccountStatus | null;
  supported: boolean;
  busy: boolean;
  message: string;
  lang: Lang;
  onSignIn: () => void;
  onRegister: () => void;
  onSignOutAndWipe: () => void;
  /** 3.1: every passkey lost — come back with the recovery code. */
  onRecover?: (code: string) => void;
}) {
  const [recovering, setRecovering] = useState(false);
  const [code, setCode] = useState("");
  const options: Array<{ id: ChatRetention; disabled?: boolean }> = [
    { id: "ephemeral" },
    { id: "session" },
    { id: "server", disabled: !account },
  ];
  return (
    <section className="space-y-3" data-testid="retention-section">
      <div>
        <h3 className="text-sm font-semibold">{t(lang, "data.title")}</h3>
        <p className="text-xs text-muted-foreground">{t(lang, "data.desc")}</p>
      </div>

      <div className="space-y-2">
        {options.map((opt) => (
          <label key={opt.id} className={`retention-option${value === opt.id ? " is-active" : ""}${opt.disabled ? " is-disabled" : ""}`} data-testid={`retention-${opt.id}`}>
            <input
              type="radio"
              name="chat-retention"
              checked={value === opt.id}
              disabled={opt.disabled}
              onChange={() => onChange(opt.id)}
            />
            <span>
              <strong>{t(lang, `data.${opt.id}`)}</strong>
              <em>{t(lang, `data.${opt.id}.desc`)}</em>
              {opt.disabled ? <em className="text-amber-600 dark:text-amber-400">{t(lang, "data.server.needsKey")}</em> : null}
            </span>
          </label>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {!account ? (
          <>
            <button type="button" className="acc-btn" disabled={busy || !supported || status?.available === false} onClick={onSignIn} data-testid="account-signin">
              <LockKeyholeOpen className="h-4 w-4" />{t(lang, "acc.signIn")}
            </button>
            <button type="button" className="acc-btn" disabled={busy || !supported || status?.available === false} onClick={onRegister} data-testid="account-register">
              <KeyRound className="h-4 w-4" />{t(lang, "acc.register")}
            </button>
          </>
        ) : (
          <button type="button" className="acc-btn" disabled={busy} onClick={onSignOutAndWipe} data-testid="account-signout-wipe">
            <LogOut className="h-4 w-4" />{t(lang, "data.signout")}
          </button>
        )}
        {value === "session" && !account ? (
          <button type="button" className="acc-btn" disabled={busy} onClick={onSignOutAndWipe} data-testid="session-wipe">
            <LogOut className="h-4 w-4" />{t(lang, "data.signout")}
          </button>
        ) : null}
      </div>

      {!account && onRecover && supported && status?.available !== false ? (
        recovering ? (
          <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); onRecover(code); }} data-testid="recover-form">
            <input className="acc-input font-mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder={t(lang, "acc.recover.placeholder")} autoComplete="off" spellCheck={false} data-testid="recover-code" />
            <button type="submit" className="acc-btn" disabled={busy || code.replace(/[\s-]/g, "").length < 26}><LifeBuoy className="h-4 w-4" />{t(lang, "acc.recover.go")}</button>
          </form>
        ) : (
          <button type="button" className="acc-link text-xs" onClick={() => setRecovering(true)} data-testid="recover-open">{t(lang, "acc.recover")}</button>
        )
      ) : null}

      {!supported ? <p className="text-xs text-amber-600 dark:text-amber-400">{t(lang, "acc.unsupported")}</p> : null}
      {status?.available === false ? <p className="text-xs text-amber-600 dark:text-amber-400">{t(lang, "acc.unavailable")}</p> : null}
      {message ? <p className="text-xs" data-testid="retention-msg">{message}</p> : null}
    </section>
  );
}
