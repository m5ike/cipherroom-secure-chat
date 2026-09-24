// "My connections" (4.13): the saved rooms of a signed-in user — the list
// (with what the window says before one can be used), a connection's editor,
// its statistics and log, and the comfort settings. Drawn by
// ConnectionsPanel.tsx, which keeps the state and hands edits back.

import { treeBuilder, type LNode } from "../layout-tree";
import type { LayoutContract } from "./contracts";

type Builder = ReturnType<typeof treeBuilder>;

/** A switch (label, hint, a checkbox drawn as a switch) — the Appearance screen's style. */
function toggle(b: Builder, id: string, spec: { label: string; hint?: string; hintIf?: string; checked: string; disabled?: string; testid: string; action: string; arg: string }): LNode {
  const { n } = b;
  return n("label", { id, attrs: { class: spec.disabled ? `ap-toggle cx-switch{if ${spec.disabled}} is-disabled{/if}` : "ap-toggle cx-switch" } }, [
    n("area", { id: `${id}-text` }, [
      n("area", { id: `${id}-label`, attrs: { class: "ap-toggle__label" }, text: spec.label }),
      spec.hint ? n("area", { id: `${id}-hint`, ...(spec.hintIf ? { if: spec.hintIf } : {}), attrs: { class: "ap-hint" }, text: spec.hint }) : null,
    ]),
    n("input", {
      id: `${id}-input`,
      attrs: { type: "checkbox", role: "switch", checked: `=${spec.checked}`, ...(spec.disabled ? { disabled: `=${spec.disabled}` } : {}), "data-testid": spec.testid },
      on: { change: { action: spec.action, arg: spec.arg } },
    }),
    n("area", { id: `${id}-track`, attrs: { class: "ap-toggle__track", "aria-hidden": "true" } }, [n("area", { id: `${id}-thumb`, attrs: { class: "ap-toggle__thumb" } }, [])]),
  ]);
}

