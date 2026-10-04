// 6.7 design area: dictation, speak-and-send, the real-time voice changer module (6.7)
// One area of the 6.7 design (design-67.ts gathers them): what it adds and
// what it changes in the trees and menus that already exist.
//
//  - Settings › Voice › Voice changer ("settings.voiceFx"): on / off for this
//    phone (only when the operator's "voiceChanger" module allows it —
//    $voiceFx.allowed), a preset or custom values (voiceFx.*: the same
//    presets as the web's), a test (record 4 s, hear them back), and what it
//    does not cover. The chain itself is native (voice/VoiceFx, MicFx): voice
//    messages and calls pass it before they are encoded and encrypted.
//  - Speak and send: "Send the text as voice" works with an empty field too
//    (dictate, then it is spoken and sent); "Speak it, send text" dictates
//    live and sends the text when stopped (voice/SpeakSend). The texts say so.
//  - Dictation: the stop / error texts the app shows (ui/parts/ComposerVoice).

import type { ANode, ScreenDef } from "./design";
import type { DesignArea } from "./design-67";

type Opts = Omit<ANode, "id" | "el" | "children">;
const n = (id: string, el: string, o: Opts = {}, children?: ANode[]): ANode => ({ id, el, ...o, ...(children ? { children } : {}) });
const click = (action: string, arg?: string) => ({ click: arg === undefined ? { action } : { action, arg } });

const bar = (title: string): ANode => n("bar", "row", { style: { padding: "8 4 8 4", align: "center", gap: 4, bg: "@surface", elevation: 2 } }, [
  n("back", "iconButton", { props: { icon: "arrow-left", label: "{_'nav.back'}" }, on: click("back") }),
  n("title", "text", { text: title, props: { variant: "title" }, style: { bold: true, weight: 1, lines: 1 } }),
]);

const page = (title: string, body: ANode[]): ANode => n("root", "column", { style: { width: "match", height: "match", bg: "@background" } }, [
  bar(title),
  n("scroll", "scroll", { style: { weight: 1 } }, [n("list", "column", { style: { padding: "0 0 24 0" } }, body)]),
]);

const caption = (id: string, text: string, cond?: string, fg = "@muted"): ANode => n(id, "text", { ...(cond ? { if: cond } : {}), text, props: { variant: "caption" }, style: { fg, padding: "6 20 6 20" } });

const toggleRow = (id: string, icon: string, label: string, setting: string): ANode => n(id, "row", { style: { padding: "10 12 10 20", gap: 18, align: "center" } }, [
  n(`${id}-icon`, "icon", { props: { icon, size: 22, color: "@muted" } }),
  n(`${id}-label`, "text", { text: label, style: { size: 16, weight: 1 } }),
  n(`${id}-switch`, "switch", { props: { setting } }),
]);

const selectRow = (id: string, icon: string, label: string, setting: string, options: string): ANode => n(id, "row", { style: { padding: "8 16 8 20", gap: 18, align: "center" } }, [
  n(`${id}-icon`, "icon", { props: { icon, size: 22, color: "@muted" } }),
  n(`${id}-label`, "text", { text: label, style: { size: 16, weight: 1 } }),
  n(`${id}-select`, "select", { props: { setting, options }, style: { maxWidth: 200 } }),
]);

const sliderRow = (id: string, icon: string, label: string, setting: string, min: number, max: number, step: number): ANode => n(id, "column", { style: { padding: "8 20 4 20" } }, [
  n(`${id}-head`, "row", { style: { gap: 18, align: "center" } }, [
    n(`${id}-icon`, "icon", { props: { icon, size: 22, color: "@muted" } }),
    n(`${id}-label`, "text", { text: label, style: { size: 16, weight: 1 } }),
    n(`${id}-value`, "text", { text: `{$settings.${setting}}`, props: { variant: "mono" }, style: { fg: "@muted" } }),
  ]),
  n(`${id}-slider`, "slider", { props: { setting, min, max, step }, style: { margin: "0 0 0 34" } }),
]);

