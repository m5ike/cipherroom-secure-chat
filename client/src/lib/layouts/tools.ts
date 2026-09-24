// The chat screen's tool windows (4.13): who is in the room, the voice and
// video calls, files, location, speech and the connection's details — the
// content of their windows. Drawn by CallPanels.tsx and ToolPanels.tsx,
// which keep what they do (calls, recognition, the keeper).

import { treeBuilder, type LNode } from "../layout-tree";
import type { LayoutContract } from "./contracts";

const PRIMARY = "inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60";
const SECONDARY = "inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent";

/** PeerList: who is in the room. */
export function peersTree(): LNode {
  const { n, icon } = treeBuilder("pl");
  return n("group", { id: "peers" }, [
    n("panel", { id: "peers-empty", name: "Nobody", if: "($peers|length) === 0", attrs: { class: "rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground" }, text: "{_'app.noPeers'}" }),
    n("panel", { id: "list-peers", name: "People", if: "($peers|length) > 0", attrs: { class: "space-y-2", "data-testid": "list-peers" } }, [
      n("panel", { id: "peer", name: "A person", each: "$peers", as: "p", key: "$p.id", attrs: { class: "flex items-center justify-between gap-3 rounded-2xl bg-background p-3" } }, [
        n("panel", { id: "peer-names", attrs: { class: "min-w-0" } }, [
          n("paragraph", { id: "peer-name", attrs: { class: "truncate text-sm font-medium", "data-testid": "text-peer-{$p.id}" }, text: "{$p.name}" }),
          n("paragraph", { id: "peer-id", attrs: { class: "font-mono text-xs text-muted-foreground" }, text: "{$p.short}" }),
        ]),
        n("panel", { id: "peer-state", attrs: { class: "flex items-center gap-1" } }, [
          icon("mic", "h-4 w-4 text-emerald-500", { "aria-label": "audio live" }, { id: "peer-live", if: "$p.audio === 'live'" }),
          icon("mic-off", "h-4 w-4 text-amber-500", { "aria-label": "audio muted" }, { id: "peer-muted", if: "$p.audio === 'muted'" }),
          n("area", {
            id: "peer-status", attrs: { class: "rounded-full px-2 py-1 text-xs {if $p.status === 'open'}bg-emerald-500/15 text-emerald-700 dark:text-emerald-300{elseif $p.status === 'connecting'}bg-amber-500/15 text-amber-700 dark:text-amber-300{else}bg-muted text-muted-foreground{/if}" },
            text: "{$p.status}",
          }),
        ]),
      ]),
    ]),
  ]);
}

/** AudioControls: the voice call. */
export function audioTree(): LNode {
  const { n, text, icon } = treeBuilder("ac");
  return n("panel", { id: "audio", name: "Voice call", attrs: { class: "space-y-3" } }, [
    n("panel", { id: "audio-hint", attrs: { class: "text-sm text-muted-foreground" }, text: "{_'audio.hint'}" }),
    n("panel", { id: "audio-count", attrs: { class: "text-xs text-muted-foreground" }, text: "{=('audio.onCall'|t|replace:'{n}':$audioPeerCount)}" }),
    n("panel", {
      id: "media-e2ee", name: "Media encryption", if: "$audioStatus !== 'off'",
      attrs: {
        "data-testid": "media-e2ee", "data-state": "{$mediaState}", "data-detail": "=$mediaDetail",
        class: "flex items-start gap-2 rounded-xl border px-3 py-2 text-xs {if $mediaState === 'e2ee'}border-emerald-500/40 text-emerald-700 dark:text-emerald-300{else}border-border text-muted-foreground{/if}",
      },
    }, [
      icon("lock", "mt-0.5 h-3.5 w-3.5 shrink-0", { "aria-hidden": "true" }, { id: "media-lock" }),
      n("area", { id: "media-text", text: "{=('sec.media.' ~ $mediaState)|t|replace:'{n}':$sealed|replace:'{total}':$total}" }),
    ]),
    n("panel", { id: "audio-buttons", attrs: { class: "flex flex-wrap gap-2" } }, [
      n("button", {
        id: "button-audio-join", name: "Join", if: "$audioStatus === 'off' || $audioStatus === 'joining'",
        attrs: { type: "button", "data-testid": "button-audio-join", class: PRIMARY, disabled: "=!$connected || $audioStatus === 'joining'" },
        on: { click: { action: "join" } },
      }, [icon("mic", "h-4 w-4", {}, { id: "join-icon" }), text("{if $audioStatus === 'joining'}...{else}{_'audio.join'}{/if}", { id: "join-text" })]),
      n("group", { id: "audio-live", if: "$audioStatus !== 'off' && $audioStatus !== 'joining'" }, [
        n("button", { id: "button-audio-mute", name: "Mute", attrs: { type: "button", "data-testid": "button-audio-mute", class: SECONDARY }, on: { click: { action: "toggleMute" } } }, [
          icon("mic-off", "h-4 w-4", {}, { id: "mute-off", if: "$audioStatus === 'muted'" }),
          icon("mic", "h-4 w-4", {}, { id: "mute-on", if: "$audioStatus !== 'muted'" }),
          text("{=($audioStatus === 'muted' ? 'audio.unmute' : 'audio.mute')|t}", { id: "mute-text" }),
        ]),
        n("button", { id: "button-audio-leave", name: "Leave", attrs: { type: "button", "data-testid": "button-audio-leave", class: SECONDARY }, on: { click: { action: "leave" } } }, [
          icon("phone-off", "h-4 w-4", {}, { id: "leave-icon" }),
          text("{_'audio.leave'}", { id: "leave-text" }),
        ]),
      ]),
    ]),
  ]);
}

