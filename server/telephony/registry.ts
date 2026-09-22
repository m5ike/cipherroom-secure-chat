// Registry of the optional telephony connectors. Reads which providers are
// present from the environment, exposes their status (without secrets), and
// resolves the DEFAULT connector for each kind. Mirrors server/plugins/registry.ts.
//
// One operator gate, OFF by default, keeps these endpoints from becoming an
// open proxy to paid, billable telephony APIs:
//   ENABLE_TELEPHONY=1   turns on /api/telephony/*
//
// Which provider handles SMS and which handles VOICE (resolution order):
//   1. an explicit `connector` in the request,
//   2. the admin console choice (persisted in the telephony data file),
//   3. SMS_PROVIDER / VOICE_PROVIDER in .env  (twilio | telnyx | vonage),
//   4. the first provider that is actually configured.
// The snapshot reports which of these picked the current default.

import { buildSmsConnectors, buildVoiceConnectors, providerWebhookSpecs, publicBaseUrl } from "./connectors";
import { sipEnvSeed, sipStore, type SipTrunk } from "./sip";
import { dataFileMtime, loadTelephonyFile, persistenceStatus, saveTelephonyFile, type PersistedSettings } from "./store";
import { isProvider, PROVIDERS, type ConnectorStatus, type SmsConnector, type TelephonyProvider, type VoiceConnector, type WebhookSpec, type WebhookVerify } from "./types";
import { webhookVerificationStatus } from "./webhooks";

const env = (name: string): string => (process.env[name]?.trim() || "");

export const telephonyEnabled = (): boolean => env("ENABLE_TELEPHONY") === "1";

const smsConnectors = buildSmsConnectors();
const voiceConnectors = buildVoiceConnectors();

/* ------------------------------------------- admin-chosen defaults (file) */

let settingsCache: { settings: PersistedSettings; mtime: number; file: string } | null = null;

/** Persisted admin choices; re-read whenever the data file changes. */
export function getSettings(): PersistedSettings {
  const status = persistenceStatus();
  const mtime = dataFileMtime();
  if (!settingsCache || settingsCache.mtime !== mtime || settingsCache.file !== status.file) {
    const { data } = loadTelephonyFile();
    settingsCache = { settings: { ...data.settings }, mtime, file: status.file };
  }
  return settingsCache.settings;
}

export function setDefaultProviders(patch: { sms?: string | null; voice?: string | null }):
  { ok: true; settings: PersistedSettings } | { ok: false; message: string } {
  const { data } = loadTelephonyFile(); // read-modify-write keeps the trunks section
  const next: PersistedSettings = { ...data.settings };
  if (patch.sms !== undefined) {
    if (patch.sms === null || patch.sms === "") delete next.smsProvider;
    else if (!isProvider(patch.sms)) return { ok: false, message: `unknown SMS provider "${patch.sms}" (twilio | telnyx | vonage)` };
    else next.smsProvider = patch.sms;
  }
  if (patch.voice !== undefined) {
    if (patch.voice === null || patch.voice === "") delete next.voiceProvider;
    else if (!isProvider(patch.voice)) return { ok: false, message: `unknown voice provider "${patch.voice}" (twilio | telnyx | vonage)` };
    else next.voiceProvider = patch.voice;
  }
  const r = saveTelephonyFile({ ...data, settings: next });
  if (!r.ok) return { ok: false, message: r.message };
  settingsCache = null;
  return { ok: true, settings: next };
}

/* ------------------------------------------------------------ resolution */

export type DefaultSource = "request" | "admin" | "env" | "auto" | "none";

function resolveWith<T extends { id: string; status(): ConnectorStatus }>(
  list: T[], id: string | undefined, adminPick: string | undefined, envName: string,
): { connector: T | undefined; source: DefaultSource } {
  if (id) return { connector: list.find((c) => c.id === id), source: "request" };
  if (adminPick) { const hit = list.find((c) => c.id === adminPick); if (hit) return { connector: hit, source: "admin" }; }
  const preferred = env(envName);
  if (preferred) { const hit = list.find((c) => c.id === preferred); if (hit) return { connector: hit, source: "env" }; }
  const first = list.find((c) => c.status().configured);
  return first ? { connector: first, source: "auto" } : { connector: list[0], source: "none" };
}

export function getSms(id?: string): SmsConnector | undefined { return resolveWith(smsConnectors, id, getSettings().smsProvider, "SMS_PROVIDER").connector; }
export function getVoice(id?: string): VoiceConnector | undefined { return resolveWith(voiceConnectors, id, getSettings().voiceProvider, "VOICE_PROVIDER").connector; }

export function defaultIds(): { sms: string; voice: string } {
  return { sms: getSms()?.id ?? "", voice: getVoice()?.id ?? "" };
}

export function defaultsSource(): { sms: DefaultSource; voice: DefaultSource } {
  const s = getSettings();
  return {
    sms: resolveWith(smsConnectors, undefined, s.smsProvider, "SMS_PROVIDER").source,
    voice: resolveWith(voiceConnectors, undefined, s.voiceProvider, "VOICE_PROVIDER").source,
  };
}

/* ---------------------------------------------------------------- snapshot */

export type ProviderWebhookInfo = {
  provider: TelephonyProvider;
  verification: { verify: WebhookVerify; configured: boolean; needs: string };
  specs: WebhookSpec[];
};

export type TelephonyRegistrySnapshot = {
  enabled: boolean;
  defaults: { sms: string; voice: string };
  defaultsSource: { sms: DefaultSource; voice: DefaultSource };
  settings: PersistedSettings;
  sms: ConnectorStatus[];
  voice: ConnectorStatus[];
  sip: SipTrunk[];
  envTrunks: { loaded: number; errors: string[] };
  persistence: { file: string; exists: boolean; writable: boolean; reason?: string; lastSaveError: string };
  publicBaseUrl: string;
  webhooks: ProviderWebhookInfo[];
};

export function registrySnapshot(): TelephonyRegistrySnapshot {
  return {
    enabled: telephonyEnabled(),
    defaults: defaultIds(),
    defaultsSource: defaultsSource(),
    settings: { ...getSettings() },
    sms: smsConnectors.map((c) => c.status()),
    voice: voiceConnectors.map((c) => c.status()),
    sip: sipStore.list(),
    envTrunks: sipEnvSeed,
    persistence: { ...persistenceStatus(), lastSaveError: sipStore.saveError },
    publicBaseUrl: publicBaseUrl(),
    webhooks: PROVIDERS.map((p) => ({ provider: p, verification: webhookVerificationStatus(p), specs: providerWebhookSpecs(p) })),
  };
}

/** Public (client-facing) view: enabled + only the configured connector ids. */
export function publicStatus() {
  return {
    enabled: telephonyEnabled(),
    defaults: defaultIds(),
    sms: smsConnectors.filter((c) => c.status().configured).map((c) => ({ id: c.id, label: c.label })),
    voice: voiceConnectors.filter((c) => c.status().configured).map((c) => ({ id: c.id, label: c.label })),
  };
}

export const allSmsConnectors = () => smsConnectors;
export const allVoiceConnectors = () => voiceConnectors;
