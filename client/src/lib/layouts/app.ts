// The app bar, the chat window and the composer as layout trees, drawn by
// App.tsx with its data, actions and live parts (the menu, the signed-in
// badge, file cards, messages, the recorder, the send options).

import { treeBuilder, type LNode } from "../layout-tree";

export function headerTree(): LNode {
  const { n, icon } = treeBuilder("h");
  return n("panel", {
    id: "header", name: "App bar", tag: "header",
    attrs: { class: "toolbar relative flex min-h-[3rem] flex-wrap items-center gap-2 border-b border-border bg-card/85 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-card/70 sm:px-4" },
  }, [
    n("button", {
      id: "brand", name: "Brand (opens the Room window)",
      attrs: { type: "button", "aria-label": "{_'menu.room'}", class: "inline-flex items-center gap-2 rounded-2xl px-2 py-1 hover:bg-accent", "data-testid": "button-brand" },
      on: { click: { action: "openRoom" } },
    }, [
      n("logo", { id: "brand-logo", props: { size: "32" }, attrs: { class: "text-primary" } }),
      n("panel", { id: "brand-text", attrs: { class: "hidden text-left sm:block" } }, [
        n("panel", { id: "brand-name", attrs: { class: "text-sm font-bold leading-tight" }, text: "{_'app.name'}" }),
        n("panel", { id: "brand-tagline", attrs: { class: "text-[11px] leading-tight text-muted-foreground" }, text: "{_'app.tagline'}" }),
      ]),
    ]),
    n("area", {
      id: "status", name: "Connection status",
      attrs: {
        "data-testid": "status-connection",
        title: "{$statusTitle}",
        class: "ml-2 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors {if $status == 'joined'}border-emerald-500/40 bg-emerald-500/10{elseif $status == 'offline'}border-amber-500/40 bg-amber-500/10{else}border-border bg-background{/if}",
      },
    }, [
      icon("wifi", "h-3.5 w-3.5 text-emerald-500", {}, { id: "status-online", if: "$status == 'joined'" }),
      icon("wifi-off", "h-3.5 w-3.5 text-muted-foreground", {}, { id: "status-offline", if: "$status != 'joined'" }),
      n("area", {
        id: "status-text", attrs: { class: "hidden sm:inline" },
        text: "{if $status == 'joined'}{$openPeerCount} P2P · {if $reconnectPending}reconnect-pending{else}{$room}{/if}{elseif $status == 'offline'}{_'status.offline'} · auto-reconnect{else}{$status|t:'status.'}{/if}",
      }),
      n("area", { id: "status-count", if: "$status == 'joined'", attrs: { class: "sm:hidden" }, text: "{$openPeerCount}" }),
    ]),
    n("label", { id: "switcher", name: "Connection switcher", if: "$showSwitcher", attrs: { class: "cx-switcher", title: "{_'cx.switch.label'}", "data-testid": "cx-switcher" } }, [
      icon("plug", "h-3.5 w-3.5 shrink-0", { "aria-hidden": "true" }, { id: "switcher-icon" }),
      n("area", { id: "switcher-label", attrs: { class: "sr-only" }, text: "{_'cx.switch.label'}" }),
      n("select", { id: "switcher-select", attrs: { value: "=$activeProfileId", "data-testid": "cx-switcher-select" }, on: { change: { action: "switchProfile" } } }, [
        n("option", { id: "switcher-none", attrs: { value: "" }, text: "—" }),
        n("option", { id: "switcher-profile", each: "$profiles", as: "p", key: "$p.id", attrs: { value: "{$p.id}" }, text: "{$p.label}" }),
      ]),
    ]),
    n("slot", { id: "signed-in", name: "Signed-in badge", slot: "signedIn" }),
    n("slot", { id: "menu", name: "Menu (Menu builder)", slot: "menu" }),
    n("button", {
      id: "fullscreen", name: "Fullscreen", if: "$showFullscreen",
      attrs: {
        type: "button",
        "aria-label": "{if $fullscreen}{_'ap.device.exitFullscreen'}{else}{_'ap.device.enterFullscreen'}{/if}",
        title: "{if $fullscreen}{_'ap.device.exitFullscreen'}{else}{_'ap.device.enterFullscreen'}{/if}",
        class: "inline-flex items-center justify-center rounded-2xl hover:bg-accent",
        "data-testid": "btn-toolbar-fullscreen",
      },
      on: { click: { action: "toggleFullscreen" } },
    }, [icon("{if $fullscreen}minimize-2{else}maximize-2{/if}", "h-4 w-4", {}, { id: "fullscreen-icon" })]),
  ]);
}

