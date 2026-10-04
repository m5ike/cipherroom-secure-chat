// 6.9: a SIP trunk with its credentials, for dialling through it (an outbound
// rule's "sip" service, a TSA's dial over a trunk). sip.ts never returns a
// password, so this reads the same two sources it does — SIP_TRUNKS in the
// environment (wins on the same id) and the telephony data file. The result
// goes straight to the provider; it is never logged or returned to a client.

import { loadTelephonyFile } from "../store";
import type { PlaceCallInput } from "../providers/types";

export type TrunkWithSecret = NonNullable<PlaceCallInput["via"]>["trunk"] & {
  label: string;
  callerIdNumber: string;
  callerIdName: string;
  didNumbers: string[];
};

type Raw = { id?: unknown; label?: unknown; host?: unknown; port?: unknown; username?: unknown; authUser?: unknown; password?: unknown; transport?: unknown; callerIdNumber?: unknown; callerIdName?: unknown; didNumbers?: unknown };

const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function shape(r: Raw): TrunkWithSecret | null {
  const id = s(r.id);
  const host = s(r.host);
  if (!id || !/^[a-zA-Z0-9.:_-]{1,255}$/.test(host)) return null;
  const port = Number(r.port);
  const transport = s(r.transport).toLowerCase();
  return {
    id,
    // The URI carries the port when it is not SIP's default.
    host: Number.isInteger(port) && port > 0 && port !== 5060 && !host.includes(":") ? `${host}:${port}` : host,
    username: s(r.authUser) || s(r.username),
    password: typeof r.password === "string" ? r.password : "",
    ...(transport === "tcp" || transport === "tls" || transport === "udp" ? { transport: transport as "udp" | "tcp" | "tls" } : port === 5061 ? { transport: "tls" as const } : {}),
    label: s(r.label) || id,
    callerIdNumber: s(r.callerIdNumber),
    callerIdName: s(r.callerIdName),
    didNumbers: Array.isArray(r.didNumbers) ? r.didNumbers.filter((d): d is string => typeof d === "string") : [],
  };
}

/** The trunk `id` with its password, or null. */
export function trunkWithSecret(id: string): TrunkWithSecret | null {
  const want = String(id ?? "").trim();
  if (!want) return null;
  try {
    const env = process.env.SIP_TRUNKS?.trim();
    if (env) {
      const arr = JSON.parse(env) as unknown;
      if (Array.isArray(arr)) for (const r of arr) if (r && typeof r === "object" && s((r as Raw).id) === want) return shape(r as Raw);
    }
  } catch { /* sip.ts reports a bad SIP_TRUNKS */ }
  const hit = loadTelephonyFile().data.trunks.find((t) => t.id === want);
  return hit ? shape(hit as unknown as Raw) : null;
}

/** The trunk without its secret (for logs and answers). */
export function trunkView(t: TrunkWithSecret): Omit<TrunkWithSecret, "password"> & { hasPassword: boolean } {
  const { password, ...rest } = t;
  return { ...rest, hasPassword: Boolean(password) };
}
