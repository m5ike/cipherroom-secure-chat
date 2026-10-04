// 6.8 design area: "Send another way" (the long press on Send) as the options
// of the next message — each one ticked green when on, applied only when the
// message is actually sent; the individual code with its field and a button
// that makes one up.
// One area of the 6.8 design (design-68.ts gathers them): what it adds and
// what it changes in the trees and menus that already exist.
//
//  - "send.options" (6.1's sheet of actions — "as voice" sent at once) is
//    now a list of options (send.option toggles one; the sheet stays open):
//    as a voice message, speak it and send text (these two exclude each
//    other), the individual code, vanishing, tap to reveal. An option that is
//    on has its icon green with a tick and its row raised; off it is neutral.
//  - The code: when on, a field for it ($form.msgSeal — empty: a new random
//    code for each message, as on the web) and a button that makes one up
//    (send.option › newCode); vanishing: how long (the messages' times).
//  - The app (android/…/chat/SendPlan, ui/parts/Composer) applies them on
//    Send — the button, Enter, message.send, a dictation that sends — and
//    keeps them on until they are turned off (as the web's SendOptions do);
//    the composer shows them as chips and Send's icon says "as voice".
//  - $composer (the attach and send.options sheets) gains asVoice, voiceText,
//    sealCode and count; hasText, tap, vanish, sealed and private stay.

import type { ANode, ScreenDef } from "./design";
import type { DesignArea } from "./design-67";
import { SCREENS_61 } from "./design-61";

type Opts = Omit<ANode, "id" | "el" | "children">;
const n = (id: string, el: string, o: Opts = {}, children?: ANode[]): ANode => ({ id, el, ...o, ...(children ? { children } : {}) });
const click = (action: string, arg?: string) => ({ click: arg === undefined ? { action } : { action, arg } });

/** A sheet: a handle, a title, then the body (6.1's shape). */
const sheet = (title: string, body: ANode[]): ANode => n("root", "column", { style: { bg: "@surface", radius: 24, padding: "10 12 16 12", gap: 6 }, anim: { enter: { type: "slide-up", ms: 220, easing: "decelerate" } } }, [
  n("handle", "row", { style: { justify: "center", padding: "0 0 6 0" } }, [n("grip", "spacer", { props: { size: 4 }, style: { width: 40, bg: "@border", radius: 2 } })]),
  n("title", "text", { text: title, props: { variant: "title" }, style: { bold: true, padding: "0 8 2 8" } }),
  ...body,
]);

/**
 * An option of the next message: its icon — green with a tick when on — the
 * label and what it does; a tap switches it (send.option), the sheet stays.
 */
const option = (id: string, icon: string, label: string, hint: string, on: string): ANode => n(id, "row", {
  style: { padding: "10 12", gap: 14, align: "center", radius: 16, bg: `=${on} ? '@surfaceVariant' : '@surface'` },
  on: click("send.option", id),
}, [
  n(`${id}-mark`, "stack", { style: { width: 30, height: 30 } }, [
    n(`${id}-icon`, "icon", { props: { icon, size: 22, color: `=${on} ? '@success' : '@muted'` }, style: { width: 22, height: 22, self: "center" } }),
    n(`${id}-tick`, "icon", { if: on, props: { icon: "circle-check", size: 14, color: "@success" }, style: { width: 14, height: 14, self: "end", bg: "@surfaceVariant", radius: 7 } }),
  ]),
  n(`${id}-col`, "column", { style: { weight: 1, gap: 2 } }, [
    n(`${id}-label`, "text", { text: label, style: { size: 16 } }),
    n(`${id}-hint`, "text", { text: hint, props: { variant: "caption" }, style: { fg: "@muted" } }),
  ]),
]);

/** The messages' vanishing times (Settings › Messages has the same). */
export const VANISH_OPTIONS = "4:4 s|15:15 s|60:1 min|300:5 min|1800:30 min|3600:1 h|7200:2 h";

export const SEND_OPTIONS = ["asVoice", "voiceText", "seal", "vanish", "tap"] as const;

