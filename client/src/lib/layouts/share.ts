// Invites (4.13): a created invite (link, code, where to send it, the QR
// code, its limits), the Room window's share part, "Share a connection" of
// My connections, and the prompt an invitee sees. Drawn by SharePanel.tsx,
// which keeps the cryptography's calls (lib/share-link.ts).

import { treeBuilder, type LNode } from "../layout-tree";
import type { LayoutContract } from "./contracts";

/** ShareResult: a created invite. */
export function shareResultTree(): LNode {
  const { n, text, icon } = treeBuilder("sr");
  const copyButton = (id: string, testid: string, label: string, flag: string, action: string) => n("button", {
    id, attrs: { type: "button", class: "share-copy", "data-testid": testid, "aria-label": `{_'${label}'}`, title: `{_'${label}'}` },
    on: { click: { action } },
  }, [
    icon("check", "h-4 w-4", { "aria-hidden": "true" }, { id: `${id}-done`, if: `$copied === '${flag}'` }),
    icon("copy", "h-4 w-4", { "aria-hidden": "true" }, { id: `${id}-icon`, if: `$copied !== '${flag}'` }),
  ]);
  return n("panel", { id: "share-result", name: "The invite", attrs: { class: "mt-3 space-y-3", "data-testid": "share-result" } }, [
    n("panel", { id: "sr-link" }, [
      n("panel", { id: "sr-link-label", attrs: { class: "text-xs font-medium" }, text: "{_'share.link'}" }),
      n("panel", { id: "sr-link-row", attrs: { class: "mt-1 flex items-center gap-2" } }, [
        n("input", {
          id: "share-url", attrs: { readonly: "=true", value: "=$url", "aria-label": "{_'share.link'}", "data-testid": "share-url", class: "min-h-10 min-w-0 flex-1 rounded-xl border border-input bg-background px-3 font-mono text-xs outline-none focus:ring-2 focus:ring-ring" },
          on: { focus: { action: "selectAll" } },
        }),
        copyButton("share-copy-link", "share-copy-link", "share.copyLink", "link", "copyLink"),
      ]),
    ]),
    n("panel", { id: "sr-code" }, [
      n("panel", { id: "sr-code-label", attrs: { class: "flex items-center gap-1 text-xs font-medium" } }, [
        icon("key-round", "h-3.5 w-3.5", { "aria-hidden": "true" }, { id: "sr-code-icon" }),
        text("{_'share.code'}", { id: "sr-code-text" }),
      ]),
      n("panel", { id: "sr-code-row", attrs: { class: "mt-1 flex items-center gap-2" } }, [
        n("area", { id: "share-code", tag: "output", attrs: { class: "share-code", "data-testid": "share-code" }, text: "{$code}" }),
        copyButton("share-copy-code", "share-copy-code", "share.copyCode", "code", "copyCode"),
      ]),
      n("paragraph", { id: "sr-code-hint", attrs: { class: "mt-1 text-xs text-amber-600 dark:text-amber-400" }, text: "{_'share.codeHint'}" }),
    ]),
    n("panel", { id: "share-targets", name: "Where to send it", attrs: { role: "group", "aria-label": "{_'share.via'}", class: "share-targets" } }, [
      n("button", {
        id: "share-target", name: "An app", each: "$targets", as: "tg", key: "$tg.id",
        attrs: { type: "button", class: "share-target", "data-testid": "share-via-{$tg.id}", title: "{$tg.label}", "aria-pressed": "=$tg.id === 'qr' ? $showQr : null" },
        on: { click: { action: "target", arg: "$tg.id" } },
      }, [
        icon("{$tg.icon}", "h-5 w-5", { "aria-hidden": "true" }, { id: "share-target-icon" }),
        n("area", { id: "share-target-label", text: "{$tg.label}" }),
      ]),
    ]),
    n("panel", { id: "sr-qr", name: "QR code", if: "$showQr", attrs: { class: "flex justify-center" } }, [n("slot", { id: "sr-qr-code", slot: "qr" })]),
    n("paragraph", { id: "sr-limits", attrs: { class: "text-xs text-muted-foreground" }, text: "{$limits}" }),
    n("panel", { id: "sr-buttons", attrs: { class: "flex gap-2" } }, [
      n("button", {
        id: "share-new", name: "Another invite", attrs: { type: "button", "data-testid": "share-new", disabled: "=$busy", class: "inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent" },
        on: { click: { action: "another" } },
      }, [icon("share-2", "h-4 w-4", { "aria-hidden": "true" }, { id: "share-new-icon" }), text("{_'share.another'}", { id: "share-new-text" })]),
      n("button", {
        id: "share-revoke", name: "Revoke", attrs: { type: "button", "data-testid": "share-revoke", class: "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-destructive/40 px-3 text-sm text-destructive hover:bg-destructive/10" },
        on: { click: { action: "revoke" } },
      }, [icon("trash", "h-4 w-4", { "aria-hidden": "true" }, { id: "share-revoke-icon" }), text("{_'share.revoke'}", { id: "share-revoke-text" })]),
    ]),
  ]);
}