/** VideoControls: the video call (the cameras are drawn by the call through refs). */
export function videoTree(): LNode {
  const { n } = treeBuilder("vc");
  return n("panel", { id: "video", name: "Video call", attrs: { class: "space-y-3" } }, [
    n("paragraph", { id: "video-hint", attrs: { class: "text-xs text-muted-foreground" }, text: "{_'app.video.hint'}" }),
    n("video", { id: "video-local", name: "My camera", ref: "localVideo", attrs: { muted: "=true", autoplay: "=true", playsinline: "=true", class: "aspect-video w-full rounded-2xl border border-border bg-black" } }),
    n("panel", { id: "video-remote", name: "The others' cameras", ref: "remoteVideos", attrs: { class: "grid grid-cols-2 gap-2" } }, []),
    n("panel", { id: "video-buttons", attrs: { class: "flex flex-wrap gap-2" } }, [
      n("button", { id: "video-start", name: "Start", if: "$mode !== 'video'", attrs: { type: "button", disabled: "=!$connected", class: PRIMARY }, on: { click: { action: "start" } }, text: "{_'app.video.start'}" }),
      n("group", { id: "video-live", if: "$mode === 'video'" }, [
        n("button", { id: "video-camera", name: "Camera", attrs: { type: "button", class: SECONDARY }, on: { click: { action: "toggleCamera" } }, text: "{=($videoOn ? 'app.video.cameraOff' : 'app.video.cameraOn')|t}" }),
        n("button", { id: "video-hangup", name: "Hang up", attrs: { type: "button", class: SECONDARY }, on: { click: { action: "leave" } }, text: "{_'app.video.hangUp'}" }),
      ]),
    ]),
  ]);
}

/** FilesPanel. */
export function filesTree(): LNode {
  const { n } = treeBuilder("fp");
  return n("panel", { id: "files", name: "Files", attrs: { class: "space-y-3" } }, [
    n("paragraph", { id: "files-intro", attrs: { class: "text-xs text-muted-foreground" }, text: "End-to-end encrypted P2P transfer (AES-GCM 256, 32 KiB chunks) with automatic server-relay fallback. Hard cap: 10 GiB. Configure your own limit in Settings." }),
    n("panel", { id: "files-buttons", attrs: { class: "flex flex-wrap gap-2" } }, [
      n("button", { id: "files-pick", name: "Choose file", attrs: { type: "button", disabled: "=!$connected", class: PRIMARY }, on: { click: { action: "pickFile" } }, text: "Choose file…" }),
    ]),
    n("panel", { id: "files-active", name: "Transfers running", if: "($active|length) > 0", attrs: { class: "rounded-2xl border border-border bg-background p-3 text-xs" } }, [
      n("panel", { id: "files-active-title", attrs: { class: "mb-1 font-semibold" }, text: "Probíhá {$active|length} přenos{if ($active|length) > 1}y{/if}:" }),
      n("list", { id: "files-active-list", attrs: { class: "space-y-1 font-mono" } }, [
        n("item", { id: "files-transfer", name: "A transfer", each: "$active", as: "tr", key: "$tr.id", text: "{$tr.line}" }),
      ]),
    ]),
    n("panel", { id: "files-recent", if: "($recent|length) > 0", attrs: { class: "rounded-2xl border border-dashed border-border/60 p-3 text-[11px] text-muted-foreground" }, text: "{$recent|length} přenosů sledováno — podrobnosti v chatu." }),
    n("paragraph", { id: "files-note", attrs: { class: "text-[11px] text-muted-foreground" }, text: "Files  10 GiB cannot transfer today. For very large volumes use the storage-provider plugin — see docs/files.md." }),
  ]);
}