const TREES: Record<string, ANode> = {
  "send.options": sheet("{_'send.title'}", [
    n("intro", "text", { text: "{_'send.intro'}", props: { variant: "caption" }, style: { fg: "@muted", padding: "0 8 6 8" } }),
    // Weighted: on a short screen (the keyboard up for the code) the list scrolls and Done stays.
    n("scroll", "scroll", { style: { weight: 1 } }, [n("list", "column", { style: { gap: 4 } }, [
      option("asVoice", "volume-2", "{_'send.opt.asVoice'}", "{_'send.opt.asVoiceHint'}", "$composer.asVoice"),
      option("voiceText", "speech", "{_'send.opt.voiceText'}", "{_'send.opt.voiceTextHint'}", "$composer.voiceText"),
      option("seal", "scroll-text", "{_'msgkind.sealed'}", "{_'send.opt.sealHint'}", "$composer.sealed"),
      n("seal-code", "column", { if: "$composer.sealed", style: { padding: "0 12 8 56", gap: 4 } }, [
        n("seal-code-row", "row", { style: { gap: 4, align: "center" } }, [
          n("seal-input", "input", { props: { bind: "msgSeal", hint: "{_'send.code.hint'}" }, style: { weight: 1, font: "mono" } }),
          n("seal-new", "iconButton", { props: { icon: "dice-5", label: "{_'send.code.new'}" }, on: click("send.option", "newCode") }),
        ]),
        n("seal-share", "text", { text: "{_'send.code.share'}", props: { variant: "caption" }, style: { fg: "@muted" } }),
        n("seal-voice", "text", { if: "$composer.asVoice", text: "{_'send.code.noVoice'}", props: { variant: "caption" }, style: { fg: "@warning" } }),
      ]),
      option("vanish", "timer", "{_'msgkind.vanish'}", "{_'send.opt.vanishHint'}", "$composer.vanish > 0"),
      n("vanish-time", "row", { if: "$composer.vanish > 0", style: { padding: "0 12 8 56", gap: 12, align: "center" } }, [
        n("vanish-label", "text", { text: "{_'send.vanish.after'}", style: { fg: "@muted", weight: 1 } }),
        n("vanish-select", "select", { props: { bind: "msgVanish", options: VANISH_OPTIONS }, style: { maxWidth: 200 }, on: { change: { action: "send.option", arg: "vanish:{$value}" } } }),
      ]),
      option("tap", "eye", "{_'msgkind.tap'}", "{_'send.opt.tapHint'}", "$composer.tap"),
    ])]),
    n("foot", "row", { style: { padding: "6 4 0 4", gap: 8, align: "center" } }, [
      n("clear", "button", { if: "$composer.count > 0", text: "{_'send.clear'}", props: { icon: "x", variant: "text" }, on: click("send.option", "none") }),
      n("foot-fill", "spacer"),
      n("done", "button", { text: "{_'send.done'}", props: { icon: "check", variant: "tonal" }, on: click("sheet.close") }),
    ]),
  ]),
};

// The console's preview of the sheet shows the options' new state (6.1's sample knew only hasText).
const DEF = SCREENS_61.find((s) => s.id === "send.options") as ScreenDef | undefined;
if (DEF) {
  DEF.sample = { ...DEF.sample, composer: { hasText: true, asVoice: false, voiceText: false, sealed: true, sealCode: "", vanish: 60, tap: false, private: false, count: 2 } };
  DEF.help = "A long press on Send: the options of the messages, applied when one is sent and on until turned off — as a voice message, speak it and send text, the individual code (its field and a made-up one), vanishing (how long), tap to reveal. $composer: hasText, asVoice, voiceText, sealed, sealCode, vanish (s), tap, private, count.";
}

const cs: Record<string, string> = {
  "send.intro": "Použijí se, až zprávu odešlete, a platí, dokud je nevypnete. Klepnutím volbu zapnete či vypnete; zapnout jich jde i víc.",
  "send.opt.asVoice": "Jako hlasová zpráva",
  "send.opt.asVoiceHint": "Odeslat nechá text přečíst hlasem (s prázdným polem nejdřív spustí diktování) a pošle ho jako šifrovanou hlasovou zprávu.",
  "send.opt.voiceText": "Nadiktovat, odeslat text",
  "send.opt.voiceTextHint": "S prázdným polem Odeslat spustí diktování; ■ nebo Odeslat pošle nadiktovaný text. Napsaný text odejde hned.",
  "send.opt.sealHint": "Text zamčený kódem, který příjemcům předáte jinou cestou.",
  "send.opt.vanishHint": "Zmizí, až uplyne zvolená doba.",
  "send.opt.tapHint": "Skrytá, dokud na ni příjemce nepodrží prst.",
  "send.code.hint": "Kód (prázdné = pro každou zprávu náhodný)",
  "send.code.new": "Vymyslet kód",
  "send.code.share": "Kód příjemcům předejte jinou cestou — bez něj zprávu nepřečtou.",
  "send.code.noVoice": "Hlasová zpráva odešla bez kódu — kódem jde zamknout jen text.",
  "send.vanish.after": "Zmizí po",
  "send.clear": "Vypnout vše",
  "send.done": "Hotovo",
  "send.btn.asVoice": "odejde jako hlas",
  "send.btn.voiceText": "s prázdným polem diktování",
};

