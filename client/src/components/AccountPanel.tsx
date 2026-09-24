// The signed-in user in the interface:
//   SignedInBadge        the unlocked-key badge next to the logo
//   AccountInfoModal     what the server holds: credentials, sizes, dates,
//                        counts, away state and the server-side activity log
//   AccountAccess        (Connection window) the ONLY place to sign in with a
//                        passkey, register one, add passkeys and set the
//                        recovery code (4.0) — with the checked sign-in steps
//   ChatRetentionSection the "chat data and history" choice in Connection
//
// 4.13: each is a layout ("dialog.account", "panel.access",
// "panel.retention" — lib/layouts/account.ts); what they do stays here.

import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { keyFingerprint } from "../lib/identity";
import { renderLayout } from "./LayoutView";
import { useLayoutBase } from "./LayoutProvider";
import { t, type Lang } from "../lib/i18n";
import type { AccountSummary, AccountStatus, StepState } from "../lib/account";
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

/** The account's passkeys, recovery code, devices and identity (3.1). */
export type AccountActions = {
  onAddPasskey?: (label: string) => void;
  onRemovePasskey?: (credentialId: string) => void;
  /** Resolves to the new code, shown once. */
  onCreateRecovery?: () => Promise<string | null>;
  onRemoveRecovery?: () => void;
  onEndSession?: (id: string) => void;
};

export function AccountInfoModal({
  account, status, busy, message, lang, onRefresh, onSaveNow, onSignOut, onDelete, actions = {}, onOpenConnection,
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
  /** Passkeys and the recovery code are managed in the Connection window (4.0). */
  onOpenConnection?: () => void;
}) {
  const { tree, base } = useLayoutBase("dialog.account", lang);
  const v = account.vault;
  // The identity key's fingerprint (computed here, shown when ready).
  const [fp, setFp] = useState("");
  const key = account.identity?.publicKey ?? "";
  useEffect(() => {
    let live = true;
    if (key) void keyFingerprint(key).then((x) => { if (live) setFp(x); }).catch(() => undefined);
    return () => { live = false; };
  }, [key]);
  return renderLayout(tree, {
    ...base,
    data: {
      notPersistent: Boolean(status && !status.persistent),
      username: account.username ?? account.id,
      credential: `${account.credentialId.slice(0, 16)}…`,
      alg: ALG_NAMES[account.alg] ?? String(account.alg),
      created: when(account.createdAt, lang),
      lastLogin: when(account.lastLoginAt, lang),
      logins: account.loginCount,
      size: bytes(v.profileBytes + v.chatBytes),
      messages: v.messages,
      messageBytes: bytes(v.messageBytes),
      rooms: v.rooms,
      profile: `${bytes(v.profileBytes)} · ${when(v.profileUpdatedAt, lang)}`,
      updated: when(v.chatUpdatedAt, lang),
      mailbox: `${account.mailbox.pending} · ${bytes(account.mailbox.bytes)}`,
      pushDevices: account.pushDevices,
      away: account.away.map((a) => t(lang, "acc.awayIn").replace("{room}", a.room).replace("{since}", when(a.since, lang))).join(", "),
      passkeyCount: account.passkeys?.length ?? 1,
      recovery: recoveryText(account, lang),
      canOpenConnection: Boolean(onOpenConnection),
      sessions: (account.sessions ?? []).map((x) => ({ id: x.id, client: x.client, current: Boolean(x.current), detail: [x.ip, t(lang, "acc.sessions.lastUsed").replace("{date}", when(x.lastUsedAt, lang))].filter(Boolean).join(" · ") })),
      canEndSession: Boolean(actions.onEndSession),
      identity: Boolean(key),
      fingerprint: fp,
      audit: account.audit.map((entry, i) => ({
        key: `${entry.at}-${i}`,
        time: when(entry.at, lang),
        label: t(lang, `acc.ev.${entry.kind}`) === `acc.ev.${entry.kind}` ? entry.kind : t(lang, `acc.ev.${entry.kind}`),
        meta: entry.meta ? Object.entries(entry.meta).map(([k, val]) => `${k}: ${val}`).join(" · ") : "",
      })),
      message,
      busy,
    },
    actions: {
      openConnection: () => onOpenConnection?.(),
      endSession: (_e, id) => actions.onEndSession?.(String(id)),
      refresh: () => onRefresh(),
      saveNow: () => onSaveNow(),
      signOut: () => onSignOut(),
      delete: () => onDelete(),
    },
  });
}

function recoveryText(account: AccountSummary, lang: Lang): string {
  return account.recovery?.set ? t(lang, "acc.recovery.set").replace("{date}", when(account.recovery.createdAt ?? 0, lang)) : t(lang, "acc.recovery.none");
}

/** A sign-in or registration in progress (or just finished): its steps and,
 *  when it stopped, why. */
export type SignInProgress = {
  kind: "signin" | "register";
  steps: Array<{ id: string; state: StepState; detail?: string }>;
  error?: { code: string; message: string } | null;
  /** Shown when it finished well. */
  done?: string;
};

const STEP_ICON: Record<StepState, string> = { run: "loader-circle", ok: "circle-check", warn: "triangle-alert", fail: "circle-x" };

/**
 * The account part of the Connection window — the one place where a passkey
 * signs in, registers, is added, and where the recovery code is set (4.0).
 */
