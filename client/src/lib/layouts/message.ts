// The message bubble as layout trees — incoming, outgoing and system — drawn
// by MessageBubble.tsx. The defaults reproduce the bubble element for element
// (checked against the previous JSX by test/layout-parity.test.tsx).

import { treeBuilder, type LNode } from "../layout-tree";

export type MessageKind = "in" | "out" | "sys";

export function messageTree(kind: MessageKind): LNode {
  const { n, text, icon } = treeBuilder("m");
  const sys = kind === "sys";
  const bubbleKind = sys ? "msg-bubble--system" : kind === "out" ? "msg-bubble--mine" : "msg-bubble--theirs";

  const label =
    kind === "in"
      ? n("slot", { id: "badge", name: "Sender (user badge)", slot: "badge" })
      : kind === "out"
        ? n("area", { id: "label", name: "Sender", attrs: { class: "msg-bubble__label inline-flex items-center gap-1.5" } }, [
            n("avatar", { id: "avatar", if: "$showAvatar", props: { name: "{$senderName}", avatar: "{$avatar}", size: "20" } }),
            text("{$senderName}", { id: "sender" }),
          ])
        : n("area", { id: "label", name: "Header", attrs: { class: "msg-bubble__label" } }, [
            n("logo", { id: "logo", if: "$showLogo", props: { size: "16", mono: "=true" }, attrs: { class: "msg-sys-logo" } }),
            text("{$headerText}", { id: "header-text" }),
          ]);

  const head = n("panel", { id: "head", name: "Head", attrs: { class: "msg-bubble__head" } }, [
    label,
    n("area", { id: "time", name: "Time", attrs: { class: "msg-bubble__time" }, text: "{$timeLabel}" }),
    icon("lock", "h-3 w-3 opacity-70", { "aria-label": "{_'userinfo.secure'}" }, { id: "icon-secure", if: "$secure" }),
    icon("timer", "h-3 w-3 opacity-70", { "aria-label": "{_'msgkind.tap'}" }, { id: "icon-tap", if: "$tap" }),
    icon("eye-off", "h-3 w-3 opacity-70", { "aria-label": "{_'msgkind.vanish'}" }, { id: "icon-vanish", if: "$vanishing" }),
    icon("scroll-text", "h-3 w-3 opacity-70", { "aria-label": "{_'msgkind.sealed'}" }, { id: "icon-sealed", if: "$sealed" }),
    // 6.1: where the sender was (a pin; the Android app puts it into the header on request).
    // 6.7: the pin of the Android app — the map and the ways there open in a window
    // (a position message shows its place chip in the body instead).
    n("button", {
      id: "loc", name: "Position", if: "$place && !$place.message",
      attrs: { type: "button", class: "msg-loc", title: "{_'msg.loc'}", "aria-label": "{_'msg.loc'}", "data-testid": "msg-loc" },
      on: { click: { action: "place" } },
    }, [icon("map-pin", "h-3 w-3", {}, { id: "loc-icon" })]),
    // 6.2: shown while the conversation shows hidden messages too.
    sys ? null : n("area", { id: "hidden-tag", name: "Hidden", if: "$hidden", attrs: { class: "msg-hidden-tag", "data-testid": "msg-hidden-{$id}" } }, [
      icon("eye-off", "h-3 w-3", { "aria-hidden": "true" }, { id: "hidden-tag-icon" }),
      text(" {_'msg.hidden.tag'}", { id: "hidden-tag-text" }),
    ]),
    kind === "out"
      ? n("area", {
          id: "delivery", name: "Delivery mark", if: "$delivery",
          attrs: { class: "msg-delivery is-{$delivery}", title: "{$delivery|t:'msginfo.state.'}", "aria-label": "{$delivery|t:'msginfo.state.'}", "data-testid": "msg-delivery" },
        }, [
          icon("{if $delivery == 'queued'}send-horizontal{elseif $delivery == 'stored'}clock{elseif $delivery == 'read' || $delivery == 'delivered'}check-check{else}check{/if}", "h-3 w-3", {}, { id: "delivery-icon" }),
        ])
      : null,
  ]);

  const info = sys ? null : n("button", {
    id: "info", name: "Info button", if: "$hasInfo",
    attrs: { type: "button", class: "msg-info-btn", "aria-label": "{_'msginfo.title'}", title: "{_'msginfo.title'}", "data-testid": "msg-info-{$id}" },
    on: { click: { action: "info" } },
  }, [icon("info", "h-3.5 w-3.5", {}, { id: "info-icon" })]);

  const forwarded = n("panel", { id: "forwarded", name: "Forwarded from", if: "$forwardedFrom", attrs: { class: "msg-fwd" } }, [
    icon("forward", "h-3 w-3", {}, { id: "forwarded-icon" }),
    text(" {_'msginfo.forwardedFrom'}: {$forwardedFrom}", { id: "forwarded-text" }),
  ]);

  const quote = n("button", {
    id: "quote", name: "Quoted message", if: "$replyTo",
    attrs: { type: "button", class: "msg-quote", "data-testid": "msg-quote-{$id}" },
    on: { click: { action: "quoteJump" } },
  }, [
    icon("corner-up-left", "h-3 w-3", {}, { id: "quote-icon" }),
    n("area", { id: "quote-inner", attrs: { class: "msg-quote__inner" } }, [
      n("area", { id: "quote-name", attrs: { class: "msg-quote__name" }, text: "{$replyTo.senderName}" }),
      n("area", { id: "quote-text", attrs: { class: "msg-quote__text" }, text: "{$replyTo.text}" }),
    ]),
  ]);

  const privateTag = n("panel", { id: "private", name: "Private to", if: "$private", attrs: { class: "msg-bubble__private-tag" } }, [
    icon("lock", "h-3 w-3", {}, { id: "private-icon" }),
    text(" {_'recipients.privateTo'}: {$to}", { id: "private-text" }),
  ]);

  const tombstone = n("paragraph", { id: "tombstone", name: "Vanished", if: "$vanished", attrs: { class: "msg-bubble__tombstone" }, text: "{_'msgkind.vanish.gone'}{$vanishedAtText}" });

  const seal = n("panel", { id: "seal", name: "Sealed: code", if: "!$vanished && $sealed && !$sealedOpen", attrs: { class: "msg-seal" } }, [
    n("paragraph", { id: "seal-hint", attrs: { class: "msg-seal__hint" } }, [
      icon("scroll-text", "h-4 w-4", {}, { id: "seal-hint-icon" }),
      text(" {_'msgkind.sealed.locked'}", { id: "seal-hint-text" }),
    ]),
    n("panel", { id: "seal-row", attrs: { class: "msg-seal__row" } }, [
      n("input", {
        id: "seal-input", name: "Code",
        attrs: { class: "msg-seal__input", value: "=$codeInput", placeholder: "{_'msgkind.sealed.code'}", "aria-label": "{_'msgkind.sealed.code'}", "data-testid": "seal-code-{$id}", autocomplete: "off" },
        on: { change: { action: "codeChange" }, keydown: { action: "codeKey" } },
      }),
      n("button", { id: "seal-unlock", attrs: { type: "button", class: "msg-seal__btn" }, text: "{_'msgkind.sealed.unlock'}", on: { click: { action: "codeSubmit" } } }),
    ]),
    n("paragraph", { id: "seal-error", if: "$codeError", attrs: { class: "msg-seal__err" }, text: "{_'msgkind.sealed.wrong'}" }),
  ]);

  // 6.2: what can be shown of the file is shown (picture, video, sound, a PDF
  // card, a text's first lines); its name, size and buttons are in the footer.
  const attachment = n("panel", { id: "attachment", name: "Attachment", if: "$attachment && $attachment.hasPreview", attrs: { class: "msg-bubble__attach msg-media is-{$attachment.kind}" } }, [
    n("image", { id: "attach-image", if: "$attachment.isImage", attrs: { src: "=$attachment.dataUrl", alt: "{$attachment.name}", class: "msg-bubble__img" } }),
    n("video", {
      id: "attach-video", name: "Video", if: "$attachment.isVideo && $attachment.mediaUrl",
      attrs: { controls: "=true", preload: "metadata", playsinline: "=true", src: "=$attachment.mediaUrl", class: "msg-bubble__video", "aria-label": "{$attachment.name}", "data-testid": "msg-video-{$id}" },
    }),
    n("audio", { id: "attach-audio", if: "$attachment.isAudio && $attachment.mediaUrl", attrs: { controls: "=true", src: "=$attachment.mediaUrl", class: "msg-bubble__audio" } }),
    n("button", {
      id: "attach-pdf", name: "PDF card", if: "$attachment.isPdf",
      attrs: { type: "button", class: "msg-pdf", title: "{_'msginfo.open'}", "data-testid": "msg-pdf-{$id}" },
      on: { click: { action: "open", arg: "0" } },
    }, [
      icon("file-text", "msg-pdf__icon", { "aria-hidden": "true" }, { id: "attach-pdf-icon" }),
      n("area", { id: "attach-pdf-text", attrs: { class: "msg-pdf__text" } }, [
        n("area", { id: "attach-pdf-name", attrs: { class: "msg-pdf__name" }, text: "{$attachment.name}" }),
        n("area", { id: "attach-pdf-kind", attrs: { class: "msg-pdf__kind" }, text: "{_'msg.pdf'} · {$attachment.sizeText}" }),
      ]),
      icon("external-link", "h-3.5 w-3.5 opacity-70", { "aria-hidden": "true" }, { id: "attach-pdf-open" }),
    ]),
    n("paragraph", {
      id: "attach-text", name: "Text preview", if: "$attachment.preview", tag: "pre",
      attrs: { class: "msg-textprev{if $attachment.previewMore} is-more{/if}", "data-testid": "msg-textprev-{$id}" }, text: "{$attachment.preview}",
    }),
  ]);

  // 6.7: a position message is its place: a chip with the pin and the
  // coordinates. The map is no longer drawn in the bubble — a click opens it
  // in a window with the ways there (navigation, a ride). $map stays for
  // layouts that still draw it.
  const place = n("button", {
    id: "place", name: "Position (opens the map)", if: "$place.message",
    attrs: { type: "button", class: "msg-place", title: "{_'msg.place.open'}", "data-testid": "msg-place-{$id}" },
    on: { click: { action: "place" } },
  }, [
    icon("map-pin", "msg-place__icon", { "aria-hidden": "true" }, { id: "place-icon" }),
    n("area", { id: "place-text", name: "Coordinates", attrs: { class: "msg-place__text" }, text: "{if $place.live}{_'msg.place.live'} · {/if}{$place.coords}" }),
  ]);

  // 6.2: every file of the message: its kind, name and size, and save, share
  // (the system's share sheet, or a small menu that gives nothing away) and forward.
  const fileBtn = (id: string, iconName: string, label: string, action: string, cond?: string) => n("button", {
    id, if: cond,
    attrs: { type: "button", class: "msg-file__btn", title: `{_'${label}'}`, "aria-label": `{_'${label}'}`, "data-testid": `${id}-{$id}` },
    on: { click: { action, arg: "$f.index" } },
  }, [icon(iconName, "h-3.5 w-3.5", {}, { id: `${id}-icon` })]);
  const files = n("panel", { id: "files", name: "Attachments footer", if: "$attachments && !($tap && !$revealed)", tag: "footer", attrs: { class: "msg-files", "aria-label": "{_'msg.files'}" } }, [
    n("panel", { id: "file", name: "A file", each: "$attachments", as: "f", key: "$f.index", attrs: { class: "msg-file{if $f.dropped} is-dropped{/if}", "data-testid": "msg-file-{$id}" } }, [
      icon("{$f.icon}", "msg-file__icon", { "aria-hidden": "true" }, { id: "file-icon" }),
      n("area", { id: "file-name", attrs: { class: "msg-file__name", title: "{if $f.dropped}{_'msg.file.dropped'}{else}{$f.name}{/if}" }, text: "{$f.name}" }),
      n("area", { id: "file-size", attrs: { class: "msg-file__size" }, text: "{$f.sizeText}" }),
      fileBtn("file-save", "download", "msginfo.save", "save", "$f.available"),
      fileBtn("file-share", "share-2", "msginfo.share", "share", "$f.available"),
      fileBtn("file-forward", "forward", "msginfo.forward", "forward", "$f.available && $canForward"),
      n("panel", { id: "file-share-menu", name: "Share menu", if: "$shareMenu === $f.index", attrs: { class: "msg-file__menu", role: "menu", "data-testid": "msg-share-menu-{$id}" } }, [
        n("button", { id: "share-copy-name", attrs: { type: "button", role: "menuitem", class: "msg-file__menu-item" }, on: { click: { action: "copyName", arg: "$f.index" } } }, [
          icon("copy", "h-3.5 w-3.5", {}, { id: "share-copy-name-icon" }), text(" {_'msg.file.copyName'}", { id: "share-copy-name-text" }),
        ]),
        n("button", { id: "share-save", attrs: { type: "button", role: "menuitem", class: "msg-file__menu-item" }, on: { click: { action: "save", arg: "$f.index" } } }, [
          icon("download", "h-3.5 w-3.5", {}, { id: "share-save-icon" }), text(" {_'msginfo.save'}", { id: "share-save-text" }),
        ]),
        n("paragraph", { id: "share-note", attrs: { class: "msg-file__menu-note" }, text: "{_'msg.file.noShare'}" }),
      ]),
    ]),
  ]);

  const holdEvents = { pointerdown: { action: "holdStart" }, pointerup: { action: "holdEnd" }, pointerleave: { action: "holdEnd" }, pointercancel: { action: "holdEnd" } };

  const open = n("group", { id: "open", name: "Content", if: "!$vanished && !($sealed && !$sealedOpen)" }, [
    n("button", {
      id: "tap", name: "Tap to read", if: "$tap && !$revealed",
      attrs: { type: "button", class: "msg-tap", "data-testid": "tap-{$id}" },
      on: holdEvents,
    }, [icon("timer", "h-4 w-4", {}, { id: "tap-icon" }), text(" {_'msgkind.tap.hold'}", { id: "tap-text" })]),
    n("panel", { id: "body", name: "Body", if: "!($tap && !$revealed)", attrs: sys ? { class: "msg-sys__body" } : {}, on: holdEvents }, [
      // A <div>, not a <p>: a command's output (5.3) holds headings, tables, forms and buttons.
      n("paragraph", { id: "text", name: "Text", if: sys ? "$bodyText" : "$bodyText && !$place.message", tag: "div", attrs: { class: "msg-bubble__text" } }, [
        text("{$bodyText}", { id: "text-body", props: { format: "links" } }),
        sys ? n("area", { id: "sys-more", attrs: { class: "msg-sys__more", "aria-hidden": "true" }, text: "…" }) : null,
      ]),
      attachment,
      sys ? null : place,
    ]),
    sys ? null : files,
    n("paragraph", { id: "seal-code", name: "Your code", if: "$sealed && $mine && $sealCode", attrs: { class: "msg-seal__code" } }, [
      text("{_'msgkind.sealed.yourcode'}: ", { id: "seal-code-label" }),
      n("area", { id: "seal-code-value", tag: "strong", text: "{$sealCode}" }),
    ]),
  ]);

  const actions = sys ? null : n("panel", { id: "actions", name: "Actions", if: "$showActions", attrs: { class: "msg-actions" } }, [
    n("button", {
      id: "reply", name: "Reply", if: "$canReply",
      attrs: { type: "button", class: "msg-act", "data-testid": "msg-reply-{$id}" },
      on: { click: { action: "reply" } },
    }, [icon("reply", "h-3.5 w-3.5", {}, { id: "reply-icon" }), text(" {_'msginfo.reply'}", { id: "reply-text" })]),
    n("button", {
      id: "forward", name: "Forward", if: "$canForward",
      attrs: { type: "button", class: "msg-act", "data-testid": "msg-forward-{$id}" },
      on: { click: { action: "forward" } },
    }, [icon("forward", "h-3.5 w-3.5", {}, { id: "forward-icon" }), text(" {_'msginfo.forward'}", { id: "forward-text" })]),
  ]);

  // 6.7: beside a hold-to-read bubble, the rest of the row holds it open too —
  // a short text is not under the finger. A short hold first, so a scroll
  // that starts there reveals nothing.
  const holdSide = sys ? null : n("panel", {
    id: "hold-side", name: "Hold area (beside the bubble)", if: "$tap && !$vanished && !($sealed && !$sealedOpen)",
    attrs: { class: "msg-hold-side", "aria-hidden": "true", "data-testid": "msg-hold-side-{$id}" },
    on: { pointerdown: { action: "holdSideStart" }, pointerup: { action: "holdEnd" }, pointerleave: { action: "holdEnd" }, pointercancel: { action: "holdEnd" } },
  });

  const bubble = n("panel", {
    id: "bubble", name: "Bubble",
    attrs: {
      // 6.11: a model's answer (system-messenger) is as wide as its content (msg-bubble--fn-answer); a failed call is marked.
      class: `msg-bubble ${bubbleKind}{if $queued} msg-bubble--queued{/if}{if $fnRunning} msg-bubble--fn-running{/if}{if $fnAnswer} msg-bubble--fn-answer{/if}{if $fnFailed} msg-bubble--fn-failed{/if}{if $private} msg-bubble--private{/if}{if $vanishing} vanish-ring{/if}{if $vanished} msg-bubble--vanished{/if}{if $collapsed} msg-bubble--sys-collapsed{/if}{if $hidden} msg-bubble--hidden{/if}`,
      "data-private": "=$private ? '1' : null",
      "data-collapsed": "=$collapsed ? '1' : null",
    },
    styleBind: "$bubbleStyle",
    ...(sys ? { on: { mouseenter: { action: "unfold" }, click: { action: "unfold" } } } : {}),
  }, [info, head, forwarded, quote, privateTag, tombstone, seal, open, actions]);

  return n("panel", {
    id: "row", name: "Message row", tag: "article", ref: "root",
    attrs: { "data-testid": "message-{$id}", "data-sealed": "=$sealedWith", class: `msg-row flex ${kind === "out" ? "justify-end" : "justify-start"}` },
  }, kind === "out" ? [holdSide, bubble] : [bubble, holdSide]);
}
