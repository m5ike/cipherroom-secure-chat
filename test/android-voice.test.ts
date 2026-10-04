// @vitest-environment node
// 6.7 — the Android app's voice area (server/android/design-67-voice.ts): the
// voice changer's settings screen is valid and in the default design, it
// offers the web's presets, Settings › Voice leads to it, "Send the text as
// voice" is offered with an empty field too (it dictates first), and every
// text the trees and the app's Java (ComposerVoice, SpeakSend) use exists in
// Czech, English and German.

import { describe, it, expect } from "vitest";
import { ACTIONS, DEFAULT_SCREENS, DEFAULT_STRINGS, SCREENS, sanitizeScreen, type ANode } from "../server/android/design";
import { AREA, FX_PRESET_IDS } from "../server/android/design-67-voice";
import { VOICE_FX_PRESET_IDS } from "../client/src/lib/voice-fx";

const find = (n: ANode, id: string): ANode | null => {
  if (n.id === id) return n;
  for (const c of n.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
};

describe("android voice (design-67-voice)", () => {
  it("its trees pass the sanitizer and are in the default design", () => {
    for (const [id, tree] of Object.entries(AREA.trees ?? {})) {
      const problems: string[] = [];
      sanitizeScreen(structuredClone(tree), id, problems);
      expect(problems, id).toEqual([]);
      expect(DEFAULT_SCREENS[id], id).toBeTruthy();
    }
    expect(SCREENS.some((s) => s.id === "settings.voiceFx")).toBe(true);
    for (const a of ["voiceFx.test", "voiceFx.reset"]) expect(ACTIONS.some((x) => x.action === a), a).toBe(true);
  });

  it("offers the web's presets, in the same order", () => {
    expect([...FX_PRESET_IDS]).toEqual([...VOICE_FX_PRESET_IDS]);
    const select = find(DEFAULT_SCREENS["settings.voiceFx"], "preset-select")!;
    expect(String(select.props?.options).split("|").map((o) => o.split(":")[0])).toEqual([...VOICE_FX_PRESET_IDS]);
    expect(select.props?.setting).toBe("voiceFx.preset");
    // The controls only when the operator's module allows it; the custom sliders only for "custom".
    expect(find(DEFAULT_SCREENS["settings.voiceFx"], "controls")?.if).toBe("$voiceFx.allowed");
    expect(find(DEFAULT_SCREENS["settings.voiceFx"], "custom")?.if).toBe("$settings.voiceFx.preset == 'custom'");
  });

  it("Settings › Voice leads to it; the attach sheet offers \"as voice\" with an empty field too", () => {
    const voice = DEFAULT_SCREENS["settings.voice"];
    const fx = find(voice, "fx")!;
    expect(fx.on?.click).toEqual({ action: "screen.open", arg: "settings.voiceFx" });
    const kids = find(voice, "list")!.children!.map((c) => c.id);
    expect(kids.indexOf("fx")).toBe(kids.indexOf("test") + 1);
    expect(find(DEFAULT_SCREENS.attach, "astts")?.if).toBeUndefined();
    // Patching twice adds nothing.
    const copy = structuredClone(DEFAULT_SCREENS);
    AREA.patch?.(copy);
    expect(find(copy["settings.voice"], "list")!.children!.filter((c) => c.id === "fx")).toHaveLength(1);
  });

  it("every text exists in Czech, English and German — the trees' and the app's", () => {
    const strings = AREA.strings!;
    const keys = new Set((["cs", "en", "de"] as const).flatMap((l) => Object.keys(strings[l] ?? {})));
    for (const l of ["cs", "en", "de"] as const) for (const k of keys) expect(strings[l]?.[k], `${l} ${k}`).toBeTruthy();
    const used = new Set<string>();
    const scan = (v: unknown): void => {
      if (typeof v === "string") for (const m of v.matchAll(/_\(?'([A-Za-z0-9_.-]+)'/g)) used.add(m[1]);
      else if (v && typeof v === "object") Object.values(v).forEach(scan);
    };
    scan(AREA.trees);
    scan(find(DEFAULT_SCREENS["settings.voice"], "fx"));
    // What the Java says on screen (ui/parts/ComposerVoice, voice/SpeakSend).
    for (const k of ["dict.stop", "dict.starting", "dict.err.other", "dict.err.not-allowed", "dict.err.audio-capture", "dict.err.network", "dict.err.language-not-supported", "dict.err.ended",
      "speakSend.speakNow", "speakSend.speakNowText", "speakSend.noVoice", "speakSend.serverOff", "speakSend.failed",
      "voice.nothingHeard", "voice.synthesizing", "voice.listening", "voice.failed", "voice.dictate", "look.dictate.none", "room.typeMessage", "room.offline"]) used.add(k);
    for (const k of used) for (const l of ["cs", "en", "de"] as const) expect(DEFAULT_STRINGS[l][k], `${l} ${k}`).toBeTruthy();
    // The new hints say what the actions now do.
    expect(DEFAULT_STRINGS.en["send.asVoiceHint"]).toContain("empty field");
  });
});