/** LocationPanel. */
export function locationTree(): LNode {
  const { n } = treeBuilder("lp");
  return n("panel", { id: "location", name: "Location", attrs: { class: "space-y-3" } }, [
    n("paragraph", { id: "location-hint", attrs: { class: "text-xs text-muted-foreground" }, text: "{_'app.location.hint'}" }),
    n("paragraph", { id: "location-unavailable", if: "!$available", attrs: { class: "rounded-xl border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200" }, text: "{$reason}" }),
    n("panel", { id: "location-buttons", attrs: { class: "flex flex-wrap gap-2" } }, [
      n("button", { id: "location-once", attrs: { type: "button", disabled: "=!$connected || !$available", class: PRIMARY }, on: { click: { action: "shareOnce" } }, text: "{_'app.location.once'}" }),
      n("button", { id: "location-stop", if: "$watching", attrs: { type: "button", class: SECONDARY }, on: { click: { action: "stop" } }, text: "{_'app.location.stop'}" }),
      n("button", { id: "location-continuous", if: "!$watching", attrs: { type: "button", disabled: "=!$connected || !$available", class: `${SECONDARY} disabled:opacity-60` }, on: { click: { action: "startContinuous" } }, text: "{_'app.location.continuous'}" }),
    ]),
    n("paragraph", { id: "location-privacy", attrs: { class: "text-[11px] text-muted-foreground" }, text: "{_'app.location.privacy'}" }),
  ]);
}

