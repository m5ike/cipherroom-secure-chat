// Registration (6.4) — what only the server can check about the form.
//
// The shared module (client/src/lib/registration/form.ts) checks and
// normalizes the fields; on top of it the server
//
//   the phone      validates it with libphonenumber's full metadata and
//                  refuses numbers that cannot be a mobile (a landline, toll
//                  free, premium rate, VoIP…) — "can't tell" is accepted
//   the e-mail     asks DNS whether its domain exists and receives mail:
//                  NXDOMAIN → no-domain, no MX / a null MX (RFC 7505) →
//                  no-mx, a timeout or SERVFAIL → dns-unavailable (try again)
//   uniqueness     compares keyed hashes of the normalized e-mail and phone
//                  with the registered accounts (store.contactTaken)
//
// Nothing the person typed is logged or stored in the clear: the audit gets
// field names and error codes, the account gets the two hashes, and the
// profile goes into the encrypted vault from the client.

import { Resolver } from "node:dns/promises";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { checkRegistration, type RegistrationErrors, type RegistrationInput } from "../../client/src/lib/registration/form";
import type { AccountStore } from "./store";

export type MailDomain = "ok" | "no-domain" | "no-mx" | "dns-unavailable";

const resolver = new Resolver({ timeout: 4_000, tries: 2 });

async function lookupMx(domain: string): Promise<MailDomain> {
  try {
    const records = await resolver.resolveMx(domain);
    // A null MX is a single record with an empty exchange: the domain takes no mail.
    return records.some((r) => r.exchange && r.exchange !== ".") ? "ok" : "no-mx";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND") return "no-domain";
    if (code === "ENODATA") return "no-mx";
    return "dns-unavailable";
  }
}

let lookup: (domain: string) => Promise<MailDomain> = lookupMx;
const cache = new Map<string, { answer: MailDomain; until: number }>();

/** Tests replace DNS; null restores it. */
export function setMxLookupForTests(fn: ((domain: string) => Promise<MailDomain>) | null): void {
  lookup = fn ?? lookupMx;
  cache.clear();
}

/** Whether mail for this (ASCII) domain has somewhere to go. Answers are cached; a DNS failure is not. */
export async function mailDomain(domain: string, now = Date.now()): Promise<MailDomain> {
  const hit = cache.get(domain);
  if (hit && hit.until > now) return hit.answer;
  const answer = await lookup(domain);
  if (answer !== "dns-unavailable") {
    if (cache.size > 2_000) cache.clear();
    cache.set(domain, { answer, until: now + (answer === "ok" ? 30 : 5) * 60_000 });
  }
  return answer;
}

/** Line types a mobile can have; undefined = the metadata can't tell, accepted. */
const MOBILE_TYPES = new Set([undefined, "MOBILE", "FIXED_LINE_OR_MOBILE"]);

export type ServerCheck =
  | { ok: true; normalized: RegistrationInput; hashes: { email: string; phone: string } }
  | { ok: false; status: 400 | 409 | 503; errors: RegistrationErrors; message: string };

/** The whole form as the server sees it: fields, line type, mail domain, then uniqueness. */
export async function checkRegistrationOnServer(input: unknown, store: Pick<AccountStore, "contactHashes" | "contactTaken">): Promise<ServerCheck> {
  const form = checkRegistration(input);
  const errors: RegistrationErrors = form.ok ? {} : { ...form.errors };
  const n = form.normalized;
  if (!errors.phone && n.phone) {
    const parsed = parsePhoneNumberFromString(n.phone);
    if (!parsed || !parsed.isValid()) errors.phone = "invalid";
    else if (!MOBILE_TYPES.has(parsed.getType())) errors.phone = "not-mobile";
  }
  if (!errors.email && n.email) {
    const answer = await mailDomain(n.email.slice(n.email.lastIndexOf("@") + 1));
    if (answer !== "ok") errors.email = answer;
  }
  const fields = Object.keys(errors) as Array<keyof RegistrationErrors>;
  if (fields.length) {
    const onlyDns = fields.every((f) => errors[f] === "dns-unavailable");
    return {
      ok: false,
      status: onlyDns ? 503 : 400,
      errors,
      message: onlyDns ? "The e-mail's domain could not be checked right now; try again in a moment." : `Please correct: ${fields.join(", ")}.`,
    };
  }
  const normalized = n as RegistrationInput;
  const hashes = store.contactHashes(normalized.email, normalized.phone);
  const taken = store.contactTaken(hashes);
  if (taken.email || taken.phone) {
    return {
      ok: false,
      status: 409,
      errors: { ...(taken.email ? { email: "taken" as const } : {}), ...(taken.phone ? { phone: "taken" as const } : {}) },
      message: "An account with this e-mail or phone already exists.",
    };
  }
  return { ok: true, normalized, hashes };
}

/** For the audit: "email:no-mx,phone:invalid" — codes only, never values. */
export function errorSummary(errors: RegistrationErrors): string {
  return Object.entries(errors).map(([field, code]) => `${field}:${code}`).join(",");
}