/** The window: before it can be used, the tabs, the list — and the other views as parts. */
export function connectionsTree(): LNode {
  const b = treeBuilder("cx");
  const { n, text, icon } = b;
  const iconBtn = (id: string, iconName: string, label: string, action: string, extra: Record<string, string> = {}, spec: Record<string, unknown> = {}) =>
    n("button", {
      id, ...spec,
      attrs: { type: "button", class: extra.class ?? "cx-icon", title: `{_'${label}'}`, "aria-label": `{_'${label}'}`, "data-testid": id, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "class")) },
      on: { click: { action, arg: "$p.id" } },
    }, [icon(iconName, "h-4 w-4", {}, { id: `${id}-icon` })]);
  const item = n("item", {
    id: "cx-item", name: "A connection", each: "$items", as: "p", key: "$p.id", css: { "--cx-color": "{$p.color}" },
    attrs: { class: "cx-card cx-item{if $p.isActive} is-active{/if}", "data-testid": "cx-item", "data-id": "{$p.id}" },
  }, [
    n("panel", { id: "cx-item-head", attrs: { class: "cx-item__head" } }, [
      n("area", { id: "cx-dot", attrs: { class: "cx-dot", "aria-hidden": "true" } }, []),
      n("panel", { id: "cx-item-title", attrs: { class: "cx-item__title" } }, [
        n("area", { id: "cx-item-label", attrs: { class: "cx-item__label", "data-testid": "cx-item-label" }, text: "{$p.label}" }),
        n("area", { id: "cx-item-sub", attrs: { class: "cx-item__sub" }, text: "{$p.room} · {$p.user} · {$p.host}" }),
      ]),
      n("area", { id: "cx-default-badge", if: "$p.isDefault", attrs: { class: "cx-badge", "data-testid": "cx-default-badge" } }, [icon("star", "h-3 w-3", {}, { id: "cx-default-icon" }), text("{_'cx.default'}", { id: "cx-default-text" })]),
      n("area", { id: "cx-active-badge", if: "$p.isActive", attrs: { class: "cx-badge cx-badge--ok" } }, [icon("check", "h-3 w-3", {}, { id: "cx-active-icon" }), text("{_'cx.active'}", { id: "cx-active-text" })]),
    ]),
    n("panel", { id: "cx-item-meta", attrs: { class: "cx-item__meta" }, text: "{$p.meta}" }),
    n("panel", { id: "cx-item-actions", attrs: { class: "cx-item__actions" } }, [
      n("button", { id: "cx-disconnect", if: "$p.isActive", attrs: { type: "button", class: "cx-btn", "data-testid": "cx-disconnect" }, on: { click: { action: "disconnect" } } }, [icon("plug-zap", "h-4 w-4", {}, { id: "cx-disconnect-icon" }), text("{_'cx.disconnect'}", { id: "cx-disconnect-text" })]),
      n("button", { id: "cx-connect", if: "!$p.isActive", attrs: { type: "button", class: "cx-btn cx-btn--primary", "data-testid": "cx-connect" }, on: { click: { action: "connect", arg: "$p.id" } } }, [icon("plug", "h-4 w-4", {}, { id: "cx-connect-icon" }), text("{_'cx.connect'}", { id: "cx-connect-text" })]),
      iconBtn("cx-edit", "pencil", "cx.edit", "edit"),
      iconBtn("cx-details", "chart-column", "cx.details", "details"),
      iconBtn("cx-make-default", "star", "cx.makeDefault", "makeDefault", { "aria-pressed": "=$p.isDefault" }),
      iconBtn("cx-share", "share-2", "cx.share", "share", {}, { if: "$canShare" }),
      iconBtn("cx-delete", "trash", "cx.delete", "delete", { class: "cx-icon cx-icon--danger" }),
    ]),
  ]);
  return n("panel", { id: "connections-panel", name: "My connections", attrs: { class: "cx", "data-testid": "connections-panel" } }, [
    n("panel", { id: "connections-need-account", name: "Sign in first", if: "$gate === 'account'", attrs: { "data-testid": "connections-need" } }, [n("slot", { id: "cx-need-signin", slot: "needSignIn" })]),
    n("panel", { id: "connections-need", name: "Not available", if: "$gate === 'server' || $gate === 'disabled'", attrs: { class: "cx-card cx-need", "data-testid": "connections-need" } }, [
      n("heading", { id: "cx-need-title", attrs: { class: "cx-need__title" }, text: "{=($gate === 'server' ? 'cx.need.title' : 'cx.need.disabled')|t}" }),
      n("group", { id: "cx-need-server", if: "$gate === 'server'" }, [
        n("paragraph", { id: "cx-need-text", text: "{_'cx.need.server'}" }),
        n("panel", { id: "cx-need-actions", attrs: { class: "cx-actions" } }, [
          n("button", { id: "cx-enable-server", attrs: { type: "button", class: "cx-btn cx-btn--primary", "data-testid": "cx-enable-server" }, on: { click: { action: "enableServerMode" } } }, [
            icon("server", "h-4 w-4", {}, { id: "cx-enable-icon" }), text("{_'cx.enableServer'}", { id: "cx-enable-text" }),
          ]),
        ]),
      ]),
    ]),
    n("group", { id: "cx-main", name: "The window", if: "!$gate" }, [
      n("panel", { id: "cx-tabs", tag: "nav", attrs: { class: "cx-tabs", role: "tablist" } }, [
        n("button", { id: "cx-tab-list", attrs: { type: "button", role: "tab", "aria-selected": "=$view !== 'settings'", class: "cx-tab", "data-testid": "cx-tab-list" }, on: { click: { action: "tab", arg: "'list'" } } }, [
          icon("plug", "h-4 w-4", {}, { id: "cx-tab-list-icon" }),
          text("{_'cx.tab.list'}", { id: "cx-tab-list-text" }),
          n("area", { id: "cx-count", attrs: { class: "cx-count" }, text: "{$countText}" }),
        ]),
        n("button", { id: "cx-tab-settings", attrs: { type: "button", role: "tab", "aria-selected": "=$view === 'settings'", class: "cx-tab", "data-testid": "cx-tab-settings" }, on: { click: { action: "tab", arg: "'settings'" } } }, [
          icon("settings-2", "h-4 w-4", {}, { id: "cx-tab-settings-icon" }),
          text("{_'cx.tab.settings'}", { id: "cx-tab-settings-text" }),
        ]),
      ]),
      n("group", { id: "cx-list-view", name: "The list", if: "$view === 'list'" }, [
        n("paragraph", { id: "cx-intro", attrs: { class: "cx-intro" }, text: "{_'cx.intro'}" }),
        n("panel", { id: "cx-list-actions", attrs: { class: "cx-actions" } }, [
          n("button", { id: "cx-add", attrs: { type: "button", class: "cx-btn cx-btn--primary", disabled: "=$full", "data-testid": "cx-add" }, on: { click: { action: "add" } } }, [icon("plus", "h-4 w-4", {}, { id: "cx-add-icon" }), text("{_'cx.add'}", { id: "cx-add-text" })]),
          n("button", { id: "cx-save-current", if: "$canSaveCurrent", attrs: { type: "button", class: "cx-btn", disabled: "=$full", "data-testid": "cx-save-current" }, on: { click: { action: "saveCurrent" } } }, [icon("save", "h-4 w-4", {}, { id: "cx-save-current-icon" }), text("{_'cx.saveCurrent'}", { id: "cx-save-current-text" })]),
        ]),
        n("paragraph", { id: "cx-empty", if: "($items|length) === 0", attrs: { class: "cx-empty", "data-testid": "cx-empty" }, text: "{_'cx.empty'}" }),
        n("list", { id: "cx-list", attrs: { class: "cx-list", "data-testid": "cx-list" } }, [item]),
      ]),
      n("slot", { id: "cx-edit-view", name: "The editor", slot: "edit", if: "$view === 'edit'" }),
      n("slot", { id: "cx-detail-view", name: "Statistics and log", slot: "detail", if: "$view === 'detail'" }),
      n("slot", { id: "cx-settings-view", name: "Settings", slot: "settings", if: "$view === 'settings'" }),
      n("slot", { id: "cx-share-view", name: "Share a connection", slot: "share", if: "$sharing" }),
    ]),
  ]);
}

