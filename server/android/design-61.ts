// The Android design, 6.1 additions: what the app gained to match the web
// client (docs/android-architecture.md §10) — settings as screens of the
// design (every switch, choice and slider bound to a setting), the account
// (passkeys), message kinds and delivery states, attachments, dictation and
// speech, the quick tools (AI assistant, voice, NFC, appearance), calls with
// video and audio ↔ text. design.ts merges these into its catalog and its
// default design; an operator's saved design keeps its own trees and gets
// the new screens from here.

import type { ANode, MenuItem, PropDef } from "./design";

type Opts = Omit<ANode, "id" | "el" | "children">;
const n = (id: string, el: string, o: Opts = {}, children?: ANode[]): ANode => ({ id, el, ...o, ...(children ? { children } : {}) });
const click = (action: string, arg?: string) => ({ click: arg === undefined ? { action } : { action, arg } });
const P = (name: string, kind: PropDef["kind"], label: string, extra: Partial<PropDef> = {}): PropDef => ({ name, kind, label, ...extra });

/* ================================================================ catalog */

/** New elements: choices bound to a setting or a form value. */
export const ELEMENTS_61 = [
  { el: "select", label: "Select", group: "controls" as const, container: false, text: false, props: [P("setting", "text", "Setting", { help: "e.g. voice.lang — read and changed by the element" }), P("bind", "text", "Or a form value"), P("options", "text", "Options", { help: "value:Label|value2:{_'key'} or =$list (values or {value, label})" }), P("hint", "text", "Hint")], help: "A drop-down choice; its change event follows the new value ($value)." },
  { el: "slider", label: "Slider", group: "controls" as const, container: false, text: false, props: [P("setting", "text", "Setting"), P("bind", "text", "Or a form value"), P("min", "number", "Minimum"), P("max", "number", "Maximum"), P("step", "number", "Step")], help: "A number on a track (rate, pitch, size…)." },
  { el: "segmented", label: "Segmented", group: "controls" as const, container: false, text: false, props: [P("setting", "text", "Setting"), P("bind", "text", "Or a form value"), P("options", "text", "Options", { help: "value:Label|…" })], help: "A few choices side by side (tone, density…)." },
];

/** switch / checkbox may be bound to a setting (or a form value) directly. */
export const TOGGLE_PROPS_61: PropDef[] = [P("setting", "text", "Setting", { help: "e.g. voice.autoplay — the switch changes it itself" }), P("bind", "text", "Or a form value")];

export const EVENTS_61 = ["change"] as const;

export const ACTIONS_61: Array<{ action: string; arg: string; help: string }> = [
  { action: "setting.set", arg: "key=value", help: "Change a setting (Settings: voice.rate=1.2, location.inHeader=true…)" },
  { action: "setting.toggle", arg: "key", help: "Switch a yes/no setting" },
  { action: "sheet.open", arg: "screen id", help: "Show a screen of the design as a sheet from the bottom (attach, tools…)" },
  { action: "sheet.close", arg: "", help: "Close the sheet" },
  { action: "compose", arg: "photo | camera | file | location | voice | voiceText | asVoice | dictate", help: "The composer: a picture, the camera, a file, the position, a voice message, speech sent as text, the text as speech, dictation" },
  { action: "message.kind", arg: "normal | tap | vanish[:seconds] | seal[:code]", help: "The kind of the next message (they combine)" },
  { action: "message.recipients", arg: "", help: "Choose who gets the next message (a private message)" },
  { action: "msg.map", arg: "message id", help: "Open the sender's position on a map" },
  { action: "msg.source", arg: "message id", help: "Play the recording a transcript came from" },
  { action: "msg.open", arg: "message id", help: "Open the message's file in another app" },
  { action: "voice.speak", arg: "text", help: "Read a text aloud (the voice settings)" },
  { action: "voice.stop", arg: "", help: "Stop reading" },
  { action: "voice.dictate", arg: "", help: "Start / stop dictation (the voice tool)" },
  { action: "ai.send", arg: "", help: "Send $form.aiInput to the AI assistant" },
  { action: "ai.stop", arg: "", help: "Stop the answer" },
  { action: "ai.clear", arg: "", help: "A new conversation" },
  { action: "nfc.read", arg: "", help: "Read a tag (a room's connection card with $form.nfcPin)" },
  { action: "nfc.write", arg: "", help: "Write the active room to a tag, sealed with $form.nfcPin" },
  { action: "nfc.emulate", arg: "", help: "Answer as a tag with the active room's card (another phone reads it)" },
  { action: "nfc.stop", arg: "", help: "Stop reading / writing / answering" },
  { action: "account.signin", arg: "", help: "Sign in with a passkey" },
  { action: "account.signup", arg: "", help: "Create an account with a new passkey" },
  { action: "account.signout", arg: "everywhere (empty = this device)", help: "Sign out" },
  { action: "pin.change", arg: "", help: "Change the PIN" },
  { action: "biometric.toggle", arg: "", help: "Unlock with biometrics on / off" },
  { action: "wipe.ask", arg: "", help: "Erase all data (asks first)" },
  { action: "system.settings", arg: "notifications | app | location", help: "The phone's settings for the app" },
  { action: "call.audioText", arg: "", help: "A call where my messages are spoken into it and what the others say is written" },
  { action: "call.camera", arg: "", help: "Camera on / off in a video call" },
  { action: "call.switchCamera", arg: "", help: "Front / back camera" },
  { action: "call.speaker", arg: "", help: "Speaker / earpiece" },
  { action: "appearance.reset", arg: "", help: "The design's look again (no own tone, accent or size)" },
];

export const SLOTS_61: Array<{ name: string; label: string; screens: string[] }> = [
  { name: "msgBody", label: "Message body (kinds, text, attachment, outputs)", screens: ["message.in", "message.out"] },
  { name: "aiChat", label: "AI conversation", screens: ["ai"] },
  { name: "voicePad", label: "Dictation and speech", screens: ["voice"] },
  { name: "nfcPanel", label: "NFC reader / writer", screens: ["nfc"] },
];

const APP = { name: "M5cet", version: "6.1.0", code: 61000, bundle: "6.1.0-b1" };
const SETTINGS_SAMPLE = {
  "messages": { vanishSeconds: 60, ttlMinutes: 0, receipts: true, readReceipts: true, enterSends: false },
  "location": { inHeader: false, track: false, interval: 60, precise: true },
  "voice": { engine: "device", lang: "", voice: "", rate: 1, pitch: 1, autoplay: false, dictateSpeak: false, dictateSend: false },
  "calls": { audioText: false, speaker: true }, callLog: false,
  "appearance": { tone: "system", preset: "design", accent: "", fontScale: 1, density: "normal", bubbles: "rounded" },
  "nfc": { emulate: false },
  "security": { shufflePin: false },
};
const VOICES = [{ value: "", label: "Default" }, { value: "cs-cz-x-jfs-local", label: "cs-CZ · jfs ★" }];

