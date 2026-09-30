// Registration (6.4) — the form's fields, how each is checked and normalized.
//
// One module for both sides: the server runs it as the authority (plus the
// checks only it can do — the phone's line type, the e-mail domain's MX
// records, whether the e-mail or phone is already registered), the web form
// runs it for feedback while the person types. The Android app mirrors the
// light checks and relies on the server's answer.
//
// Personal data stays the person's: the server keeps only keyed hashes of the
// normalized e-mail and phone (to refuse a second registration), the profile
// itself goes into the account's end-to-end encrypted vault as
// `profile.registration` (see RegistrationProfile).
//
// Phone numbers use libphonenumber's "min" metadata here (validity, E.164);
// the server loads "max" for the line type.

import { getCountries, getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/min";

export type RegistrationField = "firstName" | "lastName" | "country" | "phone" | "email";
export const REGISTRATION_FIELDS: readonly RegistrationField[] = ["firstName", "lastName", "country", "phone", "email"];

export type RegistrationInput = Record<RegistrationField, string>;

/** Why a field was refused. The server adds not-mobile, no-domain, no-mx, dns-unavailable and taken. */
export type FieldError = "required" | "too-long" | "invalid" | "not-mobile" | "no-domain" | "no-mx" | "dns-unavailable" | "taken";
export type RegistrationErrors = Partial<Record<RegistrationField, FieldError>>;

/** What the vault keeps (profile.registration), normalized values only. */
export type RegistrationProfile = RegistrationInput & { registeredAt: number };

export const REGISTRATION_LIMITS = { nameChars: 64, emailChars: 254, localChars: 64, domainChars: 253, phoneChars: 32 } as const;

/* -------------------------------------------------------------- countries */

export type Country = { code: string; dial: string };

let countries: Country[] | null = null;
let countryCodes: Set<string> | null = null;

/** Every country libphonenumber knows, with its calling code, sorted by code. */
export function countryList(): Country[] {
  if (!countries) {
    countries = getCountries().map((code) => ({ code, dial: String(getCountryCallingCode(code)) })).sort((a, b) => a.code.localeCompare(b.code));
    countryCodes = new Set(countries.map((c) => c.code));
  }
  return countries;
}

export function isCountry(code: unknown): code is string {
  countryList();
  return typeof code === "string" && countryCodes!.has(code);
}

/** 🇨🇿 from "CZ" (regional indicator symbols). */
export function flagEmoji(code: string): string {
  return /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : "";
}

/* ------------------------------------------------------------------ fields */

type Checked = { value: string; error?: FieldError };

const NAME_CHARS = /^[\p{L}\p{M} .'’-]+$/u;

/** NFC, trimmed, inner whitespace collapsed to one space. */
export function normalizeName(raw: unknown): string {
  return typeof raw === "string" ? raw.normalize("NFC").replace(/\s+/gu, " ").trim() : "";
}

export function checkName(raw: unknown): Checked {
  const value = normalizeName(raw);
  if (!value) return { value, error: "required" };
  if ([...value].length > REGISTRATION_LIMITS.nameChars) return { value, error: "too-long" };
  if (!NAME_CHARS.test(value) || !/\p{L}/u.test(value)) return { value, error: "invalid" };
  return { value };
}

export function checkCountry(raw: unknown): Checked {
  const value = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!value) return { value, error: "required" };
  return isCountry(value) ? { value } : { value, error: "invalid" };
}

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** The domain in ASCII (an internationalized one as punycode), or "" when it cannot be one. */
export function asciiDomain(raw: string): string {
  const d = raw.trim().replace(/\.$/, "");
  if (!d || /[\s/\\?#@:[\]]/.test(d)) return "";
  try { return new URL(`http://${d}`).hostname.toLowerCase(); } catch { return ""; }
}

/**
 * Trimmed and lower-cased (the whole address: two spellings of one mailbox
 * must be one registration), the domain in ASCII. Syntax only — the server
 * then asks DNS whether the domain exists and receives mail (MX).
 */
export function checkEmail(raw: unknown): Checked & { domain: string } {
  const typed = typeof raw === "string" ? raw.trim() : "";
  if (!typed) return { value: "", domain: "", error: "required" };
  if (typed.length > REGISTRATION_LIMITS.emailChars) return { value: typed, domain: "", error: "too-long" };
  const at = typed.lastIndexOf("@");
  if (at <= 0 || at === typed.length - 1) return { value: typed, domain: "", error: "invalid" };
  const local = typed.slice(0, at).toLowerCase();
  const domain = asciiDomain(typed.slice(at + 1));
  const labels = domain.split(".");
  const ok = local.length <= REGISTRATION_LIMITS.localChars && LOCAL_PART.test(local)
    && domain.length > 0 && domain.length <= REGISTRATION_LIMITS.domainChars
    && labels.length >= 2 && labels.every((l) => LABEL.test(l)) && TLD.test(labels[labels.length - 1]);
  const value = `${local}@${domain || typed.slice(at + 1).toLowerCase()}`;
  return ok ? { value, domain } : { value, domain: "", error: "invalid" };
}

/** The number in E.164 when it is a valid number (the country is the default for a national format). */
export function checkPhone(raw: unknown, country: string): Checked {
  let typed = typeof raw === "string" ? raw.trim() : "";
  if (!typed) return { value: "", error: "required" };
  if (typed.length > REGISTRATION_LIMITS.phoneChars) return { value: typed, error: "too-long" };
  if (typed.startsWith("00")) typed = `+${typed.slice(2)}`;
  const parsed = parsePhoneNumberFromString(typed, isCountry(country) ? (country as CountryCode) : undefined);
  if (!parsed || !parsed.isValid()) return { value: typed, error: "invalid" };
  return { value: parsed.number };
}

/* -------------------------------------------------------------------- form */

export type FormCheck =
  | { ok: true; normalized: RegistrationInput; emailDomain: string }
  | { ok: false; errors: RegistrationErrors; normalized: Partial<RegistrationInput> };

/** Every field at once; unknown or missing input counts as empty. */
export function checkRegistration(input: unknown): FormCheck {
  const b = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const firstName = checkName(b.firstName);
  const lastName = checkName(b.lastName);
  const country = checkCountry(b.country);
  const phone = checkPhone(b.phone, country.value);
  const email = checkEmail(b.email);
  const errors: RegistrationErrors = {};
  if (firstName.error) errors.firstName = firstName.error;
  if (lastName.error) errors.lastName = lastName.error;
  if (country.error) errors.country = country.error;
  if (phone.error) errors.phone = phone.error;
  if (email.error) errors.email = email.error;
  const normalized = { firstName: firstName.value, lastName: lastName.value, country: country.value, phone: phone.value, email: email.value };
  return Object.keys(errors).length ? { ok: false, errors, normalized } : { ok: true, normalized, emailDomain: email.domain };
}
