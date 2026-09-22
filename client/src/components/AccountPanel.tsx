// The signed-in user in the interface:
//   SignedInBadge        the unlocked-key badge next to the logo
//   AccountInfoModal     what the server holds: credentials, sizes, dates,
//                        counts, away state and the server-side activity log
//   ChatRetentionSection the "chat data and history" choice in Connection,
//                        with the passkey sign-in the server option needs

import { KeyRound, LockKeyholeOpen, RefreshCw, Trash2, Save, LogOut, Moon } from "lucide-react";
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
export function SignedInBadge({ account, onClick, lang }: { account: AccountSummary; onClick: () => void; lang: Lang }) {
  const pending = account.mailbox.pending;
  return (
    <button
      type="button"
      className="signed-badge"
      onClick={onClick}
      data-testid="signed-in-badge"
      title={t(lang, "acc.signedInAs").replace("{name}", account.userName)}
      aria-label={t(lang, "acc.signedInAs").replace("{name}", account.userName)}
    >
      <LockKeyholeOpen className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="signed-badge__label">{t(lang, "acc.signedIn")}</span>
      <span className="signed-badge__name">{account.userName}</span>
      {pending > 0 ? <span className="signed-badge__count" title={t(lang, "away.pending").replace("{n}", String(pending))}>{pending}</span> : null}
    </button>
  );
}

function Row({ label, value, mono }: { label: React.ReactNode; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="acc-row">
      <span className="acc-row__label">{label}</span>
      <span className={`acc-row__value${mono ? " font-mono text-[11px]" : ""}`}>{value}</span>
    </div>
  );
}

export function AccountInfoModal({
  account, status, busy, message, lang, onRefresh, onSaveNow, onSignOut, onDelete,
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
  value, onChange, account, status, supported, busy, message, lang, onSignIn, onRegister, onSignOutAndWipe,
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
}) {
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

      {!supported ? <p className="text-xs text-amber-600 dark:text-amber-400">{t(lang, "acc.unsupported")}</p> : null}
      {status?.available === false ? <p className="text-xs text-amber-600 dark:text-amber-400">{t(lang, "acc.unavailable")}</p> : null}
      {message ? <p className="text-xs" data-testid="retention-msg">{message}</p> : null}
    </section>
  );
}
