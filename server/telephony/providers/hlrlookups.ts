// HLR-Lookups.com adapter for m5.telephony: live HLR (connectivity, roaming,
// porting, IMSI) — the one source of roaming / reachability that survives the
// Vonage Number Insight sunset (2027-02-04).
//
// Docs: https://www.hlr-lookups.com/en/api-docs
//   POST https://www.hlr-lookups.com/api/v2/hlr-lookup   {"msisdn":"+…"}
//   X-Digest-Key:       the API key
//   X-Digest-Signature: hex HMAC-SHA256, keyed with the API secret, over
//                       path + timestamp + method + body, where path is the
//                       endpoint path ("/hlr-lookup") and body the exact JSON sent
//   X-Digest-Timestamp: Unix seconds (the server allows ±30 s)

import { createHmac } from "node:crypto";
import { isE164 } from "../types";
import {
  ProviderError, ProviderNotConfigured,
  type Capability, type HlrResult, type ProviderAdapter, type ProviderStatus,
} from "./types";

const BASE = "https://www.hlr-lookups.com/api/v2";
const PATH = "/hlr-lookup";
const TIMEOUT_MS = 15_000;

const KEY = "HLRLOOKUPS_API_KEY";
const SECRET = "HLRLOOKUPS_API_SECRET";

const env = (name: string): string => process.env[name]?.trim() || "";
const cut = (s: string): string => (s.length > 300 ? `${s.slice(0, 299)}…` : s);
const str = (v: unknown): string | undefined => (v === undefined || v === null || v === "" ? undefined : String(v));

/** The X-Digest-Signature value: hex HMAC-SHA256(secret, path + timestamp + method + body). */
export function hlrLookupsSignature(path: string, timestamp: number | string, method: string, body: string, secret: string): string {
  return createHmac("sha256", secret).update(`${path}${timestamp}${method}${body}`).digest("hex");
}

const STATUS: Record<string, HlrResult["status"]> = {
  CONNECTED: "connected", ABSENT: "absent", INVALID_MSISDN: "invalid", UNDETERMINED: "undetermined",
};

export class HlrLookupsAdapter implements ProviderAdapter {
  readonly id = "hlrlookups" as const;
  readonly label = "HLR-Lookups.com";
  /** Clock in ms (injectable for tests). */
  constructor(private readonly now: () => number = () => Date.now()) {}

  status(): ProviderStatus {
    const missing = [KEY, SECRET].filter((n) => !env(n));
    const capabilities: Capability[] = ["hlr"];
    return {
      id: this.id, label: this.label, capabilities, configured: missing.length ? [] : ["hlr"],
      needs: { hlr: [KEY, SECRET] },
      reason: missing.length ? `Set ${missing.join(", ")} (hlr).` : undefined,
    };
  }

  async hlr(number: string): Promise<HlrResult> {
    const msisdn = String(number ?? "").trim();
    if (!isE164(msisdn)) throw new ProviderError(this.id, 400, cut(`HLR-Lookups: "number" must be an E.164 number like +420123456789 (got "${cut(msisdn)}").`));
    const key = env(KEY);
    const secret = env(SECRET);
    if (!key || !secret) throw new ProviderNotConfigured(this.id, "hlr", `HLR-Lookups.com is not configured: set ${KEY} and ${SECRET}.`);

    const body = JSON.stringify({ msisdn });
    const timestamp = Math.floor(this.now() / 1000);
    let res: Response;
    try {
      res = await fetch(`${BASE}${PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Digest-Key": key,
          "X-Digest-Signature": hlrLookupsSignature(PATH, timestamp, "POST", body, secret),
          "X-Digest-Timestamp": String(timestamp),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const e = err as Error;
      if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new ProviderError(this.id, 504, `HLR-Lookups: no answer within ${TIMEOUT_MS / 1000} s.`);
      throw new ProviderError(this.id, 502, cut(`HLR-Lookups: request failed: ${e?.message || String(err)}`));
    }
    const text = await res.text();
    if (!res.ok) {
      let message = text || res.statusText;
      let code: string | undefined;
      try {
        const j = JSON.parse(text) as { errors?: Array<{ code?: number | string; message?: string }>; message?: string };
        const first = j.errors?.[0];
        if (first?.message) message = first.message;
        else if (j.message) message = j.message;
        if (first?.code !== undefined) code = String(first.code);
      } catch { /* not JSON */ }
      throw new ProviderError(this.id, res.status, cut(`HLR-Lookups ${res.status}: ${message}`), code);
    }
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ProviderError(this.id, 502, cut(`HLR-Lookups ${res.status}: the answer is not JSON: ${text}`));
    }

    const connectivity = String(j.connectivity_status ?? "UNDETERMINED");
    const status = STATUS[connectivity] ?? "undetermined";
    const ported = typeof j.is_ported === "boolean" ? j.is_ported : null;
    const roaming = typeof j.is_roaming === "boolean"
      ? (j.is_roaming
        ? { status: "roaming", country: str(j.roaming_country_code) ?? str(j.roaming_country_name), network: str(j.roaming_network_name) }
        : { status: "not_roaming" })
      : null;
    return {
      number: str(j.msisdn) ?? msisdn,
      provider: this.id,
      status,
      valid: status === "invalid" ? false : status === "undetermined" ? null : true,
      reachable: connectivity,
      // The network the subscriber is on now: the ported-to network when ported.
      network: {
        name: (ported ? str(j.ported_network_name) : undefined) ?? str(j.original_network_name),
        mcc: str(j.mcc),
        mnc: str(j.mnc),
        country: (ported ? str(j.ported_country_code) : undefined) ?? str(j.original_country_code),
      },
      original: { name: str(j.original_network_name), country: str(j.original_country_code) },
      ported,
      roaming,
      imsi: str(j.imsi),
      cost: j.cost !== undefined && j.cost !== null ? `${String(j.cost)} EUR` : undefined,
      raw: j,
    };
  }
}
