// The voice changer's window (6.7): switch it on for this client, a preset or
// the custom values, a test (record a few seconds, hear them back). Drawn by
// VoiceChangerPanel.tsx, which keeps what it does (settings, the recording).

import { treeBuilder, type LNode } from "../layout-tree";
import type { LayoutContract } from "./contracts";

const BUTTON = "inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent disabled:opacity-60";
const PRIMARY = "inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60";

/** VoiceChangerPanel: on / off, preset, custom sliders, a test. */
export function voiceChangerTree(): LNode {
  const { n, text } = treeBuilder("vc");
  const slider = (key: string, min: number, max: number, step: number) => n("label", { id: `vc-${key}`, attrs: { class: "grid gap-1 text-sm" } }, [
    n("area", { id: `vc-${key}-head`, attrs: { class: "flex items-center justify-between" } }, [
      text(`{_'vfx.${key}'}`, { id: `vc-${key}-label` }),
      n("area", { id: `vc-${key}-value`, attrs: { class: "font-mono text-xs text-muted-foreground" }, text: `{$params.${key}}` }),
    ]),
    n("input", {
      id: `vc-${key}-input`,
      attrs: { type: "range", min: String(min), max: String(max), step: String(step), value: `=$params.${key}`, disabled: "=!$allowed", "data-testid": `vfx-${key}` },
      on: { change: { action: "param", arg: `'${key}'` } },
    }),
  ]);
  return n("panel", { id: "voice-changer", name: "Voice changer", attrs: { class: "space-y-3", "data-testid": "panel-voice-changer" } }, [
    n("paragraph", { id: "vc-intro", attrs: { class: "text-sm text-muted-foreground" }, text: "{_'vfx.intro'}" }),
    n("paragraph", { id: "vc-not-allowed", if: "!$allowed", attrs: { class: "rounded-xl border border-amber-500/40 bg-amber-500/10 p-2 text-sm", "data-testid": "vfx-not-allowed" }, text: "{_'vfx.notAllowed'}" }),
    n("paragraph", { id: "vc-unsupported", if: "$allowed && !$supported", attrs: { class: "rounded-xl border border-amber-500/40 bg-amber-500/10 p-2 text-sm" }, text: "{_'vfx.unsupported'}" }),
    n("label", { id: "vc-on", attrs: { class: "flex items-center gap-3 rounded-xl border border-border bg-background p-3 text-sm font-semibold" } }, [
      n("input", { id: "vc-on-check", attrs: { type: "checkbox", checked: "=$on", disabled: "=!$allowed", "data-testid": "vfx-on" }, on: { change: { action: "toggle" } } }),
      text("{_'vfx.on'}", { id: "vc-on-text" }),
    ]),
    n("label", { id: "vc-preset", attrs: { class: "grid gap-1 text-sm" } }, [
      text("{_'vfx.preset'}", { id: "vc-preset-label" }),
      n("select", { id: "vc-preset-select", attrs: { value: "=$preset", disabled: "=!$allowed", class: "min-h-10 rounded-xl border border-input bg-background px-2", "data-testid": "vfx-preset" }, on: { change: { action: "preset" } } }, [
        n("option", { id: "vc-preset-option", each: "$presets", as: "p", key: "$p.id", attrs: { value: "{$p.id}" }, text: "{$p.label}" }),
      ]),
    ]),
    n("panel", { id: "vc-custom", name: "Custom values", if: "$custom", attrs: { class: "grid gap-2 rounded-xl border border-border bg-background p-3" } }, [
      slider("pitch", -12, 12, 1),
      slider("formant", -12, 12, 1),
      slider("robot", 0, 400, 5),
      slider("echo", 0, 1, 0.05),
      slider("echoMs", 40, 1000, 10),
      slider("whisper", 0, 1, 0.05),
      slider("gain", -12, 12, 1),
      n("button", { id: "vc-reset", attrs: { type: "button", class: BUTTON, disabled: "=!$allowed" }, on: { click: { action: "reset" } }, text: "{_'vfx.reset'}" }),
    ]),
    n("panel", { id: "vc-test", name: "Test", attrs: { class: "flex flex-wrap items-center gap-2" } }, [
      n("button", { id: "vc-test-start", if: "$testing === 'idle'", attrs: { type: "button", class: PRIMARY, disabled: "=!$micAvailable", "data-testid": "vfx-test" }, on: { click: { action: "test" } }, text: "{_'vfx.test'}" }),
      n("button", { id: "vc-test-stop", if: "$testing !== 'idle'", attrs: { type: "button", class: BUTTON, "data-testid": "vfx-test-stop" }, on: { click: { action: "stopTest" } }, text: "{_'vfx.stopTest'}" }),
      n("area", { id: "vc-test-recording", if: "$testing === 'recording'", attrs: { class: "text-sm text-red-600" }, text: "● {_'vfx.recording'}" }),
      n("area", { id: "vc-test-playing", if: "$testing === 'playing'", attrs: { class: "text-sm" }, text: "▶ {_'vfx.playing'}" }),
    ]),
    n("paragraph", { id: "vc-test-off", if: "!$active", attrs: { class: "text-xs text-muted-foreground" }, text: "{_'vfx.testOff'}" }),
    n("paragraph", { id: "vc-live", if: "$live > 0", attrs: { class: "text-xs text-muted-foreground", "data-testid": "vfx-live" }, text: "{$liveText}" }),
    n("paragraph", { id: "vc-error", if: "$error", attrs: { class: "rounded-xl border border-red-500/40 bg-red-500/10 p-2 text-xs", "data-testid": "vfx-error" }, text: "{$error}" }),
    n("paragraph", { id: "vc-limits", attrs: { class: "text-[11px] text-muted-foreground" }, text: "{_'vfx.limits'}" }),
  ]);
}

