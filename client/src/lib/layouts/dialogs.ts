// Dialogs and small parts (4.13): "sign in first", the signed-in badge, a
// person's details, a message's details and audit, and the version check —
// drawn by their components, which keep what they do.

import { treeBuilder, type LNode } from "../layout-tree";
import type { LayoutContract } from "./contracts";

/** NeedSignIn: what a signed-out user is told where a passkey is needed. */
export function needSignInTree(): LNode {
  const { n, icon } = treeBuilder("ns");
  return n("panel", { id: "id-need", name: "Sign in first", attrs: { class: "id-need{if $compact} is-compact{/if}", "data-testid": "{$testId}" } }, [
    n("area", { id: "need-icon", attrs: { class: "id-need__icon", "aria-hidden": "true" } }, [icon("key-round", "h-4 w-4", {}, { id: "need-key" })]),
    n("panel", { id: "need-body", attrs: { class: "min-w-0" } }, [
      n("area", { id: "need-title", tag: "strong", text: "{_'id.need.title'}" }),
      n("paragraph", { id: "need-text", text: "{=$text == null ? ('id.need.text'|t) : $text}" }),
      n("button", { id: "need-open", name: "Open the Connection window", if: "$canOpen", attrs: { type: "button", class: "acc-btn", "data-testid": "{$testId}-open" }, on: { click: { action: "open" } }, text: "{_'id.need.open'}" }),
    ]),
  ]);
}

/** SignedInBadge: the app bar's "signed in as …" button. */
export function signedInTree(): LNode {
  const { n, icon } = treeBuilder("sb");
  return n("button", {
    id: "signed-in-badge", name: "Signed in",
    attrs: {
      type: "button", class: "signed-badge", "data-testid": "signed-in-badge",
      title: "{=('acc.signedInAs'|t|replace:'{name}':$userName)}", "aria-label": "{=('acc.signedInAs'|t|replace:'{name}':$userName)}",
    },
    on: { click: { action: "open" } },
  }, [
    icon("lock-keyhole-open", "h-3.5 w-3.5", { "aria-hidden": "true" }, { id: "badge-icon" }),
    n("area", { id: "badge-label", attrs: { class: "signed-badge__label" }, text: "{_'acc.signedIn'}" }),
    n("area", { id: "badge-name", attrs: { class: "signed-badge__name" }, text: "{$userName}" }),
    n("area", { id: "badge-count", name: "Waiting messages", if: "$pending > 0", attrs: { class: "signed-badge__count", title: "{=('away.pending'|t|replace:'{n}':$pending)}" }, text: "{$pending}" }),
  ]);
}

/** A label and a value in a details list (shared by the two details dialogs). */
function rows(n: ReturnType<typeof treeBuilder>["n"], list: Array<{ id: string; label: string; value: string | LNode; if?: string }>): LNode[] {
  return list.map((r) => n("panel", { id: `row-${r.id}`, name: r.id, attrs: { class: "userinfo-row" }, ...(r.if ? { if: r.if } : {}) }, [
    n("area", { id: `row-${r.id}-k`, attrs: { class: "userinfo-row__k" }, text: r.label }),
    typeof r.value === "string"
      ? n("area", { id: `row-${r.id}-v`, attrs: { class: "userinfo-row__v" }, text: r.value })
      : n("area", { id: `row-${r.id}-v`, attrs: { class: "userinfo-row__v" } }, [r.value]),
  ]));
}

