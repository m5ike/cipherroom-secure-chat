// Registry of the optional telephony connectors. Reads which providers are
// present from the environment, exposes their status (without secrets), and
// resolves the default connector for each kind. Mirrors server/plugins/registry.ts.
//
// One operator gate, OFF by default, keeps these endpoints from becoming an
// open proxy to paid, billable telephony APIs:
//   ENABLE_TELEPHONY=1   turns on /api/telephony/*

import { buildSmsConnectors, buildVoiceConnectors } from "./connectors";
import { sipStore, type SipTrunk } from "./sip";
import type { SmsConnector, VoiceConnector, ConnectorStatus } from "./types";

const env = (name: string): string => (process.env[name]?.trim() || "");

export const telephonyEnabled = (): boolean => env("ENABLE_TELEPHONY") === "1";

const smsConnectors = buildSmsConnectors();
const voiceConnectors = buildVoiceConnectors();

function resolve<T extends { id: string; status(): ConnectorStatus }>(list: T[], id: string | undefined, preferredEnv: string): T | undefined {
  if (id) return list.find((c) => c.id === id);
  const preferred = env(preferredEnv);
  if (preferred) { const hit = list.find((c) => c.id === preferred); if (hit) return hit; }
  return list.find((c) => c.status().configured) ?? list[0];
}

export function getSms(id?: string): SmsConnector | undefined { return resolve(smsConnectors, id, "SMS_PROVIDER"); }
export function getVoice(id?: string): VoiceConnector | undefined { return resolve(voiceConnectors, id, "VOICE_PROVIDER"); }

export function defaultIds(): { sms: string; voice: string } {
  return { sms: getSms()?.id ?? "", voice: getVoice()?.id ?? "" };
}

export type TelephonyRegistrySnapshot = {
  enabled: boolean;
  defaults: { sms: string; voice: string };
  sms: ConnectorStatus[];
  voice: ConnectorStatus[];
  sip: SipTrunk[];
};

export function registrySnapshot(): TelephonyRegistrySnapshot {
  return {
    enabled: telephonyEnabled(),
    defaults: defaultIds(),
    sms: smsConnectors.map((c) => c.status()),
    voice: voiceConnectors.map((c) => c.status()),
    sip: sipStore.list(),
  };
}

/** Public (client-facing) view: enabled + only the configured connector ids. */
export function publicStatus() {
  return {
    enabled: telephonyEnabled(),
    sms: smsConnectors.filter((c) => c.status().configured).map((c) => ({ id: c.id, label: c.label })),
    voice: voiceConnectors.filter((c) => c.status().configured).map((c) => ({ id: c.id, label: c.label })),
  };
}

export const allSmsConnectors = () => smsConnectors;
export const allVoiceConnectors = () => voiceConnectors;