/** ShareSection: the Room window's "Share this room". */
export function shareTree(): LNode {
  const { n, text, icon } = treeBuilder("ss");
  return n("panel", { id: "share-section", name: "Share this room", tag: "section", attrs: { class: "share-section", "data-testid": "share-section", "aria-label": "{_'share.title'}" } }, [
    n("heading", { id: "ss-title", attrs: { class: "flex items-center gap-2 text-sm font-semibold" } }, [
      icon("link-2", "h-4 w-4", { "aria-hidden": "true" }, { id: "ss-title-icon" }),
      text("{_'share.title'}", { id: "ss-title-text" }),
    ]),
    n("paragraph", { id: "ss-intro", attrs: { class: "mt-1 text-xs text-muted-foreground" }, text: "{_'share.intro'}" }),
    n("group", { id: "ss-form", name: "Before creating", if: "!$created" }, [
      n("panel", { id: "ss-options", attrs: { class: "mt-3 grid grid-cols-2 gap-2" } }, [
        n("label", { id: "ss-uses", attrs: { class: "grid gap-1 text-xs font-medium" } }, [
          text("{_'share.maxUses'}", { id: "ss-uses-label" }),
          n("select", { id: "share-max-uses", attrs: { "data-testid": "share-max-uses", class: "share-select", value: "=$maxUses" }, on: { change: { action: "maxUses" } } }, [
            n("option", { id: "ss-uses-option", each: "$uses", as: "u", key: "$u", attrs: { value: "=$u" }, text: "{$u}×" }),
          ]),
        ]),
        n("label", { id: "ss-ttl", attrs: { class: "grid gap-1 text-xs font-medium" } }, [
          text("{_'share.ttl'}", { id: "ss-ttl-label" }),
          n("select", { id: "share-ttl", attrs: { "data-testid": "share-ttl", class: "share-select", value: "=$ttlSec" }, on: { change: { action: "ttl" } } }, [
            n("option", { id: "ss-ttl-option", each: "$ttls", as: "o", key: "$o.sec", attrs: { value: "=$o.sec" }, text: "{$o.label}" }),
          ]),
        ]),
      ]),
      n("button", {
        id: "button-share", name: "Create the invite",
        attrs: { type: "button", "data-testid": "button-share", disabled: "=!$ready || $busy", class: "mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-primary/50 bg-primary/10 px-4 text-sm font-semibold text-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50" },
        on: { click: { action: "create" } },
      }, [
        icon("share-2", "h-4 w-4", { "aria-hidden": "true" }, { id: "ss-create-icon" }),
        text("{=($busy ? 'share.creating' : 'share.create')|t}", { id: "ss-create-text" }),
      ]),
      n("paragraph", { id: "ss-need-session", if: "!$ready", attrs: { class: "mt-2 text-xs text-muted-foreground" }, text: "{_'share.needSession'}" }),
    ]),
    n("slot", { id: "ss-result", name: "The invite", slot: "result", if: "$created" }),
    n("paragraph", { id: "ss-error", if: "$error", attrs: { role: "alert", class: "mt-2 text-xs text-destructive" }, text: "{$error}" }),
  ]);
}

