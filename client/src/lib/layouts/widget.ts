// The recipients widget as layout trees — the floating panel and its
// minimised button — drawn by RecipientsWidget.tsx (which keeps dragging,
// docking and the settings to itself).

import { treeBuilder, type LNode } from "../layout-tree";

export function widgetTree(): LNode {
  const { n, text, icon } = treeBuilder("w");
  const peerRow = n("item", {
    id: "peer", name: "Person", each: "$peers", as: "p", key: "$p.id",
    attrs: { class: "recip-row{if !$p.reachable} is-offline{/if}{if $p.away} is-away{/if}", "data-testid": "recip-{$p.id}" },
  }, [
    n("avatar", { id: "peer-avatar", props: { name: "{$p.name}", avatar: "{$p.avatar}", size: "26" } }),
    n("area", { id: "peer-name", attrs: { class: "recip-name" } }, [
      text("{$p.name}", { id: "peer-name-text" }),
      n("area", { id: "peer-away", if: "$p.away", attrs: { class: "recip-away-tag" } }, [icon("moon", "h-3 w-3", {}, { id: "peer-away-icon" }), text("{_'away.badge'}", { id: "peer-away-text" })]),
      text(" · {_'recipients.offline'}", { id: "peer-offline", if: "!$p.away && !$p.online" }),
    ]),
    n("area", {
      id: "latency", name: "Latency", attrs: { class: "lat-meter lat-{$p.tone}", title: "{$p.rttTitle}", "aria-hidden": "true" },
    }, [
      n("area", { id: "latency-bar", each: "$p.bars", as: "b", attrs: { class: "lat-bar {if $b.on}on{/if}" }, css: { height: "{$b.height}" } }),
    ]),
    n("button", { id: "peer-info", attrs: { type: "button", class: "recip-info", "aria-label": "{_'userstyle.info'}" }, on: { click: { action: "peerInfo", arg: "$p.id" } } }, [icon("info", "h-4 w-4", {}, { id: "peer-info-icon" })]),
    n("button", {
      id: "peer-check", name: "Receives",
      attrs: {
        type: "button", class: "recip-check {if $p.checked}on{else}off{/if}", "aria-pressed": "=$p.checked", disabled: "=$p.disabled",
        "data-testid": "recip-check-{$p.id}", "aria-label": "{if $p.checked}{_'recipients.receiving'}{else}{_'recipients.excluded'}{/if}",
      },
      on: { click: { action: "togglePeer", arg: "$p.id" } },
    }, [icon("{if $p.checked}check{else}x{/if}", "h-4 w-4", {}, { id: "peer-check-icon" })]),
  ]);

  const configRow = n("label", { id: "cfg-row", name: "Setting", each: "$configRows", as: "row", key: "$row.key", attrs: { class: "recip-cfg-row" } }, [
    n("area", { id: "cfg-label", text: "{$row.label}" }),
    n("area", { id: "cfg-control", attrs: { class: "flex items-center gap-2" } }, [
      n("input", { id: "cfg-range", attrs: { type: "range", min: "=$row.min", max: "=$row.max", step: "=$row.step", value: "=$row.value" }, on: { change: { action: "configChange", arg: "$row.key" } } }),
      n("area", { id: "cfg-value", attrs: { class: "recip-cfg-val" }, text: "{$row.display}" }),
    ]),
  ]);

  const colorRow = n("label", { id: "cfg-color", name: "Colour", attrs: { class: "recip-cfg-row" } }, [
    n("area", { id: "cfg-color-label", text: "{_'recipients.cfg.color'}" }),
    n("area", { id: "cfg-color-control", attrs: { class: "flex items-center gap-2" } }, [
      n("input", { id: "cfg-color-input", attrs: { type: "color", class: "h-6 w-8 rounded border-0 bg-transparent p-0", value: "=$accentValue" }, on: { change: { action: "accentChange" } } }),
      n("button", { id: "cfg-color-reset", if: "$accent", attrs: { type: "button", class: "text-[10px] underline" }, text: "{_'userstyle.default'}", on: { click: { action: "accentReset" } } }),
    ]),
  ]);

  return n("panel", {
    id: "widget", name: "Recipients widget", styleBind: "$appearance",
    attrs: { class: "recip-widget{if $locked} is-locked{/if}", "data-testid": "recip-widget", role: "group", "aria-label": "{$title}" },
  }, [
    n("panel", { id: "head", name: "Head (drag)", attrs: { class: "recip-widget__head", "data-testid": "recip-drag" }, on: { pointerdown: { action: "startDrag" } } }, [
      icon("lock", "h-4 w-4 opacity-70", {}, { id: "head-lock", if: "$locked" }),
      icon("grip-horizontal", "h-4 w-4 opacity-60", {}, { id: "head-grip", if: "!$locked" }),
      n("area", { id: "title", name: "Title", attrs: { class: "recip-widget__title" }, text: "{$title}" }),
      n("button", {
        id: "btn-config", name: "Settings",
        attrs: { type: "button", class: "recip-widget__min", "aria-label": "{_'recipients.settings'}", title: "{_'recipients.settings'}", "data-testid": "recip-config-toggle" },
        on: { click: { action: "toggleConfig" } },
      }, [icon("settings-2", "h-4 w-4", {}, { id: "btn-config-icon" })]),
      n("button", {
        id: "btn-lock", name: "Dock",
        attrs: {
          type: "button", class: "recip-widget__min",
          "aria-label": "{if $locked}{_'recipients.unlock'}{else}{_'recipients.lock'}{/if}", title: "{if $locked}{_'recipients.unlock'}{else}{_'recipients.lock'}{/if}",
          "data-testid": "recip-lock",
        },
        on: { click: { action: "toggleLock" } },
      }, [icon("{if $locked}lock-open{else}lock{/if}", "h-4 w-4", {}, { id: "btn-lock-icon" })]),
      n("button", { id: "btn-min", name: "Minimise", attrs: { type: "button", class: "recip-widget__min", "aria-label": "{_'recipients.minimize'}" }, on: { click: { action: "minimize" } } }, [icon("minus", "h-4 w-4", {}, { id: "btn-min-icon" })]),
    ]),
    n("panel", { id: "config", name: "Settings", if: "$showConfig", attrs: { class: "recip-config", "data-testid": "recip-config" } }, [configRow, colorRow]),
    n("panel", { id: "body", name: "Body", attrs: { class: "recip-widget__body" } }, [
      n("paragraph", { id: "empty", name: "Nobody here", if: "!$hasPeers", attrs: { class: "recip-empty" }, text: "{_'recipients.nopeers'}" }),
      n("list", { id: "list", name: "People", if: "$hasPeers", attrs: { class: "recip-list" } }, [peerRow]),
      n("panel", { id: "room", name: "Room row", attrs: { class: "recip-room", "data-testid": "recip-room" } }, [
        icon("radio", "h-4 w-4 opacity-80", {}, { id: "room-icon" }),
        n("area", { id: "room-name", attrs: { class: "recip-name" }, text: "{_'recipients.room'}{if $room} · {$room}{/if}" }),
        n("button", { id: "room-info", attrs: { type: "button", class: "recip-info", "aria-label": "{_'recipients.roominfo'}" }, on: { click: { action: "roomInfo" } } }, [icon("info", "h-4 w-4", {}, { id: "room-info-icon" })]),
        n("button", {
          id: "room-auto", name: "Everyone",
          attrs: { type: "button", class: "recip-check {if $autoRoom}on{else}off{/if}", "aria-pressed": "=$autoRoom", "data-testid": "recip-auto", "aria-label": "{_'recipients.autoall'}" },
          on: { click: { action: "toggleAuto" } },
        }, [icon("{if $autoRoom}check{else}x{/if}", "h-4 w-4", {}, { id: "room-auto-icon" })]),
      ]),
      n("panel", { id: "actions", name: "Select all / none", if: "!$autoRoom", attrs: { class: "recip-actions" } }, [
        n("button", { id: "select-all", attrs: { type: "button" }, text: "{_'recipients.all'}", on: { click: { action: "selectAll" } } }),
        n("button", { id: "select-none", attrs: { type: "button" }, text: "{_'recipients.clear'}", on: { click: { action: "selectNone" } } }),
      ]),
    ]),
  ]);
}

export function widgetFabTree(): LNode {
  const { n, icon } = treeBuilder("f");
  return n("button", {
    id: "fab", name: "Recipients button", styleBind: "$pos",
    attrs: { type: "button", class: "recip-fab", "data-testid": "recip-fab", title: "{$title}", "aria-label": "{$title}" },
    on: { pointerdown: { action: "fabDrag" }, click: { action: "fabClick" } },
  }, [
    icon("users", "h-5 w-5", {}, { id: "fab-icon" }),
    n("area", { id: "fab-count", name: "Count", attrs: { class: "recip-fab__count" }, text: "{$count}" }),
  ]);
}
