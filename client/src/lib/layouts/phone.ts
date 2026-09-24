// The telephony panel (4.13): the number, the dial pad, call / SMS, the
// providers and a short history. Drawn by PhonePanel.tsx, which keeps its
// own texts ($txt, cs/en/de) and the calls to /api/telephony/*.

import { treeBuilder, type LNode } from "../layout-tree";
import type { LayoutContract } from "./contracts";

export function phoneTree(): LNode {
  const { n, text, icon } = treeBuilder("ph");
  const sized = (name: string, size: string, id: string, spec: Record<string, unknown> = {}) => icon(name, "", {}, { id, props: { icon: name, size }, ...spec });
  const provider = (id: string, label: string, list: string, value: string, action: string, testid: string) => [
    n("label", { id, if: `($${list}|length) > 0`, attrs: { class: "phone__label" } }, [
      text(`{$txt.${label}}`, { id: `${id}-text` }),
      n("select", { id: `${id}-select`, attrs: { class: "phone__select", value: `=$${value}`, "data-testid": testid }, on: { change: { action } } }, [
        n("option", { id: `${id}-option`, each: `$${list}`, as: "c", key: "$c.id", attrs: { value: "{$c.id}" }, text: "{$c.label}" }),
      ]),
    ]),
    n("paragraph", { id: `${id}-none`, if: `($${list}|length) === 0`, attrs: { class: "phone__hint" }, text: "{$txt.noProvider}" }),
  ];
  return n("group", { id: "phone-panel", name: "Telephony" }, [
    n("panel", { id: "phone-off", name: "Switched off", if: "$disabled", attrs: { class: "phone" } }, [
      n("panel", { id: "phone-banner", attrs: { class: "phone__banner phone__banner--warn" } }, [
        n("panel", { id: "phone-banner-head", attrs: { class: "phone__banner-head" } }, [
          sized("triangle-alert", "16", "phone-banner-icon"),
          text(" ", { id: "phone-banner-sp" }),
          n("area", { id: "phone-banner-title", tag: "strong", text: "{$txt.disabledTitle}" }),
        ]),
        n("paragraph", { id: "phone-banner-body", text: "{$txt.disabledBody}" }),
      ]),
    ]),
    n("panel", { id: "phone", name: "Phone", if: "!$disabled", attrs: { class: "phone" } }, [
      n("panel", { id: "phone-display", name: "The number", attrs: { class: "phone__display" } }, [
        n("input", { id: "phone-number", attrs: { class: "phone__number", value: "=$number", inputmode: "tel", placeholder: "{$txt.placeholderNumber}", "aria-label": "{$txt.number}" }, on: { change: { action: "number" } } }),
        n("button", { id: "phone-bs", name: "Backspace", attrs: { type: "button", class: "phone__bs", "aria-label": "{$txt.backspace}" }, on: { click: { action: "backspace" } } }, [sized("delete", "18", "phone-bs-icon")]),
      ]),
      n("paragraph", { id: "phone-invalid", if: "$showInvalid", attrs: { class: "phone__hint phone__hint--err" }, text: "{$txt.invalidNumber}" }),
      n("panel", { id: "phone-pad", name: "Dial pad", attrs: { class: "phone__pad" } }, [
        n("button", { id: "phone-key", name: "A key", each: "$keys", as: "k", key: "$k", attrs: { type: "button", class: "phone__key" }, on: { click: { action: "tap", arg: "$k" } }, text: "{$k}" }),
        n("button", { id: "phone-plus", attrs: { type: "button", class: "phone__key phone__key--plus" }, on: { click: { action: "tap", arg: "'+'" } }, text: "+" }),
      ]),
      n("panel", { id: "phone-tabs", name: "Call / SMS", attrs: { class: "phone__tabs", role: "tablist" } }, [
        n("button", { id: "phone-tab-call", attrs: { type: "button", role: "tab", "aria-selected": "=$mode === 'call'", class: "phone__tab" }, on: { click: { action: "mode", arg: "'call'" } } }, [
          sized("phone", "14", "phone-tab-call-icon"), text(" {$txt.call}", { id: "phone-tab-call-text" }),
        ]),
        n("button", { id: "phone-tab-sms", attrs: { type: "button", role: "tab", "aria-selected": "=$mode === 'sms'", class: "phone__tab" }, on: { click: { action: "mode", arg: "'sms'" } } }, [
          sized("message-square", "14", "phone-tab-sms-icon"), text(" {$txt.sms}", { id: "phone-tab-sms-text" }),
        ]),
      ]),
      n("panel", { id: "phone-call", name: "Call", if: "$mode === 'call'", attrs: { class: "phone__section" } }, [
        ...provider("phone-voice", "callProvider", "voice", "voiceConnector", "voiceConnector", "phone-voice-connector"),
        n("button", { id: "phone-call-btn", name: "Call", attrs: { type: "button", class: "phone__btn phone__btn--call", disabled: "=!$valid || $busy || ($voice|length) === 0" }, on: { click: { action: "call" } } }, [
          sized("phone-outgoing", "16", "phone-call-icon"), text(" {if $busy}{$txt.calling}{else}{$txt.call}{/if}", { id: "phone-call-text" }),
        ]),
        n("paragraph", { id: "phone-media-note", attrs: { class: "phone__note" }, text: "{$txt.mediaNote}" }),
      ]),
      n("panel", { id: "phone-sms", name: "SMS", if: "$mode === 'sms'", attrs: { class: "phone__section" } }, [
        ...provider("phone-sms-provider", "smsProvider", "sms", "smsConnector", "smsConnector", "phone-sms-connector"),
        n("textarea", { id: "phone-sms-text", attrs: { class: "phone__textarea", rows: "3", value: "=$text", maxlength: "1600", placeholder: "{$txt.placeholderText}", "aria-label": "{$txt.sms}", "data-testid": "phone-sms-text" }, on: { change: { action: "text" } } }),
        n("panel", { id: "phone-sms-row", attrs: { class: "phone__row" } }, [
          n("area", { id: "phone-count", attrs: { class: "phone__count" }, text: "{$text|length}/1600" }),
          n("button", { id: "phone-send", name: "Send", attrs: { type: "button", class: "phone__btn phone__btn--send", disabled: "=!$valid || $busy || !$hasText || ($sms|length) === 0" }, on: { click: { action: "send" } } }, [
            sized("send", "16", "phone-send-icon"), text(" {if $busy}{$txt.sending}{else}{$txt.send}{/if}", { id: "phone-send-text" }),
          ]),
        ]),
      ]),
      n("panel", { id: "phone-history", name: "History", attrs: { class: "phone__section" } }, [
        n("panel", { id: "phone-history-title", attrs: { class: "phone__section-title" } }, [
          n("area", { id: "phone-history-label", text: "{$txt.history}" }),
          n("button", { id: "phone-clear", if: "($history|length) > 0", attrs: { type: "button", class: "phone__link" }, on: { click: { action: "clear" } }, text: "{$txt.clear}" }),
        ]),
        n("paragraph", { id: "phone-history-empty", if: "($history|length) === 0", attrs: { class: "phone__hint" }, text: "{$txt.noHistory}" }),
        n("list", { id: "phone-hist", if: "($history|length) > 0", attrs: { class: "phone__hist" } }, [
          n("item", { id: "phone-hist-item", name: "A call or an SMS", each: "$history", as: "h", key: "$h.id", attrs: { class: "phone__hist-item {if !$h.ok}phone__hist-item--err{/if}" } }, [
            sized("phone", "13", "phone-hist-call", { if: "$h.kind === 'call'" }),
            sized("message-square", "13", "phone-hist-sms", { if: "$h.kind !== 'call'" }),
            n("area", { id: "phone-hist-to", attrs: { class: "phone__hist-to" }, text: "{$h.to}" }),
            n("area", { id: "phone-hist-detail", attrs: { class: "phone__hist-detail" }, text: "{$h.detail}" }),
          ]),
        ]),
      ]),
    ]),
  ]);
}

