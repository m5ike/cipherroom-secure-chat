// The user's voice changer (6.7): on or off for this client, the preset and
// the custom parameters. Kept in this browser (localStorage) and nowhere
// else; whether it may be on at all is the operator's (the "voiceChanger"
// module — mic.ts › setVoiceFxAllowed).

import { fxParamsFor, isFxPreset, NEUTRAL_FX, sanitizeFxParams, type VoiceFxParams, type VoiceFxPreset } from "./voice-fx";

export type VoiceFxSettings = {
  /** Switched on for this client: every microphone of the app goes through it. */
  on: boolean;
  preset: VoiceFxPreset;
  /** The "custom" preset's own values. */
  custom: VoiceFxParams;
};

export const DEFAULT_VOICE_FX: Readonly<VoiceFxSettings> = Object.freeze({
  on: false,
  preset: "deep",
  custom: { ...NEUTRAL_FX, pitch: -5, formant: -3 },
});

const KEY = "m5cet.voiceFx";

export function sanitizeVoiceFxSettings(raw: unknown): VoiceFxSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    on: r.on === true,
    preset: isFxPreset(r.preset) ? r.preset : DEFAULT_VOICE_FX.preset,
    custom: r.custom && typeof r.custom === "object" ? sanitizeFxParams({ ...DEFAULT_VOICE_FX.custom, ...(r.custom as object) }) : { ...DEFAULT_VOICE_FX.custom },
  };
}

type Store = Pick<Storage, "getItem" | "setItem">;

function storage(): Store | null {
  try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; }
}

let current: VoiceFxSettings | null = null;
const listeners = new Set<(s: VoiceFxSettings) => void>();

export function loadVoiceFx(store: Store | null = storage()): VoiceFxSettings {
  try { return sanitizeVoiceFxSettings(JSON.parse(store?.getItem(KEY) || "{}")); } catch { return sanitizeVoiceFxSettings({}); }
}

/** The settings now (read once, then kept in memory). */
export function getVoiceFx(): VoiceFxSettings {
  if (!current) current = loadVoiceFx();
  return current;
}

/** Changes and saves the settings; everyone listening hears of it. */
export function setVoiceFx(patch: Partial<VoiceFxSettings>, store: Store | null = storage()): VoiceFxSettings {
  const next = sanitizeVoiceFxSettings({ ...getVoiceFx(), ...patch, custom: { ...getVoiceFx().custom, ...(patch.custom ?? {}) } });
  current = next;
  try { store?.setItem(KEY, JSON.stringify(next)); } catch { /* private mode: in memory only */ }
  for (const l of [...listeners]) l(next);
  return next;
}

export function onVoiceFxChange(listener: (s: VoiceFxSettings) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The parameters the settings ask for (the preset's, or the custom ones). */
export function settingsParams(s: VoiceFxSettings): VoiceFxParams {
  return fxParamsFor(s.preset, s.custom);
}

/** For tests: forget what was read (the listeners stay). */
export function resetVoiceFxForTests(): void {
  current = null;
}