/** ShareConnection: "Share a connection" of My connections. */
export function shareConnectionTree(): LNode {
  const { n, text, icon } = treeBuilder("sc");
  const pills = (id: string, iconName: string, label: string, list: string, value: string, action: string) =>
    n("panel", { id, attrs: { class: "sc-field" } }, [
      n("area", { id: `${id}-label`, attrs: { class: "sc-field__label" } }, [icon(iconName, "h-3.5 w-3.5", { "aria-hidden": "true" }, { id: `${id}-icon` }), text(`{_'${label}'}`, { id: `${id}-text` })]),
      n("panel", { id: `${id}-pills`, attrs: { class: "sc-pills", role: "radiogroup", "aria-label": `{_'${label}'}`, "data-testid": id } }, [
        n("button", {
          id: `${id}-pill`, each: `$${list}`, as: "o", key: "$o.value",
          attrs: { type: "button", role: "radio", "aria-checked": `=$o.value === $${value}`, class: "sc-pill", "data-testid": `${id}-{$o.value}` },
          on: { click: { action, arg: "$o.value" } }, text: "{$o.label}",
        }),
      ]),
    ]);
  return n("panel", { id: "share-connection", name: "Share a connection", attrs: { class: "sc", "data-testid": "share-connection" } }, [
    n("panel", { id: "sc-card", name: "The connection", css: { "--cx-color": "{$color}" }, attrs: { class: "sc-card" } }, [
      n("area", { id: "sc-card-dot", attrs: { class: "sc-card__dot", "aria-hidden": "true" } }, []),
      n("panel", { id: "sc-card-text", attrs: { class: "sc-card__text" } }, [
        n("area", { id: "sc-card-label", attrs: { class: "sc-card__label" }, text: "{$label}" }),
        n("area", { id: "sc-card-sub", attrs: { class: "sc-card__sub" }, text: "{$room} · {=$host || ('cx.thisServer'|t)}" }),
      ]),
      n("area", { id: "sc-card-lock", attrs: { class: "sc-card__lock", title: "{_'sc.sealed'}" } }, [icon("shield-check", "h-4 w-4", { "aria-hidden": "true" }, { id: "sc-lock-icon" })]),
    ]),
    n("group", { id: "sc-form", name: "Before creating", if: "!$created" }, [
      n("paragraph", { id: "sc-intro", attrs: { class: "sc-intro" }, text: "{_'sc.intro'}" }),
      pills("sc-uses", "users", "share.maxUses", "uses", "maxUses", "maxUses"),
      pills("sc-ttl", "clock-3", "share.ttl", "ttls", "ttlSec", "ttl"),
      n("label", { id: "sc-guest-field", attrs: { class: "sc-field" } }, [
        n("area", { id: "sc-guest-label", attrs: { class: "sc-field__label" } }, [icon("user-round", "h-3.5 w-3.5", { "aria-hidden": "true" }, { id: "sc-guest-icon" }), text("{_'sc.guest'}", { id: "sc-guest-text" })]),
        n("input", { id: "sc-guest", attrs: { class: "sc-input", value: "=$guest", maxlength: "42", placeholder: "{_'sc.guest.placeholder'}", "data-testid": "sc-guest" }, on: { change: { action: "guest" } } }),
      ]),
      n("paragraph", { id: "sc-note", if: "$host", attrs: { class: "sc-note" } }, [
        icon("server", "h-3.5 w-3.5", { "aria-hidden": "true" }, { id: "sc-note-icon" }),
        text("{=('sc.server'|t|replace:'{host}':$host)}", { id: "sc-note-text" }),
      ]),
      n("button", { id: "sc-create", name: "Create the invite", attrs: { type: "button", class: "sc-create", disabled: "=$busy", "data-testid": "sc-create" }, on: { click: { action: "create" } } }, [
        icon("share-2", "h-4 w-4", { "aria-hidden": "true" }, { id: "sc-create-icon" }),
        text("{=($busy ? 'share.creating' : 'sc.create')|t}", { id: "sc-create-text" }),
      ]),
    ]),
    n("group", { id: "sc-done-group", if: "$created" }, [
      n("slot", { id: "sc-result", name: "The invite", slot: "result" }),
      n("button", { id: "sc-done", name: "Done", attrs: { type: "button", class: "sc-done", "data-testid": "sc-done" }, on: { click: { action: "done" } }, text: "{_'sc.done'}" }),
    ]),
    n("paragraph", { id: "sc-error", if: "$error", attrs: { role: "alert", class: "sc-error" }, text: "{$error}" }),
  ]);
}

