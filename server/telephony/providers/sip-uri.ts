// 6.9: SIP addresses for the adapters — a dial to a SIP URI, a number carried
// over the operator's SIP trunk (sip:+420…@trunk.host;transport=tls), and the
// user part of an inbound SIP URI (the test SIP address, sipUri in events).
// Plus degrade(): one log line when a provider cannot do what an action asks
// and the adapter does the nearest thing instead (rate-limited per process).

import { telLog } from "../control/hooks";
import type { CallAction, ProviderId } from "./types";

export type DialTrunk = NonNullable<Extract<CallAction, { dial: unknown }>["dial"]["trunk"]>;

/** "sip:", "sips:" or nothing — the scheme of a SIP address. */
export const isSipAddress = (v: string | undefined | null): boolean => typeof v === "string" && /^sips?:/i.test(v.trim());

/**
 * Where a dial goes as a SIP URI:
 *   kind "sip"     the address as given ("sip:" added when missing; a bare user goes to the trunk's host)
 *   kind "number"  over a trunk: sip:<number>@<host>
 * A trunk's transport other than UDP is added as ;transport=… (unless the URI has one).
 */
export function sipTarget(to: string, kind: "number" | "sip", trunk?: DialTrunk): string {
  const t = String(to ?? "").trim();
  let uri: string;
  if (kind === "sip") {
    if (isSipAddress(t)) uri = t;
    else if (t.includes("@")) uri = `sip:${t}`;
    else if (trunk?.host) uri = `sip:${t}@${trunk.host}`;
    else uri = `sip:${t}`;
  } else {
    if (!trunk?.host) return t;
    uri = `sip:${t}@${trunk.host}`;
  }
  const transport = trunk?.transport;
  if (transport && transport !== "udp" && !/;transport=/i.test(uri)) uri += `;transport=${transport}`;
  return uri;
}

/** The user part of a SIP URI ("sip:test-ab12@x.sip.twilio.com;transport=tls" → "test-ab12"); a non-URI as is. */
export function sipUser(uri: string): string {
  const s = String(uri ?? "").trim().replace(/^sips?:/i, "");
  const at = s.indexOf("@");
  return (at >= 0 ? s.slice(0, at) : s.split(/[;?]/)[0]).trim();
}

/** The host of a SIP URI, lower case, without port and parameters ("" when there is none). */
export function sipHost(uri: string): string {
  const s = String(uri ?? "").trim().replace(/^sips?:/i, "");
  const at = s.indexOf("@");
  if (at < 0) return "";
  return s.slice(at + 1).split(/[;?:>]/)[0].toLowerCase();
}

const said = new Map<string, number>();

/** One notice per provider + what, every 10 minutes: the provider cannot do it; the nearest behaviour runs instead. */
export function degrade(provider: ProviderId, what: string): void {
  const key = `${provider}|${what}`;
  const now = Date.now();
  if ((said.get(key) ?? 0) > now - 600_000) return;
  said.set(key, now);
  if (said.size > 500) said.clear();
  telLog({ kind: "call", level: "notice", provider, direction: "", summary: `${provider} cannot do this — ${what}` });
}