export function chatTree(): LNode {
  const { n, text, icon } = treeBuilder("c");
  const pill = "ml-1 inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 hover:bg-accent";
  const earlier = (id: string, cond: string) => n("button", {
    id, name: "Show earlier", if: cond,
    attrs: { type: "button", "data-testid": "button-show-earlier", class: "show-earlier" }, text: "{$showEarlierText}",
    on: { click: { action: "showEarlier" } },
  });
  return n("panel", { id: "main", name: "Chat window", tag: "main", attrs: { class: "relative flex flex-1 min-h-0 flex-col chat-canvas" } }, [
    n("panel", { id: "column", attrs: { class: "flex flex-1 min-h-0 flex-col" } }, [
      n("panel", { id: "dock", name: "Info bar", ref: "dock", attrs: { "data-layout-hide": "focus", class: "flex-shrink-0 border-b border-border bg-card/60 px-3 py-2 sm:px-4" } }, [
        n("panel", { id: "dock-row", attrs: { class: "flex items-center justify-between gap-3 text-xs" } }, [
          n("paragraph", { id: "notice", name: "Notice", attrs: { "data-testid": "text-notice", class: "truncate text-muted-foreground" }, text: "{$notice}" }),
          n("panel", { id: "dock-info", attrs: { class: "flex items-center gap-2 font-mono text-[11px] text-muted-foreground" } }, [
            n("area", { id: "dock-room", text: "{if $room}room:{$room}{else}{_'status.idle'}{/if}" }),
            n("area", { id: "dock-dot", attrs: { class: "hidden sm:inline" }, text: "·" }),
            n("area", { id: "dock-id", attrs: { class: "hidden sm:inline" }, text: "{$myIdShort}" }),
            n("button", {
              id: "disconnect", name: "Disconnect", if: "$connected",
              attrs: { type: "button", "data-testid": "button-disconnect-bar", class: pill }, on: { click: { action: "disconnect" } },
            }, [icon("log-out", "h-3 w-3", {}, { id: "disconnect-icon" }), text("{_'common.disconnect'}", { id: "disconnect-text" })]),
            n("button", { id: "copy", name: "Copy room", attrs: { type: "button", class: pill }, on: { click: { action: "copyRoom" } } }, [
              icon("copy", "h-3 w-3", {}, { id: "copy-icon" }),
              text("{if $copied}{_'common.copied'}{else}{_'common.copy'}{/if}", { id: "copy-text" }),
            ]),
          ]),
        ]),
      ]),
      n("panel", { id: "messages", name: "Conversation", attrs: { "data-testid": "list-messages", class: "flex-1 overflow-y-auto chat-surface p-3 sm:p-5" } }, [
        n("panel", { id: "transfers", name: "File transfers", if: "$transfers", attrs: { class: "mx-auto mb-4 grid w-full max-w-4xl grid-cols-1 gap-2 md:grid-cols-2" } }, [
          n("slot", { id: "transfer", name: "File card", slot: "transfer", each: "$transfers", as: "tr", key: "$tr.id", arg: "$tr" }),
        ]),
        n("panel", { id: "empty", name: "Empty chat", if: "$empty", attrs: { class: "flex h-full min-h-[60dvh] items-center justify-center" } }, [
          n("panel", { id: "empty-card", attrs: { class: "max-w-md rounded-3xl border border-border bg-card/90 p-6 text-center shadow-sm" } }, [
            n("panel", { id: "empty-icon", attrs: { class: "mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary" } }, [icon("lock", "h-6 w-6", {}, { id: "empty-lock" })]),
            n("heading", { id: "empty-title", tag: "h3", attrs: { class: "text-lg font-semibold" }, text: "{$emptyTitle}" }),
            n("paragraph", { id: "empty-body", attrs: { class: "mt-2 text-sm text-muted-foreground" }, text: "{$emptyBody}" }),
            n("button", {
              id: "empty-join", name: "Connect",
              attrs: { type: "button", class: "mt-4 inline-flex min-h-10 items-center gap-2 rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground", "data-testid": "button-open-join" },
              on: { click: { action: "openRoom" } },
            }, [icon("radio", "h-4 w-4", {}, { id: "empty-join-icon" }), text("{_'join.connect'}", { id: "empty-join-text" })]),
          ]),
        ]),
        n("panel", { id: "conversation", name: "Messages", if: "!$empty", attrs: { class: "chat-column mx-auto w-full space-y-3" } }, [
          earlier("earlier-top", "$hiddenMessages > 0 && !$newestFirst"),
          n("slot", { id: "message", name: "Message", slot: "message", each: "$messages", as: "m", key: "$m.id", arg: "$m" }),
          earlier("earlier-bottom", "$hiddenMessages > 0 && $newestFirst"),
          n("panel", { id: "end", name: "End marker", ref: "end" }),
        ]),
      ]),
      n("slot", { id: "composer", name: "Composer (its own layout)", slot: "composer" }),
    ]),
  ]);
}