/** EditView: a connection's editor. */
export function connectionEditTree(): LNode {
  const b = treeBuilder("ce");
  const { n, text, icon } = b;
  const field = (id: string, label: string, control: LNode, wide = false, tag: "label" | "panel" = "label") =>
    n(tag, { id, attrs: { class: `cx-field${wide ? " cx-field--wide" : ""}` } }, [n("area", { id: `${id}-label`, text: `{_'${label}'}` }), control]);
  const select = (id: string, value: string, action: string, options: LNode[], testid: string) =>
    n("select", { id, attrs: { value: `=${value}`, "data-testid": testid }, on: { change: { action } } }, options);
  return n("form", { id: "cx-form", name: "The editor", attrs: { class: "cx-form", "data-testid": "cx-form" }, on: { submit: { action: "save" } } }, [
    n("heading", { id: "cx-form-title", attrs: { class: "cx-form__title" }, text: "{=($editing ? 'cx.form.edit' : 'cx.form.new')|t}" }),
    n("panel", { id: "cx-grid", attrs: { class: "cx-grid" } }, [
      field("cx-f-label-field", "cx.form.label", n("input", { id: "cx-f-label", attrs: { value: "=$form.label", maxlength: "60", "data-testid": "cx-f-label" }, on: { change: { action: "field", arg: "'label'" } } })),
      n("panel", { id: "cx-f-color-field", attrs: { class: "cx-field" } }, [
        n("area", { id: "cx-f-color-label", text: "{_'cx.form.color'}" }),
        n("panel", { id: "cx-colors", attrs: { class: "cx-colors", role: "radiogroup", "aria-label": "{_'cx.form.color'}" } }, [
          n("button", {
            id: "cx-color", name: "A colour", each: "$colors", as: "c", key: "$c.key", css: { background: "{$c.bg}" },
            attrs: { type: "button", role: "radio", "aria-checked": "=$c.checked", class: "cx-color", "aria-label": "{$c.label}" },
            on: { click: { action: "color", arg: "$c.value" } },
          }, []),
        ]),
      ]),
      field("cx-f-room-field", "cx.form.room", n("input", { id: "cx-f-room", attrs: { value: "=$form.room", required: "=true", maxlength: "64", "data-testid": "cx-f-room", autocomplete: "off" }, on: { change: { action: "field", arg: "'room'" } } })),
      field("cx-f-name-field", "cx.form.userName", n("input", { id: "cx-f-name", attrs: { value: "=$form.userName", maxlength: "42", "data-testid": "cx-f-name" }, on: { change: { action: "field", arg: "'userName'" } } })),
      field("cx-f-key-field", "cx.form.passphrase", n("panel", { id: "cx-key", attrs: { class: "cx-key" } }, [
        n("input", { id: "cx-f-key", attrs: { type: "=$showKey ? 'text' : 'password'", "aria-label": "{_'cx.form.passphrase'}", value: "=$form.passphrase", required: "=true", "data-testid": "cx-f-key", autocomplete: "new-password", spellcheck: "false" }, on: { change: { action: "field", arg: "'passphrase'" } } }),
        n("button", { id: "cx-f-eye", attrs: { type: "button", class: "cx-icon", "aria-label": "{=($showKey ? 'cx.form.hide' : 'cx.form.show')|t}" }, on: { click: { action: "toggleKey" } } }, [
          icon("eye-off", "h-4 w-4", {}, { id: "cx-f-eye-off", if: "$showKey" }),
          icon("eye", "h-4 w-4", {}, { id: "cx-f-eye-on", if: "!$showKey" }),
        ]),
        n("button", { id: "cx-f-generate", attrs: { type: "button", class: "cx-btn", "data-testid": "cx-f-generate" }, on: { click: { action: "generate" } } }, [icon("refresh-cw", "h-4 w-4", {}, { id: "cx-f-generate-icon" }), text("{_'cx.form.generate'}", { id: "cx-f-generate-text" })]),
      ]), true, "panel"),
      n("label", { id: "cx-f-server-field", attrs: { class: "cx-field cx-field--wide" } }, [
        n("area", { id: "cx-f-server-label", text: "{_'cx.form.server'}" }),
        select("cx-f-server", "$serverValue", "server", [
          n("option", { id: "cx-f-server-this", attrs: { value: "" }, text: "{_'cx.thisServer'}" }),
          n("option", { id: "cx-f-server-option", each: "$servers", as: "s", key: "$s.id", attrs: { value: "{$s.url}" }, text: "{$s.label} — {$s.host}" }),
          n("option", { id: "cx-f-server-custom", if: "$allowCustom", attrs: { value: "__custom" }, text: "{_'cx.form.server.custom'}" }),
        ], "cx-f-server"),
        n("input", { id: "cx-f-server-url", if: "$custom", attrs: { placeholder: "{_'cx.form.server.url'}", value: "=$form.server", "data-testid": "cx-f-server-url" }, on: { change: { action: "field", arg: "'server'" }, blur: { action: "serverBlur" } } }),
        n("area", { id: "cx-f-server-hint", if: "$foreign", attrs: { class: "ap-hint" }, text: "{_'cx.form.server.hint'}" }),
      ]),
      field("cx-f-mode-field", "cx.form.mode", select("cx-f-mode", "$form.mode", "mode", [
        n("option", { id: "cx-f-mode-server", attrs: { value: "server" }, text: "Server-enhanced" }),
        n("option", { id: "cx-f-mode-light", attrs: { value: "light" }, text: "Light · P2P" }),
      ], "cx-f-mode")),
      field("cx-f-retention-field", "cx.form.retention", select("cx-f-retention", "$form.retention", "retention", [
        n("option", { id: "cx-f-retention-option", each: "$retentions", as: "r", key: "$r", attrs: { value: "{$r}" }, text: "{$r|t:'data.'}" }),
      ], "cx-f-retention")),
      field("cx-f-ttl-field", "cx.form.ttl", select("cx-f-ttl", "$ttlValue", "ttl", [
        n("option", { id: "cx-f-ttl-option", each: "$ttls", as: "o", key: "$o.value", attrs: { value: "=$o.value" }, text: "{$o.label}" }),
      ], "cx-f-ttl")),
      field("cx-f-keepalive-field", "cx.form.keepalive", select("cx-f-keepalive", "$form.keepalive", "keepalive", [
        n("option", { id: "cx-f-keepalive-option", each: "$keepalives", as: "k", key: "$k", attrs: { value: "{$k}" }, text: "{$k|t:'keepalive.'}" }),
      ], "cx-f-keepalive")),
    ]),
    n("panel", { id: "cx-f-switches", attrs: { class: "cx-switches" } }, [
      toggle(b, "cx-f-away-switch", { label: "{_'cx.form.away'}", hint: "{_'cx.form.away.hint'}", checked: "!$foreign && $form.away", disabled: "$foreign || $form.retention !== 'server'", testid: "cx-f-away", action: "check", arg: "'away'" }),
      toggle(b, "cx-f-notify-switch", { label: "{_'cx.form.notifications'}", checked: "$form.notifications", testid: "cx-f-notify", action: "check", arg: "'notifications'" }),
      toggle(b, "cx-f-reconnect-switch", { label: "{_'cx.form.autoReconnect'}", checked: "$form.autoReconnect", testid: "cx-f-reconnect", action: "check", arg: "'autoReconnect'" }),
    ]),
    n("paragraph", { id: "cx-error", if: "$error", attrs: { class: "cx-error", role: "alert", "data-testid": "cx-error" }, text: "{$error}" }),
    n("panel", { id: "cx-f-actions", attrs: { class: "cx-actions" } }, [
      n("button", { id: "cx-f-save", attrs: { type: "submit", class: "cx-btn cx-btn--primary", "data-testid": "cx-f-save" } }, [icon("save", "h-4 w-4", {}, { id: "cx-f-save-icon" }), text("{_'cx.form.save'}", { id: "cx-f-save-text" })]),
      n("button", { id: "cx-f-save-connect", attrs: { type: "button", class: "cx-btn", "data-testid": "cx-f-save-connect" }, on: { click: { action: "saveConnect" } } }, [icon("plug", "h-4 w-4", {}, { id: "cx-f-save-connect-icon" }), text("{_'cx.form.saveConnect'}", { id: "cx-f-save-connect-text" })]),
      n("button", { id: "cx-f-cancel", attrs: { type: "button", class: "cx-btn cx-btn--ghost" }, on: { click: { action: "cancel" } } }, [icon("undo-2", "h-4 w-4", {}, { id: "cx-f-cancel-icon" }), text("{_'cx.form.cancel'}", { id: "cx-f-cancel-text" })]),
    ]),
  ]);
}