/** UserInfoView: a person in the room — the connection, what was exchanged, the safety number. */
export function userInfoTree(): LNode {
  const { n, text, icon } = treeBuilder("ui");
  return n("panel", { id: "userinfo", name: "Details", attrs: { class: "space-y-3" } }, [
    n("panel", { id: "userinfo-head", name: "Head", attrs: { class: "userinfo-head" } }, [
      n("avatar", { id: "userinfo-avatar", props: { name: "{$name}", avatar: "{$avatar}", size: "44" } }),
      n("panel", { id: "userinfo-names" }, [
        n("panel", { id: "userinfo-name", attrs: { class: "text-base font-semibold" }, text: "{=$name || '—'}" }),
        n("panel", { id: "userinfo-peer", attrs: { class: "font-mono text-xs text-muted-foreground" }, text: "{$peerShort}" }),
      ]),
    ]),
    n("panel", { id: "userinfo-grid", name: "Facts", attrs: { class: "userinfo-grid" } }, rows(n, [
      { id: "username", label: "{_'id.username'}", if: "$username", value: n("area", { id: "userinfo-username", attrs: { class: "font-mono", "data-testid": "userinfo-username" }, text: "{$username}" }) },
      { id: "duration", label: "{_'userinfo.duration'}", value: "{$duration}" },
      { id: "ip", label: "{_'userinfo.ip'}", value: "{=$ip || ('userinfo.ip.unknown'|t)}" },
      { id: "candidate", label: "{_'userinfo.candidate'}", value: "{=$candidateType || '—'}" },
      { id: "transport", label: "{_'userinfo.transport'}", value: "{$transport|t:'userinfo.transport.'}" },
      { id: "app", label: "{_'userinfo.app'}", value: "{$appType}" },
      { id: "server", label: "{_'userinfo.server'}", value: "{=($usesServer ? 'userinfo.server.on' : 'userinfo.server.off')|t}" },
      { id: "sent", label: "{_'userinfo.sent'}", value: "{$sent}" },
      { id: "recv", label: "{_'userinfo.recv'}", value: "{$recv}" },
      { id: "security", label: "{_'userinfo.security'}", value: "{$security}" },
    ])),
    n("panel", { id: "userinfo-fingerprint", name: "Fingerprint", if: "$fingerprint" }, [
      n("panel", { id: "fingerprint-k", attrs: { class: "userinfo-row__k mb-1" }, text: "{_'userinfo.fingerprint'}" }),
      n("area", { id: "fingerprint-v", tag: "code", attrs: { class: "userinfo-fp" }, text: "{$fingerprint}" }),
    ]),
    n("panel", { id: "safety-number", name: "Safety number", if: "$hasSafety", attrs: { class: "userinfo-safety", "data-testid": "safety-number" } }, [
      n("panel", { id: "safety-k", attrs: { class: "userinfo-row__k mb-1" }, text: "{_'sec.safety'}" }),
      n("paragraph", { id: "safety-desc", attrs: { class: "text-[11px] text-muted-foreground" }, text: "{_'sec.safety.desc'}" }),
      n("area", { id: "safety-sn", tag: "code", attrs: { class: "userinfo-sn" }, text: "{=$number || '…'}" }),
      n("slot", { id: "safety-qr", name: "QR code of the number", slot: "qr", if: "$digits" }),
      n("slot", { id: "safety-scanner", name: "Camera scanner", slot: "scanner", if: "$scanning" }),
      n("paragraph", { id: "safety-verified", if: "$verified || $result === 'match'", attrs: { class: "text-xs text-emerald-600 dark:text-emerald-400" } }, [
        icon("shield-check", "mr-1 inline h-3.5 w-3.5", {}, { id: "safety-verified-icon" }),
        text("{_'sec.safety.verified'}", { id: "safety-verified-text" }),
      ]),
      n("paragraph", { id: "safety-mismatch", if: "$result === 'mismatch'", attrs: { class: "text-xs font-semibold text-destructive" }, text: "{_'sec.safety.mismatch'}" }),
      n("panel", { id: "safety-actions", attrs: { class: "flex flex-wrap gap-2" } }, [
        n("button", { id: "safety-scan", name: "Scan", if: "$canScan && !$verified", attrs: { type: "button", class: "acc-btn acc-btn--small" }, on: { click: { action: "scan" } } }, [
          icon("scan-line", "h-3.5 w-3.5", {}, { id: "safety-scan-icon" }),
          text("{_'sec.safety.scan'}", { id: "safety-scan-text" }),
        ]),
        n("button", { id: "safety-confirm", name: "Confirm", if: "!$verified && $result !== 'match'", attrs: { type: "button", class: "acc-btn acc-btn--small", "data-testid": "safety-confirm" }, on: { click: { action: "confirm" } }, text: "{_'sec.safety.confirm'}" }),
        n("button", { id: "peer-exclude", name: "Exclude", attrs: { type: "button", class: "acc-btn acc-btn--small acc-btn--danger", "data-testid": "peer-exclude" }, on: { click: { action: "exclude" } } }, [
          icon("user-x", "h-3.5 w-3.5", {}, { id: "exclude-icon" }),
          text("{_'sec.exclude'}", { id: "exclude-text" }),
        ]),
      ]),
    ]),
    n("paragraph", { id: "userinfo-note", attrs: { class: "text-[11px] text-muted-foreground" }, text: "{_'userinfo.note'}" }),
  ]);
}