export const PHONE_CONTRACTS: Record<"panel.phone", LayoutContract> = {
  "panel.phone": {
    description: "Telephony: a number, the dial pad, a call or an SMS through the operator's provider, and a short history.",
    vars: [
      { path: "$txt", type: "object", description: "The panel's texts in the user's language (.call, .sms, .send, .history…)." },
      { path: "$disabled", type: "yes/no", description: "The module is off on the server." },
      { path: "$number", type: "text", description: "The number." }, { path: "$valid", type: "yes/no", description: "A valid E.164 number." },
      { path: "$showInvalid", type: "yes/no", description: "Say it is not valid." }, { path: "$keys", type: "list", description: "The dial pad's keys." },
      { path: "$mode", type: "text", description: "call or sms." }, { path: "$voice", type: "list", description: "Voice providers: .id, .label." },
      { path: "$sms", type: "list", description: "SMS providers." }, { path: "$voiceConnector", type: "text", description: "The voice provider chosen." },
      { path: "$smsConnector", type: "text", description: "The SMS provider chosen." }, { path: "$text", type: "text", description: "The SMS text." },
      { path: "$hasText", type: "yes/no", description: "There is a text." }, { path: "$busy", type: "yes/no", description: "Calling or sending." },
      { path: "$history", type: "list", description: "Calls and SMS: .id, .kind, .to, .ok, .detail." },
    ],
    actions: [
      { name: "number", description: "The number typed.", event: "change" }, { name: "backspace", description: "Delete a digit." }, { name: "tap", description: "A key pressed.", arg: "the key" },
      { name: "mode", description: "Call or SMS.", arg: "'call' or 'sms'" }, { name: "voiceConnector", description: "A voice provider chosen.", event: "change" },
      { name: "smsConnector", description: "An SMS provider chosen.", event: "change" }, { name: "text", description: "The SMS typed.", event: "change" },
      { name: "call", description: "Call." }, { name: "send", description: "Send the SMS." }, { name: "clear", description: "Clear the history." },
    ],
    slots: [],
    refs: [],
  },
};

export const PHONE_VARIANTS: Record<"panel.phone", ReadonlyArray<{ id: string; label: string }>> = {
  "panel.phone": [{ id: "call", label: "Calling" }, { id: "sms", label: "An SMS" }, { id: "off", label: "Switched off" }],
};
