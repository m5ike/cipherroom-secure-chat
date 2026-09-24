// The Room window (4.13): its tabs in the window's head (Light · P2P /
// Server-enhanced) and its content — the saved connections to pick from, the
// fields typed in, Connect / Reconnect / Disconnect and the share part —
// drawn by RoomDialog.tsx, which keeps the choosing and connecting.

import { treeBuilder, type LNode } from "../layout-tree";
import type { LayoutContract } from "./contracts";

/** The tabs (RoomTabs), in the window's head in place of its title. */
export function roomTabsTree(): LNode {
  const { n, icon } = treeBuilder("rt");
  return n("panel", {
    id: "room-tabs", name: "Tabs",
    attrs: { class: "rd-tabs", role: "tablist", "aria-label": "{_'room.tabs'}", "data-testid": "room-tabs" },
    on: { keydown: { action: "tabKey" } },
  }, [
    n("button", {
      id: "room-tab", name: "Tab", each: "$tabs", as: "x", key: "$x.id",
      attrs: {
        type: "button", role: "tab", id: "rd-tab-{$x.id}", "aria-selected": "=$x.selected", "aria-controls": "rd-panel",
        tabindex: "=$x.selected ? 0 : -1", disabled: "=$x.disabled", title: "=$x.disabled ? ('room.locked'|t) : null", class: "rd-tab", "data-testid": "room-tab-{$x.id}",
      },
      on: { click: { action: "tab", arg: "$x.id" } },
    }, [
      icon("{$x.icon}", "rd-tab__icon", { "aria-hidden": "true" }, { id: "tab-icon" }),
      n("area", { id: "tab-long", name: "Long name", attrs: { class: "rd-tab__long" }, text: "{$x.long|t}" }),
      n("area", { id: "tab-short", name: "Short name", attrs: { class: "rd-tab__short", "aria-hidden": "true" }, text: "{$x.short|t}" }),
    ]),
  ]);
}