/** MessageInfoView: a message's details, its audit trail and its data. */
export function messageInfoTree(): LNode {
  const { n, text, icon } = treeBuilder("mi");
  const chip = (id: string, iconName: string, label: string, spec: Record<string, unknown>) =>
    n(spec.tag === "a" ? "link" : "button", { id, ...spec } as never, [icon(iconName, "h-3.5 w-3.5", {}, { id: `${id}-icon` }), text(` {_'${label}'}`, { id: `${id}-text` })]);
  return n("panel", { id: "msginfo", name: "Details", attrs: { class: "space-y-3" } }, [
    n("panel", { id: "msginfo-grid", name: "Facts", attrs: { class: "userinfo-grid" } }, rows(n, [
      { id: "sender", label: "{_'msginfo.sender'}", value: "{$sender}" },
      { id: "recipients", label: "{_'msginfo.recipients'}", value: "{$recipients|join:', '}" },
      { id: "route", label: "{_'msginfo.route'}", value: "{$route}" },
      { id: "ip", label: "{_'userinfo.ip'}", value: "{=$ip || ('userinfo.ip.unknown'|t)}" },
      { id: "created", label: "{_'msginfo.created'}", value: "{$created}" },
      {
        id: "security", label: "{_'userinfo.security'}",
        value: n("area", { id: "security-value", attrs: { class: "inline-flex items-center gap-1" } }, [
          icon("lock", "h-3.5 w-3.5", {}, { id: "security-lock", if: "$secure" }),
          icon("lock-open", "h-3.5 w-3.5", {}, { id: "security-open", if: "!$secure" }),
          text(" {=$secure ? ('sec.cipher'|t|replace:'{v}':$cryptoVersion) : ('msginfo.insecure'|t)}", { id: "security-text" }),
        ]),
      },
      { id: "sealed", label: "{_'sec.sealed'}", if: "$sealedWith", value: "{$sealedWith|t:'sec.sealed.'}" },
      {
        id: "identity", label: "{_'sec.identity'}", if: "$identity",
        value: n("area", {
          id: "msginfo-identity", attrs: { "data-testid": "msginfo-identity", class: "{if $identity.tone === 'warn'}font-semibold text-destructive{elseif $identity.tone === 'ok'}text-emerald-600 dark:text-emerald-400{else}text-muted-foreground{/if}" },
          text: "{$identity.text}",
        }),
      },
      { id: "kinds", label: "{_'msginfo.kinds'}", if: "($flags|length) > 0", value: "{$flags|join:' · '}" },
    ])),
    n("panel", { id: "msginfo-audit", name: "Audit trail" }, [
      n("panel", { id: "audit-k", attrs: { class: "userinfo-row__k mb-1" }, text: "{_'msginfo.audit'}" }),
      n("list", { id: "msg-audit", tag: "ol", attrs: { class: "msg-audit", "data-testid": "msg-audit" } }, [
        n("item", { id: "audit-item", name: "A step", each: "$audit", as: "a" }, [
          n("area", { id: "audit-dot", attrs: { class: "msg-audit__dot", "aria-hidden": "true" } }, []),
          n("area", { id: "audit-state", attrs: { class: "msg-audit__state" }, text: "{$a.label|t}" }),
          n("area", { id: "audit-time", attrs: { class: "msg-audit__time" }, text: "{$a.time}{if $a.meta} · {$a.meta}{/if}" }),
        ]),
      ]),
    ]),
    n("panel", { id: "msg-data-cipher", name: "Encrypted data", tag: "details", attrs: { class: "msg-data" } }, [
      n("panel", { id: "cipher-summary", tag: "summary", text: "{_'msginfo.encrypted'}" }),
      n("panel", { id: "cipher-row", attrs: { class: "msg-data__row" } }, [
        n("area", { id: "cipher-code", tag: "code", attrs: { class: "userinfo-fp" }, text: "{=$cipher ? $cipherShort : '—'}" }),
        chip("cipher-copy", "copy", "common.copy", { if: "$cipher", attrs: { type: "button", class: "ai-chip" }, on: { click: { action: "copyCipher" } } }),
      ]),
    ]),
    n("panel", { id: "msg-data-plain", name: "Decrypted text", tag: "details", attrs: { class: "msg-data" } }, [
      n("panel", { id: "plain-summary", tag: "summary", text: "{_'msginfo.decrypted'}" }),
      n("area", { id: "plain-code", tag: "code", attrs: { class: "userinfo-fp" }, text: "{=$plaintext == null ? ('msginfo.sealedNote'|t) : $plaintext}" }),
    ]),
    n("panel", { id: "msg-attach-actions", name: "The file", if: "$attachment", attrs: { class: "msg-attach-actions" } }, [
      n("panel", { id: "attach-name", attrs: { class: "text-xs font-semibold" }, text: "{$attachment.name} · {$attachment.mime} · {$attachment.sizeText}" }),
      n("panel", { id: "attach-actions", attrs: { class: "flex flex-wrap gap-2" } }, [
        chip("attach-save", "download", "msginfo.save", { tag: "a", attrs: { class: "ai-chip", href: "=$attachment.url", download: "{$attachment.name}" } }),
        chip("attach-open", "external-link", "msginfo.open", { tag: "a", attrs: { class: "ai-chip", href: "=$attachment.url", target: "_blank", rel: "noreferrer" } }),
        chip("attach-share", "share-2", "msginfo.share", { attrs: { type: "button", class: "ai-chip" }, on: { click: { action: "share" } } }),
        chip("attach-forward", "forward", "msginfo.forward", { attrs: { type: "button", class: "ai-chip" }, on: { click: { action: "forward" } } }),
      ]),
    ]),
    chip("msginfo-forward", "forward", "msginfo.forward", { if: "!$attachment", attrs: { type: "button", class: "ai-chip" }, on: { click: { action: "forward" } } }),
  ]);
}