export const SCREENS_61 = [
  { id: "tools", label: "Tools (sheet)", group: "app" as const, vars: ["$tools", "$settings"], sample: { tools: { ai: true, voice: true, nfc: true }, settings: SETTINGS_SAMPLE }, help: "The quick tools (the hammer): AI assistant, voice, NFC, appearance, position." },
  { id: "attach", label: "Attach (sheet)", group: "room" as const, vars: ["$composer", "$settings"], sample: { composer: { hasText: true, tap: false, vanish: 0, sealed: false, private: false }, settings: SETTINGS_SAMPLE }, help: "The + of the composer: picture, camera, file, position, voice message; the message's kind and recipients." },
  { id: "send.options", label: "Send options (sheet)", group: "room" as const, vars: ["$composer", "$settings"], sample: { composer: { hasText: true }, settings: SETTINGS_SAMPLE }, help: "A long press on Send: the text as a voice message, speech sent as text, kinds." },
  { id: "dictate.options", label: "Dictation options (sheet)", group: "room" as const, vars: ["$settings", "$voices"], sample: { settings: SETTINGS_SAMPLE, voices: VOICES }, help: "A long press on the microphone: read back, send at once, language." },
  { id: "call.options", label: "Call options (sheet)", group: "room" as const, vars: ["$settings", "$call"], sample: { settings: SETTINGS_SAMPLE, call: { active: false } }, help: "A long press on the call button: audio, video, audio ↔ text." },
  { id: "settings.user", label: "Settings › User", group: "app" as const, vars: ["$account", "$keys", "$connection"], sample: { account: { signedIn: true, username: "bystry-sokol-7k3q", credential: "Xy12AbCdEf34…", passkeys: 2, sessions: 3, groups: "user, staff", since: 1760000000000, lastLogin: 1760900000000, keyVerified: true }, keys: { device: "and_mun44x0d02651c81e33d", deviceKey: "ptM0vNPIIsAo4sr7", identity: "3C4D 5E6F 7A8B 9C0D", server: "A6D3 34BC D3C8 22C0" }, connection: { server: "https://chat.example.com", rooms: 2, status: "joined", push: "fcm", checkin: 1760900000000, protocol: 2, crypto: "v3", turn: 2 } }, help: "The account (passkey sign-in / out), the keys and the connection." },
  { id: "settings.messages", label: "Settings › Messages", group: "app" as const, vars: ["$settings"], sample: { settings: SETTINGS_SAMPLE }, help: "Receipts, Enter sends, vanishing time, expiry." },
  { id: "settings.voice", label: "Settings › Voice", group: "app" as const, vars: ["$settings", "$voices"], sample: { settings: SETTINGS_SAMPLE, voices: VOICES }, help: "Engine, language, voice, rate, pitch, reading aloud, dictation." },
  { id: "settings.location", label: "Settings › Location", group: "app" as const, vars: ["$settings", "$location"], sample: { settings: SETTINGS_SAMPLE, location: { permitted: true, tracking: false, allowed: true } }, help: "The position in messages, tracking." },
  { id: "settings.calls", label: "Settings › Calls", group: "app" as const, vars: ["$settings"], sample: { settings: SETTINGS_SAMPLE }, help: "Audio ↔ text calls, speaker, the call log." },
  { id: "settings.appearance", label: "Settings › Appearance", group: "app" as const, vars: ["$settings", "$presets"], sample: { settings: SETTINGS_SAMPLE, presets: [{ value: "design", label: "Design" }, { value: "midnight", label: "Midnight" }] }, help: "Tone, template, accent, size, density, bubbles." },
  { id: "settings.security", label: "Settings › Security", group: "app" as const, vars: ["$security", "$settings"], sample: { security: { biometricAvailable: true, biometric: true, pinLength: 6, maxAttempts: 8, wipe: true, screenshots: false }, settings: SETTINGS_SAMPLE }, help: "Lock, biometrics, PIN, the PIN pad's shuffle, erase." },
  { id: "ai", label: "AI assistant", group: "app" as const, vars: ["$ai"], sample: { ai: { state: "ready", model: "anthropic/claude-sonnet-5-5", busy: false } }, help: "A conversation with the operator's AI (not end-to-end encrypted)." },
  { id: "voice", label: "Voice", group: "app" as const, vars: ["$voice", "$settings", "$voices"], sample: { voice: { dictating: false, listening: false, speaking: false, available: true }, settings: SETTINGS_SAMPLE, voices: VOICES }, help: "Dictation to text, reading aloud, the voice settings at hand." },
  { id: "nfc", label: "NFC", group: "app" as const, vars: ["$nfc", "$room"], sample: { nfc: { available: true, enabled: true, state: "idle", last: null, emulating: false }, room: { name: "team" } }, help: "Read and write a room's connection card, answer as a tag." },
];

/* ================================================================= trees */

const bar = (title: string, extra: ANode[] = []) => n("bar", "row", { style: { padding: "8 4 8 4", align: "center", gap: 4, bg: "@surface", elevation: 2 } }, [
  n("back", "iconButton", { props: { icon: "arrow-left", label: "{_'nav.back'}" }, on: click("back") }),
  n("title", "text", { text: title, props: { variant: "title" }, style: { bold: true, weight: 1, lines: 1 } }),
  ...extra,
]);

const section = (id: string, key: string) => n(id, "text", { text: `{_'${key}'}`, props: { variant: "label" }, style: { fg: "@primary", padding: "18 20 6 20", bold: true } });

const hintText = (id: string, key: string, cond?: string) => n(id, "text", { ...(cond ? { if: cond } : {}), text: `{_'${key}'}`, props: { variant: "caption" }, style: { fg: "@muted", padding: "0 20 8 64" } });

/** A row that opens a screen: icon, label (+ a line under it), chevron. */
const navRow = (id: string, icon: string, label: string, target: string, sub?: string): ANode => n(id, "row", { style: { padding: "12 20", gap: 18, align: "center" }, on: click("screen.open", target) }, [
  n(`${id}-icon`, "icon", { props: { icon, size: 22, color: "@muted" } }),
  n(`${id}-col`, "column", { style: { weight: 1 } }, [
    n(`${id}-label`, "text", { text: label, style: { size: 16 } }),
    ...(sub ? [n(`${id}-sub`, "text", { text: sub, props: { variant: "caption" }, style: { fg: "@muted", lines: 1 } })] : []),
  ]),
  n(`${id}-go`, "icon", { props: { icon: "chevron-right", size: 18, color: "@muted" } }),
]);

/** A row with an action (no chevron). */
const actRow = (id: string, icon: string, label: string, action: string, arg?: string, color?: string): ANode => n(id, "row", { style: { padding: "14 20", gap: 18, align: "center" }, on: click(action, arg) }, [
  n(`${id}-icon`, "icon", { props: { icon, size: 22, color: color ?? "@muted" } }),
  n(`${id}-label`, "text", { text: label, style: { size: 16, weight: 1, ...(color ? { fg: color } : {}) } }),
]);

/** A switch bound to a setting. */
const toggleRow = (id: string, icon: string, label: string, setting: string, hint?: string): ANode => n(id, "column", {}, [
  n(`${id}-row`, "row", { style: { padding: "10 12 10 20", gap: 18, align: "center" } }, [
    n(`${id}-icon`, "icon", { props: { icon, size: 22, color: "@muted" } }),
    n(`${id}-label`, "text", { text: label, style: { size: 16, weight: 1 } }),
    n(`${id}-switch`, "switch", { props: { setting } }),
  ]),
  ...(hint ? [hintText(`${id}-hint`, hint)] : []),
]);

/** A labelled choice bound to a setting. */
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

const segRow = (id: string, label: string, setting: string, options: string): ANode => n(id, "column", { style: { padding: "8 20", gap: 8 } }, [
  n(`${id}-label`, "text", { text: label, style: { size: 16 } }),
  n(`${id}-seg`, "segmented", { props: { setting, options } }),
]);

const infoRow = (id: string, label: string, value: string, mono = false): ANode => n(id, "row", { style: { padding: "6 20", gap: 12, align: "center" } }, [
  n(`${id}-label`, "text", { text: label, props: { variant: "caption" }, style: { fg: "@muted", width: 120 } }),
  n(`${id}-value`, "text", { text: value, props: mono ? { variant: "mono" } : {}, style: { weight: 1, size: 13 } }),
]);

const page = (title: string, body: ANode[]): ANode => n("root", "column", { style: { width: "match", height: "match", bg: "@background" } }, [
  bar(title),
  n("scroll", "scroll", { style: { weight: 1 } }, [n("list", "column", { style: { padding: "0 0 24 0" } }, body)]),
]);

/** A sheet: a handle, a title, then tiles or rows. */
const sheet = (title: string, body: ANode[]): ANode => n("root", "column", { style: { bg: "@surface", radius: 24, padding: "10 12 20 12", gap: 6 }, anim: { enter: { type: "slide-up", ms: 220, easing: "decelerate" } } }, [
  n("handle", "row", { style: { justify: "center", padding: "0 0 6 0" } }, [n("grip", "spacer", { props: { size: 4 }, style: { width: 40, bg: "@border", radius: 2 } })]),
  n("title", "text", { text: title, props: { variant: "title" }, style: { bold: true, padding: "0 8 6 8" } }),
  ...body,
]);

/** A tile of a sheet's grid: a round icon over a label. */
const tile = (id: string, icon: string, label: string, action: string, arg?: string, cond?: string): ANode => n(id, "column", { ...(cond ? { if: cond } : {}), style: { weight: 1, align: "center", gap: 6, padding: "10 4", radius: 16 }, on: click(action, arg) }, [
  n(`${id}-icon`, "column", { style: { bg: "@surfaceVariant", radius: 20, padding: 12, align: "center" } }, [n(`${id}-i`, "icon", { props: { icon, size: 24, color: "@primary" } })]),
  n(`${id}-label`, "text", { text: label, props: { variant: "caption", align: "center" }, style: { lines: 2 } }),
]);

const grid = (id: string, tiles: ANode[]): ANode => n(id, "row", { style: { gap: 4, align: "start" } }, tiles);

const TTL_OPTIONS = "0:{_'set.never'}|60:1 h|1440:24 h|10080:7 d";
const VANISH_OPTIONS = "4:4 s|15:15 s|60:1 min|300:5 min|1800:30 min|3600:1 h|7200:2 h";
// 6.13: with Slovenian and Finnish — the app's nine languages, and Polish.
const LANG_OPTIONS = ":{_'set.appLanguage'}|cs:Čeština|en:English|de:Deutsch|sk:Slovenčina|pl:Polski|fr:Français|es:Español|it:Italiano|sl:Slovenščina|fi:Suomi";