/** SpeechPanel: speak, listen, revoice; server voices in Server-enhanced. */
export function speechTree(): LNode {
  const { n, text } = treeBuilder("sp");
  const SELECT = "min-h-10 rounded-xl border border-input bg-background px-2";
  const labelled = (id: string, key: string, control: LNode) => n("label", { id, attrs: { class: "grid gap-1 text-sm" } }, [text(`{_'${key}'}`, { id: `${id}-label` }), control]);
  return n("panel", { id: "speech", name: "Speech", attrs: { class: "space-y-3" } }, [
    n("panel", { id: "speech-grid", attrs: { class: "grid grid-cols-2 gap-2" } }, [
      labelled("speech-lang", "app.speech.language", n("select", { id: "speech-lang-select", attrs: { value: "=$voiceLang", class: SELECT }, on: { change: { action: "voiceLang" } } }, [
        n("option", { id: "speech-lang-option", each: "$langs", as: "l", key: "$l", text: "{$l}" }),
      ])),
      labelled("speech-preset", "app.speech.preset", n("select", { id: "speech-preset-select", attrs: { value: "=$preset", class: SELECT }, on: { change: { action: "preset" } } }, [
        n("option", { id: "speech-preset-option", each: "$presets", as: "p", key: "$p", text: "{$p}" }),
      ])),
    ]),
    labelled("speech-voice", "app.speech.voice", n("select", { id: "speech-voice-select", attrs: { value: "=$voiceURI", class: SELECT }, on: { change: { action: "voice" } } }, [
      n("option", { id: "speech-voice-auto", attrs: { value: "" }, text: "{_'app.speech.auto'}" }),
      n("option", { id: "speech-voice-option", each: "$voices", as: "v", key: "$v.uri", attrs: { value: "{$v.uri}" }, text: "{$v.name} · {$v.lang}" }),
    ])),
    labelled("speech-text", "app.speech.text", n("textarea", { id: "speech-textarea", attrs: { value: "=$text", class: "min-h-20 rounded-xl border border-input bg-background px-2 py-1" }, on: { change: { action: "text" } } })),
    n("panel", { id: "speech-buttons", attrs: { class: "flex flex-wrap gap-2" } }, [
      n("button", { id: "speech-speak", attrs: { type: "button", disabled: "=!$ttsAvailable", class: PRIMARY }, on: { click: { action: "speak" } }, text: "{_'app.speech.speak'}" }),
      n("button", { id: "speech-stop", attrs: { type: "button", disabled: "=!$ttsAvailable", class: `${SECONDARY} disabled:opacity-60` }, on: { click: { action: "stopSpeaking" } }, text: "{_'app.speech.stop'}" }),
      n("button", { id: "speech-listen", if: "!$listening", attrs: { type: "button", disabled: "=!$sttAvailable", class: `${SECONDARY} disabled:opacity-60` }, on: { click: { action: "listen" } }, text: "{_'app.speech.listen'}" }),
      n("button", { id: "speech-stop-listening", if: "$listening", attrs: { type: "button", class: SECONDARY }, on: { click: { action: "stopListening" } }, text: "{_'app.speech.stopListening'}" }),
      n("label", { id: "speech-revoice", attrs: { class: "inline-flex items-center gap-2 text-xs" } }, [
        n("input", { id: "speech-revoice-check", attrs: { type: "checkbox", checked: "=$revoice" }, on: { change: { action: "revoice" } } }),
        text("{_'app.speech.revoice'}", { id: "speech-revoice-text" }),
      ]),
      n("button", { id: "speech-insert", attrs: { type: "button", disabled: "=!$hasText", class: `${SECONDARY} disabled:opacity-60`, "data-testid": "speech-insert" }, on: { click: { action: "insert" } }, text: "{_'speech.insert'}" }),
      n("button", { id: "speech-send", attrs: { type: "button", class: SECONDARY }, on: { click: { action: "send" } }, text: "{_'app.speech.send'}" }),
    ]),
    n("panel", { id: "speech-partial", if: "$partial", attrs: { class: "rounded-xl border border-border bg-background p-2 text-xs italic" }, text: "{$partial}" }),
    n("panel", { id: "speech-server", name: "Server voices", if: "$serverMode && ($serverVoices|length) > 0", attrs: { class: "rounded-xl border border-border bg-background p-2 text-xs" } }, [
      n("panel", { id: "speech-server-title", attrs: { class: "mb-1 font-semibold" }, text: "{_'speech.server'}" }),
      n("panel", { id: "speech-server-row", attrs: { class: "flex flex-wrap items-center gap-2" } }, [
        n("select", { id: "speech-server-select", attrs: { value: "=$serverVoice", "aria-label": "{_'speech.server'}", class: "min-h-9 rounded-lg border border-input bg-background px-2" }, on: { change: { action: "serverVoice" } } }, [
          n("option", { id: "speech-server-option", each: "$serverVoices", as: "v", key: "$v.id", attrs: { value: "{$v.id}" }, text: "{$v.label}" }),
        ]),
        n("button", {
          id: "speech-server-speak", attrs: { type: "button", disabled: "=$serverBusy || !$hasText", class: "inline-flex min-h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground disabled:opacity-60" },
          on: { click: { action: "speakServer" } }, text: "{if $serverBusy}…{else}{_'speech.server.speak'}{/if}",
        }),
      ]),
    ]),
    n("paragraph", { id: "speech-no-stt", if: "!$sttAvailable", attrs: { class: "text-[11px] text-muted-foreground" }, text: "Speech recognition is Chrome/Edge/Android only. Voice cloning of arbitrary samples is intentionally not implemented — see docs/speech.md." }),
  ]);
}

