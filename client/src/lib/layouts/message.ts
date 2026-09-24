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
        attrs: { class: "msg-seal__input", value: "=$codeInput", placeholder: "{_'msgkind.sealed.code'}", "data-testid": "seal-code-{$id}", autocomplete: "off" },
        on: { change: { action: "codeChange" }, keydown: { action: "codeKey" } },
      }),
      n("button", { id: "seal-unlock", attrs: { type: "button", class: "msg-seal__btn" }, text: "{_'msgkind.sealed.unlock'}", on: { click: { action: "codeSubmit" } } }),
    ]),
    n("paragraph", { id: "seal-error", if: "$codeError", attrs: { class: "msg-seal__err" }, text: "{_'msgkind.sealed.wrong'}" }),
  ]);

  const attachment = n("panel", { id: "attachment", name: "Attachment", if: "$attachment", attrs: { class: "msg-bubble__attach" } }, [
    n("image", { id: "attach-image", if: "$attachment.isImage", attrs: { src: "=$attachment.dataUrl", alt: "{$attachment.name}", class: "msg-bubble__img" } }),
    n("audio", { id: "attach-audio", if: "!$attachment.isImage && $attachment.isAudio", attrs: { controls: "=true", src: "=$attachment.dataUrl", class: "msg-bubble__audio" } }),
    n("link", {
      id: "attach-file", if: "!$attachment.isImage && !$attachment.isAudio",
      attrs: { href: "=$attachment.dataUrl", download: "{$attachment.name}", class: "msg-bubble__file" },
    }, [icon("paperclip", "h-3 w-3", {}, { id: "attach-file-icon" }), text(" {$attachment.name}", { id: "attach-file-name" })]),
    n("panel", { id: "attach-meta", attrs: { class: "msg-bubble__meta" }, text: "{$attachment.mime} · {$attachment.sizeText}" }),
  ]);

  const holdEvents = { pointerdown: { action: "holdStart" }, pointerup: { action: "holdEnd" }, pointerleave: { action: "holdEnd" }, pointercancel: { action: "holdEnd" } };

  const open = n("group", { id: "open", name: "Content", if: "!$vanished && !($sealed && !$sealedOpen)" }, [
    n("button", {
      id: "tap", name: "Tap to read", if: "$tap && !$revealed",
      attrs: { type: "button", class: "msg-tap", "data-testid": "tap-{$id}" },
      on: holdEvents,
    }, [icon("timer", "h-4 w-4", {}, { id: "tap-icon" }), text(" {_'msgkind.tap.hold'}", { id: "tap-text" })]),
    n("panel", { id: "body", name: "Body", if: "!($tap && !$revealed)", attrs: sys ? { class: "msg-sys__body" } : {}, on: holdEvents }, [
      n("paragraph", { id: "text", name: "Text", if: "$bodyText", attrs: { class: "msg-bubble__text" } }, [
        text("{$bodyText}", { id: "text-body", props: { format: "links" } }),
        sys ? n("area", { id: "sys-more", attrs: { class: "msg-sys__more", "aria-hidden": "true" }, text: "…" }) : null,
      ]),
      attachment,
    ]),
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

  return n("panel", {
    id: "row", name: "Message row", tag: "article", ref: "root",
    attrs: { "data-testid": "message-{$id}", "data-sealed": "=$sealedWith", class: `msg-row flex ${kind === "out" ? "justify-end" : "justify-start"}` },
  }, [
    n("panel", {
      id: "bubble", name: "Bubble",
      attrs: {
        class: `msg-bubble ${bubbleKind}{if $queued} msg-bubble--queued{/if}{if $private} msg-bubble--private{/if}{if $vanishing} vanish-ring{/if}{if $vanished} msg-bubble--vanished{/if}{if $collapsed} msg-bubble--sys-collapsed{/if}`,
        "data-private": "=$private ? '1' : null",
        "data-collapsed": "=$collapsed ? '1' : null",
      },
      styleBind: "$bubbleStyle",
      ...(sys ? { on: { mouseenter: { action: "unfold" }, click: { action: "unfold" } } } : {}),
    }, [info, head, forwarded, quote, privateTag, tombstone, seal, open, actions]),
  ]);
}
