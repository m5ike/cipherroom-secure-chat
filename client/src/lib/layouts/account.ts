// The account in the interface (4.13): what the server holds (the account
// window), the Connection window's passkey part — sign in, register, the
// steps of a sign-in, passkeys and the recovery code — and the chat history
// choice. Drawn by AccountPanel.tsx, which keeps what they do.

import { treeBuilder, type LNode } from "../layout-tree";
import type { LayoutContract } from "./contracts";

type Builder = ReturnType<typeof treeBuilder>;

/** A label and a value of the account window. */
function row(b: Builder, id: string, label: string | LNode, value: string | LNode, opts: { mono?: boolean; if?: string } = {}): LNode {
  const { n } = b;
  return n("panel", { id: `row-${id}`, name: id, attrs: { class: "acc-row" }, ...(opts.if ? { if: opts.if } : {}) }, [
    typeof label === "string" ? n("area", { id: `row-${id}-k`, attrs: { class: "acc-row__label" }, text: label }) : n("area", { id: `row-${id}-k`, attrs: { class: "acc-row__label" } }, [label]),
    typeof value === "string"
      ? n("area", { id: `row-${id}-v`, attrs: { class: `acc-row__value${opts.mono ? " font-mono text-[11px]" : ""}` }, text: value })
      : n("area", { id: `row-${id}-v`, attrs: { class: `acc-row__value${opts.mono ? " font-mono text-[11px]" : ""}` } }, [value]),
  ]);
}

/** The heading of a card: an icon (or none) and a text. */
function cardTitle(b: Builder, id: string, iconName: string | null, label: string): LNode {
  const { n, text, icon } = b;
  return n("heading", { id: `${id}-title`, tag: "h4", attrs: { class: "acc-card__title" } }, [
    ...(iconName ? [icon(iconName, "h-4 w-4", {}, { id: `${id}-icon` })] : []),
    text(label, { id: `${id}-title-text` }),
  ]);
}

/** A button with an icon: `<button class=…><Icon class=… />text</button>`. */
function iconButton(b: Builder, id: string, iconName: string, iconClass: string, label: string, spec: Record<string, unknown>): LNode {
  const { n, text, icon } = b;
  return n("button", { id, ...spec } as never, [icon(iconName, iconClass, {}, { id: `${id}-icon` }), text(label, { id: `${id}-text` })]);
}