/** ConnectionPanel: what the app wants, the keeper's strategy and state, the log. */
export function connectionTree(): LNode {
  const { n, text } = treeBuilder("cp");
  return n("panel", { id: "connection", name: "Connection", attrs: { class: "space-y-3" } }, [
    n("panel", { id: "conn-desired", name: "Wanted", attrs: { class: "rounded-xl border border-border bg-background p-2 text-xs", "data-testid": "conn-desired", "data-desired": "{$desired}" } }, [
      n("area", { id: "conn-desired-label", attrs: { class: "font-semibold" }, text: "{_'conn.desired'}:" }),
      text(" {=($desired === 'connected' ? 'conn.desired.connected' : 'conn.desired.disconnected')|t}", { id: "conn-desired-value" }),
    ]),
    n("paragraph", { id: "conn-hint", attrs: { class: "text-xs text-muted-foreground" }, text: "{_'keepalive.hint'}" }),
    n("label", { id: "conn-strategy", attrs: { class: "grid gap-1 text-sm font-medium" } }, [
      text("{_'keepalive.strategy'}", { id: "conn-strategy-label" }),
      n("select", { id: "conn-strategy-select", attrs: { value: "=$strategy", class: "min-h-10 rounded-xl border border-input bg-background px-2" }, on: { change: { action: "strategy" } } }, [
        n("option", { id: "conn-conservative", attrs: { value: "conservative" }, text: "{_'keepalive.conservative'}" }),
        n("option", { id: "conn-balanced", attrs: { value: "balanced" }, text: "{_'keepalive.balanced'}" }),
        n("option", { id: "conn-aggressive", attrs: { value: "aggressive" }, text: "{_'keepalive.aggressive'}" }),
      ]),
    ]),
    n("panel", { id: "conn-status", name: "State", if: "$status", attrs: { class: "rounded-xl border border-border bg-background p-2 text-xs font-mono" } }, [
      n("panel", { id: "conn-state", text: "state: {$status.state}" }),
      n("panel", { id: "conn-rtt", text: "RTT: {$status.rttMs} ms" }),
      n("panel", { id: "conn-strategy-now", text: "strategy: {$status.strategy}" }),
      n("panel", { id: "conn-activity", text: "last activity: {$status.lastActivity}" }),
      n("panel", { id: "conn-pong", text: "last pong: {$status.lastPong}" }),
    ]),
    n("paragraph", { id: "conn-none", if: "!$status", attrs: { class: "text-xs text-muted-foreground" }, text: "Not connected." }),
    n("panel", { id: "conn-log-box" }, [
      n("heading", { id: "conn-log-title", attrs: { class: "mb-1 text-xs font-semibold" }, text: "{_'conn.log.title'}" }),
      n("paragraph", { id: "conn-log-empty", if: "($log|length) === 0", attrs: { class: "text-xs text-muted-foreground" }, text: "{_'conn.log.empty'}" }),
      n("list", { id: "conn-log", tag: "ol", if: "($log|length) > 0", attrs: { class: "max-h-40 overflow-y-auto rounded-xl border border-border bg-background p-2 font-mono text-[11px] leading-5", "data-testid": "conn-log" } }, [
        n("item", { id: "conn-log-entry", name: "An event", each: "$log", as: "e", key: "$e.key", text: "{$e.time} · #{$e.attempt} · {$e.text}" }),
      ]),
    ]),
  ]);
}

/* ------------------------------------------------------------ contracts */

type ToolId = "part.peers" | "part.audio" | "part.video" | "panel.files" | "panel.location" | "panel.speech" | "panel.connection";