export const SCREENS_TREES_61: Record<string, ANode> = {
  tools: sheet("{_'tools.title'}", [
    grid("row1", [
      tile("ai", "bot", "{_'tools.ai'}", "screen.open", "ai"),
      tile("voice", "audio-lines", "{_'tools.voice'}", "screen.open", "voice"),
      tile("nfc", "nfc", "{_'tools.nfc'}", "screen.open", "nfc"),
      tile("look", "palette", "{_'tools.appearance'}", "screen.open", "settings.appearance"),
    ]),
    grid("row2", [
      tile("pos", "map-pin", "{_'tools.position'}", "compose", "location"),
      tile("dict", "mic", "{_'tools.dictate'}", "compose", "dictate"),
      tile("user", "user-round", "{_'set.user'}", "screen.open", "settings.user"),
      tile("settings", "settings", "{_'menu.settings'}", "screen.open", "settings"),
    ]),
  ]),
  attach: sheet("{_'attach.title'}", [
    grid("media", [
      tile("photo", "image", "{_'attach.photo'}", "compose", "photo"),
      tile("camera", "camera", "{_'attach.camera'}", "compose", "camera"),
      tile("file", "paperclip", "{_'attach.file'}", "compose", "file"),
      tile("pos", "map-pin", "{_'attach.position'}", "compose", "location"),
    ]),
    grid("voice", [
      tile("rec", "mic", "{_'attach.voice'}", "compose", "voice"),
      tile("rectext", "speech", "{_'attach.voiceText'}", "compose", "voiceText"),
      tile("astts", "volume-2", "{_'attach.asVoice'}", "compose", "asVoice", "$composer.hasText"),
      tile("to", "users", "{_'msg.recipients'}", "message.recipients"),
    ]),
    n("kinds-title", "text", { text: "{_'attach.kinds'}", props: { variant: "label" }, style: { fg: "@muted", padding: "8 8 2 8" } }),
    n("kinds", "row", { props: { wrap: true }, style: { gap: 8, padding: "0 8" } }, [
      n("k-tap", "chip", { text: "{_'msgkind.tap'}", props: { icon: "eye", selected: "=$composer.tap" }, on: click("message.kind", "tap") }),
      n("k-vanish", "chip", { text: "{_'msgkind.vanish'}", props: { icon: "timer", selected: "=$composer.vanish > 0" }, on: click("message.kind", "vanish") }),
      n("k-seal", "chip", { text: "{_'msgkind.sealed'}", props: { icon: "scroll-text", selected: "=$composer.sealed" }, on: click("message.kind", "seal") }),
      n("k-normal", "chip", { text: "{_'msgkind.normal'}", props: { icon: "message-square" }, on: click("message.kind", "normal") }),
    ]),
  ]),
  "send.options": sheet("{_'send.title'}", [
    actRow("asvoice", "volume-2", "{_'attach.asVoice'}", "compose", "asVoice"),
    hintText("asvoice-hint", "send.asVoiceHint"),
    actRow("rectext", "speech", "{_'attach.voiceText'}", "compose", "voiceText"),
    hintText("rectext-hint", "send.voiceTextHint"),
    actRow("seal", "scroll-text", "{_'msgkind.sealed'}", "message.kind", "seal"),
    actRow("vanish", "timer", "{_'msgkind.vanish'}", "message.kind", "vanish"),
    actRow("tap", "eye", "{_'msgkind.tap'}", "message.kind", "tap"),
  ]),
  "dictate.options": sheet("{_'dictate.title'}", [
    toggleRow("speak", "volume-2", "{_'set.voice.dictateSpeak'}", "voice.dictateSpeak", "set.voice.dictateSpeakHint"),
    toggleRow("send", "send", "{_'set.voice.dictateSend'}", "voice.dictateSend"),
    selectRow("lang", "languages", "{_'set.voice.lang'}", "voice.lang", LANG_OPTIONS),
    actRow("more", "sliders-horizontal", "{_'set.voice'}", "screen.open", "settings.voice"),
  ]),
  "call.options": sheet("{_'callopt.title'}", [
    actRow("audio", "phone", "{_'call.audio'}", "call.audio"),
    actRow("video", "video", "{_'call.video'}", "call.video"),
    actRow("text", "speech", "{_'call.audioText'}", "call.audioText"),
    hintText("text-hint", "call.audioTextHint"),
    toggleRow("speaker", "speaker", "{_'set.calls.speaker'}", "calls.speaker"),
  ]),
  settings: page("{_'settings.title'}", [
    navRow("user", "user-round", "{_'set.user'}", "settings.user", "{=$account.signedIn ? $account.username : _('set.user.signedOut')}"),
    navRow("messages", "message-square", "{_'set.messages'}", "settings.messages", "{_'set.messages.sub'}"),
    navRow("voice", "audio-lines", "{_'set.voice'}", "settings.voice", "{_'set.voice.sub'}"),
    navRow("location", "map-pin", "{_'set.location'}", "settings.location", "{_'set.location.sub'}"),
    navRow("calls", "phone", "{_'set.calls'}", "settings.calls", "{_'set.calls.sub'}"),
    navRow("appearance", "palette", "{_'set.appearance'}", "settings.appearance", "{_'set.appearance.sub'}"),
    navRow("security", "lock", "{_'set.security'}", "settings.security", "{_'set.security.sub'}"),
    actRow("notifications", "bell", "{_'settings.notifications'}", "system.settings", "notifications"),
    actRow("update", "refresh-cw", "{_'menu.update'}", "update.check"),
    navRow("about", "info", "{_'settings.about'}", "about"),
  ]),
  "settings.user": page("{_'set.user'}", [
    n("card", "card", { style: { margin: "16 16 4 16", padding: 16, gap: 10 } }, [
      n("who", "row", { if: "$account.signedIn", style: { gap: 14, align: "center" } }, [
        n("avatar", "avatar", { props: { name: "{$account.username}", size: 48 } }),
        n("who-col", "column", { style: { weight: 1 } }, [
          n("name", "text", { text: "{$account.username}", props: { variant: "title" }, style: { bold: true } }),
          n("via", "text", { text: "{_'set.user.viaPasskey'} · {$account.passkeys} {_'set.user.passkeys'}", props: { variant: "caption" }, style: { fg: "@muted" } }),
        ]),
        n("ok", "icon", { if: "$account.keyVerified", props: { icon: "shield-check", size: 22, color: "@success" } }),
      ]),
      n("out", "column", { if: "!$account.signedIn", style: { gap: 8 } }, [
        n("out-title", "text", { text: "{_'set.user.signedOut'}", props: { variant: "title" }, style: { bold: true } }),
        n("out-hint", "text", { text: "{_'set.user.why'}", style: { fg: "@muted" } }),
      ]),
      n("signin", "button", { if: "!$account.signedIn", text: "{_'set.user.signin'}", props: { icon: "fingerprint-pattern", variant: "primary" }, on: click("account.signin") }),
      n("signup", "button", { if: "!$account.signedIn", text: "{_'set.user.signup'}", props: { icon: "user-plus", variant: "text" }, on: click("account.signup") }),
      n("signout", "button", { if: "$account.signedIn", text: "{_'set.user.signout'}", props: { icon: "log-out", variant: "secondary" }, on: click("account.signout") }),
      n("signout-all", "button", { if: "$account.signedIn", text: "{_'set.user.signoutAll'}", props: { icon: "log-out", variant: "text" }, on: click("account.signout", "everywhere") }),
    ]),
    n("acc-info", "column", { if: "$account.signedIn" }, [
      section("acc-title", "set.user.account"),
      infoRow("acc-cred", "{_'set.user.credential'}", "{$account.credential}", true),
      infoRow("acc-groups", "{_'set.user.groups'}", "{$account.groups|default:'—'}"),
      infoRow("acc-sessions", "{_'set.user.sessions'}", "{$account.sessions}"),
      infoRow("acc-since", "{_'set.user.since'}", "{$account.since|date}"),
    ]),
    section("keys-title", "set.user.keys"),
    infoRow("k-device", "{_'set.user.device'}", "{$keys.device}", true),
    infoRow("k-devkey", "{_'set.user.deviceKey'}", "{$keys.deviceKey}", true),
    infoRow("k-identity", "{_'set.user.identity'}", "{$keys.identity}", true),
    infoRow("k-server", "{_'about.serverKey'}", "{$keys.server}", true),
    section("conn-title", "set.user.connection"),
    infoRow("c-server", "{_'enroll.server'}", "{$connection.server}"),
    infoRow("c-rooms", "{_'rooms.connected'}", "{$connection.rooms}"),
    infoRow("c-proto", "{_'set.user.protocol'}", "v{$connection.protocol} · {$connection.crypto} · {_'set.user.e2ee'}"),
    infoRow("c-push", "{_'set.user.push'}", "{=$connection.push == 'fcm' ? 'Firebase Cloud Messaging' : _('set.user.poll')}"),
    infoRow("c-checkin", "{_'set.user.checkin'}", "{$connection.checkin|datetime}"),
    infoRow("c-turn", "TURN / STUN", "{$connection.turn}"),
  ]),
  "settings.messages": page("{_'set.messages'}", [
    section("s-receipts", "set.messages.receipts"),
    toggleRow("delivered", "check-check", "{_'set.messages.delivered'}", "messages.receipts"),
    toggleRow("read", "eye", "{_'set.messages.read'}", "messages.readReceipts", "set.messages.readHint"),
    section("s-write", "set.messages.writing"),
    toggleRow("enter", "send", "{_'set.messages.enterSends'}", "messages.enterSends"),
    selectRow("vanish", "timer", "{_'set.messages.vanish'}", "messages.vanishSeconds", VANISH_OPTIONS),
    selectRow("ttl", "hourglass", "{_'set.messages.ttl'}", "messages.ttlMinutes", TTL_OPTIONS),
    hintText("ttl-hint", "set.messages.ttlHint"),
  ]),
  "settings.voice": page("{_'set.voice'}", [
    segRow("engine", "{_'set.voice.engine'}", "voice.engine", "device:{_'set.voice.device'}|server:{_'set.voice.server'}"),
    selectRow("lang", "languages", "{_'set.voice.lang'}", "voice.lang", LANG_OPTIONS),
    selectRow("voice", "speech", "{_'set.voice.voice'}", "voice.voice", "=$voices"),
    sliderRow("rate", "gauge", "{_'set.voice.rate'}", "voice.rate", 0.5, 2, 0.05),
    sliderRow("pitch", "audio-lines", "{_'set.voice.pitch'}", "voice.pitch", 0.5, 2, 0.05),
    n("test", "button", { text: "{_'set.voice.test'}", props: { icon: "volume-2", variant: "tonal" }, style: { margin: "4 20 8 20" }, on: click("voice.speak", "{_'set.voice.sample'}") }),
    section("s-auto", "set.voice.auto"),
    toggleRow("autoplay", "volume-2", "{_'set.voice.autoplay'}", "voice.autoplay", "set.voice.autoplayHint"),
    toggleRow("dspeak", "refresh-ccw", "{_'set.voice.dictateSpeak'}", "voice.dictateSpeak", "set.voice.dictateSpeakHint"),
    toggleRow("dsend", "send", "{_'set.voice.dictateSend'}", "voice.dictateSend"),
  ]),
  "settings.location": page("{_'set.location'}", [
    toggleRow("header", "map-pin", "{_'set.location.inHeader'}", "location.inHeader", "set.location.inHeaderHint"),
    toggleRow("track", "route", "{_'set.location.track'}", "location.track", "set.location.trackHint"),
    n("track-off", "text", { if: "!$location.allowed", text: "{_'set.location.notAllowed'}", props: { variant: "caption" }, style: { fg: "@warning", padding: "0 20 8 64" } }),
    selectRow("interval", "timer", "{_'set.location.interval'}", "location.interval", "15:15 s|60:1 min|300:5 min|900:15 min"),
    toggleRow("precise", "locate-fixed", "{_'set.location.precise'}", "location.precise"),
    actRow("perm", "shield", "{_'set.location.permission'}", "system.settings", "app"),
  ]),
  "settings.calls": page("{_'set.calls'}", [
    toggleRow("audiotext", "speech", "{_'set.calls.audioText'}", "calls.audioText", "call.audioTextHint"),
    toggleRow("speaker", "speaker", "{_'set.calls.speaker'}", "calls.speaker"),
    toggleRow("log", "phone", "{_'settings.callLog'}", "callLog"),
  ]),
  "settings.appearance": page("{_'set.appearance'}", [
    segRow("tone", "{_'set.appearance.tone'}", "appearance.tone", "system:{_'set.appearance.system'}|light:{_'set.appearance.light'}|dark:{_'set.appearance.dark'}"),
    selectRow("preset", "palette", "{_'set.appearance.preset'}", "appearance.preset", "=$presets"),
    selectRow("accent", "sparkles", "{_'set.appearance.accent'}", "appearance.accent", ":{_'set.appearance.default'}|red:{_'color.red'}|orange:{_'color.orange'}|green:{_'color.green'}|blue:{_'color.blue'}|violet:{_'color.violet'}"),
    sliderRow("size", "type", "{_'set.appearance.fontScale'}", "appearance.fontScale", 0.8, 1.5, 0.05),
    segRow("density", "{_'set.appearance.density'}", "appearance.density", "compact:{_'set.appearance.compact'}|normal:{_'set.appearance.normal'}|comfortable:{_'set.appearance.comfortable'}"),
    segRow("bubbles", "{_'set.appearance.bubbles'}", "appearance.bubbles", "rounded:{_'set.appearance.rounded'}|square:{_'set.appearance.square'}|minimal:{_'set.appearance.minimal'}"),
    actRow("reset", "rotate-ccw", "{_'set.appearance.reset'}", "appearance.reset"),
  ]),
  "settings.security": page("{_'set.security'}", [
    n("bio", "row", { if: "$security.biometricAvailable", style: { padding: "10 12 10 20", gap: 18, align: "center" } }, [
      n("bio-icon", "icon", { props: { icon: "fingerprint-pattern", size: 22, color: "@muted" } }),
      n("bio-label", "text", { text: "{_'settings.biometric'}", style: { size: 16, weight: 1 } }),
      n("bio-switch", "switch", { props: { checked: "$security.biometric" }, on: click("biometric.toggle") }),
    ]),
    actRow("pin", "key-round", "{_'settings.changePin'}", "pin.change"),
    toggleRow("shuffle", "shuffle", "{_'set.security.shuffle'}", "security.shufflePin", "set.security.shuffleHint"),
    actRow("lock", "lock", "{_'menu.lock'}", "lock.now"),
    infoRow("policy", "{_'set.security.policy'}", "PIN {$security.pinLength} · {$security.maxAttempts}× → {=$security.wipe ? _('set.security.wipe') : _('set.security.lockout')}"),
    infoRow("shots", "{_'set.security.screenshots'}", "{=$security.screenshots ? _('set.security.allowed') : _('set.security.blocked')}"),
    actRow("wipe", "trash", "{_'settings.wipe'}", "wipe.ask", undefined, "@danger"),
  ]),
  ai: n("root", "column", { style: { width: "match", height: "match", bg: "@background" } }, [
    bar("{_'tools.ai'}", [n("new", "iconButton", { props: { icon: "rotate-ccw", label: "{_'ai.new'}" }, on: click("ai.clear") })]),
    n("chat", "slot", { props: { name: "aiChat" }, style: { weight: 1 } }),
  ]),
  voice: n("root", "column", { style: { width: "match", height: "match", bg: "@background" } }, [
    bar("{_'tools.voice'}", [n("settings", "iconButton", { props: { icon: "sliders-horizontal", label: "{_'set.voice'}" }, on: click("screen.open", "settings.voice") })]),
    n("pad", "slot", { props: { name: "voicePad" }, style: { weight: 1 } }),
    n("quick", "column", { style: { bg: "@surface", padding: "4 0 12 0", elevation: 4 } }, [
      toggleRow("autoplay", "volume-2", "{_'set.voice.autoplay'}", "voice.autoplay"),
      toggleRow("dspeak", "refresh-ccw", "{_'set.voice.dictateSpeak'}", "voice.dictateSpeak"),
      selectRow("voice", "speech", "{_'set.voice.voice'}", "voice.voice", "=$voices"),
    ]),
  ]),
  nfc: n("root", "column", { style: { width: "match", height: "match", bg: "@background" } }, [
    bar("{_'tools.nfc'}"),
    n("panel", "slot", { props: { name: "nfcPanel" }, style: { weight: 1 } }),
  ]),
};