/** AccountInfoModal: what the server holds about the signed-in account. */
export function accountInfoTree(): LNode {
  const b = treeBuilder("ai");
  const { n, text, icon } = b;
  return n("panel", { id: "account-info", name: "Account", attrs: { class: "space-y-4", "data-testid": "account-info" } }, [
    n("paragraph", { id: "acc-desc", attrs: { class: "text-xs text-muted-foreground" }, text: "{_'acc.desc'}" }),
    n("paragraph", { id: "acc-not-persistent", if: "$notPersistent", attrs: { class: "rounded-xl border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200" }, text: "{_'acc.notPersistent'}" }),
    n("panel", { id: "card-credentials", name: "Credentials", tag: "section", attrs: { class: "acc-card" } }, [
      cardTitle(b, "credentials", "key-round", "{_'acc.credentials'}"),
      row(b, "username", "{_'id.username'}", n("area", { id: "account-info-username", attrs: { "data-testid": "account-info-username" }, text: "{$username}" }), { mono: true }),
      row(b, "credential", "{_'acc.credential'}", "{$credential}", { mono: true }),
      row(b, "alg", "{_'acc.alg'}", "{$alg}"),
      row(b, "created", "{_'acc.created'}", "{$created}"),
      row(b, "last-login", "{_'acc.lastLogin'}", "{$lastLogin}"),
      row(b, "logins", "{_'acc.logins'}", "{$logins}"),
    ]),
    n("panel", { id: "card-storage", name: "Storage", tag: "section", attrs: { class: "acc-card" } }, [
      cardTitle(b, "storage", null, "{_'acc.storage'}"),
      row(b, "size", "{_'acc.size'}", "{$size}"),
      row(b, "messages", "{_'acc.messages'}", "{$messages}"),
      row(b, "message-bytes", "{_'acc.messageBytes'}", "{$messageBytes}"),
      row(b, "rooms", "{_'acc.rooms'}", "{$rooms}"),
      row(b, "profile", "{_'acc.profile'}", "{$profile}"),
      row(b, "updated", "{_'acc.updated'}", "{$updated}"),
      row(b, "mailbox", "{_'acc.mailbox'}", "{$mailbox}"),
      row(b, "push", "{_'acc.pushDevices'}", "{$pushDevices}"),
      row(b, "away", n("area", { id: "away-label", attrs: { class: "inline-flex items-center gap-1" } }, [icon("moon", "h-3.5 w-3.5", {}, { id: "away-icon" }), text("{_'acc.away'}", { id: "away-text" })]), "{$away}", { if: "$away" }),
    ]),
    n("panel", { id: "account-passkeys-summary", name: "Passkeys", tag: "section", attrs: { class: "acc-card", "data-testid": "account-passkeys-summary" } }, [
      cardTitle(b, "passkeys", "key-round", "{_'id.passkeys'}"),
      row(b, "passkey-count", "{_'acc.passkeys'}", "{$passkeyCount}"),
      row(b, "recovery", "{_'acc.recovery'}", "{$recovery}"),
      iconButton(b, "account-open-connection", "external-link", "h-3.5 w-3.5", "{_'id.need.open'}", {
        if: "$canOpenConnection", attrs: { type: "button", class: "acc-btn acc-btn--small", "data-testid": "account-open-connection" }, on: { click: { action: "openConnection" } },
      }),
    ]),
    n("panel", { id: "account-sessions", name: "Sessions", tag: "section", if: "($sessions|length) > 0", attrs: { class: "acc-card", "data-testid": "account-sessions" } }, [
      cardTitle(b, "sessions", "monitor-smartphone", "{_'acc.sessions'}"),
      n("list", { id: "sessions-list", attrs: { class: "acc-list" } }, [
        n("item", { id: "session-row", name: "A session", each: "$sessions", as: "s", key: "$s.id", attrs: { "data-testid": "session-row" } }, [
          n("area", { id: "session-text" }, [
            n("area", { id: "session-client", tag: "strong", text: "{=$s.client || '—'}" }),
            n("area", { id: "session-current", tag: "em", if: "$s.current", attrs: { class: "acc-chip" }, text: "{_'acc.sessions.current'}" }),
            n("area", { id: "session-detail", tag: "small", text: "{$s.detail}" }),
          ]),
          iconButton(b, "session-end", "log-out", "h-3.5 w-3.5", "{_'acc.sessions.end'}", {
            if: "!$s.current && $canEndSession", attrs: { type: "button", class: "acc-btn acc-btn--small", disabled: "=$busy" }, on: { click: { action: "endSession", arg: "$s.id" } },
          }),
        ]),
      ]),
    ]),
    n("panel", { id: "account-identity", name: "Identity", tag: "section", if: "$identity", attrs: { class: "acc-card", "data-testid": "account-identity" } }, [
      cardTitle(b, "identity", "fingerprint-pattern", "{_'acc.identity'}"),
      n("paragraph", { id: "identity-desc", attrs: { class: "text-xs text-muted-foreground" }, text: "{_'acc.identity.desc'}" }),
      row(b, "fingerprint", "{_'acc.identity'}", "{=$fingerprint || '…'}", { mono: true }),
    ]),
    n("panel", { id: "card-activity", name: "Activity", tag: "section", attrs: { class: "acc-card" } }, [
      cardTitle(b, "activity", null, "{_'acc.activity'}"),
      n("list", { id: "account-audit", attrs: { class: "acc-log", "data-testid": "account-audit" } }, [
        n("item", { id: "audit-empty", if: "($audit|length) === 0", attrs: { class: "text-xs text-muted-foreground" }, text: "—" }),
        n("item", { id: "audit-entry", name: "An event", each: "$audit", as: "e", key: "$e.key" }, [
          n("area", { id: "audit-time", tag: "time", text: "{$e.time}" }),
          n("area", { id: "audit-label", text: "{$e.label}" }),
          n("area", { id: "audit-meta", tag: "em", if: "$e.meta", text: "{$e.meta}" }),
        ]),
      ]),
    ]),
    n("paragraph", { id: "account-msg", if: "$message", attrs: { class: "text-xs", "data-testid": "account-msg" }, text: "{$message}" }),
    n("panel", { id: "account-buttons", name: "Buttons", attrs: { class: "flex flex-wrap gap-2" } }, [
      iconButton(b, "account-refresh", "refresh-cw", "h-4 w-4", "{_'acc.refresh'}", { attrs: { type: "button", disabled: "=$busy", class: "acc-btn", "data-testid": "account-refresh" }, on: { click: { action: "refresh" } } }),
      iconButton(b, "account-save", "save", "h-4 w-4", "{_'acc.saveNow'}", { attrs: { type: "button", disabled: "=$busy", class: "acc-btn", "data-testid": "account-save" }, on: { click: { action: "saveNow" } } }),
      iconButton(b, "account-signout", "log-out", "h-4 w-4", "{_'acc.signOut'}", { attrs: { type: "button", disabled: "=$busy", class: "acc-btn", "data-testid": "account-signout" }, on: { click: { action: "signOut" } } }),
      iconButton(b, "account-delete", "trash", "h-4 w-4", "{_'acc.delete'}", { attrs: { type: "button", disabled: "=$busy", class: "acc-btn acc-btn--danger", "data-testid": "account-delete" }, on: { click: { action: "delete" } } }),
    ]),
  ]);
}

