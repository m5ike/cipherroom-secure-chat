// Registry of the optional server-side connectors. Reads which providers are
// present from the environment, exposes their status (without secrets), and
// resolves the default connector for each kind.
//
// Two operator gates, both OFF by default, keep these endpoints from becoming
// an open proxy to paid APIs:
//   ENABLE_AI=1      turns on /api/ai/*
//   ENABLE_SPEECH=1  turns on /api/speech/*

import { buildAiConnectors } from "./connectors/ai";
import { buildTtsConnectors, buildSttConnectors } from "./connectors/speech";
import type { AiConnector, TtsConnector, SttConnector, ConnectorStatus } from "./types";

const env = (name: string): string => (process.env[name]?.trim() || "");

export const aiEnabled = (): boolean => env("ENABLE_AI") === "1";
export const speechEnabled = (): boolean => env("ENABLE_SPEECH") === "1";

const aiConnectors = buildAiConnectors();
const ttsConnectors = buildTtsConnectors();
const sttConnectors = buildSttConnectors();

function resolve<T extends { id: string; status(): ConnectorStatus }>(list: T[], id: string | undefined, preferredEnv: string): T | undefined {
  if (id) return list.find((c) => c.id === id);
  const preferred = env(preferredEnv);
  if (preferred) { const hit = list.find((c) => c.id === preferred); if (hit) return hit; }
  return list.find((c) => c.status().configured) ?? list[0];
}

export function getAi(id?: string): AiConnector | undefined { return resolve(aiConnectors, id, "AI_PROVIDER"); }
export function getTts(id?: string): TtsConnector | undefined { return resolve(ttsConnectors, id, "TTS_PROVIDER"); }
export function getStt(id?: string): SttConnector | undefined { return resolve(sttConnectors, id, "STT_PROVIDER"); }

export function defaultIds(): { ai: string; tts: string; stt: string } {
  return { ai: getAi()?.id ?? "", tts: getTts()?.id ?? "", stt: getStt()?.id ?? "" };
}

export type RegistrySnapshot = {
  enabled: { ai: boolean; speech: boolean };
  defaults: { ai: string; tts: string; stt: string };
  ai: ConnectorStatus[];
  tts: ConnectorStatus[];
  stt: ConnectorStatus[];
};

export function registrySnapshot(): RegistrySnapshot {
  return {
    enabled: { ai: aiEnabled(), speech: speechEnabled() },
    defaults: defaultIds(),
    ai: aiConnectors.map((c) => c.status()),
    tts: ttsConnectors.map((c) => c.status()),
    stt: sttConnectors.map((c) => c.status()),
  };
}

/** Public (client-facing) view: what a room member may use right now. */
export function publicSpeechStatus() {
  return {
    ai: { enabled: aiEnabled(), connectors: aiConnectors.filter((c) => c.status().configured).map((c) => ({ id: c.id, label: c.label, model: c.status().model })) },
    tts: { enabled: speechEnabled(), connectors: ttsConnectors.filter((c) => c.status().configured).map((c) => ({ id: c.id, label: c.label })) },
    stt: { enabled: speechEnabled(), connectors: sttConnectors.filter((c) => c.status().configured).map((c) => ({ id: c.id, label: c.label })) },
  };
}

export const allAiConnectors = () => aiConnectors;
export const allTtsConnectors = () => ttsConnectors;
export const allSttConnectors = () => sttConnectors;
