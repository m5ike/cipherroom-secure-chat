// The phone bridge panel (6.0): someone called a number a function lent
// (m5.telephony.did) and typed the code — the call is offered to this
// member. Take it as audio (the call plays here, the microphone goes back),
// as text (the caller is transcribed; written replies are spoken), or hang
// up. Drawn by components/PhoneBridgePanel.tsx; lib/phone-bridge.ts carries
// the sound.

import { treeBuilder, type LNode } from "../layout-tree";
import type { LayoutContract } from "./contracts";

export function phoneBridgeTree(): LNode {
  const { n, text, icon } = treeBuilder("pb");
  return n("panel", {
    id: "phone-bridge", name: "Phone bridge", each: "$calls", as: "c", key: "$c.session",
    attrs: { class: "pb-card pb-card--{$c.state}", role: "dialog", "aria-label": "{_'phone.title'}{if $c.from} {$c.from}{/if}", "data-testid": "phone-bridge" },
  }, [
    n("panel", { id: "pb-head", name: "Who calls", attrs: { class: "pb-head" } }, [
      icon("phone", "pb-head__icon", { "aria-hidden": "true" }, { id: "pb-icon" }),
      n("panel", { id: "pb-who", attrs: { class: "pb-who" } }, [
        n("area", { id: "pb-from", name: "Caller", attrs: { class: "pb-from" }, text: "{if $c.from}{$c.from}{else}{_'phone.unknown'}{/if}" }),
        n("area", { id: "pb-to", name: "Number", attrs: { class: "pb-to" }, text: "{_'phone.via'} {$c.number}{if $c.label} · {$c.label}{/if}" }),
      ]),
      n("area", { id: "pb-state", name: "State", attrs: { class: "pb-state pb-state--{$c.state}", "data-testid": "pb-state" }, text: "{=('phone.state.' ~ $c.state)|t}" }),
    ]),
    n("area", { id: "pb-note", name: "Not end-to-end", if: "$c.state != 'ended'", attrs: { class: "pb-note" }, text: "{_'phone.note'}" }),
    n("panel", { id: "pb-lines", name: "Transcript", if: "($c.transcripts|length) > 0", attrs: { class: "pb-lines", "aria-live": "polite", "data-testid": "pb-lines" } }, [
      n("area", { id: "pb-line", name: "A line", each: "$c.transcripts", as: "t", key: "$t.at", attrs: { class: "pb-line{if $t.mine} pb-line--mine{/if}" }, text: "{$t.text}" }),
    ]),
    n("panel", { id: "pb-actions", name: "Take it", if: "$c.state == 'ringing'", attrs: { class: "pb-actions" } }, [
      n("button", { id: "pb-audio", name: "Take as audio", attrs: { type: "button", class: "pb-btn pb-btn--go", "data-testid": "pb-audio" }, on: { click: { action: "takeAudio", arg: "$c.session" } } }, [icon("mic", "h-4 w-4", { "aria-hidden": "true" }, { id: "pb-audio-icon" }), text("{_'phone.audio'}", { id: "pb-audio-text" })]),
      n("button", { id: "pb-text", name: "Take as text", attrs: { type: "button", class: "pb-btn", "data-testid": "pb-text" }, on: { click: { action: "takeText", arg: "$c.session" } } }, [icon("message-square", "h-4 w-4", { "aria-hidden": "true" }, { id: "pb-text-icon" }), text("{_'phone.text'}", { id: "pb-text-text" })]),
    ]),
    n("form", { id: "pb-reply", name: "Reply", if: "$c.state == 'text' || $c.state == 'audio'", attrs: { class: "pb-reply" }, on: { submit: { action: "reply", arg: "$c.session" } } }, [
      n("input", { id: "pb-reply-input", name: "Reply text", attrs: { class: "pb-input", placeholder: "{_'phone.reply'}", "aria-label": "{_'phone.reply'}", maxlength: "1000", "data-session": "{$c.session}", "data-testid": "pb-reply-input" } }),
      n("button", { id: "pb-send", name: "Speak it", attrs: { type: "submit", class: "pb-btn", title: "{_'phone.say'}" } }, [icon("volume-2", "h-4 w-4", { "aria-hidden": "true" }, { id: "pb-send-icon" })]),
    ]),
    n("panel", { id: "pb-foot", attrs: { class: "pb-foot" } }, [
      n("button", { id: "pb-mute", name: "Mute", if: "$c.state == 'audio'", attrs: { type: "button", class: "pb-btn{if $c.muted} is-on{/if}", "aria-pressed": "=$c.muted" }, on: { click: { action: "mute", arg: "$c.session" } } }, [icon("mic-off", "h-4 w-4", { "aria-hidden": "true" }, { id: "pb-mute-icon" }), text("{_'phone.mute'}", { id: "pb-mute-text" })]),
      n("button", { id: "pb-hangup", name: "Hang up", if: "$c.state != 'ended'", attrs: { type: "button", class: "pb-btn pb-btn--stop", "data-testid": "pb-hangup" }, on: { click: { action: "hangup", arg: "$c.session" } } }, [icon("phone-off", "h-4 w-4", { "aria-hidden": "true" }, { id: "pb-hangup-icon" }), text("{_'phone.hangup'}", { id: "pb-hangup-text" })]),
      n("button", { id: "pb-close", name: "Close", if: "$c.state == 'ended'", attrs: { type: "button", class: "pb-btn" }, on: { click: { action: "dismiss", arg: "$c.session" } } }, [text("{_'phone.close'}", { id: "pb-close-text" })]),
    ]),
  ]);
}

export const PHONE_BRIDGE_CONTRACT: LayoutContract = {
  description: "The phone bridge: a call from a number a function lent (m5.telephony.did), offered to this member — take it as audio or as text, reply, hang up.",
  vars: [
    { path: "$calls", type: "list", description: "The calls: .session, .from (the caller's number), .number (the lent number), .label, .state (ringing / connecting / audio / text / ended), .transcripts (.text, .mine, .at), .muted, .reason." },
  ],
  actions: [
    { name: "takeAudio", description: "Take the call as audio (the microphone goes to the caller).", arg: "its session" },
    { name: "takeText", description: "Take the call as text (the caller is transcribed; replies are spoken).", arg: "its session" },
    { name: "reply", description: "Speak the typed reply to the caller.", arg: "its session", event: "submit" },
    { name: "mute", description: "Mute / unmute the microphone.", arg: "its session" },
    { name: "hangup", description: "End the call.", arg: "its session" },
    { name: "dismiss", description: "Close an ended call's card.", arg: "its session" },
  ],
  slots: [],
  refs: [],
};

export const PHONE_BRIDGE_VARIANTS = [
  { id: "ringing", label: "A call waiting to be taken" },
  { id: "text", label: "Taken as text, with a transcript" },
  { id: "audio", label: "Taken as audio" },
  { id: "ended", label: "Ended" },
];