/** The room screen of 6.1: video, the tools (hammer), the call's options on a long press. */
export function roomBar61(): ANode {
  return n("bar", "row", { style: { padding: "8 4 8 12", align: "center", gap: 2, bg: "@surface", elevation: 2 } }, [
    n("back", "iconButton", { props: { icon: "arrow-left", label: "{_'nav.back'}" }, on: click("screen.open", "rooms") }),
    n("head", "column", { style: { weight: 1, padding: "0 4" } }, [
      n("name", "text", { text: "{$room.name}", props: { variant: "title" }, style: { bold: true, lines: 1 } }),
      n("sub", "text", { text: "{$room.users} {_'room.people'}", props: { variant: "caption" }, style: { fg: "@muted" } }),
    ]),
    n("call", "iconButton", { props: { icon: "phone", label: "{_'call.audio'}" }, on: { click: { action: "call.audio" }, longClick: { action: "sheet.open", arg: "call.options" } } }),
    n("video", "iconButton", { props: { icon: "video", label: "{_'call.video'}" }, on: click("call.video") }),
    n("tools", "iconButton", { props: { icon: "hammer", label: "{_'tools.title'}" }, on: click("sheet.open", "tools") }),
    n("users", "iconButton", { props: { icon: "users", label: "{_'users.title'}", badge: "=$users.count" }, on: click("users.toggle") }),
    n("menu", "iconButton", { props: { icon: "ellipsis-vertical", label: "{_'menu.more'}" }, on: click("menu.open", "room") }),
  ]);
}