/** DetailView: a connection's statistics and log. */
export function connectionDetailTree(): LNode {
  const { n, text, icon } = treeBuilder("cd");
  return n("panel", { id: "cx-detail", name: "Statistics and log", attrs: { class: "cx-detail", "data-testid": "cx-detail" } }, [
    n("panel", { id: "cx-detail-head", attrs: { class: "cx-detail__head" } }, [
      n("button", { id: "cx-detail-back", attrs: { type: "button", class: "cx-btn cx-btn--ghost" }, on: { click: { action: "back" } } }, [icon("undo-2", "h-4 w-4", {}, { id: "cx-detail-back-icon" }), text("{_'cx.log.back'}", { id: "cx-detail-back-text" })]),
      n("heading", { id: "cx-detail-title", attrs: { class: "cx-form__title" }, text: "{$label}" }),
      n("button", { id: "cx-detail-edit", attrs: { type: "button", class: "cx-icon", "aria-label": "{_'cx.edit'}" }, on: { click: { action: "edit" } } }, [icon("pencil", "h-4 w-4", {}, { id: "cx-detail-edit-icon" })]),
    ]),
    n("panel", { id: "cx-stats", name: "Statistics", attrs: { class: "cx-stats", "data-testid": "cx-stats" } }, [
      n("panel", { id: "cx-stat", name: "A number", each: "$tiles", as: "tl", key: "$tl.label", attrs: { class: "cx-stat" } }, [
        n("area", { id: "cx-stat-value", attrs: { class: "cx-stat__value" }, text: "{$tl.value}" }),
        n("area", { id: "cx-stat-label", attrs: { class: "cx-stat__label" }, text: "{$tl.label}" }),
      ]),
    ]),
    n("panel", { id: "cx-log-head", attrs: { class: "cx-log-head" } }, [
      n("heading", { id: "cx-log-title", tag: "h4", text: "{_'cx.log'}" }),
      n("panel", { id: "cx-log-filters", attrs: { class: "ap-seg", role: "radiogroup", "aria-label": "{_'cx.log'}" } }, [
        n("button", { id: "cx-log-filter", each: "$filters", as: "f", key: "$f", attrs: { type: "button", role: "radio", "aria-checked": "=$filter === $f", class: "ap-seg__btn", "data-testid": "cx-log-{$f}" }, on: { click: { action: "filter", arg: "$f" } }, text: "{$f|t:'cx.log.filter.'}" }),
      ]),
    ]),
    n("paragraph", { id: "cx-log-empty", if: "($shown|length) === 0", attrs: { class: "cx-empty" }, text: "{_'cx.log.empty'}" }),
    n("list", { id: "cx-log", tag: "ol", if: "($shown|length) > 0", attrs: { class: "cx-log", "data-testid": "cx-log" } }, [
      n("item", { id: "cx-log-row", name: "An event", each: "$shown", as: "e", key: "$e.key", attrs: { class: "cx-log__row is-{$e.event}" } }, [
        n("area", { id: "cx-log-time", tag: "time", attrs: { datetime: "{$e.iso}", title: "{$e.full}" }, text: "{$e.time}" }),
        n("area", { id: "cx-log-event", attrs: { class: "cx-log__event" }, text: "{$e.event|t:'cx.ev.'}" }),
        n("area", { id: "cx-log-detail", if: "$e.detail", attrs: { class: "cx-log__detail" }, text: "{$e.detail}" }),
      ]),
    ]),
    n("panel", { id: "cx-detail-actions", attrs: { class: "cx-actions" } }, [
      n("button", { id: "cx-export", attrs: { type: "button", class: "cx-btn", "data-testid": "cx-export" }, on: { click: { action: "export" } }, text: "{_'cx.log.export'}" }),
      n("button", { id: "cx-clear-log", attrs: { type: "button", class: "cx-btn cx-btn--danger", "data-testid": "cx-clear-log" }, on: { click: { action: "clearLog" } }, text: "{_'cx.log.clear'}" }),
    ]),
  ]);
}