export function composerTree(): LNode {
  const { n, text, icon } = treeBuilder("k");
  const iconBtn = "composer-icon-btn";
  return n("form", { id: "composer", name: "Composer", attrs: { class: "composer border-t border-border bg-card/80 backdrop-blur" }, on: { submit: { action: "submit" } } }, [
    n("panel", { id: "column", attrs: { class: "chat-column mx-auto w-full" } }, [
      n("panel", { id: "reply", name: "Replying to", if: "$replyTo", attrs: { class: "composer-reply", "data-testid": "composer-reply" } }, [
        n("button", { id: "reply-jump", attrs: { type: "button", class: "composer-reply__jump" }, on: { click: { action: "replyJump" } } }, [
          icon("corner-up-left", "h-3.5 w-3.5", {}, { id: "reply-icon" }),
          n("area", { id: "reply-inner", attrs: { class: "composer-reply__inner" } }, [
            n("area", { id: "reply-name", attrs: { class: "composer-reply__name" }, text: "{_'msginfo.replyingTo'} {$replyTo.senderName}" }),
            n("area", { id: "reply-text", attrs: { class: "composer-reply__text" }, text: "{$replyTo.text}" }),
          ]),
        ]),
        n("button", { id: "reply-cancel", attrs: { type: "button", class: "composer-reply__x", "aria-label": "{_'common.close'}" }, text: "×", on: { click: { action: "cancelReply" } } }),
      ]),
      n("panel", { id: "emoji", name: "Emoji", if: "$emojiOpen", attrs: { class: "mb-2 flex flex-wrap gap-1 rounded-2xl border border-border bg-background p-2", "data-testid": "picker-emoji" } }, [
        n("button", { id: "emoji-btn", each: "$emojis", as: "e", key: "$e", attrs: { type: "button", class: "rounded-xl px-2 py-1 text-lg hover:bg-accent" }, text: "{$e}", on: { click: { action: "insertEmoji", arg: "$e" } } }),
      ]),
      n("panel", { id: "bar", name: "Bar", attrs: { class: "composer-bar" } }, [
        n("panel", { id: "actions", name: "Buttons", attrs: { class: "composer-actions" } }, [
          n("button", {
            id: "btn-emoji", name: "Emoji",
            attrs: { type: "button", "data-testid": "button-emoji", class: iconBtn, "aria-expanded": "=$emojiOpen", "aria-label": "{_'chat.emoji'}", title: "{_'chat.emoji'}" },
            on: { click: { action: "toggleEmoji" } },
          }, [icon("face-slightly-smiling", "h-5 w-5", { "aria-hidden": "true" }, { id: "btn-emoji-icon" })]),
          n("group", { id: "files", name: "Files (module)", if: "$filesOn" }, [
            n("button", {
              id: "btn-file", name: "Attach a file",
              attrs: { type: "button", "data-testid": "button-attach-file", class: iconBtn, disabled: "=$openPeerCount == 0", "aria-label": "{_'chat.attach.file'}", title: "{_'chat.attach.file'}" },
              on: { click: { action: "pickFile" } },
            }, [icon("paperclip", "h-5 w-5", { "aria-hidden": "true" }, { id: "btn-file-icon" })]),
            n("button", {
              id: "btn-image", name: "Attach an image",
              attrs: { type: "button", "data-testid": "button-attach-image", class: iconBtn, disabled: "=$openPeerCount == 0", "aria-label": "{_'chat.attach.image'}", title: "{_'chat.attach.image'}" },
              on: { click: { action: "pickImage" } },
            }, [icon("image", "h-5 w-5", { "aria-hidden": "true" }, { id: "btn-image-icon" })]),
            n("slot", { id: "recorder", name: "Voice recorder", slot: "recorder" }),
          ]),
        ]),
        n("label", { id: "input-label", attrs: { class: "sr-only", for: "message" }, text: "{_'chat.placeholder'}" }),
        n("textarea", {
          id: "input", name: "Message field",
          attrs: { "data-testid": "input-message", id: "message", rows: "1", class: "composer-input", placeholder: "{$placeholder}", value: "=$messageInput" },
          on: { change: { action: "input" }, keydown: { action: "keydown" } },
        }),
        n("slot", { id: "send", name: "Send (options)", slot: "sendOptions" }),
      ]),
      n("panel", { id: "foot", name: "Foot", attrs: { class: "composer-foot" } }, [
        n("area", { id: "hint-everyone", name: "To everyone", if: "$everyone", attrs: { class: "recipient-hint" } }, [icon("users", "h-3 w-3", {}, { id: "hint-everyone-icon" }), text(" {_'recipients.everyone'}", { id: "hint-everyone-text" })]),
        n("area", { id: "hint-none", name: "To nobody", if: "!$everyone && !$recipientNames", attrs: { class: "recipient-hint is-warn" }, text: "{_'recipients.none'}" }),
        n("area", { id: "hint-private", name: "Privately to", if: "!$everyone && $recipientNames", attrs: { class: "recipient-hint is-private" } }, [icon("lock", "h-3 w-3", {}, { id: "hint-private-icon" }), text(" {$recipientNames}", { id: "hint-private-text" })]),
        n("paragraph", { id: "hint", attrs: { class: "composer-hint" }, text: "{_'composer.attachHint'}" }),
      ]),
      n("input", { id: "file-input", ref: "fileInput", attrs: { type: "file", class: "hidden", "data-testid": "input-file" }, on: { change: { action: "attachment" } } }),
      n("input", { id: "image-input", ref: "imageInput", attrs: { type: "file", accept: "image/*", class: "hidden", "data-testid": "input-image" }, on: { change: { action: "attachment" } } }),
    ]),
  ]);
}