const en: Record<string, string> = {
  "send.intro": "They apply when you send a message and stay on until you turn them off. Tap an option to turn it on or off; several can be on at once.",
  "send.opt.asVoice": "As a voice message",
  "send.opt.asVoiceHint": "Send has the text read by a voice (with an empty field it starts dictation first) and sends it as an encrypted voice message.",
  "send.opt.voiceText": "Speak it, send text",
  "send.opt.voiceTextHint": "With an empty field Send starts dictation; ■ or Send sends what you said as text. Typed text goes at once.",
  "send.opt.sealHint": "The text locked with a code you give the recipients another way.",
  "send.opt.vanishHint": "Disappears when the chosen time runs out.",
  "send.opt.tapHint": "Hidden until the recipient holds a finger on it.",
  "send.code.hint": "Code (empty = a random one for each message)",
  "send.code.new": "Make up a code",
  "send.code.share": "Give the recipients the code another way — without it they cannot read the message.",
  "send.code.noVoice": "The voice message went without the code — only text can be locked with one.",
  "send.vanish.after": "Disappears after",
  "send.clear": "Turn all off",
  "send.done": "Done",
  "send.btn.asVoice": "goes as voice",
  "send.btn.voiceText": "empty field: dictation",
};

const de: Record<string, string> = {
  "send.intro": "Sie gelten beim Senden einer Nachricht und bleiben an, bis Sie sie ausschalten. Tippen Sie auf eine Option, um sie ein- oder auszuschalten; mehrere können gleichzeitig an sein.",
  "send.opt.asVoice": "Als Sprachnachricht",
  "send.opt.asVoiceHint": "Senden lässt den Text von einer Stimme lesen (bei leerem Feld startet zuerst das Diktat) und schickt ihn als verschlüsselte Sprachnachricht.",
  "send.opt.voiceText": "Sprechen, als Text senden",
  "send.opt.voiceTextHint": "Bei leerem Feld startet Senden das Diktat; ■ oder Senden schickt das Gesagte als Text. Getippter Text geht sofort.",
  "send.opt.sealHint": "Der Text mit einem Code verschlossen, den Sie den Empfängern auf anderem Weg geben.",
  "send.opt.vanishHint": "Verschwindet, wenn die gewählte Zeit abläuft.",
  "send.opt.tapHint": "Verborgen, bis der Empfänger den Finger darauf hält.",
  "send.code.hint": "Code (leer = für jede Nachricht ein zufälliger)",
  "send.code.new": "Code erzeugen",
  "send.code.share": "Geben Sie den Empfängern den Code auf anderem Weg — ohne ihn können sie die Nachricht nicht lesen.",
  "send.code.noVoice": "Die Sprachnachricht ging ohne Code — nur Text lässt sich damit verschließen.",
  "send.vanish.after": "Verschwindet nach",
  "send.clear": "Alle aus",
  "send.done": "Fertig",
  "send.btn.asVoice": "geht als Sprache",
  "send.btn.voiceText": "leeres Feld: Diktat",
};

export const AREA: DesignArea = {
  actions: [
    { action: "send.option", arg: "asVoice | voiceText | seal[:code] | newCode | vanish[:seconds] | tap | none", help: "An option of the messages sent from the composer on / off (\"Send another way\"): applied when one is sent, on until turned off — as voice and speak-it-send-text exclude each other; newCode makes up a code ($form.msgSeal), none turns all off" },
  ],
  trees: TREES,
  strings: { cs, en, de },
};