/** AccountAccess: the Connection window's passkey part. */
export function accessTree(): LNode {
  const b = treeBuilder("aa");
  const { n, text, icon } = b;
  const passkeys = n("panel", { id: "account-passkeys", name: "Passkeys", tag: "section", attrs: { class: "acc-card", "data-testid": "account-passkeys" } }, [
    cardTitle(b, "pk", "key-round", "{_'acc.passkeys'}"),
    n("paragraph", { id: "pk-desc", attrs: { class: "text-xs text-muted-foreground" }, text: "{_'acc.passkeys.desc'}" }),
    n("list", { id: "pk-list", attrs: { class: "acc-list" } }, [
      n("item", { id: "passkey-row", name: "A passkey", each: "$passkeys", as: "p", key: "$p.id", attrs: { "data-testid": "passkey-row" } }, [
        n("area", { id: "pk-text" }, [
          n("area", { id: "pk-title", tag: "strong", text: "{$p.title}" }),
          n("area", { id: "pk-primary", tag: "em", if: "$p.primary", attrs: { class: "acc-chip" }, text: "{_'acc.passkeys.primary'}" }),
          n("area", { id: "pk-used", tag: "small", text: "{$p.lastUsed}" }),
        ]),
        iconButton(b, "pk-remove", "trash", "h-3.5 w-3.5", "{_'acc.passkeys.remove'}", {
          if: "$canRemovePasskey", attrs: { type: "button", class: "acc-btn acc-btn--small", disabled: "=$busy" }, on: { click: { action: "removePasskey", arg: "$p.id" } },
        }),
      ]),
    ]),
    n("panel", { id: "pk-add", name: "Add a passkey", if: "$canAddPasskey", attrs: { class: "flex flex-wrap items-center gap-2" } }, [
      n("input", { id: "passkey-label", attrs: { class: "acc-input", value: "=$passkeyLabel", maxlength: "40", placeholder: "{_'acc.passkeys.label'}", "aria-label": "{_'acc.passkeys.label'}", "data-testid": "passkey-label" }, on: { change: { action: "passkeyLabel" } } }),
      iconButton(b, "passkey-add", "plus", "h-4 w-4", "{_'acc.passkeys.add'}", { attrs: { type: "button", class: "acc-btn", disabled: "=$busy", "data-testid": "passkey-add" }, on: { click: { action: "addPasskey" } } }),
    ]),
  ]);
  const recovery = n("panel", { id: "account-recovery", name: "Recovery code", tag: "section", attrs: { class: "acc-card", "data-testid": "account-recovery" } }, [
    cardTitle(b, "rc", "life-buoy", "{_'acc.recovery'}"),
    n("paragraph", { id: "rc-desc", attrs: { class: "text-xs text-muted-foreground" }, text: "{_'acc.recovery.desc'}" }),
    row(b, "rc-state", "{_'acc.recovery'}", "{$recoveryText}"),
    n("panel", { id: "recovery-code-box", name: "The new code", if: "$recoveryCode", attrs: { class: "acc-code", "data-testid": "recovery-code-box" } }, [
      n("paragraph", { id: "rc-show", attrs: { class: "text-xs" }, text: "{_'acc.recovery.show'}" }),
      n("area", { id: "recovery-code", tag: "code", attrs: { "data-testid": "recovery-code" }, text: "{$recoveryCode}" }),
      n("panel", { id: "rc-code-actions", attrs: { class: "flex flex-wrap gap-2" } }, [
        n("button", { id: "rc-copy", attrs: { type: "button", class: "acc-btn acc-btn--small" }, on: { click: { action: "copyRecovery" } }, text: "{=($copied ? 'acc.recovery.copied' : 'acc.recovery.copy')|t}" }),
        n("button", { id: "rc-done", attrs: { type: "button", class: "acc-btn acc-btn--small" }, on: { click: { action: "recoveryDone" } }, text: "{_'acc.recovery.done'}" }),
      ]),
    ]),
    n("panel", { id: "rc-actions", attrs: { class: "flex flex-wrap gap-2" } }, [
      iconButton(b, "recovery-create", "life-buoy", "h-4 w-4", "{=($recoverySet ? 'acc.recovery.replace' : 'acc.recovery.create')|t}", {
        if: "$canCreateRecovery", attrs: { type: "button", class: "acc-btn", disabled: "=$busy", "data-testid": "recovery-create" }, on: { click: { action: "createRecovery" } },
      }),
      n("button", { id: "rc-remove", if: "$recoverySet && $canRemoveRecovery", attrs: { type: "button", class: "acc-btn acc-btn--danger", disabled: "=$busy" }, on: { click: { action: "removeRecovery" } }, text: "{_'acc.recovery.remove'}" }),
    ]),
  ]);
  return n("panel", { id: "account-access", name: "Passkey", tag: "section", attrs: { class: "id-access space-y-3", "data-testid": "account-access" } }, [
    n("panel", { id: "access-head" }, [
      n("heading", { id: "access-title", attrs: { class: "flex items-center gap-2 text-sm font-semibold" } }, [
        icon("key-round", "h-4 w-4", { "aria-hidden": "true" }, { id: "access-title-icon" }),
        text("{_'id.title'}", { id: "access-title-text" }),
      ]),
      n("paragraph", { id: "access-desc", attrs: { class: "text-xs text-muted-foreground" }, text: "{_'id.desc'}" }),
    ]),
    n("panel", { id: "account-identity-card", name: "Signed in as", if: "$signedIn", attrs: { class: "id-card", "data-testid": "account-identity-card" } }, [
      n("area", { id: "id-card-avatar", attrs: { class: "id-card__avatar", "aria-hidden": "true" } }, [icon("user-round", "h-5 w-5", {}, { id: "id-card-user" })]),
      n("panel", { id: "id-card-text", attrs: { class: "id-card__text" } }, [
        n("area", { id: "id-card-caption", attrs: { class: "id-card__caption" }, text: "{_'id.signedInAs'}" }),
        n("area", { id: "account-username", tag: "strong", attrs: { class: "id-card__username", "data-testid": "account-username", title: "{_'id.username.hint'}" }, text: "{$username}" }),
        n("area", { id: "id-card-nick", attrs: { class: "id-card__nick" } }, [
          text("{_'id.nickname'}: ", { id: "id-card-nick-label" }),
          n("area", { id: "id-card-nick-name", tag: "b", text: "{=$nickname || '—'}" }),
          text(" ", { id: "id-card-nick-sp" }),
          n("area", { id: "id-card-nick-hint", tag: "em", text: "· {_'id.nickname.hint'}" }),
        ]),
      ]),
      n("area", { id: "id-chip", if: "$keyVerified", attrs: { class: "id-chip", title: "{_'id.keyVerified'}" } }, [
        icon("badge-check", "h-3.5 w-3.5", { "aria-hidden": "true" }, { id: "id-chip-icon" }),
        text("{_'id.keyVerified'}", { id: "id-chip-text" }),
      ]),
    ]),
    n("panel", { id: "access-buttons", attrs: { class: "flex flex-wrap items-center gap-2" } }, [
      iconButton(b, "account-signin", "lock-keyhole-open", "h-4 w-4", "{_'id.signIn'}", { if: "!$signedIn", attrs: { type: "button", class: "acc-btn acc-btn--primary", disabled: "=$blocked", "data-testid": "account-signin" }, on: { click: { action: "signIn" } } }),
      iconButton(b, "account-register", "user-plus", "h-4 w-4", "{_'id.register'}", { if: "!$signedIn", attrs: { type: "button", class: "acc-btn", disabled: "=$blocked", "data-testid": "account-register" }, on: { click: { action: "register" } } }),
      iconButton(b, "account-signout-wipe", "log-out", "h-4 w-4", "{_'id.signOut'}", { if: "$signedIn", attrs: { type: "button", class: "acc-btn", disabled: "=$busy", "data-testid": "account-signout-wipe" }, on: { click: { action: "signOutWipe" } } }),
    ]),
    n("list", { id: "signin-steps", name: "Sign-in steps", tag: "ol", if: "($steps|length) > 0", attrs: { class: "id-steps", "data-testid": "signin-steps", "aria-label": "{_'id.steps'}" } }, [
      n("item", { id: "id-step", name: "A step", each: "$steps", as: "s", key: "$s.id", attrs: { class: "id-step is-{$s.state}", "data-step": "{$s.id}", "data-state": "{$s.state}" } }, [
        icon("{$s.icon}", "id-step__icon{if $s.state === 'run'} animate-spin{/if}", { "aria-hidden": "true" }, { id: "id-step-icon" }),
        n("area", { id: "id-step-label", attrs: { class: "id-step__label" }, text: "{$s.id|t:'id.step.'}" }),
        n("area", { id: "id-step-state", attrs: { class: "sr-only" }, text: "{$s.state|t:'id.state.'}" }),
        n("area", { id: "id-step-detail", if: "$s.detail", attrs: { class: "id-step__detail" }, text: "{$s.detail}" }),
      ]),
    ]),
    n("panel", { id: "signin-error", name: "What went wrong", if: "$error", attrs: { class: "id-error", role: "alert", "data-testid": "signin-error", "data-code": "{$error.code}" } }, [
      icon("circle-x", "h-5 w-5 flex-none", { "aria-hidden": "true" }, { id: "error-icon" }),
      n("panel", { id: "error-body", attrs: { class: "min-w-0" } }, [
        n("area", { id: "error-title", tag: "strong", text: "{$error.title}" }),
        n("paragraph", { id: "error-hint", if: "$error.hint", text: "{$error.hint}" }),
        n("paragraph", { id: "error-detail", if: "$error.detail", attrs: { class: "id-error__detail" }, text: "{$error.detail}" }),
        n("paragraph", { id: "error-logged", if: "$error.logged", attrs: { class: "id-error__logged" }, text: "{_'id.err.logged'}" }),
        iconButton(b, "signin-error-register", "user-plus", "h-4 w-4", "{_'id.register'}", {
          if: "$error.code === 'unknown-passkey'", attrs: { type: "button", class: "acc-btn acc-btn--primary mt-2", disabled: "=$blocked", "data-testid": "signin-error-register" }, on: { click: { action: "register" } },
        }),
      ]),
    ]),
    n("paragraph", { id: "signin-done", if: "$done", attrs: { class: "id-done", "data-testid": "signin-done" }, text: "{$done}" }),
    n("form", { id: "recover-form", name: "Recovery code form", if: "$canRecover && $recovering", attrs: { class: "flex flex-wrap items-center gap-2", "data-testid": "recover-form" }, on: { submit: { action: "recover" } } }, [
      n("input", { id: "recover-code", attrs: { class: "acc-input font-mono", value: "=$recoverCode", placeholder: "{_'acc.recover.placeholder'}", "aria-label": "{_'acc.recover'}", autocomplete: "off", spellcheck: "false", "data-testid": "recover-code" }, on: { change: { action: "recoverCode" } } }),
      iconButton(b, "recover-go", "life-buoy", "h-4 w-4", "{_'acc.recover.go'}", { attrs: { type: "submit", class: "acc-btn", disabled: "=$busy || !$recoverCodeOk" } }),
    ]),
    n("button", { id: "recover-open", name: "Lost every passkey?", if: "$canRecover && !$recovering", attrs: { type: "button", class: "acc-link text-xs", "data-testid": "recover-open" }, on: { click: { action: "recoverOpen" } }, text: "{_'acc.recover'}" }),
    n("group", { id: "signed-in-parts", if: "$signedIn" }, [passkeys, recovery]),
    n("paragraph", { id: "access-unsupported", if: "$unsupported", attrs: { class: "text-xs text-amber-600 dark:text-amber-400" }, text: "{_'acc.unsupported'}" }),
    n("paragraph", { id: "access-unavailable", if: "$unavailable", attrs: { class: "text-xs text-amber-600 dark:text-amber-400" }, text: "{_'acc.unavailable'}" }),
    n("paragraph", { id: "retention-msg", if: "$message", attrs: { class: "text-xs", "data-testid": "retention-msg" }, text: "{$message}" }),
  ]);
}

