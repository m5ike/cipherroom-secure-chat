// Telephony › Overview (6.9): one answer for the console's first tab — every
// provider and what it can carry (its application, SIP trunks), the counts of
// what is configured and going on, and the warnings an operator should act on
// (no public address for webhooks, unsigned webhooks, calls with nowhere to
// go, rules that point at a TSA that is not there or not published).

import type { Express, Request, Response } from "express";
import { providerStatuses } from "../providers";
import { publicBaseUrl } from "../connectors";
import { sipStore } from "../sip";
import { telStore } from "../tel-store";
import { FINAL_CALL_STATUSES } from "../providers/types";
import { tsaStore } from "../tsa/store";
import { getPermissions, getRules } from "./store";
import { inrouteCount } from "./inroute";
import { logCounts } from "./log";
import type { OverviewAnswer } from "./api-contract";

const CALL_PROVIDERS = new Set(["twilio", "telnyx", "vonage"]);
const env = (k: string) => (process.env[k] ?? "").trim();

export async function telephonyOverview(now = Date.now()): Promise<OverviewAnswer> {
  const statuses = providerStatuses();
  const trunks = sipStore.list();
  const providers = statuses.map((p) => ({
    id: p.id,
    label: p.label,
    capabilities: [...p.capabilities],
    configured: [...p.configured],
    ...(p.reason ? { reason: p.reason } : {}),
    // A SIP trunk is dialled through a provider that carries calls (control/types.ts RouteService).
    services: { app: p.configured.includes("call"), sip: CALL_PROVIDERS.has(p.id) && p.configured.includes("call") && trunks.length > 0 },
  }));

  const { inbound, outbound } = getRules();
  const tsas = tsaStore.list();
  await telStore.ready();
  const liveCalls = telStore.calls.list({ after: now - 6 * 3600_000, limit: 5000, filter: (c) => !FINAL_CALL_STATUSES.includes(c.status) }).length;
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const [inroute, today] = await Promise.all([inrouteCount(), logCounts(midnight.getTime())]);

  const warnings: string[] = [];
  const base = publicBaseUrl();
  const callers = providers.filter((p) => p.services.app);
  if (!base) warnings.push("PUBLIC_BASE_URL is not set: providers cannot reach this server's webhooks, so inbound calls, TSA callbacks and delivery reports do not arrive.");
  else if (!/^https:\/\//.test(base)) warnings.push(`PUBLIC_BASE_URL (${base}) is not https: providers refuse or warn about plain-http webhooks, and media streams need wss.`);
  if (!callers.length) warnings.push("No provider is configured for calls (Telephony › Providers names the variables to set).");
  if (callers.some((p) => p.id === "telnyx") && !env("TELNYX_PUBLIC_KEY")) warnings.push(`TELNYX_PUBLIC_KEY is not set: Telnyx webhooks are accepted unverified${process.env.TELEPHONY_ALLOW_UNSIGNED?.trim() === "1" ? " and drive inbound calls (TELEPHONY_ALLOW_UNSIGNED=1) — anybody can forge a call" : "; inbound calls do not reach the rules, TSAs or the bridge"}.`);
  if (callers.some((p) => p.id === "vonage") && !env("VONAGE_SIGNATURE_SECRET")) warnings.push(`VONAGE_SIGNATURE_SECRET is not set: Vonage webhooks are accepted unverified${process.env.TELEPHONY_ALLOW_UNSIGNED?.trim() === "1" ? " and drive inbound calls (TELEPHONY_ALLOW_UNSIGNED=1) — anybody can forge a call" : "; inbound calls do not reach the rules, TSAs or the bridge"}.`);
  const p = getPermissions();
  if (callers.length && !inbound.some((r) => r.enabled) && p.defaults.inbound.kind === "state") warnings.push(`No inbound rule is on: every inbound call gets the default "${p.defaults.inbound.state}".`);
  const byId = new Map(tsas.map((t) => [t.id, t]));
  for (const r of [...inbound, ...outbound]) {
    if (!r.enabled || r.target.kind !== "tsa") continue;
    const t = byId.get(r.target.tsa);
    if (!t) warnings.push(`The rule "${r.label || r.id}" routes to the TSA "${r.target.tsa}", which does not exist — its calls fail.`);
    else if (!t.published) warnings.push(`The rule "${r.label || r.id}" routes to the TSA "${t.name}", which is not published — its calls fail until it is.`);
  }
  for (const [dir, d] of [["inbound", p.defaults.inbound], ["outbound", p.defaults.outbound]] as const) {
    if (d.kind === "tsa" && !byId.get(d.tsa)?.published) warnings.push(`The ${dir} default routes to the TSA "${d.tsa}", which is missing or not published.`);
  }

  return {
    providers,
    counts: {
      inboundRules: inbound.length, outboundRules: outbound.length,
      tsa: tsas.length, tsaPublished: tsas.filter((t) => t.published).length,
      liveCalls, inroute, eventsToday: today.events, errorsToday: today.errors,
    },
    publicBaseUrl: base,
    warnings,
  };
}

export function registerOverviewRoute(app: Express): void {
  app.get("/admin/telephony/overview", async (_req: Request, res: Response) => {
    try { res.json({ ok: true, ...(await telephonyOverview()) }); }
    catch (err) { res.status(500).json({ ok: false, message: (err as Error).message.slice(0, 300) }); }
  });
}
