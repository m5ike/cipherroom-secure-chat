// m5.telephony provider registry: one adapter per provider, in a fixed order
// (twilio, telnyx, vonage, hlrlookups, meta). Adapters read their credentials
// from the environment at call time, so the instances are shared.

import type { Capability, ProviderAdapter, ProviderId, ProviderStatus } from "./types";
import { TwilioAdapter } from "./twilio";
import { TelnyxAdapter } from "./telnyx";
import { VonageAdapter } from "./vonage";
import { HlrLookupsAdapter } from "./hlrlookups";
import { MetaAdapter } from "./meta";

const ALL: readonly ProviderAdapter[] = [
  new TwilioAdapter(), new TelnyxAdapter(), new VonageAdapter(), new HlrLookupsAdapter(), new MetaAdapter(),
];

/** Every adapter, in registry order. */
export function adapters(): ProviderAdapter[] {
  return [...ALL];
}

/** The adapter for a provider id, or undefined for an unknown id. */
export function adapter(id: ProviderId | string): ProviderAdapter | undefined {
  return ALL.find((a) => a.id === id);
}

/** status() of every adapter, in registry order (env var names only, never values). */
export function providerStatuses(): ProviderStatus[] {
  return ALL.map((a) => a.status());
}

const configuredFor = (a: ProviderAdapter, capability: Capability) => a.status().configured.includes(capability);

/**
 * The adapter to use for a capability: the preferred one when it is configured
 * for it, else the first configured adapter (registry order) that has it, else undefined.
 */
export function pick(capability: Capability, preferred?: ProviderId | string): ProviderAdapter | undefined {
  if (preferred) {
    const p = adapter(preferred);
    if (p && configuredFor(p, capability)) return p;
  }
  return ALL.find((a) => configuredFor(a, capability));
}

export { TwilioAdapter, renderTwiml, xmlEscape, splitStreamUrl, twilioVoice, TWILIO_DIAL_STATUS } from "./twilio";
export { TelnyxAdapter, telnyxPendingActions, telnyxWaitsFor, telnyxVoice, telnyxCommands, telnyxDialStatus, TELNYX_HANGUP_STATUS, TELNYX_REJECT_CAUSE } from "./telnyx";
export { VonageAdapter, renderNcco, vonageDtmf, VONAGE_CALL_STATUS } from "./vonage";
export { sipTarget, sipUser, sipHost, isSipAddress } from "./sip-uri";
export { HlrLookupsAdapter, hlrLookupsSignature } from "./hlrlookups";
export { MetaAdapter } from "./meta";
export * from "./types";