/** InvitePrompt: the app was opened from an invite link. */
export function inviteTree(): LNode {
  const { n, text } = treeBuilder("ip");
  return n("form", { id: "form-invite", name: "Join by invite", attrs: { class: "space-y-3", "data-testid": "form-invite", autocomplete: "off" }, on: { submit: { action: "submit" } } }, [
    n("paragraph", { id: "invite-intro", attrs: { class: "text-sm text-muted-foreground" }, text: "{_'invite.intro'}" }),
    n("label", { id: "invite-label", attrs: { class: "grid gap-1 text-sm font-medium" } }, [
      text("{_'invite.code'}", { id: "invite-label-text" }),
      n("input", {
        id: "input-invite-code",
        attrs: {
          "data-testid": "input-invite-code", autofocus: "=true", inputmode: "numeric", autocomplete: "one-time-code", placeholder: "0000-0000-0000", disabled: "=$dead", value: "=$value",
          class: "min-h-12 rounded-xl border border-input bg-background px-3 text-center font-mono text-xl tracking-widest outline-none focus:ring-2 focus:ring-ring",
        },
        on: { change: { action: "code" } },
      }),
    ]),
    n("paragraph", { id: "invite-message", if: "$message", attrs: { role: "alert", class: "text-sm text-destructive", "data-testid": "invite-message" }, text: "{$message}" }),
    n("panel", { id: "invite-buttons", attrs: { class: "flex gap-2" } }, [
      n("button", {
        id: "button-invite-join", name: "Join", attrs: { type: "submit", "data-testid": "button-invite-join", disabled: "=!$code || $busy || $dead", class: "inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50" },
        text: "{=($busy ? 'invite.checking' : 'invite.join')|t}",
      }),
      n("button", { id: "invite-cancel", name: "Cancel", attrs: { type: "button", class: "inline-flex min-h-11 items-center rounded-2xl border border-border bg-background px-3 text-sm hover:bg-accent" }, on: { click: { action: "dismiss" } }, text: "{_'common.cancel'}" }),
    ]),
  ]);
}

/* ------------------------------------------------------------ contracts */

type ShareId = "part.shareResult" | "panel.share" | "panel.shareConnection" | "part.invite";