/** The window's content (RoomDialog). */
export function roomTree(): LNode {
  const { n, text, icon } = treeBuilder("rm");

  const savedItem = n("button", {
    id: "room-item", name: "A saved connection", each: "$items", as: "p", key: "$p.id",
    css: { "--cx-color": "{$p.color}" },
    attrs: {
      type: "button", role: "radio", "aria-checked": "=$p.checked", disabled: "=$p.disabled", class: "rd-item{if $p.live} is-live{/if}",
      "data-testid": "room-item", "data-id": "{$p.id}",
    },
    on: { click: { action: "pick", arg: "$p.id" } },
  }, [
    n("area", { id: "item-dot", name: "Colour dot", attrs: { class: "rd-item__dot", "aria-hidden": "true" } }, []),
    n("area", { id: "item-text", attrs: { class: "rd-item__text" } }, [
      n("area", { id: "item-label", name: "Label", attrs: { class: "rd-item__label" } }, [
        n("area", { id: "item-name", attrs: { class: "truncate" }, text: "{$p.label}" }),
        icon("star", "rd-item__star", { "aria-label": "{_'cx.default'}" }, { id: "item-default", if: "$p.isDefault" }),
      ]),
      n("area", { id: "item-sub", name: "Room · name · server", attrs: { class: "rd-item__sub" }, text: "{$p.room} · {$p.user} · {$p.host}" }),
    ]),
    n("area", { id: "item-meta", attrs: { class: "rd-item__meta" } }, [
      n("area", { id: "room-item-live", name: "Live", if: "$p.live", attrs: { class: "rd-live", "data-testid": "room-item-live" } }, [
        n("area", { id: "live-pulse", attrs: { class: "rd-live__pulse", "aria-hidden": "true" } }, []),
        text("{_'cx.active'}", { id: "live-text" }),
      ]),
      n("area", { id: "item-mode", name: "Mode", if: "!$p.live", attrs: { class: "rd-chip" }, text: "{=($p.mode === 'server' ? 'room.mode.server' : 'room.mode.light')|t}" }),
    ]),
    n("area", { id: "item-check", attrs: { class: "rd-item__check", "aria-hidden": "true" } }, [icon("check", "h-3.5 w-3.5", {}, { id: "item-check-icon" })]),
  ]);

  const saved = n("group", { id: "saved", name: "Saved connections", if: "$tab === 'server'" }, [
    n("slot", { id: "need-sign-in", name: "Sign in first", slot: "needSignIn", if: "!$signedIn" }),
    n("panel", { id: "room-disabled", name: "Switched off", if: "$signedIn && !$savedEnabled", attrs: { class: "rd-need", "data-testid": "room-disabled" } }, [
      n("area", { id: "disabled-icon", attrs: { class: "rd-need__icon", "aria-hidden": "true" } }, [icon("lock", "h-5 w-5", {}, { id: "disabled-lock" })]),
      n("area", { id: "disabled-text", attrs: { class: "rd-need__text" } }, [n("area", { id: "disabled-label", text: "{_'room.disabled'}" })]),
    ]),
    n("paragraph", { id: "room-loading", name: "Loading", if: "$signedIn && $savedEnabled && !$listed", attrs: { class: "rd-loading", "aria-busy": "true", "data-testid": "room-loading" }, text: "{_'room.saved.loading'}" }),
    n("panel", { id: "rd-saved", name: "The list", if: "$signedIn && $savedEnabled && $listed", attrs: { class: "rd-saved" } }, [
      n("panel", { id: "saved-head", attrs: { class: "rd-saved__head" } }, [
        n("area", { id: "saved-title", attrs: { class: "rd-saved__title" } }, [
          text("{_'room.saved.title'}", { id: "saved-title-text" }),
          n("area", { id: "saved-count", attrs: { class: "rd-count" }, text: "{$items|length}" }),
        ]),
        n("button", {
          id: "room-manage", name: "My connections",
          attrs: { type: "button", class: "rd-gear", title: "{_'room.saved.manage'}", "aria-label": "{_'room.saved.manage'}", "data-testid": "room-manage" },
          on: { click: { action: "manage" } },
        }, [icon("settings", "h-[1.1rem] w-[1.1rem]", { "aria-hidden": "true" }, { id: "manage-icon" })]),
      ]),
      n("panel", { id: "room-empty", name: "None yet", if: "($items|length) === 0", attrs: { class: "rd-empty", "data-testid": "room-empty" } }, [
        n("area", { id: "empty-icon", attrs: { class: "rd-empty__icon", "aria-hidden": "true" } }, [icon("plug", "h-5 w-5", {}, { id: "empty-plug" })]),
        n("area", { id: "empty-text", text: "{_'room.saved.empty'}" }),
        n("button", {
          id: "room-create", name: "Create one",
          attrs: { type: "button", class: "rd-btn rd-btn--soft", disabled: "=$locked", "data-testid": "room-create" },
          on: { click: { action: "create" } },
        }, [icon("plus", "h-4 w-4", { "aria-hidden": "true" }, { id: "create-icon" }), text("{_'room.saved.create'}", { id: "create-text" })]),
      ]),
      n("panel", { id: "room-list", name: "Choices", attrs: { class: "rd-list", role: "radiogroup", "aria-label": "{_'room.saved.list'}", "data-testid": "room-list" } }, [
        savedItem,
        n("button", {
          id: "room-item-manual", name: "Another room",
          attrs: { type: "button", role: "radio", "aria-checked": "=$selected === 'manual'", disabled: "=$locked && $selected !== 'manual'", class: "rd-item rd-item--manual", "data-testid": "room-item-manual" },
          on: { click: { action: "pick", arg: "'manual'" } },
        }, [
          n("area", { id: "manual-glyph", attrs: { class: "rd-item__glyph", "aria-hidden": "true" } }, [icon("pencil-line", "h-4 w-4", {}, { id: "manual-icon" })]),
          n("area", { id: "manual-text", attrs: { class: "rd-item__text" } }, [
            n("area", { id: "manual-label", attrs: { class: "rd-item__label" }, text: "{_'room.manual'}" }),
            n("area", { id: "manual-sub", attrs: { class: "rd-item__sub rd-item__sub--plain" }, text: "{_'room.manual.hint'}" }),
          ]),
          n("area", { id: "manual-check", attrs: { class: "rd-item__check", "aria-hidden": "true" } }, [icon("check", "h-3.5 w-3.5", {}, { id: "manual-check-icon" })]),
        ]),
      ]),
    ]),
  ]);

  const field = (id: string, label: string, input: LNode, wide = false) =>
    n("label", { id: `field-${id}`, name: label, attrs: { class: wide ? "rd-field rd-field--wide" : "rd-field" } }, [n("area", { id: `field-${id}-label`, text: `{_'${label}'}` }), input]);
  const manual = n("panel", { id: "room-manual-fields", name: "Typed in", if: "$manual", attrs: { class: "rd-fields", "data-testid": "room-manual-fields" } }, [
    field("name", "join.name", n("input", {
      id: "input-name", attrs: { "data-testid": "input-name", class: "rd-input", value: "=$fields.name", disabled: "=$locked", maxlength: "42" },
      on: { change: { action: "fieldName" } },
    })),
    field("room", "join.room", n("input", {
      id: "input-room", attrs: { "data-testid": "input-room", class: "rd-input rd-input--mono", value: "=$fields.room", disabled: "=$locked", maxlength: "48" },
      on: { change: { action: "fieldRoom" } },
    })),
    field("key", "join.passphrase", n("area", { id: "rd-key", attrs: { class: "rd-key" } }, [
      n("input", {
        id: "input-passphrase",
        attrs: { "data-testid": "input-passphrase", class: "rd-input", value: "=$fields.passphrase", disabled: "=$locked", type: "=$showKey ? 'text' : 'password'", autocomplete: "new-password", spellcheck: "false" },
        on: { change: { action: "fieldKey" } },
      }),
      n("button", {
        id: "room-key-toggle", name: "Show / hide the key",
        attrs: {
          type: "button", class: "rd-eye", "aria-label": "{=($showKey ? 'cx.form.hide' : 'cx.form.show')|t}", title: "{=($showKey ? 'cx.form.hide' : 'cx.form.show')|t}",
          "aria-pressed": "=$showKey", "data-testid": "room-key-toggle",
        },
        on: { click: { action: "toggleKey" } },
      }, [
        icon("eye-off", "h-4 w-4", { "aria-hidden": "true" }, { id: "key-hide", if: "$showKey" }),
        icon("eye", "h-4 w-4", { "aria-hidden": "true" }, { id: "key-show", if: "!$showKey" }),
      ]),
    ]), true),
  ]);

  return n("panel", { id: "rd", name: "Room window", attrs: { class: "rd", "data-tab": "{$tab}" } }, [
    n("form", { id: "form-join", name: "Form", attrs: { "data-testid": "form-join", autocomplete: "off", class: "rd-form" }, on: { submit: { action: "submit" } } }, [
      n("panel", {
        id: "rd-panel", name: "Tab content",
        attrs: { role: "tabpanel", id: "rd-panel", "aria-labelledby": "rd-tab-{$tab}", class: "rd-panel", "data-testid": "room-panel-{$tab}" },
      }, [
        n("paragraph", { id: "rd-hint", name: "Hint", attrs: { class: "rd-hint" }, text: "{=($tab === 'light' ? 'room.hint.light' : 'room.hint.server')|t}" }),
        saved,
        manual,
        n("paragraph", { id: "room-locked", name: "Locked while connected", if: "$locked", attrs: { class: "rd-locked", "data-testid": "room-locked" } }, [
          icon("lock", "h-3.5 w-3.5 flex-none", { "aria-hidden": "true" }, { id: "locked-icon" }),
          text("{_'room.locked'}", { id: "locked-text" }),
        ]),
      ]),
      n("panel", { id: "rd-actions", name: "Buttons", attrs: { class: "rd-actions" } }, [
        n("button", {
          id: "button-connect", name: "Connect / Reconnect",
          attrs: { "data-testid": "button-connect", type: "submit", class: "rd-btn rd-btn--primary", disabled: "=$busy || ($needsSignIn && !$joined)" },
        }, [
          icon("refresh-cw", "h-4 w-4 flex-none", { "aria-hidden": "true" }, { id: "connect-again", if: "$joined" }),
          icon("radio", "h-4 w-4 flex-none", { "aria-hidden": "true" }, { id: "connect-icon", if: "!$joined" }),
          n("area", { id: "connect-label", attrs: { class: "truncate" }, text: "{$connectLabel}" }),
        ]),
        n("button", {
          id: "button-disconnect", name: "Disconnect", if: "$locked",
          attrs: { type: "button", "data-testid": "button-disconnect", class: "rd-btn" },
          on: { click: { action: "disconnect" } },
        }, [icon("log-out", "h-4 w-4 flex-none", { "aria-hidden": "true" }, { id: "disconnect-icon" }), text("{_'common.disconnect'}", { id: "disconnect-text" })]),
      ]),
    ]),
    n("panel", { id: "rd-share", name: "Share this room", attrs: { class: "rd-share" } }, [n("slot", { id: "share", name: "Share this room", slot: "share" })]),
  ]);
}