const navRow = (id: string, icon: string, label: string, target: string, sub: string): ANode => n(id, "row", { style: { padding: "12 20", gap: 18, align: "center" }, on: click("screen.open", target) }, [
  n(`${id}-icon`, "icon", { props: { icon, size: 22, color: "@muted" } }),
  n(`${id}-col`, "column", { style: { weight: 1 } }, [
    n(`${id}-label`, "text", { text: label, style: { size: 16 } }),
    n(`${id}-sub`, "text", { text: sub, props: { variant: "caption" }, style: { fg: "@muted", lines: 1 } }),
  ]),
  n(`${id}-go`, "icon", { props: { icon: "chevron-right", size: 18, color: "@muted" } }),
]);

/** The presets, as the web has them (client/src/lib/voice-fx.ts › VOICE_FX_PRESET_IDS). */
export const FX_PRESET_IDS = ["off", "higher", "lower", "deep", "robot", "echo", "whisper", "anonymous", "custom"] as const;
const PRESET_OPTIONS = FX_PRESET_IDS.map((id) => `${id}:{_'fx.p.${id}'}`).join("|");

const ALLOWED = "$voiceFx.allowed";

const SCREENS: ScreenDef[] = [
  {
    id: "settings.voiceFx", label: "Settings › Voice changer", group: "app", vars: ["$settings", "$voiceFx"],
    sample: { settings: { voiceFx: { on: true, preset: "custom", pitch: -5, formant: -3, robot: 0, echo: 0, echoMs: 250, whisper: 0, gain: 0 } }, voiceFx: { allowed: true, active: true, testing: "idle" } },
    help: "The voice changer (the operator's module): on / off for this phone, a preset or custom values, a test recording. $voiceFx: allowed (the module lets this user in), active (the voice is being changed now), testing (idle | recording | playing).",
  },
];

const TREES: Record<string, ANode> = {
  "settings.voiceFx": page("{_'fx.title'}", [
    caption("intro", "{_'fx.intro'}"),
    caption("not-allowed", "{_'fx.notAllowed'}", `!${ALLOWED}`, "@warning"),
    n("controls", "column", { if: ALLOWED }, [
      toggleRow("on", "wand-sparkles", "{_'fx.on'}", "voiceFx.on"),
      selectRow("preset", "audio-lines", "{_'fx.preset'}", "voiceFx.preset", PRESET_OPTIONS),
      n("custom", "column", { if: "$settings.voiceFx.preset == 'custom'" }, [
        sliderRow("pitch", "music", "{_'fx.pitch'}", "voiceFx.pitch", -12, 12, 1),
        sliderRow("formant", "audio-lines", "{_'fx.formant'}", "voiceFx.formant", -12, 12, 1),
        sliderRow("robot", "bot", "{_'fx.robot'}", "voiceFx.robot", 0, 400, 5),
        sliderRow("echo", "refresh-ccw", "{_'fx.echo'}", "voiceFx.echo", 0, 1, 0.05),
        sliderRow("echoMs", "timer", "{_'fx.echoMs'}", "voiceFx.echoMs", 40, 1000, 10),
        sliderRow("whisper", "cloud", "{_'fx.whisper'}", "voiceFx.whisper", 0, 1, 0.05),
        sliderRow("gain", "volume-2", "{_'fx.gain'}", "voiceFx.gain", -12, 12, 1),
        n("reset", "button", { text: "{_'fx.reset'}", props: { icon: "rotate-ccw", variant: "text" }, style: { margin: "4 20 0 20" }, on: click("voiceFx.reset") }),
      ]),
      n("test", "button", { text: "{=$voiceFx.testing == 'idle' ? _('fx.test') : _('fx.stopTest')}", props: { icon: "mic", variant: "tonal" }, style: { margin: "12 20 4 20" }, on: click("voiceFx.test") }),
      caption("recording", "● {_'fx.recording'}", "$voiceFx.testing == 'recording'", "@danger"),
      caption("playing", "▶ {_'fx.playing'}", "$voiceFx.testing == 'playing'"),
      caption("test-off", "{_'fx.testOff'}", "!$settings.voiceFx.on"),
    ]),
    caption("limits", "{_'fx.limits'}"),
  ]),
};