export const TOOL_CONTRACTS: Record<ToolId, LayoutContract> = {
  "part.peers": {
    description: "Who is in the room.",
    vars: [{ path: "$peers", type: "list", description: "People: .id, .name, .short, .status (open / connecting / closed), .audio (live / muted)." }],
    actions: [], slots: [], refs: [],
  },
  "part.audio": {
    description: "The voice call: join, mute, leave, and whether its media is encrypted end to end.",
    vars: [
      { path: "$audioStatus", type: "text", description: "off, joining, live or muted." },
      { path: "$audioPeerCount", type: "number", description: "People on the call." },
      { path: "$connected", type: "yes/no", description: "In a room." },
      { path: "$mediaState", type: "text", description: "e2ee, partial, off or unsupported." },
      { path: "$mediaDetail", type: "text", description: "More about the media encryption." },
      { path: "$sealed", type: "number", description: "Streams sealed." },
      { path: "$total", type: "number", description: "Streams." },
    ],
    actions: [{ name: "join", description: "Join the call." }, { name: "toggleMute", description: "Mute / unmute." }, { name: "leave", description: "Leave." }],
    slots: [], refs: [],
  },
  "part.video": {
    description: "The video call: my camera, the others', start, camera, hang up.",
    vars: [{ path: "$connected", type: "yes/no", description: "In a room." }, { path: "$mode", type: "text", description: "audio, video or off." }, { path: "$videoOn", type: "yes/no", description: "My camera is on." }],
    actions: [{ name: "start", description: "Start the video call." }, { name: "toggleCamera", description: "Camera on / off." }, { name: "leave", description: "Hang up." }],
    slots: [],
    refs: [{ name: "localVideo", description: "My camera (a video element)." }, { name: "remoteVideos", description: "Where the others' cameras go." }],
  },
  "panel.files": {
    description: "Files: choose one to send, and the transfers running.",
    vars: [{ path: "$connected", type: "yes/no", description: "In a room." }, { path: "$active", type: "list", description: "Transfers running: .id, .line." }, { path: "$recent", type: "list", description: "The last transfers." }],
    actions: [{ name: "pickFile", description: "Choose a file." }],
    slots: [], refs: [],
  },
  "panel.location": {
    description: "Location: share it once, or keep sharing it.",
    vars: [{ path: "$connected", type: "yes/no", description: "In a room." }, { path: "$available", type: "yes/no", description: "This device has a location." }, { path: "$reason", type: "text", description: "Why not." }, { path: "$watching", type: "yes/no", description: "Sharing continuously." }],
    actions: [{ name: "shareOnce", description: "Share it once." }, { name: "startContinuous", description: "Keep sharing." }, { name: "stop", description: "Stop sharing." }],
    slots: [], refs: [],
  },
  "panel.speech": {
    description: "Speech: speak a text, listen and write down, revoice; the server's voices in Server-enhanced.",
    vars: [
      { path: "$langs", type: "list", description: "Speech languages." }, { path: "$presets", type: "list", description: "Voice presets." }, { path: "$voices", type: "list", description: "This browser's voices: .uri, .name, .lang." },
      { path: "$voiceLang", type: "text", description: "The language." }, { path: "$preset", type: "text", description: "The preset." }, { path: "$voiceURI", type: "text", description: "The voice." },
      { path: "$text", type: "text", description: "The text." }, { path: "$hasText", type: "yes/no", description: "There is text." }, { path: "$ttsAvailable", type: "yes/no", description: "This browser speaks." },
      { path: "$sttAvailable", type: "yes/no", description: "This browser listens." }, { path: "$listening", type: "yes/no", description: "Listening now." }, { path: "$revoice", type: "yes/no", description: "Speak what was heard." },
      { path: "$partial", type: "text", description: "What is being heard." }, { path: "$serverMode", type: "yes/no", description: "Server-enhanced." }, { path: "$serverVoices", type: "list", description: "The server's voices: .id, .label." },
      { path: "$serverVoice", type: "text", description: "The server voice." }, { path: "$serverBusy", type: "yes/no", description: "The server speaks." },
    ],
    actions: [
      { name: "voiceLang", description: "The language chosen.", event: "change" }, { name: "preset", description: "The preset chosen.", event: "change" }, { name: "voice", description: "The voice chosen.", event: "change" },
      { name: "text", description: "The text typed.", event: "change" }, { name: "speak", description: "Speak it." }, { name: "stopSpeaking", description: "Stop speaking." },
      { name: "listen", description: "Listen." }, { name: "stopListening", description: "Stop listening." }, { name: "revoice", description: "Revoice on / off.", event: "change" },
      { name: "insert", description: "Put the text into the composer." }, { name: "send", description: "Send the text." }, { name: "serverVoice", description: "A server voice chosen.", event: "change" },
      { name: "speakServer", description: "Speak with the server's voice." },
    ],
    slots: [], refs: [],
  },
  "panel.connection": {
    description: "The connection: what the app wants, the keeper's strategy and state, and its log.",
    vars: [
      { path: "$desired", type: "text", description: "connected or disconnected." }, { path: "$strategy", type: "text", description: "The keeper's strategy." },
      { path: "$status", type: "object", description: "The keeper: .state, .rttMs, .strategy, .lastActivity, .lastPong." }, { path: "$log", type: "list", description: "Events: .key, .time, .attempt, .text." },
    ],
    actions: [{ name: "strategy", description: "The strategy chosen.", event: "change" }],
    slots: [], refs: [],
  },
};

export const TOOL_VARIANTS: Record<ToolId, ReadonlyArray<{ id: string; label: string }>> = {
  "part.peers": [{ id: "people", label: "People" }, { id: "empty", label: "Nobody" }],
  "part.audio": [{ id: "off", label: "Not on the call" }, { id: "live", label: "On the call" }, { id: "muted", label: "Muted" }],
  "part.video": [{ id: "off", label: "Not started" }, { id: "video", label: "In a video call" }],
  "panel.files": [{ id: "idle", label: "Nothing running" }, { id: "active", label: "Transfers running" }],
  "panel.location": [{ id: "plain", label: "Location" }, { id: "watching", label: "Sharing" }],
  "panel.speech": [{ id: "plain", label: "Speech" }, { id: "server", label: "With server voices" }],
  "panel.connection": [{ id: "connected", label: "Connected" }, { id: "none", label: "Not connected" }],
};