/** SettingsView: the default connection and the comfort switches. */
export function connectionSettingsTree(): LNode {
  const b = treeBuilder("cs");
  const { n } = b;
  return n("panel", { id: "cx-settings", name: "Settings", attrs: { class: "cx-settings", "data-testid": "cx-settings" } }, [
    n("label", { id: "cx-s-default-field", attrs: { class: "cx-field" } }, [
      n("area", { id: "cx-s-default-label", text: "{_'cx.set.default'}" }),
      n("select", { id: "cx-s-default", attrs: { value: "=$defaultId", "data-testid": "cx-s-default" }, on: { change: { action: "default" } } }, [
        n("option", { id: "cx-s-default-none", attrs: { value: "" }, text: "{_'cx.set.default.none'}" }),
        n("option", { id: "cx-s-default-option", each: "$profiles", as: "p", key: "$p.id", attrs: { value: "{$p.id}" }, text: "{$p.label}" }),
      ]),
    ]),
    n("panel", { id: "cx-s-switches", attrs: { class: "cx-switches" } }, [
      toggle(b, "cx-s-autoconnect-switch", { label: "{_'cx.set.autoConnect'}", hint: "{_'cx.set.autoConnect.hint'}", checked: "$settings.autoConnect", testid: "cx-s-autoconnect", action: "setting", arg: "'autoConnect'" }),
      toggle(b, "cx-s-autoreconnect-switch", { label: "{_'cx.set.autoReconnect'}", checked: "$settings.autoReconnect", testid: "cx-s-autoreconnect", action: "setting", arg: "'autoReconnect'" }),
      toggle(b, "cx-s-resume-switch", { label: "{_'cx.set.reconnectOnResume'}", checked: "$settings.reconnectOnResume", testid: "cx-s-resume", action: "setting", arg: "'reconnectOnResume'" }),
      toggle(b, "cx-s-stats-switch", { label: "{_'cx.set.collectStats'}", hint: "{_'cx.set.collectStats.off'}", hintIf: "!$statsAllowed", checked: "$settings.collectStats", disabled: "!$statsAllowed", testid: "cx-s-stats", action: "setting", arg: "'collectStats'" }),
      toggle(b, "cx-s-quickswitch-switch", { label: "{_'cx.set.quickSwitch'}", checked: "$settings.quickSwitch", testid: "cx-s-quickswitch", action: "setting", arg: "'quickSwitch'" }),
      toggle(b, "cx-s-confirm-switch", { label: "{_'cx.set.confirmSwitch'}", checked: "$settings.confirmSwitch", testid: "cx-s-confirm", action: "setting", arg: "'confirmSwitch'" }),
    ]),
    n("paragraph", { id: "cx-s-storage", attrs: { class: "cx-intro" }, text: "{$storageText}" }),
  ]);
}