const find = (node: ANode, id: string): ANode | null => {
  if (node.id === id) return node;
  for (const c of node.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
};

/** Settings › Voice: the voice changer's row (after the test button); the attach sheet: "as voice" without text too. */
function patch(screens: Record<string, ANode>): void {
  const voice = screens["settings.voice"];
  const list = voice ? find(voice, "list") : null;
  if (list && !find(list, "fx")) {
    const kids = list.children ?? [];
    const at = kids.findIndex((k) => k.id === "test");
    kids.splice(at < 0 ? kids.length : at + 1, 0, navRow("fx", "wand-sparkles", "{_'fx.title'}", "settings.voiceFx", "{=$settings.voiceFx.on ? _('fx.sub.on') : _('fx.sub')}"));
    list.children = kids;
  }
  // 6.7: "Send the text as voice" dictates first when the field is empty — the tile is always there.
  const attach = screens.attach;
  const tile = attach ? find(attach, "astts") : null;
  if (tile?.if === "$composer.hasText") delete tile.if;
}

const cs: Record<string, string> = {
  "fx.title": "Měnič hlasu",
  "fx.sub": "Vypnuto · předvolby, výška, barva hlasu",
  "fx.sub.on": "Zapnuto — hovory a hlasové zprávy jdou změněné",
  "fx.intro": "Mění hlas, který aplikace nahrává mikrofonem: hlasové zprávy a hovory. Jen v telefonu — kvůli tomu nikam neodchází žádný zvuk; zpráva i hovor jdou dál šifrované.",
  "fx.notAllowed": "Měnič hlasu nezapnul provozovatel serveru (konzole › Moduly a skupiny).",
  "fx.on": "Měnit můj hlas",
  "fx.preset": "Předvolba",
  "fx.p.off": "Beze změny",
  "fx.p.higher": "Vyšší",
  "fx.p.lower": "Nižší",
  "fx.p.deep": "Hluboký (obr)",
  "fx.p.robot": "Robot",
  "fx.p.echo": "Ozvěna",
  "fx.p.whisper": "Šepot",
  "fx.p.anonymous": "Anonym",
  "fx.p.custom": "Vlastní",
  "fx.pitch": "Výška (půltóny)",
  "fx.formant": "Barva — formanty",
  "fx.robot": "Robot (Hz)",
  "fx.echo": "Ozvěna",
  "fx.echoMs": "Zpoždění ozvěny (ms)",
  "fx.whisper": "Šepot",
  "fx.gain": "Hlasitost (dB)",
  "fx.reset": "Výchozí hodnoty",
  "fx.test": "Vyzkoušet: nahrát 4 s a přehrát",
  "fx.stopTest": "Zastavit",
  "fx.recording": "Nahrávám… mluvte",
  "fx.playing": "Přehrávám…",
  "fx.testOff": "Měnič je vypnutý — uslyšíte svůj hlas beze změny.",
  "fx.limits": "Diktování (rozpoznávání řeči v telefonu) poslouchá mikrofon samo a vrací jen text — měnič se na něj nevztahuje. Hovory: hlas se mění v mikrofonu ještě před šifrováním; bez sluchátek může druhá strana slyšet ozvěnu svého hlasu změněnou.",
  "dict.stop": "Zastavit diktování",
  "dict.starting": "Spouštím poslech…",
  "dict.err.not-allowed": "Mikrofon není povolen.",
  "dict.err.audio-capture": "Mikrofon nejde použít (možná ho drží jiná aplikace).",
  "dict.err.no-microphone": "Mikrofon nenalezen.",
  "dict.err.network": "Rozpoznávání řeči nemá síť — zkouším dál.",
  "dict.err.language-not-supported": "Tento jazyk rozpoznávání řeči v telefonu neumí.",
  "dict.err.unsupported": "Rozpoznávání řeči se nespustilo.",
  "dict.err.ended": "Nic jsem neslyšel — diktování skončilo.",
  "dict.err.other": "Diktování selhalo ({code}).",
  "speakSend.speakNow": "Mluvte — ■ zastaví a odešle jako hlas",
  "speakSend.speakNowText": "Mluvte — ■ nebo Odeslat pošle text",
  "speakSend.noVoice": "V telefonu není hlas pro převod textu na řeč (nainstalujte hlas, nebo v Nastavení › Hlas zvolte „Na serveru“).",
  "speakSend.serverOff": "Server nemá zapnutý převod textu na řeč.",
  "speakSend.failed": "Převod textu na řeč selhal",
  "send.asVoiceHint": "Text (nebo, je-li pole prázdné, co teď nadiktujete) přečte hlas a odejde jako šifrovaná hlasová zpráva.",
  "send.voiceTextHint": "Mluvíte, text se píše do pole; ■ nebo Odeslat ho pošle jako zprávu.",
};

const en: Record<string, string> = {
  "fx.title": "Voice changer",
  "fx.sub": "Off · presets, pitch, timbre",
  "fx.sub.on": "On — calls and voice messages go changed",
  "fx.intro": "Changes the voice the app records with the microphone: voice messages and calls. On the phone only — no audio leaves it for this; the message and the call still go end-to-end encrypted.",
  "fx.notAllowed": "The voice changer has not been turned on by the server's operator (console › Modules & groups).",
  "fx.on": "Change my voice",
  "fx.preset": "Preset",
  "fx.p.off": "No change",
  "fx.p.higher": "Higher",
  "fx.p.lower": "Lower",
  "fx.p.deep": "Deep (giant)",
  "fx.p.robot": "Robot",
  "fx.p.echo": "Echo",
  "fx.p.whisper": "Whisper",
  "fx.p.anonymous": "Anonymous",
  "fx.p.custom": "Custom",
  "fx.pitch": "Pitch (semitones)",
  "fx.formant": "Timbre — formants",
  "fx.robot": "Robot (Hz)",
  "fx.echo": "Echo",
  "fx.echoMs": "Echo delay (ms)",
  "fx.whisper": "Whisper",
  "fx.gain": "Volume (dB)",
  "fx.reset": "Reset",
  "fx.test": "Try it: record 4 s, play back",
  "fx.stopTest": "Stop",
  "fx.recording": "Recording… speak",
  "fx.playing": "Playing…",
  "fx.testOff": "The voice changer is off — you will hear your voice unchanged.",
  "fx.limits": "Dictation (the phone's speech recognition) listens to the microphone itself and gives only text — the voice changer does not apply to it. Calls: the voice is changed at the microphone, before encryption; without headphones the other side may hear the echo of their own voice changed.",
  "dict.stop": "Stop dictation",
  "dict.starting": "Starting to listen…",
  "dict.err.not-allowed": "The microphone is not allowed.",
  "dict.err.audio-capture": "The microphone cannot be used (another app may hold it).",
  "dict.err.no-microphone": "No microphone found.",
  "dict.err.network": "Speech recognition has no network — still trying.",
  "dict.err.language-not-supported": "The phone's speech recognition does not know this language.",
  "dict.err.unsupported": "Speech recognition did not start.",
  "dict.err.ended": "I heard nothing — dictation stopped.",
  "dict.err.other": "Dictation failed ({code}).",
  "speakSend.speakNow": "Speak — ■ stops and sends it as voice",
  "speakSend.speakNowText": "Speak — ■ or Send sends the text",
  "speakSend.noVoice": "There is no text-to-speech voice on this phone (install one, or choose “On the server” in Settings › Voice).",
  "speakSend.serverOff": "The server has no text to speech turned on.",
  "speakSend.failed": "Text to speech failed",
  "send.asVoiceHint": "The text (or, with an empty field, what you dictate now) is read by a voice and goes as an encrypted voice message.",
  "send.voiceTextHint": "You speak, the text appears in the field; ■ or Send sends it as a message.",
};

const de: Record<string, string> = {
  "fx.title": "Stimmverzerrer",
  "fx.sub": "Aus · Voreinstellungen, Tonhöhe, Klangfarbe",
  "fx.sub.on": "An — Anrufe und Sprachnachrichten gehen verändert",
  "fx.intro": "Verändert die Stimme, die die App mit dem Mikrofon aufnimmt: Sprachnachrichten und Anrufe. Nur auf dem Telefon — dafür verlässt kein Ton das Gerät; Nachricht und Anruf bleiben Ende-zu-Ende verschlüsselt.",
  "fx.notAllowed": "Der Betreiber des Servers hat den Stimmverzerrer nicht eingeschaltet (Konsole › Module & Gruppen).",
  "fx.on": "Meine Stimme verändern",
  "fx.preset": "Voreinstellung",
  "fx.p.off": "Unverändert",
  "fx.p.higher": "Höher",
  "fx.p.lower": "Tiefer",
  "fx.p.deep": "Tief (Riese)",
  "fx.p.robot": "Roboter",
  "fx.p.echo": "Echo",
  "fx.p.whisper": "Flüstern",
  "fx.p.anonymous": "Anonym",
  "fx.p.custom": "Eigene",
  "fx.pitch": "Tonhöhe (Halbtöne)",
  "fx.formant": "Klangfarbe — Formanten",
  "fx.robot": "Roboter (Hz)",
  "fx.echo": "Echo",
  "fx.echoMs": "Echo-Verzögerung (ms)",
  "fx.whisper": "Flüstern",
  "fx.gain": "Lautstärke (dB)",
  "fx.reset": "Zurücksetzen",
  "fx.test": "Testen: 4 s aufnehmen, abspielen",
  "fx.stopTest": "Stopp",
  "fx.recording": "Aufnahme… sprechen Sie",
  "fx.playing": "Wiedergabe…",
  "fx.testOff": "Der Stimmverzerrer ist aus — Sie hören Ihre Stimme unverändert.",
  "fx.limits": "Das Diktat (die Spracherkennung des Telefons) hört das Mikrofon selbst und liefert nur Text — der Stimmverzerrer gilt dafür nicht. Anrufe: die Stimme wird am Mikrofon verändert, vor der Verschlüsselung; ohne Kopfhörer hört die Gegenseite vielleicht das Echo ihrer eigenen Stimme verändert.",
  "dict.stop": "Diktat beenden",
  "dict.starting": "Starte das Zuhören…",
  "dict.err.not-allowed": "Das Mikrofon ist nicht erlaubt.",
  "dict.err.audio-capture": "Das Mikrofon lässt sich nicht nutzen (vielleicht hält es eine andere App).",
  "dict.err.no-microphone": "Kein Mikrofon gefunden.",
  "dict.err.network": "Die Spracherkennung hat kein Netz — ich versuche es weiter.",
  "dict.err.language-not-supported": "Die Spracherkennung des Telefons kennt diese Sprache nicht.",
  "dict.err.unsupported": "Die Spracherkennung ist nicht gestartet.",
  "dict.err.ended": "Ich habe nichts gehört — das Diktat ist beendet.",
  "dict.err.other": "Das Diktat ist fehlgeschlagen ({code}).",
  "speakSend.speakNow": "Sprechen Sie — ■ beendet und sendet als Sprache",
  "speakSend.speakNowText": "Sprechen Sie — ■ oder Senden schickt den Text",
  "speakSend.noVoice": "Auf diesem Telefon gibt es keine Stimme für die Sprachausgabe (installieren Sie eine oder wählen Sie „Auf dem Server“ in Einstellungen › Sprache).",
  "speakSend.serverOff": "Auf dem Server ist keine Sprachausgabe eingeschaltet.",
  "speakSend.failed": "Die Sprachausgabe ist fehlgeschlagen",
  "send.asVoiceHint": "Der Text (oder, bei leerem Feld, was Sie jetzt diktieren) wird von einer Stimme gelesen und geht als verschlüsselte Sprachnachricht.",
  "send.voiceTextHint": "Sie sprechen, der Text erscheint im Feld; ■ oder Senden schickt ihn als Nachricht.",
};

export const AREA: DesignArea = {
  actions: [
    { action: "voiceFx.test", arg: "", help: "The voice changer's test: record 4 s through it and play them back (again: stop)" },
    { action: "voiceFx.reset", arg: "", help: "The voice changer's custom values back to the defaults" },
  ],
  screens: SCREENS,
  trees: TREES,
  strings: { cs, en, de },
  patch,
};