/** The Layout builder's preview: on with a preset, the custom values, not allowed. */
export const VOICE_VARIANTS: Record<"panel.voiceChanger", ReadonlyArray<{ id: string; label: string }>> = {
  "panel.voiceChanger": [{ id: "on", label: "On (a preset)" }, { id: "custom", label: "Custom values" }, { id: "off", label: "Not allowed by the operator" }],
};

export const VOICE_CONTRACTS: Record<"panel.voiceChanger", LayoutContract> = {
  "panel.voiceChanger": {
    description: "6.7: the voice changer — on or off for this client, a preset or custom values, a test recording.",
    vars: [
      { path: "$allowed", type: "yes/no", description: "The operator turned the module on (for this user)." },
      { path: "$supported", type: "yes/no", description: "This browser can change the voice live (AudioWorklet)." },
      { path: "$micAvailable", type: "yes/no", description: "There is a microphone API." },
      { path: "$on", type: "yes/no", description: "Switched on for this client." },
      { path: "$active", type: "yes/no", description: "Allowed and switched on: the microphone goes through it." },
      { path: "$preset", type: "text", description: "The preset's id." },
      { path: "$presets", type: "list", description: "The presets: .id, .label." },
      { path: "$custom", type: "yes/no", description: "The custom preset is chosen (its sliders show)." },
      { path: "$params", type: "object", description: "The custom values: .pitch, .formant, .robot, .echo, .echoMs, .whisper, .gain." },
      { path: "$testing", type: "text", description: "idle, recording or playing." },
      { path: "$live", type: "number", description: "Microphones going through it now." },
      { path: "$liveText", type: "text", description: "That, said in words." },
      { path: "$error", type: "text", description: "What went wrong (the voice was not changed, the test failed)." },
    ],
    actions: [
      { name: "toggle", description: "On / off.", event: "change" },
      { name: "preset", description: "A preset chosen.", event: "change" },
      { name: "param", description: "A custom value changed.", arg: "the value's name: pitch, formant, robot, echo, echoMs, whisper, gain", event: "change" },
      { name: "reset", description: "The custom values back to the defaults." },
      { name: "test", description: "Record a few seconds through it and play them back." },
      { name: "stopTest", description: "Stop the test." },
    ],
    slots: [],
    refs: [],
  },
};