/* ------------------------------------------------------------ contracts */

type ConnId = "panel.connections" | "part.connectionEdit" | "part.connectionDetail" | "part.connectionSettings";

export const CONNECTION_CONTRACTS: Record<ConnId, LayoutContract> = {
  "panel.connections": {
    description: "My connections: before it can be used, the tabs and the list of saved connections.",
    vars: [
      { path: "$gate", type: "text", description: "Why it cannot be used: account (sign in), server (Server-enhanced is off), disabled — or empty." },
      { path: "$view", type: "text", description: "list, edit, detail or settings." }, { path: "$countText", type: "text", description: "“2 of 10”." },
      { path: "$full", type: "yes/no", description: "No more can be saved." }, { path: "$canSaveCurrent", type: "yes/no", description: "The room this tab is in can be saved." },
      { path: "$items", type: "list", description: "Saved connections: .id, .label, .room, .user, .host, .color, .isActive, .isDefault, .meta." },
      { path: "$canShare", type: "yes/no", description: "Invitations are on." }, { path: "$sharing", type: "yes/no", description: "A connection is being shared." },
    ],
    actions: [
      { name: "tab", description: "List or settings.", arg: "'list' or 'settings'" }, { name: "add", description: "A new connection." }, { name: "saveCurrent", description: "Save the room this tab is in." },
      { name: "connect", description: "Connect.", arg: "its id" }, { name: "disconnect", description: "Disconnect." }, { name: "edit", description: "Edit.", arg: "its id" },
      { name: "details", description: "Statistics and log.", arg: "its id" }, { name: "makeDefault", description: "The default one (or not).", arg: "its id" },
      { name: "share", description: "Share it.", arg: "its id" }, { name: "delete", description: "Delete it (asks first).", arg: "its id" }, { name: "enableServerMode", description: "Turn Server-enhanced on." },
    ],
    slots: [
      { name: "needSignIn", description: "“Sign in first”." }, { name: "edit", description: "The editor." }, { name: "detail", description: "Statistics and log." },
      { name: "settings", description: "Settings." }, { name: "share", description: "The “Share a connection” window." },
    ],
    refs: [],
  },
  "part.connectionEdit": {
    description: "A saved connection's editor.",
    vars: [
      { path: "$editing", type: "yes/no", description: "An existing one." }, { path: "$form", type: "object", description: ".label, .room, .userName, .passphrase, .server, .mode, .retention, .keepalive, .away, .notifications, .autoReconnect." },
      { path: "$colors", type: "list", description: "Colours: .key, .value, .bg, .label, .checked." }, { path: "$showKey", type: "yes/no", description: "The key is shown." },
      { path: "$servers", type: "list", description: "Other servers: .id, .url, .label, .host." }, { path: "$allowCustom", type: "yes/no", description: "A server of one's own may be typed." },
      { path: "$custom", type: "yes/no", description: "Typing a server." }, { path: "$serverValue", type: "text", description: "The server choice." }, { path: "$foreign", type: "yes/no", description: "Another server." },
      { path: "$retentions", type: "list", description: "History choices." }, { path: "$ttls", type: "list", description: "Lifetimes: .value, .label." }, { path: "$ttlValue", type: "text", description: "The lifetime." },
      { path: "$keepalives", type: "list", description: "Keeper strategies." }, { path: "$error", type: "text", description: "Why it cannot be saved." },
    ],
    actions: [
      { name: "field", description: "A field typed.", arg: "its name", event: "change" }, { name: "color", description: "A colour.", arg: "the colour" }, { name: "toggleKey", description: "Show / hide the key." },
      { name: "generate", description: "A new random key." }, { name: "server", description: "A server chosen.", event: "change" }, { name: "serverBlur", description: "Tidy a typed server address.", event: "blur" },
      { name: "mode", description: "The mode chosen.", event: "change" }, { name: "retention", description: "History chosen.", event: "change" }, { name: "ttl", description: "Lifetime chosen.", event: "change" },
      { name: "keepalive", description: "Strategy chosen.", event: "change" }, { name: "check", description: "A switch.", arg: "its name", event: "change" },
      { name: "save", description: "Save.", event: "submit" }, { name: "saveConnect", description: "Save and connect." }, { name: "cancel", description: "Back to the list." },
    ],
    slots: [], refs: [],
  },
  "part.connectionDetail": {
    description: "A saved connection's statistics and log.",
    vars: [
      { path: "$label", type: "text", description: "Its name." }, { path: "$tiles", type: "list", description: "Numbers: .label, .value." },
      { path: "$filters", type: "list", description: "Log filters." }, { path: "$filter", type: "text", description: "The filter chosen." },
      { path: "$shown", type: "list", description: "Events: .key, .iso, .full, .time, .event, .detail." },
    ],
    actions: [
      { name: "back", description: "Back to the list." }, { name: "edit", description: "Edit it." }, { name: "filter", description: "A filter.", arg: "all, session, people, files, errors" },
      { name: "export", description: "Download statistics and log (without the key)." }, { name: "clearLog", description: "Clear the log (asks first)." },
    ],
    slots: [], refs: [],
  },
  "part.connectionSettings": {
    description: "The default connection and the comfort switches.",
    vars: [
      { path: "$defaultId", type: "text", description: "The default connection." }, { path: "$profiles", type: "list", description: "The connections: .id, .label." },
      { path: "$settings", type: "object", description: ".autoConnect, .autoReconnect, .reconnectOnResume, .collectStats, .quickSwitch, .confirmSwitch." },
      { path: "$statsAllowed", type: "yes/no", description: "The operator allows statistics." }, { path: "$storageText", type: "text", description: "What is stored." },
    ],
    actions: [{ name: "default", description: "The default chosen.", event: "change" }, { name: "setting", description: "A switch.", arg: "its name", event: "change" }],
    slots: [], refs: [],
  },
};

export const CONNECTION_VARIANTS: Record<ConnId, ReadonlyArray<{ id: string; label: string }>> = {
  "panel.connections": [{ id: "list", label: "Saved connections" }, { id: "empty", label: "None yet" }, { id: "account", label: "Signed out" }, { id: "server", label: "Light · P2P" }],
  "part.connectionEdit": [{ id: "new", label: "A new one" }, { id: "edit", label: "Editing, another server" }],
  "part.connectionDetail": [{ id: "log", label: "Statistics and log" }],
  "part.connectionSettings": [{ id: "plain", label: "Settings" }],
};