export const SHARE_CONTRACTS: Record<ShareId, LayoutContract> = {
  "part.shareResult": {
    description: "A created invite: its link and code, where to send it, the QR code, its limits, another one, revoke.",
    vars: [
      { path: "$url", type: "text", description: "The link." }, { path: "$code", type: "text", description: "The code (formatted)." },
      { path: "$copied", type: "text", description: "What was just copied: link or code." }, { path: "$showQr", type: "yes/no", description: "The QR code is shown." },
      { path: "$targets", type: "list", description: "Where to send it: .id, .label, .icon." }, { path: "$limits", type: "text", description: "Its uses, attempts and expiry." },
      { path: "$busy", type: "yes/no", description: "Creating another." },
    ],
    actions: [
      { name: "selectAll", description: "Select the link.", event: "focus" }, { name: "copyLink", description: "Copy the link." }, { name: "copyCode", description: "Copy the code." },
      { name: "target", description: "Send it with an app (or QR, copy, more…).", arg: "the target's id" }, { name: "another", description: "Create another invite." }, { name: "revoke", description: "Revoke it." },
    ],
    slots: [{ name: "qr", description: "The link as a QR code." }],
    refs: [],
  },
  "panel.share": {
    description: "The Room window's “Share this room”: how many uses, how long, create.",
    vars: [
      { path: "$created", type: "yes/no", description: "An invite was created." }, { path: "$ready", type: "yes/no", description: "The room key is in memory (a session)." },
      { path: "$busy", type: "yes/no", description: "Creating." }, { path: "$error", type: "text", description: "Why it failed." },
      { path: "$uses", type: "list", description: "Use limits." }, { path: "$maxUses", type: "number", description: "The one chosen." },
      { path: "$ttls", type: "list", description: "Lifetimes: .sec, .label." }, { path: "$ttlSec", type: "number", description: "The one chosen." },
    ],
    actions: [{ name: "maxUses", description: "Uses chosen.", event: "change" }, { name: "ttl", description: "Lifetime chosen.", event: "change" }, { name: "create", description: "Create the invite." }],
    slots: [{ name: "result", description: "The created invite." }],
    refs: [],
  },
  "panel.shareConnection": {
    description: "“Share a connection”: an invite made from a saved connection, for a named guest if you like.",
    vars: [
      { path: "$label", type: "text", description: "The connection's name." }, { path: "$color", type: "text", description: "Its colour." }, { path: "$room", type: "text", description: "Its room." },
      { path: "$host", type: "text", description: "Its server (empty: this one)." }, { path: "$created", type: "yes/no", description: "An invite was created." }, { path: "$busy", type: "yes/no", description: "Creating." },
      { path: "$error", type: "text", description: "Why it failed." }, { path: "$uses", type: "list", description: "Use limits: .value, .label." }, { path: "$maxUses", type: "number", description: "The one chosen." },
      { path: "$ttls", type: "list", description: "Lifetimes: .value, .label." }, { path: "$ttlSec", type: "number", description: "The one chosen." }, { path: "$guest", type: "text", description: "The guest's name." },
    ],
    actions: [
      { name: "maxUses", description: "Uses chosen.", arg: "the number" }, { name: "ttl", description: "Lifetime chosen.", arg: "seconds" }, { name: "guest", description: "The guest's name typed.", event: "change" },
      { name: "create", description: "Create the invite." }, { name: "done", description: "Close." },
    ],
    slots: [{ name: "result", description: "The created invite." }],
    refs: [],
  },
  "part.invite": {
    description: "Opened from an invite link: the code, join or cancel.",
    vars: [
      { path: "$value", type: "text", description: "The code typed." }, { path: "$code", type: "text", description: "The code, when complete." }, { path: "$busy", type: "yes/no", description: "Checking." },
      { path: "$dead", type: "yes/no", description: "The invite is gone." }, { path: "$message", type: "text", description: "What went wrong." },
    ],
    actions: [{ name: "code", description: "The code typed.", event: "change" }, { name: "submit", description: "Join.", event: "submit" }, { name: "dismiss", description: "Cancel." }],
    slots: [],
    refs: [],
  },
};

export const SHARE_VARIANTS: Record<ShareId, ReadonlyArray<{ id: string; label: string }>> = {
  "part.shareResult": [{ id: "plain", label: "A created invite" }, { id: "qr", label: "With the QR code" }],
  "panel.share": [{ id: "ready", label: "Ready to create" }, { id: "nosession", label: "Without a session" }],
  "panel.shareConnection": [{ id: "plain", label: "This server" }, { id: "server", label: "Another server" }],
  "part.invite": [{ id: "empty", label: "Typing the code" }, { id: "wrong", label: "A wrong code" }],
};