/** Message bubbles of 6.1: the body slot, the kinds, the position pin and the recording's icon, the delivery states. */
export function messageIn61(): ANode {
  return n("row", "row", { style: { padding: "3 12", gap: 8, align: "end" }, anim: { enter: { type: "slide-up", ms: 180 } } }, [
    n("avatar", "avatar", { props: { name: "{$msg.sender}", size: 30 } }),
    n("bubble-wrap", "row", { style: { align: "center", gap: 4 } }, [
      n("bubble", "column", { style: { bg: "@bubbleIn", fg: "@onBubbleIn", radius: 16, padding: "8 12", gap: 2, maxWidth: 300, elevation: 1 } }, [
        n("sender", "text", { text: "{$msg.sender}", props: { variant: "label" }, style: { fg: "@primary", bold: true } }),
        n("forwarded", "text", { if: "$msg.forwarded", text: "↪ {_'msg.forwardedFrom'} {$msg.forwarded}", props: { variant: "caption" }, style: { fg: "@muted", italic: true } }),
        n("private", "text", { if: "$msg.private", text: "✉ {_'msg.privateTo'} {$msg.to}", props: { variant: "caption" }, style: { fg: "@muted" } }),
        n("reply", "text", { if: "$msg.replyTo", text: "↪ {$msg.replyTo.sender}: {$msg.replyTo.text|truncate:60}", props: { variant: "caption" }, style: { fg: "@muted", italic: true } }),
        n("body", "slot", { props: { name: "msgBody" } }),
        n("meta", "row", { style: { gap: 4, align: "center", self: "end" } }, [
          n("tap", "icon", { if: "$msg.tap", props: { icon: "eye", size: 12, color: "@muted" } }),
          n("vanish", "icon", { if: "$msg.vanish > 0", props: { icon: "timer", size: 12, color: "@muted" } }),
          n("sealed", "icon", { if: "$msg.sealed", props: { icon: "scroll-text", size: 12, color: "@muted" } }),
          n("changed", "icon", { if: "$msg.changed", props: { icon: "shield-alert", size: 12, color: "@warning" } }),
          n("verified", "icon", { if: "$msg.verified && !$msg.changed", props: { icon: "shield-check", size: 12, color: "@success" } }),
          n("time", "text", { text: "{$msg.time|time}", props: { variant: "caption" }, style: { fg: "@muted" } }),
          n("loc", "icon", { if: "$msg.loc", props: { icon: "map-pin", size: 14, color: "@primary" }, on: click("msg.map", "{$msg.id}") }),
        ]),
      ]),
      n("source", "iconButton", { if: "$msg.source", props: { icon: "audio-lines", label: "{_'msg.source'}" }, on: click("msg.source", "{$msg.id}") }),
    ]),
  ]);
}

export function messageOut61(): ANode {
  return n("row", "row", { style: { padding: "3 12", justify: "end" }, anim: { enter: { type: "slide-up", ms: 160 } } }, [
    n("bubble-wrap", "row", { style: { align: "center", gap: 4 } }, [
      n("source", "iconButton", { if: "$msg.source", props: { icon: "audio-lines", label: "{_'msg.source'}" }, on: click("msg.source", "{$msg.id}") }),
      n("bubble", "column", { style: { bg: "@bubbleOut", fg: "@onBubbleOut", radius: 16, padding: "8 12", gap: 2, maxWidth: 300, elevation: 1, opacity: "=$msg.status == 'queued' || $msg.status == 'sending' ? 0.75 : 1" } }, [
        n("forwarded", "text", { if: "$msg.forwarded", text: "↪ {_'msg.forwardedFrom'} {$msg.forwarded}", props: { variant: "caption" }, style: { opacity: 0.8, italic: true } }),
        n("private", "text", { if: "$msg.private", text: "✉ {_'msg.privateTo'} {$msg.to}", props: { variant: "caption" }, style: { opacity: 0.85 } }),
        n("reply", "text", { if: "$msg.replyTo", text: "↪ {$msg.replyTo.sender}: {$msg.replyTo.text|truncate:60}", props: { variant: "caption" }, style: { opacity: 0.8, italic: true } }),
        n("body", "slot", { props: { name: "msgBody" } }),
        n("meta", "row", { style: { gap: 4, align: "center", self: "end", opacity: 0.85 } }, [
          n("tap", "icon", { if: "$msg.tap", props: { icon: "eye", size: 12, color: "@onBubbleOut" } }),
          n("vanish", "icon", { if: "$msg.vanish > 0", props: { icon: "timer", size: 12, color: "@onBubbleOut" } }),
          n("sealed", "icon", { if: "$msg.sealed", props: { icon: "scroll-text", size: 12, color: "@onBubbleOut" } }),
          n("time", "text", { text: "{$msg.time|time}", props: { variant: "caption" } }),
          n("state", "icon", { props: {
            icon: "=$msg.status == 'sending' ? 'clock' : ($msg.status == 'queued' ? 'send-horizontal' : ($msg.status == 'stored' ? 'clock' : ($msg.status == 'delivered' || $msg.status == 'read' ? 'check-check' : 'check')))",
            size: 14,
            color: "=$msg.status == 'read' ? '#7cc4ff' : ($msg.status == 'stored' ? '@warning' : '@onBubbleOut')",
          } }),
          n("loc", "icon", { if: "$msg.loc", props: { icon: "map-pin", size: 14, color: "@onBubbleOut" }, on: click("msg.map", "{$msg.id}") }),
        ]),
      ]),
    ]),
  ]);
}

export const MENUS_61: Record<string, MenuItem[]> = {
  tools: [
    { id: "ai", icon: "bot", label: "{_'tools.ai'}", action: "screen.open", arg: "ai" },
    { id: "voice", icon: "audio-lines", label: "{_'tools.voice'}", action: "screen.open", arg: "voice" },
    { id: "nfc", icon: "nfc", label: "{_'tools.nfc'}", action: "screen.open", arg: "nfc" },
    { id: "look", icon: "palette", label: "{_'tools.appearance'}", action: "screen.open", arg: "settings.appearance" },
  ],
};

/* =============================================================== strings */