export function AccountAccess({
  account, status, supported, busy, message, lang, nickname, progress, onSignIn, onRegister, onSignOutAndWipe, onRecover, actions = {},
}: {
  account: AccountSummary | null;
  status: AccountStatus | null;
  supported: boolean;
  busy: boolean;
  message: string;
  lang: Lang;
  /** The name used in rooms: only an alias of the username. */
  nickname: string;
  progress: SignInProgress | null;
  onSignIn: () => void;
  onRegister: () => void;
  onSignOutAndWipe: () => void;
  /** Every passkey lost — come back with the recovery code. */
  onRecover?: (code: string) => void;
  actions?: AccountActions;
}) {
  const { tree, base } = useLayoutBase("panel.access", lang);
  const [recovering, setRecovering] = useState(false);
  const [code, setCode] = useState("");
  // The passkeys' label field and the new recovery code (shown once).
  const [label, setLabel] = useState("");
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Signed out: what belonged to the account goes (as the sections it was in did).
  useEffect(() => { if (!account) { setLabel(""); setRecoveryCode(null); setCopied(false); } }, [account]);
  const blocked = busy || !supported || status?.available === false;
  const err = progress?.error ?? null;
  const passkeys = account ? account.passkeys ?? [{ credentialId: account.credentialId, alg: account.alg, createdAt: account.createdAt, lastUsedAt: account.lastLoginAt, label: "", primary: true }] : [];
  const errTitle = err ? (t(lang, `id.err.${err.code}`) === `id.err.${err.code}` ? t(lang, "id.err.server") : t(lang, `id.err.${err.code}`)) : "";
  return renderLayout(tree, {
    ...base,
    data: {
      signedIn: Boolean(account),
      username: account ? account.username ?? account.id : "",
      nickname: nickname.trim(),
      keyVerified: Boolean(account && account.keyVerified !== false),
      blocked,
      busy,
      steps: (progress?.steps ?? []).map((st) => ({ ...st, icon: STEP_ICON[st.state] ?? "circle-dashed" })),
      error: err ? {
        code: err.code,
        title: errTitle,
        hint: t(lang, `id.err.${err.code}.hint`) !== `id.err.${err.code}.hint` ? t(lang, `id.err.${err.code}.hint`) : "",
        detail: err.message && err.code !== "cancelled" ? err.message : "",
        logged: err.code !== "cancelled",
      } : null,
      done: progress?.done && !err ? progress.done : "",
      canRecover: Boolean(!account && onRecover && supported && status?.available !== false),
      recovering,
      recoverCode: code,
      recoverCodeOk: code.replace(/[\s-]/g, "").length >= 26,
      passkeys: passkeys.map((p) => ({
        id: p.credentialId,
        title: p.label || `${ALG_NAMES[p.alg] ?? p.alg} · ${p.credentialId.slice(0, 8)}…`,
        primary: Boolean(p.primary),
        lastUsed: t(lang, "acc.sessions.lastUsed").replace("{date}", when(p.lastUsedAt, lang)),
      })),
      canRemovePasskey: passkeys.length > 1 && Boolean(actions.onRemovePasskey),
      canAddPasskey: Boolean(actions.onAddPasskey),
      passkeyLabel: label,
      recoverySet: account?.recovery?.set === true,
      recoveryText: account ? recoveryText(account, lang) : "",
      recoveryCode: recoveryCode ?? "",
      copied,
      canCreateRecovery: Boolean(actions.onCreateRecovery),
      canRemoveRecovery: Boolean(actions.onRemoveRecovery),
      unsupported: !supported,
      unavailable: status?.available === false,
      message,
    },
    actions: {
      signIn: () => onSignIn(),
      register: () => onRegister(),
      signOutWipe: () => onSignOutAndWipe(),
      recoverOpen: () => setRecovering(true),
      recover: (e) => { (e as FormEvent).preventDefault(); onRecover?.(code); },
      recoverCode: (e) => setCode((e as ChangeEvent<HTMLInputElement>).target.value),
      passkeyLabel: (e) => setLabel((e as ChangeEvent<HTMLInputElement>).target.value),
      addPasskey: () => { actions.onAddPasskey?.(label.trim()); setLabel(""); },
      removePasskey: (_e, id) => { if (window.confirm(t(lang, "acc.passkeys.removeConfirm"))) actions.onRemovePasskey?.(String(id)); },
      createRecovery: () => { void actions.onCreateRecovery?.().then((c) => { if (c) setRecoveryCode(c); }); },
      removeRecovery: () => actions.onRemoveRecovery?.(),
      copyRecovery: () => { if (recoveryCode) void navigator.clipboard?.writeText(recoveryCode).then(() => setCopied(true)); },
      recoveryDone: () => { setRecoveryCode(null); setCopied(false); },
    },
  });
}

/** "Chat data and history" — the three retention modes; the server one needs
 *  a signed-in account (AccountAccess above it). */
export function ChatRetentionSection({ value, onChange, account, lang }: {
  value: ChatRetention;
  onChange: (next: ChatRetention) => void;
  account: AccountSummary | null;
  lang: Lang;
}) {
  const { tree, base } = useLayoutBase("panel.retention", lang);
  const options: Array<{ id: ChatRetention; disabled?: boolean }> = [
    { id: "ephemeral" },
    { id: "session" },
    { id: "server", disabled: !account },
  ];
  return renderLayout(tree, {
    ...base,
    data: { options: options.map((o) => ({ id: o.id, checked: value === o.id, disabled: Boolean(o.disabled) })) },
    actions: { choose: (_e, id) => onChange(id as ChatRetention) },
  });
}