/** IntegrityCheck: this browser runs something else than the server deploys. */
export function integrityTree(): LNode {
  const { n, text, icon } = treeBuilder("ic");
  return n("panel", { id: "ic", name: "Version check", attrs: { class: "ic" } }, [
    n("paragraph", { id: "ic-lead", name: "What happened", attrs: { class: "ic-lead" } }, [
      icon("triangle-alert", "h-5 w-5 flex-none", { "aria-hidden": "true" }, { id: "ic-alert" }),
      n("area", { id: "ic-desc", text: "{_'ver.desc'}" }),
    ]),
    n("heading", { id: "ic-title", tag: "h3", attrs: { class: "ic-title" } }, [
      text("{_'ver.found'} ", { id: "ic-found" }),
      n("area", { id: "ic-count", attrs: { class: "ic-count" }, text: "{$found|length}" }),
    ]),
    n("panel", { id: "ic-table-wrap", attrs: { class: "ic-table-wrap" } }, [
      n("table", { id: "integrity-list", name: "What differs", attrs: { class: "ic-table", "data-testid": "integrity-list" } }, [
        n("tableSection", { id: "ic-head", tag: "thead" }, [
          n("tableRow", { id: "ic-head-row" }, [
            n("tableCell", { id: "ic-col-item", tag: "th", text: "{_'ver.col.item'}" }),
            n("tableCell", { id: "ic-col-local", tag: "th", text: "{_'ver.col.local'}" }),
            n("tableCell", { id: "ic-col-server", tag: "th", text: "{_'ver.col.server'}" }),
          ]),
        ]),
        n("tableSection", { id: "ic-body", tag: "tbody" }, [
          n("tableRow", { id: "ic-row", name: "A difference", each: "$found", as: "m", key: "$m.key", attrs: { "data-kind": "{$m.kind}" } }, [
            n("tableCell", { id: "ic-item" }, [
              n("area", { id: "ic-kind", attrs: { class: "ic-kind" }, text: "{$m.kind|t:'ver.kind.'}" }),
              text(" ", { id: "ic-sp" }),
              n("area", { id: "ic-item-name", tag: "code", text: "{$m.item}" }),
            ]),
            n("tableCell", { id: "ic-local" }, [n("area", { id: "ic-local-v", tag: "code", text: "{$m.local}" })]),
            n("tableCell", { id: "ic-server" }, [n("area", { id: "ic-server-v", tag: "code", text: "{=$m.server || ('ver.missing'|t)}" })]),
          ]),
        ]),
      ]),
    ]),
    n("paragraph", { id: "ic-fix-desc", attrs: { class: "ic-fix-desc" }, text: "{_'ver.fix.desc'}" }),
    n("label", { id: "ic-keep", attrs: { class: "ic-keep" } }, [
      n("input", { id: "integrity-keep", attrs: { type: "checkbox", checked: "=$keepPrefs", "data-testid": "integrity-keep" }, on: { change: { action: "keepPrefs" } } }),
      text("{_'ver.keepPrefs'}", { id: "ic-keep-text" }),
    ]),
    n("panel", { id: "ic-actions", attrs: { class: "ic-actions" } }, [
      n("button", { id: "integrity-fix", name: "Fix", attrs: { type: "button", class: "acc-btn acc-btn--primary", disabled: "=$fixing", "data-testid": "integrity-fix" }, on: { click: { action: "fix" } } }, [
        icon("refresh-cw", "h-4 w-4 animate-spin", { "aria-hidden": "true" }, { id: "ic-fixing", if: "$fixing" }),
        icon("wrench", "h-4 w-4", { "aria-hidden": "true" }, { id: "ic-wrench", if: "!$fixing" }),
        text("{=($fixing ? 'ver.fixing' : 'ver.fix')|t}", { id: "ic-fix-text" }),
      ]),
      n("button", { id: "integrity-later", name: "Later", attrs: { type: "button", class: "acc-btn", disabled: "=$fixing", "data-testid": "integrity-later" }, on: { click: { action: "later" } }, text: "{_'ver.later'}" }),
    ]),
  ]);
}