export const STRINGS_61: Record<"cs" | "en" | "de", Record<string, string>> = {
  cs: {
    "tools.title": "Nástroje", "tools.ai": "AI asistent", "tools.voice": "Hlas", "tools.nfc": "NFC", "tools.appearance": "Vzhled", "tools.position": "Poslat polohu", "tools.dictate": "Diktovat",
    "attach.title": "Přiložit", "attach.photo": "Fotka", "attach.camera": "Fotoaparát", "attach.file": "Soubor", "attach.position": "Poloha", "attach.voice": "Hlasová zpráva", "attach.voiceText": "Nadiktovat a poslat text", "attach.asVoice": "Poslat text jako hlas", "attach.kinds": "Druh zprávy",
    "send.title": "Odeslat jinak", "send.asVoiceHint": "Text se převede na řeč a odejde jako hlasová zpráva.", "send.voiceTextHint": "Namluvíte zprávu, převede se na text a ten se odešle.",
    "dictate.title": "Diktování", "callopt.title": "Hovor",
    "call.audioText": "Hovor hlas ↔ text", "call.audioTextHint": "Vaše zprávy se v hovoru přečtou nahlas a co ostatní řeknou, přijde jako text (s ikonou zdroje k přehrání).",
    "msgkind.tap": "Klikací", "msgkind.vanish": "Mizející", "msgkind.sealed": "Individuální (kód)", "msgkind.normal": "Běžná",
    "msg.vanished": "Dočasná zpráva už není k dispozici — vypršela.", "msg.yourCode": "Váš kód", "msg.sealed": "Zpráva je zapečetěná kódem", "msg.open": "Otevřít", "msg.wrongCode": "Nesprávný kód.", "msg.holdToReveal": "Podržte pro zobrazení", "msg.holding": "vidíte jen při podržení",
    "msg.copy": "Kopírovat", "msg.forward": "Přeposlat", "msg.map": "Poloha na mapě", "msg.source": "Přehrát zdroj", "msg.speak": "Přečíst nahlas", "msg.info": "Informace o zprávě", "msg.recipients": "Komu", "msg.everyone": "Všem", "msg.nobody": "V místnosti není nikdo další.", "msg.forwardedFrom": "Přeposláno od", "msg.privateTo": "Jen pro",
    "msg.info.sent": "Odesláno", "msg.info.from": "Od", "msg.info.state": "Stav", "msg.info.to": "Komu", "msg.info.expires": "Vyprší", "msg.info.verified": "Ověřený odesílatel",
    "msg.state.sending": "odesílá se", "msg.state.queued": "čeká na příjemce", "msg.state.sent": "odesláno", "msg.state.stored": "drží server", "msg.state.forwarded": "předáno serverem", "msg.state.delivered": "doručeno", "msg.state.read": "přečteno", "msg.state.received": "přijato",
    "file.open": "Otevřít", "file.save": "Uložit", "file.saved": "Uloženo", "file.failed": "přenos se nezdařil", "file.noApp": "Žádná aplikace to neotevře",
    "composer.attach": "Přiložit",
    "voice.dictate": "Diktovat", "voice.defaultVoice": "Výchozí hlas", "voice.synthesizing": "Převádím text na řeč…", "voice.recognizing": "Převádím řeč na text…", "voice.failed": "Nepodařilo se", "voice.nothingHeard": "Nic jsem neslyšel", "voice.listening": "Poslouchám…", "voice.tapToDictate": "Klepněte na mikrofon a mluvte", "voice.speak": "Přečíst", "voice.clear": "Smazat", "voice.toChat": "Do zprávy",
    "location.tracking": "Sdílení polohy se serverem", "location.finding": "Zjišťuji polohu…", "location.none": "Polohu se nepodařilo zjistit", "location.inHeader": "poloha v hlavičce",
    "set.user": "Uživatel", "set.user.signedOut": "Nepřihlášeno", "set.user.why": "Přihlášení passkey (stejným jako na webu) dá příkazům, AI a řeči vaše oprávnění a server podrží zprávy, když nejste online.", "set.user.signin": "Přihlásit passkey", "set.user.signup": "Vytvořit účet", "set.user.signout": "Odhlásit", "set.user.signoutAll": "Odhlásit všude",
    "set.user.viaPasskey": "přihlášeno passkey", "set.user.passkeys": "passkeys", "set.user.account": "Účet", "set.user.credential": "Passkey", "set.user.groups": "Skupiny", "set.user.sessions": "Relace", "set.user.since": "Účet od",
    "set.user.keys": "Klíče", "set.user.device": "Zařízení", "set.user.deviceKey": "Klíč zařízení", "set.user.identity": "Identita v chatu", "set.user.connection": "Spojení", "set.user.protocol": "Protokol", "set.user.e2ee": "šifrováno end-to-end", "set.user.push": "Probouzení", "set.user.poll": "pravidelná kontrola", "set.user.checkin": "Poslední kontakt",
    "set.messages": "Zprávy", "set.messages.sub": "Potvrzení, psaní, mizení", "set.messages.receipts": "Potvrzení", "set.messages.delivered": "Potvrzovat doručení", "set.messages.read": "Potvrzovat přečtení", "set.messages.readHint": "Odesílatel uvidí dvě modré fajfky, když zprávu uvidíte.", "set.messages.writing": "Psaní", "set.messages.enterSends": "Enter odesílá", "set.messages.vanish": "Mizející zpráva zmizí po", "set.messages.ttl": "Zprávy vyprší po", "set.messages.ttlHint": "Platí pro nové zprávy této aplikace; u ostatních rozhoduje odesílatel.",
    "set.voice": "Hlas", "set.voice.sub": "Hlas, rychlost, diktování, čtení nahlas", "set.voice.engine": "Převod", "set.voice.device": "V telefonu", "set.voice.server": "Na serveru", "set.voice.lang": "Jazyk", "set.voice.voice": "Hlas", "set.voice.rate": "Rychlost", "set.voice.pitch": "Výška", "set.voice.test": "Vyzkoušet", "set.voice.sample": "Dobrý den, takhle zní tento hlas.",
    "set.voice.auto": "Automaticky", "set.voice.autoplay": "Číst nové zprávy nahlas", "set.voice.autoplayHint": "Jen v místnosti na obrazovce; zapečetěné a klikací zprávy se nečtou.", "set.voice.dictateSpeak": "Nadiktované přečíst zpět", "set.voice.dictateSpeakHint": "Během čtení se poslech vypne a po přečtení zase zapne.", "set.voice.dictateSend": "Nadiktované hned odeslat",
    "set.location": "Poloha", "set.location.sub": "V hlavičce zpráv, sledování", "set.location.inHeader": "Poloha v hlavičce zprávy", "set.location.inHeaderHint": "Každá odeslaná zpráva ponese vaši polohu — příjemci uvidí vpravo dole špendlík a otevřou mapu.", "set.location.track": "Průběžně ukládat na server", "set.location.trackHint": "Poloha se v intervalu posílá na server (stopa zařízení v konzoli správce). Vypnutím se zastaví.", "set.location.notAllowed": "Správce serveru sledování nepovoluje.", "set.location.interval": "Interval", "set.location.precise": "Přesná poloha (GPS)", "set.location.permission": "Oprávnění k poloze",
    "set.calls": "Hovory", "set.calls.sub": "Hlas ↔ text, reproduktor", "set.calls.audioText": "Odchozí hovory jako hlas ↔ text", "set.calls.speaker": "Reproduktor",
    "set.appearance": "Vzhled", "set.appearance.sub": "Tón, šablona, barva, velikost", "set.appearance.tone": "Tón", "set.appearance.system": "Podle systému", "set.appearance.light": "Světlý", "set.appearance.dark": "Tmavý", "set.appearance.preset": "Šablona", "set.appearance.accent": "Barva", "set.appearance.default": "Podle šablony", "set.appearance.fontScale": "Velikost písma", "set.appearance.density": "Hustota", "set.appearance.compact": "Hustá", "set.appearance.normal": "Běžná", "set.appearance.comfortable": "Vzdušná", "set.appearance.bubbles": "Bubliny", "set.appearance.rounded": "Oblé", "set.appearance.square": "Hranaté", "set.appearance.minimal": "Bez pozadí", "set.appearance.reset": "Vrátit vzhled designu",
    "color.red": "Červená", "color.orange": "Oranžová", "color.green": "Zelená", "color.blue": "Modrá", "color.violet": "Fialová",
    "set.security": "Zabezpečení", "set.security.sub": "Zámek, biometrie, PIN", "set.security.policy": "Pravidla", "set.security.wipe": "smazání dat", "set.security.lockout": "zablokování", "set.security.screenshots": "Snímky obrazovky", "set.security.allowed": "povolené", "set.security.blocked": "zakázané",
    "set.never": "nikdy", "set.appLanguage": "Jazyk aplikace",
    "ai.new": "Nová konverzace", "ai.placeholder": "Zeptejte se…", "ai.off": "AI není na tomto serveru zapnutá.", "ai.signIn": "AI je jen pro přihlášené — Nastavení › Uživatel.", "ai.notE2ee": "AI běží na serveru — co napíšete, není šifrované end-to-end.",
    "ai.send": "Odeslat", "ai.stop": "Zastavit", "ai.stopped": "Zastaveno", "ai.thinking": "Přemýšlím…", "ai.you": "Vy", "ai.error": "Chyba", "ai.noModel": "Vyberte model.", "ai.model": "Model", "ai.reasoning": "Uvažování",
    "functions.failed": "Příkaz selhal", "functions.empty": "Model nevrátil nic.", "functions.localOnly": "Nikdo tu není — výsledek vidíte jen vy.", "functions.running": "Spouštím {name}…", "functions.sentToRoom": "Odesláno do místnosti", "functions.off": "Příkazy nejsou zapnuté.", "fnui.expired": "Sezení příkazu skončilo.", "fnui.eventFailed": "Nepodařilo se odpovědět.",
    "set.security.shuffle": "Míchat klávesy PIN", "set.security.shuffleHint": "Čísla nejsou v pořadí a po každém ťuknutí se přemíchají.",
    "nfc.pin": "PIN karty (4–16 číslic)", "nfc.read": "Číst", "nfc.write": "Zapsat místnost", "nfc.emulate": "Být kartou", "nfc.stop": "Zastavit", "nfc.hold": "Přiložte kartu nebo telefon…", "nfc.unavailable": "Telefon nemá NFC.", "nfc.disabled": "NFC je vypnuté.", "nfc.written": "Karta zapsána", "nfc.card": "Připojka do místnosti", "nfc.join": "Připojit", "nfc.wrongPin": "Nesprávný PIN", "nfc.tooSmall": "Karta je na připojku malá (použijte NTAG215/216).", "nfc.emulating": "Odpovídám jako karta — přiložte druhý telefon.",
  },
  en: {
    "tools.title": "Tools", "tools.ai": "AI assistant", "tools.voice": "Voice", "tools.nfc": "NFC", "tools.appearance": "Appearance", "tools.position": "Send position", "tools.dictate": "Dictate",
    "attach.title": "Attach", "attach.photo": "Photo", "attach.camera": "Camera", "attach.file": "File", "attach.position": "Position", "attach.voice": "Voice message", "attach.voiceText": "Speak it, send text", "attach.asVoice": "Send the text as voice", "attach.kinds": "Kind of message",
    "send.title": "Send another way", "send.asVoiceHint": "The text is turned into speech and goes as a voice message.", "send.voiceTextHint": "You speak the message; it is turned into text and the text is sent.",
    "dictate.title": "Dictation", "callopt.title": "Call",
    "call.audioText": "Voice ↔ text call", "call.audioTextHint": "Your messages are read aloud into the call and what the others say comes as text (with a source icon to play it).",
    "msgkind.tap": "Tap to reveal", "msgkind.vanish": "Vanishing", "msgkind.sealed": "Individual (code)", "msgkind.normal": "Normal",
    "msg.vanished": "The temporary message is no longer available — it expired.", "msg.yourCode": "Your code", "msg.sealed": "The message is sealed with a code", "msg.open": "Open", "msg.wrongCode": "Wrong code.", "msg.holdToReveal": "Hold to reveal", "msg.holding": "visible only while held",
    "msg.copy": "Copy", "msg.forward": "Forward", "msg.map": "Position on a map", "msg.source": "Play the source", "msg.speak": "Read aloud", "msg.info": "Message info", "msg.recipients": "To", "msg.everyone": "Everyone", "msg.nobody": "Nobody else is in the room.", "msg.forwardedFrom": "Forwarded from", "msg.privateTo": "Only to",
    "msg.info.sent": "Sent", "msg.info.from": "From", "msg.info.state": "State", "msg.info.to": "To", "msg.info.expires": "Expires", "msg.info.verified": "Verified sender",
    "msg.state.sending": "sending", "msg.state.queued": "waiting for the recipient", "msg.state.sent": "sent", "msg.state.stored": "held by the server", "msg.state.forwarded": "forwarded by the server", "msg.state.delivered": "delivered", "msg.state.read": "read", "msg.state.received": "received",
    "file.open": "Open", "file.save": "Save", "file.saved": "Saved", "file.failed": "the transfer failed", "file.noApp": "No app can open it",
    "composer.attach": "Attach",
    "voice.dictate": "Dictate", "voice.defaultVoice": "Default voice", "voice.synthesizing": "Turning the text into speech…", "voice.recognizing": "Turning speech into text…", "voice.failed": "It did not work", "voice.nothingHeard": "I heard nothing", "voice.listening": "Listening…", "voice.tapToDictate": "Tap the microphone and speak", "voice.speak": "Read aloud", "voice.clear": "Clear", "voice.toChat": "Into a message",
    "location.tracking": "Sharing the position with the server", "location.finding": "Finding the position…", "location.none": "The position could not be found", "location.inHeader": "position in the header",
    "set.user": "User", "set.user.signedOut": "Not signed in", "set.user.why": "Signing in with a passkey (the same as on the web) gives commands, AI and speech your permissions, and the server holds messages while you are away.", "set.user.signin": "Sign in with a passkey", "set.user.signup": "Create an account", "set.user.signout": "Sign out", "set.user.signoutAll": "Sign out everywhere",
    "set.user.viaPasskey": "signed in with a passkey", "set.user.passkeys": "passkeys", "set.user.account": "Account", "set.user.credential": "Passkey", "set.user.groups": "Groups", "set.user.sessions": "Sessions", "set.user.since": "Account since",
    "set.user.keys": "Keys", "set.user.device": "Device", "set.user.deviceKey": "Device key", "set.user.identity": "Chat identity", "set.user.connection": "Connection", "set.user.protocol": "Protocol", "set.user.e2ee": "end-to-end encrypted", "set.user.push": "Wake-ups", "set.user.poll": "regular check-in", "set.user.checkin": "Last contact",
    "set.messages": "Messages", "set.messages.sub": "Receipts, writing, vanishing", "set.messages.receipts": "Receipts", "set.messages.delivered": "Send delivery receipts", "set.messages.read": "Send read receipts", "set.messages.readHint": "The sender sees two blue ticks when you have seen the message.", "set.messages.writing": "Writing", "set.messages.enterSends": "Enter sends", "set.messages.vanish": "A vanishing message goes after", "set.messages.ttl": "Messages expire after", "set.messages.ttlHint": "For new messages from this app; the sender decides for the others.",
    "set.voice": "Voice", "set.voice.sub": "Voice, rate, dictation, reading aloud", "set.voice.engine": "Conversion", "set.voice.device": "On the phone", "set.voice.server": "On the server", "set.voice.lang": "Language", "set.voice.voice": "Voice", "set.voice.rate": "Rate", "set.voice.pitch": "Pitch", "set.voice.test": "Try it", "set.voice.sample": "Hello, this is how this voice sounds.",
    "set.voice.auto": "Automatically", "set.voice.autoplay": "Read new messages aloud", "set.voice.autoplayHint": "Only in the room on screen; sealed and tap-to-reveal messages are not read.", "set.voice.dictateSpeak": "Read dictation back", "set.voice.dictateSpeakHint": "Listening stops while it reads and comes back after.", "set.voice.dictateSend": "Send dictation at once",
    "set.location": "Location", "set.location.sub": "In message headers, tracking", "set.location.inHeader": "Position in the message header", "set.location.inHeaderHint": "Every message you send carries your position — recipients see a pin at the bottom right and open the map.", "set.location.track": "Keep sending it to the server", "set.location.trackHint": "The position goes to the server at the interval (the device's track in the operator console). Switch off to stop.", "set.location.notAllowed": "The server's operator does not allow tracking.", "set.location.interval": "Interval", "set.location.precise": "Precise position (GPS)", "set.location.permission": "Location permission",
    "set.calls": "Calls", "set.calls.sub": "Voice ↔ text, speaker", "set.calls.audioText": "Outgoing calls as voice ↔ text", "set.calls.speaker": "Speaker",
    "set.appearance": "Appearance", "set.appearance.sub": "Tone, template, colour, size", "set.appearance.tone": "Tone", "set.appearance.system": "Like the system", "set.appearance.light": "Light", "set.appearance.dark": "Dark", "set.appearance.preset": "Template", "set.appearance.accent": "Colour", "set.appearance.default": "The template's", "set.appearance.fontScale": "Text size", "set.appearance.density": "Density", "set.appearance.compact": "Compact", "set.appearance.normal": "Normal", "set.appearance.comfortable": "Comfortable", "set.appearance.bubbles": "Bubbles", "set.appearance.rounded": "Rounded", "set.appearance.square": "Square", "set.appearance.minimal": "Plain", "set.appearance.reset": "The design's look again",
    "color.red": "Red", "color.orange": "Orange", "color.green": "Green", "color.blue": "Blue", "color.violet": "Violet",
    "set.security": "Security", "set.security.sub": "Lock, biometrics, PIN", "set.security.policy": "Rules", "set.security.wipe": "erase data", "set.security.lockout": "lock out", "set.security.screenshots": "Screenshots", "set.security.allowed": "allowed", "set.security.blocked": "blocked",
    "set.never": "never", "set.appLanguage": "The app's language",
    "ai.new": "New conversation", "ai.placeholder": "Ask…", "ai.off": "AI is not switched on on this server.", "ai.signIn": "AI is for signed-in people — Settings › User.", "ai.notE2ee": "AI runs on the server — what you write is not end-to-end encrypted.",
    "ai.send": "Send", "ai.stop": "Stop", "ai.stopped": "Stopped", "ai.thinking": "Thinking…", "ai.you": "You", "ai.error": "Error", "ai.noModel": "Choose a model.", "ai.model": "Model", "ai.reasoning": "Reasoning",
    "functions.failed": "The command failed", "functions.empty": "The model returned nothing.", "functions.localOnly": "Nobody is here — only you see the result.", "functions.running": "Running {name}…", "functions.sentToRoom": "Sent to the room", "functions.off": "Commands are off.", "fnui.expired": "The command's session is over.", "fnui.eventFailed": "The answer did not go through.",
    "set.security.shuffle": "Shuffle the PIN keys", "set.security.shuffleHint": "The digits are out of order and reshuffle after every tap.",
    "nfc.pin": "Card PIN (4–16 digits)", "nfc.read": "Read", "nfc.write": "Write the room", "nfc.emulate": "Be a card", "nfc.stop": "Stop", "nfc.hold": "Hold a card or a phone to the back…", "nfc.unavailable": "This phone has no NFC.", "nfc.disabled": "NFC is switched off.", "nfc.written": "Card written", "nfc.card": "A room's connection card", "nfc.join": "Join", "nfc.wrongPin": "Wrong PIN", "nfc.tooSmall": "The card is too small for a connection card (use NTAG215/216).", "nfc.emulating": "Answering as a card — hold the other phone to this one.",
  },
  de: {
    "tools.title": "Werkzeuge", "tools.ai": "KI-Assistent", "tools.voice": "Sprache", "tools.nfc": "NFC", "tools.appearance": "Aussehen", "tools.position": "Standort senden", "tools.dictate": "Diktieren",
    "attach.title": "Anhängen", "attach.photo": "Foto", "attach.camera": "Kamera", "attach.file": "Datei", "attach.position": "Standort", "attach.voice": "Sprachnachricht", "attach.voiceText": "Sprechen, als Text senden", "attach.asVoice": "Text als Sprache senden", "attach.kinds": "Art der Nachricht",
    "send.title": "Anders senden", "send.asVoiceHint": "Der Text wird in Sprache umgewandelt und als Sprachnachricht gesendet.", "send.voiceTextHint": "Sie sprechen die Nachricht; sie wird zu Text und der Text wird gesendet.",
    "dictate.title": "Diktat", "callopt.title": "Anruf",
    "call.audioText": "Anruf Sprache ↔ Text", "call.audioTextHint": "Ihre Nachrichten werden im Anruf vorgelesen, und was die anderen sagen, kommt als Text (mit einem Quellsymbol zum Abspielen).",
    "msgkind.tap": "Zum Anzeigen halten", "msgkind.vanish": "Verschwindend", "msgkind.sealed": "Individuell (Code)", "msgkind.normal": "Normal",
    "msg.vanished": "Die temporäre Nachricht ist nicht mehr verfügbar — sie ist abgelaufen.", "msg.yourCode": "Ihr Code", "msg.sealed": "Die Nachricht ist mit einem Code versiegelt", "msg.open": "Öffnen", "msg.wrongCode": "Falscher Code.", "msg.holdToReveal": "Zum Anzeigen halten", "msg.holding": "nur beim Halten sichtbar",
    "msg.copy": "Kopieren", "msg.forward": "Weiterleiten", "msg.map": "Standort auf der Karte", "msg.source": "Quelle abspielen", "msg.speak": "Vorlesen", "msg.info": "Nachrichteninfo", "msg.recipients": "An", "msg.everyone": "Alle", "msg.nobody": "Sonst ist niemand im Raum.", "msg.forwardedFrom": "Weitergeleitet von", "msg.privateTo": "Nur an",
    "msg.info.sent": "Gesendet", "msg.info.from": "Von", "msg.info.state": "Status", "msg.info.to": "An", "msg.info.expires": "Läuft ab", "msg.info.verified": "Bestätigter Absender",
    "msg.state.sending": "wird gesendet", "msg.state.queued": "wartet auf den Empfänger", "msg.state.sent": "gesendet", "msg.state.stored": "beim Server", "msg.state.forwarded": "vom Server weitergegeben", "msg.state.delivered": "zugestellt", "msg.state.read": "gelesen", "msg.state.received": "empfangen",
    "file.open": "Öffnen", "file.save": "Speichern", "file.saved": "Gespeichert", "file.failed": "die Übertragung ist fehlgeschlagen", "file.noApp": "Keine App kann das öffnen",
    "composer.attach": "Anhängen",
    "voice.dictate": "Diktieren", "voice.defaultVoice": "Standardstimme", "voice.synthesizing": "Wandle den Text in Sprache um…", "voice.recognizing": "Wandle Sprache in Text um…", "voice.failed": "Das hat nicht geklappt", "voice.nothingHeard": "Ich habe nichts gehört", "voice.listening": "Ich höre zu…", "voice.tapToDictate": "Tippen Sie aufs Mikrofon und sprechen Sie", "voice.speak": "Vorlesen", "voice.clear": "Löschen", "voice.toChat": "In eine Nachricht",
    "location.tracking": "Standort wird mit dem Server geteilt", "location.finding": "Ermittle den Standort…", "location.none": "Der Standort konnte nicht ermittelt werden", "location.inHeader": "Standort im Kopf",
    "set.user": "Benutzer", "set.user.signedOut": "Nicht angemeldet", "set.user.why": "Die Anmeldung mit einem Passkey (demselben wie im Web) gibt Befehlen, KI und Sprache Ihre Rechte, und der Server hält Nachrichten, wenn Sie nicht online sind.", "set.user.signin": "Mit Passkey anmelden", "set.user.signup": "Konto erstellen", "set.user.signout": "Abmelden", "set.user.signoutAll": "Überall abmelden",
    "set.user.viaPasskey": "mit Passkey angemeldet", "set.user.passkeys": "Passkeys", "set.user.account": "Konto", "set.user.credential": "Passkey", "set.user.groups": "Gruppen", "set.user.sessions": "Sitzungen", "set.user.since": "Konto seit",
    "set.user.keys": "Schlüssel", "set.user.device": "Gerät", "set.user.deviceKey": "Geräteschlüssel", "set.user.identity": "Chat-Identität", "set.user.connection": "Verbindung", "set.user.protocol": "Protokoll", "set.user.e2ee": "Ende-zu-Ende verschlüsselt", "set.user.push": "Aufwecken", "set.user.poll": "regelmäßige Abfrage", "set.user.checkin": "Letzter Kontakt",
    "set.messages": "Nachrichten", "set.messages.sub": "Bestätigungen, Schreiben, Verschwinden", "set.messages.receipts": "Bestätigungen", "set.messages.delivered": "Zustellung bestätigen", "set.messages.read": "Lesen bestätigen", "set.messages.readHint": "Der Absender sieht zwei blaue Haken, wenn Sie die Nachricht gesehen haben.", "set.messages.writing": "Schreiben", "set.messages.enterSends": "Enter sendet", "set.messages.vanish": "Eine verschwindende Nachricht geht nach", "set.messages.ttl": "Nachrichten laufen ab nach", "set.messages.ttlHint": "Für neue Nachrichten dieser App; bei anderen entscheidet der Absender.",
    "set.voice": "Sprache", "set.voice.sub": "Stimme, Tempo, Diktat, Vorlesen", "set.voice.engine": "Umwandlung", "set.voice.device": "Im Telefon", "set.voice.server": "Auf dem Server", "set.voice.lang": "Sprache", "set.voice.voice": "Stimme", "set.voice.rate": "Tempo", "set.voice.pitch": "Tonhöhe", "set.voice.test": "Ausprobieren", "set.voice.sample": "Hallo, so klingt diese Stimme.",
    "set.voice.auto": "Automatisch", "set.voice.autoplay": "Neue Nachrichten vorlesen", "set.voice.autoplayHint": "Nur im Raum auf dem Bildschirm; versiegelte und Halte-Nachrichten werden nicht vorgelesen.", "set.voice.dictateSpeak": "Diktat vorlesen", "set.voice.dictateSpeakHint": "Das Zuhören pausiert beim Vorlesen und geht danach weiter.", "set.voice.dictateSend": "Diktat sofort senden",
    "set.location": "Standort", "set.location.sub": "Im Nachrichtenkopf, Verfolgung", "set.location.inHeader": "Standort im Nachrichtenkopf", "set.location.inHeaderHint": "Jede gesendete Nachricht trägt Ihren Standort — Empfänger sehen unten rechts eine Stecknadel und öffnen die Karte.", "set.location.track": "Laufend an den Server senden", "set.location.trackHint": "Der Standort geht im Intervall an den Server (Gerätespur in der Betreiberkonsole). Ausschalten beendet es.", "set.location.notAllowed": "Der Betreiber erlaubt keine Verfolgung.", "set.location.interval": "Intervall", "set.location.precise": "Genauer Standort (GPS)", "set.location.permission": "Standortberechtigung",
    "set.calls": "Anrufe", "set.calls.sub": "Sprache ↔ Text, Lautsprecher", "set.calls.audioText": "Ausgehende Anrufe als Sprache ↔ Text", "set.calls.speaker": "Lautsprecher",
    "set.appearance": "Aussehen", "set.appearance.sub": "Ton, Vorlage, Farbe, Größe", "set.appearance.tone": "Ton", "set.appearance.system": "Wie das System", "set.appearance.light": "Hell", "set.appearance.dark": "Dunkel", "set.appearance.preset": "Vorlage", "set.appearance.accent": "Farbe", "set.appearance.default": "Wie die Vorlage", "set.appearance.fontScale": "Schriftgröße", "set.appearance.density": "Dichte", "set.appearance.compact": "Kompakt", "set.appearance.normal": "Normal", "set.appearance.comfortable": "Luftig", "set.appearance.bubbles": "Blasen", "set.appearance.rounded": "Rund", "set.appearance.square": "Eckig", "set.appearance.minimal": "Schlicht", "set.appearance.reset": "Aussehen des Designs wiederherstellen",
    "color.red": "Rot", "color.orange": "Orange", "color.green": "Grün", "color.blue": "Blau", "color.violet": "Violett",
    "set.security": "Sicherheit", "set.security.sub": "Sperre, Biometrie, PIN", "set.security.policy": "Regeln", "set.security.wipe": "Daten löschen", "set.security.lockout": "sperren", "set.security.screenshots": "Bildschirmfotos", "set.security.allowed": "erlaubt", "set.security.blocked": "gesperrt",
    "set.never": "nie", "set.appLanguage": "Sprache der App",
    "ai.new": "Neues Gespräch", "ai.placeholder": "Fragen…", "ai.off": "KI ist auf diesem Server nicht eingeschaltet.", "ai.signIn": "KI ist für angemeldete Personen — Einstellungen › Benutzer.", "ai.notE2ee": "Die KI läuft auf dem Server — was Sie schreiben, ist nicht Ende-zu-Ende verschlüsselt.",
    "ai.send": "Senden", "ai.stop": "Stopp", "ai.stopped": "Gestoppt", "ai.thinking": "Ich denke nach…", "ai.you": "Sie", "ai.error": "Fehler", "ai.noModel": "Wählen Sie ein Modell.", "ai.model": "Modell", "ai.reasoning": "Denken",
    "functions.failed": "Der Befehl ist fehlgeschlagen", "functions.empty": "Das Modell hat nichts zurückgegeben.", "functions.localOnly": "Niemand ist hier — nur Sie sehen das Ergebnis.", "functions.running": "{name} läuft…", "functions.sentToRoom": "An den Raum gesendet", "functions.off": "Befehle sind aus.", "fnui.expired": "Die Sitzung des Befehls ist vorbei.", "fnui.eventFailed": "Die Antwort ist fehlgeschlagen.",
    "set.security.shuffle": "PIN-Tasten mischen", "set.security.shuffleHint": "Die Ziffern sind nicht der Reihe nach und mischen sich nach jedem Tippen neu.",
    "nfc.pin": "Karten-PIN (4–16 Ziffern)", "nfc.read": "Lesen", "nfc.write": "Raum schreiben", "nfc.emulate": "Als Karte antworten", "nfc.stop": "Stopp", "nfc.hold": "Karte oder Telefon an die Rückseite halten…", "nfc.unavailable": "Dieses Telefon hat kein NFC.", "nfc.disabled": "NFC ist ausgeschaltet.", "nfc.written": "Karte geschrieben", "nfc.card": "Verbindungskarte eines Raums", "nfc.join": "Beitreten", "nfc.wrongPin": "Falsche PIN", "nfc.tooSmall": "Die Karte ist zu klein für eine Verbindungskarte (NTAG215/216 verwenden).", "nfc.emulating": "Antworte als Karte — das andere Telefon daranhalten.",
  },
};