/** ChatRetentionSection: where the chat history is kept. */
export function retentionTree(): LNode {
  const { n } = treeBuilder("rt");
  return n("panel", { id: "retention-section", name: "Chat data", tag: "section", attrs: { class: "space-y-3", "data-testid": "retention-section" } }, [
    n("panel", { id: "retention-head" }, [
      n("heading", { id: "retention-title", attrs: { class: "text-sm font-semibold" }, text: "{_'data.title'}" }),
      n("paragraph", { id: "retention-desc", attrs: { class: "text-xs text-muted-foreground" }, text: "{_'data.desc'}" }),
    ]),
    n("panel", { id: "retention-options", attrs: { class: "space-y-2" } }, [
      n("label", {
        id: "retention-option", name: "An option", each: "$options", as: "o", key: "$o.id",
        attrs: { class: "retention-option{if $o.checked} is-active{/if}{if $o.disabled} is-disabled{/if}", "data-testid": "retention-{$o.id}" },
      }, [
        n("input", { id: "retention-radio", attrs: { type: "radio", name: "chat-retention", checked: "=$o.checked", disabled: "=$o.disabled" }, on: { change: { action: "choose", arg: "$o.id" } } }),
        n("area", { id: "retention-text" }, [
          n("area", { id: "retention-name", tag: "strong", text: "{$o.id|t:'data.'}" }),
          n("area", { id: "retention-desc-o", tag: "em", text: "{=('data.' ~ $o.id ~ '.desc')|t}" }),
          n("area", { id: "retention-need", tag: "em", if: "$o.disabled", attrs: { class: "text-amber-600 dark:text-amber-400" }, text: "{_'id.need.title'}" }),
        ]),
      ]),
    ]),
  ]);
}

