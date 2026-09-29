// m5.telephony.lookup / hlr (6.0): everything that can be learnt about a
// phone number. First what costs nothing — the numbering plan (numbers.ts):
// country, type, formats, time zones. Then every configured provider that
// can look numbers up (Twilio Lookup, Telnyx Number Lookup, Vonage Number
// Insight) and, for reachability and roaming, an HLR (HLR-Lookups.com,
// Vonage Advanced). The answers are merged; each provider's own is kept.

import { adapter, adapters } from "./providers";
import type { HlrResult, LookupField, LookupResult, ProviderAdapter } from "./providers/types";
// The numbering plan is a large table: loaded when a lookup first needs it.
const plan = () => import("./numbers");
import { TelError } from "./engine";
import { telStore } from "./tel-store";

const DEFAULT_FIELDS: LookupField[] = ["carrier", "line_type", "caller_name", "portability", "validation"];
const FIELDS = new Set<LookupField>(["carrier", "caller_name", "line_type", "portability", "sim_swap", "line_status", "validation"]);

export type LookupSource = { provider: string; kind: "lookup" | "hlr"; ok: boolean; error?: string; result?: LookupResult | HlrResult };

export async function e164Of(input: string, country?: string): Promise<string> {
  const n = (await plan()).normalizeNumber(input, country);
  if (!n) throw new TelError("bad-argument", `not a phone number: ${input.slice(0, 40)} (write it as +420603123456, or give the country)`);
  return n;
}

export async function lookupNumber(input: string, o: { offline?: boolean; fields?: string[]; providers?: string[]; country?: string } = {}) {
  const { mergeLookups, numberInfo } = await plan();
  const number = await e164Of(input, o.country);
  const offline = numberInfo(number);
  if (o.offline) return { number, offline, summary: mergeLookups(offline, []), sources: [] as LookupSource[] };
  const fields = (o.fields?.length ? o.fields.filter((f): f is LookupField => FIELDS.has(f as LookupField)) : DEFAULT_FIELDS);
  const chosen: ProviderAdapter[] = o.providers?.length
    ? o.providers.map((id) => adapter(id)).filter((a): a is ProviderAdapter => Boolean(a))
    : adapters().filter((a) => a.status().configured.some((c) => c === "lookup" || c === "hlr"));
  const jobs: Array<Promise<LookupSource>> = [];
  for (const a of chosen) {
    const st = a.status().configured;
    if (a.lookup && st.includes("lookup")) jobs.push(a.lookup(number, fields).then((result) => ({ provider: a.id, kind: "lookup" as const, ok: true, result }), (err) => ({ provider: a.id, kind: "lookup" as const, ok: false, error: (err as Error).message.slice(0, 200) })));
    // An HLR asks the home network (reachable, roaming): only a dedicated HLR provider by default.
    if (a.hlr && st.includes("hlr") && (a.id === "hlrlookups" || o.providers?.includes(a.id))) jobs.push(a.hlr(number).then((result) => ({ provider: a.id, kind: "hlr" as const, ok: true, result }), (err) => ({ provider: a.id, kind: "hlr" as const, ok: false, error: (err as Error).message.slice(0, 200) })));
  }
  const sources = await Promise.all(jobs);
  await telStore.ready();
  telStore.record({ kind: "lookup", level: "info", ref: number, provider: sources.map((s) => s.provider).join(","), summary: `lookup ${number}: ${sources.filter((s) => s.ok).length}/${sources.length} answered`, detail: { fields } });
  const summary = mergeLookups(offline, sources.filter((s) => s.ok && s.result).map((s) => s.result!));
  return { number, offline, summary, sources };
}

export async function hlrNumber(input: string, provider?: string): Promise<HlrResult> {
  const number = await e164Of(input);
  const a = provider ? adapter(provider) : adapters().find((x) => x.hlr && x.status().configured.includes("hlr"));
  if (!a || !a.hlr) throw new TelError("not-configured", provider ? `${provider} cannot do an HLR query` : "no provider is configured for HLR (HLR-Lookups.com: HLRLOOKUPS_API_KEY / HLRLOOKUPS_API_SECRET, or Vonage Number Insight)");
  if (!a.status().configured.includes("hlr")) throw new TelError("not-configured", `${a.label} is not configured for HLR`);
  const r = await a.hlr(number);
  await telStore.ready();
  telStore.record({ kind: "hlr", level: "info", ref: number, provider: a.id, summary: `HLR ${number}: ${r.status}${r.roaming?.status ? `, roaming ${r.roaming.status}` : ""}`, detail: {} });
  return r;
}