/* ------------------------------------------------------------ contracts */

type DialogId = "part.needSignIn" | "part.signedIn" | "dialog.userInfo" | "dialog.messageInfo" | "dialog.integrity";

export const DIALOG_CONTRACTS: Record<DialogId, LayoutContract> = {
  "part.needSignIn": {
    description: "“Sign in first” — shown where a passkey sign-in is needed.",
    vars: [
      { path: "$text", type: "text", description: "What signing in would unlock (else the general sentence)." },
      { path: "$testId", type: "text", description: "Its test id." },
      { path: "$compact", type: "yes/no", description: "The small form." },
      { path: "$canOpen", type: "yes/no", description: "The Connection window can be opened from here." },
    ],
    actions: [{ name: "open", description: "Open the Connection window (sign in)." }],
    slots: [],
    refs: [],
  },
  "part.signedIn": {
    description: "The app bar's button of a signed-in user.",
    vars: [
      { path: "$userName", type: "text", description: "The username." },
      { path: "$pending", type: "number", description: "Messages waiting (the away relay)." },
    ],
    actions: [{ name: "open", description: "Open the account." }],
    slots: [],
    refs: [],
  },
  "dialog.userInfo": {
    description: "A person in the room: the connection, what was exchanged, the safety number.",
    vars: [
      { path: "$name", type: "text", description: "Their nickname." },
      { path: "$avatar", type: "text", description: "Their avatar." },
      { path: "$peerShort", type: "text", description: "The end of their peer id." },
      { path: "$username", type: "text", description: "Their username (account or session)." },
      { path: "$duration", type: "text", description: "How long they are connected." },
      { path: "$ip", type: "text", description: "Their address (when ICE shows it)." },
      { path: "$candidateType", type: "text", description: "host, srflx, prflx or relay." },
      { path: "$transport", type: "text", description: "p2p-direct, p2p-relay, connecting, self." },
      { path: "$appType", type: "text", description: "Their app." },
      { path: "$usesServer", type: "yes/no", description: "Server-enhanced." },
      { path: "$sent", type: "text", description: "Sent to them." },
      { path: "$recv", type: "text", description: "Received from them." },
      { path: "$security", type: "text", description: "The encryption." },
      { path: "$fingerprint", type: "text", description: "The DTLS fingerprint." },
      { path: "$hasSafety", type: "yes/no", description: "A safety number can be compared." },
      { path: "$number", type: "text", description: "The safety number." },
      { path: "$digits", type: "text", description: "Its digits (the QR code)." },
      { path: "$verified", type: "yes/no", description: "Verified before." },
      { path: "$result", type: "text", description: "match or mismatch after a scan." },
      { path: "$scanning", type: "yes/no", description: "The camera is scanning." },
      { path: "$canScan", type: "yes/no", description: "This browser can scan a QR code." },
    ],
    actions: [
      { name: "scan", description: "Scan their QR code." },
      { name: "confirm", description: "Mark the number as compared." },
      { name: "exclude", description: "Exclude them from the room (asks first)." },
    ],
    slots: [
      { name: "qr", description: "The safety number as a QR code." },
      { name: "scanner", description: "The camera, scanning." },
    ],
    refs: [],
  },
  "dialog.messageInfo": {
    description: "A message's details: who, when, how, its audit trail and data, and the file.",
    vars: [
      { path: "$sender", type: "text", description: "Who sent it." },
      { path: "$recipients", type: "list", description: "To whom." },
      { path: "$route", type: "text", description: "How it travelled." },
      { path: "$ip", type: "text", description: "The address it came from." },
      { path: "$created", type: "text", description: "When (a date and time)." },
      { path: "$secure", type: "yes/no", description: "Encrypted end to end." },
      { path: "$cryptoVersion", type: "number", description: "The encryption's version." },
      { path: "$sealedWith", type: "text", description: "sender-key, pair or room." },
      { path: "$identity", type: "object", description: "The sender's identity: .text, .tone (ok / warn / muted)." },
      { path: "$flags", type: "list", description: "The kinds of message." },
      { path: "$audit", type: "list", description: "Its steps: .label (a translation key), .time, .meta." },
      { path: "$cipher", type: "text", description: "The encrypted data." },
      { path: "$cipherShort", type: "text", description: "Its first 220 characters." },
      { path: "$plaintext", type: "text", description: "The text (none when sealed)." },
      { path: "$attachment", type: "object", description: "The file: .name, .mime, .sizeText, .url." },
    ],
    actions: [
      { name: "copyCipher", description: "Copy the encrypted data." },
      { name: "share", description: "Share the file." },
      { name: "forward", description: "Forward the message." },
    ],
    slots: [],
    refs: [],
  },
  "dialog.integrity": {
    description: "The version check: this browser runs other files than the server deploys.",
    vars: [
      { path: "$found", type: "list", description: "What differs: .kind, .item, .local, .server, .key." },
      { path: "$keepPrefs", type: "yes/no", description: "Keep the settings when fixing." },
      { path: "$fixing", type: "yes/no", description: "Fixing now." },
    ],
    actions: [
      { name: "keepPrefs", description: "Keep the settings / not.", event: "change" },
      { name: "fix", description: "Clear this app's cache and data here and load everything fresh." },
      { name: "later", description: "Ask again later." },
    ],
    slots: [],
    refs: [],
  },
};

export const DIALOG_VARIANTS: Record<DialogId, ReadonlyArray<{ id: string; label: string }>> = {
  "part.needSignIn": [{ id: "open", label: "With the button" }, { id: "text", label: "Only the text" }, { id: "compact", label: "Compact" }],
  "part.signedIn": [{ id: "plain", label: "Signed in" }, { id: "pending", label: "Messages waiting" }],
  "dialog.userInfo": [{ id: "peer", label: "Someone connected" }, { id: "safety", label: "With a safety number" }, { id: "verified", label: "Verified" }],
  "dialog.messageInfo": [{ id: "text", label: "A text message" }, { id: "file", label: "With a file" }, { id: "sealed", label: "Sealed, insecure" }],
  "dialog.integrity": [{ id: "found", label: "Differences found" }, { id: "fixing", label: "Fixing" }],
};