/* ------------------------------------------------------------ contracts */

type AccountId = "dialog.account" | "panel.access" | "panel.retention";

export const ACCOUNT_CONTRACTS: Record<AccountId, LayoutContract> = {
  "dialog.account": {
    description: "The account window: what the server holds — credentials, storage, passkeys, sessions, identity and activity.",
    vars: [
      { path: "$notPersistent", type: "yes/no", description: "The server keeps accounts only in memory." },
      { path: "$username", type: "text", description: "The username." },
      { path: "$credential", type: "text", description: "The start of the passkey's credential id." },
      { path: "$alg", type: "text", description: "The passkey's algorithm." },
      { path: "$created", type: "text", description: "Created (a date)." },
      { path: "$lastLogin", type: "text", description: "Last sign-in (a date)." },
      { path: "$logins", type: "number", description: "Sign-ins." },
      { path: "$size", type: "text", description: "Data on the server." },
      { path: "$messages", type: "number", description: "Messages in the vault." },
      { path: "$messageBytes", type: "text", description: "Their size." },
      { path: "$rooms", type: "number", description: "Rooms." },
      { path: "$profile", type: "text", description: "The profile's size and date." },
      { path: "$updated", type: "text", description: "The chat vault's last change." },
      { path: "$mailbox", type: "text", description: "Waiting messages and their size." },
      { path: "$pushDevices", type: "number", description: "Devices with web push." },
      { path: "$away", type: "text", description: "Rooms marked away (empty: none)." },
      { path: "$passkeyCount", type: "number", description: "Passkeys." },
      { path: "$recovery", type: "text", description: "The recovery code's state." },
      { path: "$canOpenConnection", type: "yes/no", description: "The Connection window can be opened." },
      { path: "$sessions", type: "list", description: "Signed-in devices: .id, .client, .current, .detail." },
      { path: "$canEndSession", type: "yes/no", description: "A session can be ended here." },
      { path: "$identity", type: "yes/no", description: "The account has an identity key." },
      { path: "$fingerprint", type: "text", description: "Its fingerprint." },
      { path: "$audit", type: "list", description: "Activity: .key, .time, .label, .meta." },
      { path: "$message", type: "text", description: "A message (after an action)." },
      { path: "$busy", type: "yes/no", description: "An action runs." },
    ],
    actions: [
      { name: "openConnection", description: "Open the Connection window (passkeys, recovery)." },
      { name: "endSession", description: "End a session.", arg: "its id" },
      { name: "refresh", description: "Load it again." },
      { name: "saveNow", description: "Save the vault now." },
      { name: "signOut", description: "Sign out." },
      { name: "delete", description: "Delete the account (asks first)." },
    ],
    slots: [],
    refs: [],
  },
  "panel.access": {
    description: "The Connection window's passkey part: sign in, register, the steps, passkeys and the recovery code.",
    vars: [
      { path: "$signedIn", type: "yes/no", description: "Signed in." },
      { path: "$username", type: "text", description: "The username." },
      { path: "$nickname", type: "text", description: "The nickname (an alias)." },
      { path: "$keyVerified", type: "yes/no", description: "The global key was proven." },
      { path: "$blocked", type: "yes/no", description: "Signing in is not possible now." },
      { path: "$busy", type: "yes/no", description: "Working." },
      { path: "$steps", type: "list", description: "Sign-in steps: .id, .state (run / ok / warn / fail), .icon, .detail." },
      { path: "$error", type: "object", description: "Why it stopped: .code, .title, .hint, .detail, .logged." },
      { path: "$done", type: "text", description: "What went well." },
      { path: "$canRecover", type: "yes/no", description: "A recovery code can be used." },
      { path: "$recovering", type: "yes/no", description: "The recovery form is open." },
      { path: "$recoverCode", type: "text", description: "The code typed." },
      { path: "$recoverCodeOk", type: "yes/no", description: "It is long enough." },
      { path: "$passkeys", type: "list", description: "Passkeys: .id, .title, .primary, .lastUsed." },
      { path: "$canRemovePasskey", type: "yes/no", description: "More than one, and removing is allowed." },
      { path: "$canAddPasskey", type: "yes/no", description: "Adding is allowed." },
      { path: "$passkeyLabel", type: "text", description: "The new passkey's label." },
      { path: "$recoverySet", type: "yes/no", description: "A recovery code is set." },
      { path: "$recoveryText", type: "text", description: "Its state." },
      { path: "$recoveryCode", type: "text", description: "A new code, shown once." },
      { path: "$copied", type: "yes/no", description: "The code was copied." },
      { path: "$canCreateRecovery", type: "yes/no", description: "A code can be made." },
      { path: "$canRemoveRecovery", type: "yes/no", description: "The code can be removed." },
      { path: "$unsupported", type: "yes/no", description: "This browser has no passkeys." },
      { path: "$unavailable", type: "yes/no", description: "The server has no accounts." },
      { path: "$message", type: "text", description: "A message." },
    ],
    actions: [
      { name: "signIn", description: "Sign in with a passkey." },
      { name: "register", description: "Register." },
      { name: "signOutWipe", description: "Sign out and wipe this device." },
      { name: "recoverOpen", description: "Open the recovery form." },
      { name: "recover", description: "Use the recovery code.", event: "submit" },
      { name: "recoverCode", description: "The code typed.", event: "change" },
      { name: "passkeyLabel", description: "The new passkey's label.", event: "change" },
      { name: "addPasskey", description: "Add a passkey." },
      { name: "removePasskey", description: "Remove a passkey (asks first).", arg: "its id" },
      { name: "createRecovery", description: "Make a recovery code." },
      { name: "removeRecovery", description: "Remove the recovery code." },
      { name: "copyRecovery", description: "Copy the new code." },
      { name: "recoveryDone", description: "Hide the new code." },
    ],
    slots: [],
    refs: [],
  },
  "panel.retention": {
    description: "Where the chat history is kept: this tab only, this browser, or the account's vault.",
    vars: [{ path: "$options", type: "list", description: "The choices: .id (ephemeral / session / server), .checked, .disabled." }],
    actions: [{ name: "choose", description: "Choose one.", arg: "its id", event: "change" }],
    slots: [],
    refs: [],
  },
};

export const ACCOUNT_VARIANTS: Record<AccountId, ReadonlyArray<{ id: string; label: string }>> = {
  "dialog.account": [{ id: "full", label: "Everything" }, { id: "new", label: "A new account" }],
  "panel.access": [
    { id: "signedout", label: "Signed out" }, { id: "steps", label: "Signing in (steps)" }, { id: "error", label: "It failed" },
    { id: "signedin", label: "Signed in" }, { id: "code", label: "A new recovery code" },
  ],
  "panel.retention": [{ id: "signedin", label: "Signed in" }, { id: "signedout", label: "Signed out" }],
};
