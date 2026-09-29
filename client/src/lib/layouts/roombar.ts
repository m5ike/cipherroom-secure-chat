// The room bar (6.0): every room the person keeps connected — the one on
// screen and those in the background (lib/room-hub.ts) — as chips with the
// number of people and of unread messages; a tap switches, × disconnects,
// + keeps one more room connected. Drawn by components/RoomBar.tsx.

import { treeBuilder, type LNode } from "../layout-tree";
import type { LayoutContract } from "./contracts";

export function roomBarTree(): LNode {
  const { n, text, icon } = treeBuilder("rb");
  const chip = n("panel", {
    id: "rb-room", name: "A room", each: "$rooms", as: "r", key: "$r.key",
    attrs: { class: "rb-chip{if $r.active} is-active{/if}{if $r.unread > 0 && !$r.active} has-unread{/if}", "data-testid": "rb-room", "data-key": "{$r.key}", role: "presentation" },
  }, [
    n("button", {
      id: "rb-switch", name: "Switch to it",
      attrs: { type: "button", class: "rb-chip__main", role: "tab", "aria-selected": "=$r.active", title: "{$r.label} · {=('rooms.bar.status.' ~ $r.status)|t}", "data-testid": "rb-switch" },
      on: { click: { action: "switchRoom", arg: "$r.key" } },
    }, [
      n("area", { id: "rb-dot", name: "Status", attrs: { class: "rb-dot rb-dot--{$r.status}", "aria-hidden": "true" } }, []),
      n("area", { id: "rb-label", name: "Name", attrs: { class: "rb-label truncate" }, text: "{$r.label}" }),
      n("area", {
        id: "rb-users", name: "People", if: "$r.users > 0",
        attrs: { class: "rb-badge", title: "{_'rooms.bar.users'}", "aria-label": "{$r.users} {_'rooms.bar.users'}" },
      }, [icon("users", "rb-badge__icon", { "aria-hidden": "true" }, { id: "rb-users-icon" }), text("{$r.users}", { id: "rb-users-n" })]),
      n("area", {
        id: "rb-unread", name: "Unread", if: "$r.unread > 0 && !$r.active",
        attrs: { class: "rb-badge rb-badge--unread", title: "{_'rooms.bar.unread'}", "aria-label": "{$r.unread} {_'rooms.bar.unread'}", "data-testid": "rb-unread" },
      }, [icon("message-circle", "rb-badge__icon", { "aria-hidden": "true" }, { id: "rb-unread-icon" }), text("{$r.unread}", { id: "rb-unread-n" })]),
    ]),
    n("button", {
      id: "rb-close", name: "Disconnect",
      attrs: { type: "button", class: "rb-chip__close", title: "{_'rooms.bar.close'}", "aria-label": "{_'rooms.bar.close'} {$r.label}", "data-testid": "rb-close" },
      on: { click: { action: "closeRoom", arg: "$r.key" } },
    }, [icon("x", "h-3.5 w-3.5", { "aria-hidden": "true" }, { id: "rb-close-icon" })]),
  ]);
  return n("panel", {
    id: "room-bar", name: "Room bar",
    attrs: { class: "rb-bar", role: "tablist", "aria-label": "{_'rooms.bar.label'}", "data-testid": "room-bar" },
    on: { keydown: { action: "barKey" } },
  }, [
    chip,
    n("button", {
      id: "rb-add", name: "Keep one more room", if: "$canAdd && !$adding",
      attrs: { type: "button", class: "rb-add", title: "{_'rooms.bar.add'}", "aria-label": "{_'rooms.bar.add'}", "data-testid": "rb-add" },
      on: { click: { action: "addOpen" } },
    }, [icon("plus", "h-4 w-4", { "aria-hidden": "true" }, { id: "rb-add-icon" })]),
    n("form", {
      id: "rb-form", name: "Another room", if: "$adding",
      attrs: { class: "rb-form", "data-testid": "rb-form" },
      on: { submit: { action: "addSubmit" } },
    }, [
      n("input", { id: "rb-room-input", name: "Room", attrs: { class: "rb-input", placeholder: "{_'rooms.bar.room'}", value: "=$fields.room", maxlength: "48", required: "=true", autofocus: "=true", "aria-label": "{_'rooms.bar.room'}", "data-testid": "rb-room-input" }, on: { input: { action: "fieldRoom" } } }),
      n("input", { id: "rb-key-input", name: "Key", attrs: { class: "rb-input", type: "password", placeholder: "{_'rooms.bar.key'}", value: "=$fields.passphrase", required: "=true", autocomplete: "off", "aria-label": "{_'rooms.bar.key'}", "data-testid": "rb-key-input" }, on: { input: { action: "fieldKey" } } }),
      n("button", { id: "rb-submit", name: "Connect", attrs: { type: "submit", class: "rb-btn rb-btn--primary", "data-testid": "rb-submit" } }, [text("{_'rooms.bar.connect'}", { id: "rb-submit-text" })]),
      n("button", { id: "rb-cancel", name: "Cancel", attrs: { type: "button", class: "rb-btn" }, on: { click: { action: "addCancel" } } }, [text("{_'rooms.bar.cancel'}", { id: "rb-cancel-text" })]),
    ]),
    n("area", { id: "rb-full", name: "At the limit", if: "!$canAdd && !$adding && ($rooms|length) > 1", attrs: { class: "rb-note" }, text: "{_'rooms.bar.full'}" }),
  ]);
}

export const ROOM_BAR_CONTRACT: LayoutContract = {
  description: "The room bar: the rooms kept connected at once (the one on screen and those in the background), with people and unread counts.",
  vars: [
    { path: "$rooms", type: "list", description: "The rooms: .key, .label, .users (people, us included), .unread, .active (on screen), .status (joined / connecting / deriving / offline / mismatch)." },
    { path: "$adding", type: "yes/no", description: "The form for another room is open." },
    { path: "$fields", type: "object", description: "What is typed in the form: .room, .passphrase." },
    { path: "$canAdd", type: "yes/no", description: "Another room may be kept (below the limit)." },
    { path: "$unreadTotal", type: "number", description: "Unread messages in the background rooms together." },
  ],
  actions: [
    { name: "switchRoom", description: "Put a room on screen (the one there goes to the background).", arg: "its key" },
    { name: "closeRoom", description: "Disconnect a room.", arg: "its key" },
    { name: "addOpen", description: "Open the form for another room." },
    { name: "addCancel", description: "Close the form." },
    { name: "addSubmit", description: "Keep the typed room connected in the background.", event: "submit" },
    { name: "fieldRoom", description: "The room typed.", event: "input" },
    { name: "fieldKey", description: "The key typed.", event: "input" },
    { name: "barKey", description: "Arrow keys move between the rooms.", event: "keydown" },
  ],
  slots: [],
  refs: [],
};

export const ROOM_BAR_VARIANTS = [
  { id: "rooms", label: "Three rooms, unread in the background" },
  { id: "one", label: "Only the room on screen" },
  { id: "adding", label: "Adding another room" },
  { id: "states", label: "Connecting, offline, wrong key" },
];