/* ------------------------------------------------------------ contracts */

export const ROOM_CONTRACTS: Record<"room.tabs" | "room", LayoutContract> = {
  "room.tabs": {
    description: "The Room window's tabs — Light · P2P and Server-enhanced — in the window's head.",
    vars: [
      { path: "$tabs", type: "list", description: "The tabs: .id (light / server), .icon, .long / .short (translation keys), .selected, .disabled (locked while connected)." },
      { path: "$locked", type: "yes/no", description: "A connection is up: the other tab cannot be chosen." },
    ],
    actions: [
      { name: "tab", description: "Choose a tab.", arg: "its id" },
      { name: "tabKey", description: "Arrow keys move between the tabs.", event: "keydown" },
    ],
    slots: [],
    refs: [],
  },
  room: {
    description: "The Room window: saved connections to pick from or a room typed in, and Connect / Reconnect / Disconnect.",
    vars: [
      { path: "$tab", type: "text", description: "light or server." },
      { path: "$locked", type: "yes/no", description: "Connected (or connecting): nothing can be switched." },
      { path: "$joined", type: "yes/no", description: "In the room: the button reconnects." },
      { path: "$busy", type: "yes/no", description: "Deriving the key or opening the connection." },
      { path: "$signedIn", type: "yes/no", description: "Signed in with a passkey." },
      { path: "$savedEnabled", type: "yes/no", description: "The operator allows saved connections." },
      { path: "$listed", type: "yes/no", description: "The saved connections are loaded (the vault is open)." },
      { path: "$needsSignIn", type: "yes/no", description: "Server-enhanced while signed out: nothing to connect." },
      { path: "$manual", type: "yes/no", description: "The room is typed in (Light, or “another room”)." },
      { path: "$items", type: "list", description: "The saved connections: .id, .label, .room, .user, .host, .mode, .color, .isDefault, .checked, .disabled, .live." },
      { path: "$selected", type: "text", description: "The chosen connection's id, or manual." },
      { path: "$fields", type: "object", description: "What is typed in: .name, .room, .passphrase." },
      { path: "$showKey", type: "yes/no", description: "The key is shown." },
      { path: "$connectLabel", type: "text", description: "Connect / Connect to … / Reconnect." },
    ],
    actions: [
      { name: "submit", description: "Connect (or reconnect).", event: "submit" },
      { name: "disconnect", description: "Disconnect." },
      { name: "pick", description: "Choose a saved connection (or manual).", arg: "its id" },
      { name: "manage", description: "Open My connections." },
      { name: "create", description: "Create a saved connection." },
      { name: "fieldName", description: "The name typed.", event: "change" },
      { name: "fieldRoom", description: "The room typed.", event: "change" },
      { name: "fieldKey", description: "The key typed.", event: "change" },
      { name: "toggleKey", description: "Show / hide the key." },
    ],
    slots: [
      { name: "needSignIn", description: "“Sign in first” (Server-enhanced, signed out)." },
      { name: "share", description: "Share this room (always below)." },
    ],
    refs: [],
  },
};

export const ROOM_VARIANTS: Record<"room.tabs" | "room", ReadonlyArray<{ id: string; label: string }>> = {
  "room.tabs": [{ id: "light", label: "Light · P2P" }, { id: "server", label: "Server-enhanced" }, { id: "locked", label: "Connected (locked)" }],
  room: [
    { id: "light", label: "Light · P2P" },
    { id: "saved", label: "Saved connections" },
    { id: "empty", label: "No saved connection yet" },
    { id: "connected", label: "Connected (locked)" },
    { id: "signedout", label: "Server-enhanced, signed out" },
  ],
};
