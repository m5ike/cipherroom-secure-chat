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
// 6.4.1: the passkey's name (what the password manager lists) is the country
// and a scrambled "First-Last-Mobile" — passkeyName(). It lives only in the
// person's password manager; the server makes it for /register/start and
// keeps nothing of it.
//
// Nothing the person typed is logged or stored in the clear: the audit gets
// field names and error codes, the account gets the two hashes, and the
// profile goes into the encrypted vault from the client.

import { randomInt } from "node:crypto";
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

/* ------------------------------------------------------- passkey name */

/**
 * Moves about `ratio` of the characters to other places among themselves:
 * that many positions (not the hyphens, which keep the parts apart) are
 * picked at random and each hands its character on to the next one in a
 * random cycle — so every picked position changes. At least two when the
 * text has two characters to swap.
 */
export function scramble(text: string, ratio = 0.2, rand: (max: number) => number = randomInt): string {
  const chars = [...text];
  const slots = chars.flatMap((c, i) => (c === "-" ? [] : [i]));
  if (slots.length < 2) return text;
  const k = Math.min(slots.length, Math.max(2, Math.round(slots.length * ratio)));
  for (let i = 0; i < k; i++) {
    const j = i + rand(slots.length - i);
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  const picked = slots.slice(0, k);
  const moving = picked.map((p) => chars[p]);
  const out = chars.slice();
  picked.forEach((_p, i) => { out[picked[(i + 1) % k]] = moving[i]; });
  return out.join("");
}

const FOLD: Record<string, string> = { ł: "l", Ł: "L", đ: "d", Đ: "D", ø: "o", Ø: "O", ß: "ss", æ: "ae", Æ: "AE", œ: "oe", Œ: "OE", þ: "th", Þ: "Th", ð: "d", Ð: "D" };

/** A name part as letters and digits — Latin folded to ASCII, another script kept as it is. */
function token(value: string, max: number): string {
  const ascii = value.normalize("NFD").replace(/\p{M}/gu, "").replace(/[łŁđĐøØßæÆœŒþÞðÐ]/g, (c) => FOLD[c]).replace(/[^A-Za-z0-9]/g, "");
  const kept = ascii || value.normalize("NFC").replace(/[^\p{L}\p{N}]/gu, "");
  return [...kept].slice(0, max).join("");
}

/**
 * The passkey's name: "<ISO2>-" + scramble("First-Last-Mobile"), the mobile
 * as its national number — e.g. "CZ-Mi3ale-Ko38a-7a73kassa". Recognisable to
 * its owner in the password manager, not a plain copy of their details.
 */
export function passkeyName(n: RegistrationInput, rand: (max: number) => number = randomInt): string {
  const national = parsePhoneNumberFromString(n.phone)?.nationalNumber ?? n.phone.replace(/\D/g, "");
  const base = [token(n.firstName, 16), token(n.lastName, 16), String(national).slice(0, 15)].filter(Boolean).join("-");
  return `${n.country}-${scramble(base, 0.2, rand)}`;
}
