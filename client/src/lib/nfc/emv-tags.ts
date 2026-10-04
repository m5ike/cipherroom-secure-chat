// EMV data elements (6.5) — the tag dictionary and the AID → scheme map, used
// by the EMV reader (cards/emv.ts) and the workbench widget, and ported to
// Java for the Android reader. Public reference data (EMV Book 3, ISO 7816-4):
// names only, so a parsed element can be labelled and formatted.
//
// The reader is read-only: it reads the applications and records a contactless
// terminal reads (PPSE → SELECT → GPO → READ RECORD) and labels what it finds.
// It never verifies a PIN (tag 9F17 is read as a counter, never checked) nor
// generates a cryptogram for a transaction.

export type EmvFormat = "n" | "cn" | "an" | "ans" | "b" | "date" | "month" | "country" | "currency" | "hex";

export type EmvTagInfo = { name: string; format: EmvFormat };

/** tag (hex, upper, no spaces) → its EMV name and value format. */
export const EMV_TAGS: Record<string, EmvTagInfo> = {
  "4F": { name: "Application identifier (AID)", format: "hex" },
  "50": { name: "Application label", format: "ans" },
  "57": { name: "Track 2 equivalent data", format: "b" },
  "5A": { name: "Application PAN", format: "cn" },
  "5F20": { name: "Cardholder name", format: "ans" },
  "5F24": { name: "Application expiry date", format: "date" },
  "5F25": { name: "Application effective date", format: "date" },
  "5F28": { name: "Issuer country code", format: "country" },
  "5F2A": { name: "Transaction currency code", format: "currency" },
  "5F2D": { name: "Language preference", format: "an" },
  "5F30": { name: "Service code", format: "n" },
  "5F34": { name: "PAN sequence number", format: "n" },
  "5F36": { name: "Transaction currency exponent", format: "n" },
  "5F50": { name: "Issuer URL", format: "ans" },
  "5F53": { name: "IBAN", format: "ans" },
  "5F54": { name: "Bank identifier code (BIC)", format: "ans" },
  "5F55": { name: "Issuer country code (alpha-2)", format: "an" },
  "5F56": { name: "Issuer country code (alpha-3)", format: "an" },
  "61": { name: "Application template", format: "hex" },
  "6F": { name: "File control information (FCI)", format: "hex" },
  "70": { name: "Record template", format: "hex" },
  "77": { name: "Response message template 2", format: "hex" },
  "80": { name: "Response message template 1", format: "hex" },
  "82": { name: "Application interchange profile (AIP)", format: "hex" },
  "84": { name: "Dedicated file (DF) name", format: "hex" },
  "87": { name: "Application priority indicator", format: "hex" },
  "88": { name: "Short file identifier (SFI)", format: "n" },
  "8C": { name: "CDOL1", format: "hex" },
  "8D": { name: "CDOL2", format: "hex" },
  "8E": { name: "Cardholder verification method (CVM) list", format: "hex" },
  "8F": { name: "CA public key index", format: "hex" },
  "90": { name: "Issuer public key certificate", format: "hex" },
  "92": { name: "Issuer public key remainder", format: "hex" },
  "93": { name: "Signed static application data", format: "hex" },
  "94": { name: "Application file locator (AFL)", format: "hex" },
  "95": { name: "Terminal verification results", format: "hex" },
  "9A": { name: "Transaction date", format: "date" },
  "9C": { name: "Transaction type", format: "n" },
  "A5": { name: "FCI proprietary template", format: "hex" },
  "9F02": { name: "Amount, authorised", format: "n" },
  "9F03": { name: "Amount, other", format: "n" },
  "9F05": { name: "Application discretionary data", format: "hex" },
  "9F07": { name: "Application usage control", format: "hex" },
  "9F08": { name: "Application version number", format: "hex" },
  "9F0D": { name: "Issuer action code — default", format: "hex" },
  "9F0E": { name: "Issuer action code — denial", format: "hex" },
  "9F0F": { name: "Issuer action code — online", format: "hex" },
  "9F10": { name: "Issuer application data", format: "hex" },
  "9F11": { name: "Issuer code table index", format: "n" },
  "9F12": { name: "Application preferred name", format: "ans" },
  "9F13": { name: "Last online ATC register", format: "n" },
  "9F17": { name: "PIN try counter", format: "n" },
  "9F1A": { name: "Terminal country code", format: "country" },
  "9F1F": { name: "Track 1 discretionary data", format: "ans" },
  "9F20": { name: "Track 2 discretionary data", format: "cn" },
  "9F26": { name: "Application cryptogram", format: "hex" },
  "9F27": { name: "Cryptogram information data", format: "hex" },
  "9F32": { name: "Issuer public key exponent", format: "hex" },
  "9F36": { name: "Application transaction counter (ATC)", format: "n" },
  "9F38": { name: "Processing options data object list (PDOL)", format: "hex" },
  "9F42": { name: "Application currency code", format: "currency" },
  "9F44": { name: "Application currency exponent", format: "n" },
  "9F4A": { name: "Static data authentication tag list", format: "hex" },
  "9F4D": { name: "Log entry", format: "hex" },
  "9F4F": { name: "Log format", format: "hex" },
  "9F46": { name: "ICC public key certificate", format: "hex" },
  "9F47": { name: "ICC public key exponent", format: "hex" },
  "9F48": { name: "ICC public key remainder", format: "hex" },
  "9F49": { name: "DDOL", format: "hex" },
  "9F62": { name: "PCVC3 (Track 1)", format: "hex" },
  "9F63": { name: "PUNATC (Track 1)", format: "hex" },
  "9F64": { name: "NATC (Track 1)", format: "n" },
  "9F65": { name: "PCVC3 (Track 2)", format: "hex" },
  "9F66": { name: "Terminal transaction qualifiers (TTQ)", format: "hex" },
  "9F6B": { name: "Track 2 data (Mag-stripe)", format: "b" },
  "9F6C": { name: "Card transaction qualifiers (CTQ)", format: "hex" },
  "BF0C": { name: "FCI issuer discretionary data", format: "hex" },
};

export function emvTagInfo(tag: string): EmvTagInfo {
  return EMV_TAGS[tag.toUpperCase()] ?? { name: `Tag ${tag.toUpperCase()}`, format: "hex" };
}

/** Longest-prefix AID → scheme. The RIDs (first 5 bytes / 10 hex) identify the scheme. */
const SCHEMES: Array<{ prefix: string; scheme: string }> = [
  { prefix: "A000000003", scheme: "Visa" },
  { prefix: "A000000004", scheme: "Mastercard" },
  { prefix: "A000000005", scheme: "Mastercard" }, // Maestro / US region
  { prefix: "A000000025", scheme: "American Express" },
  { prefix: "A000000065", scheme: "JCB" },
  { prefix: "A000000152", scheme: "Discover" },
  { prefix: "A000000324", scheme: "Discover" }, // Diners / Discover
  { prefix: "A000000333", scheme: "UnionPay" },
  { prefix: "A000000277", scheme: "Interac" },
  { prefix: "A0000006581010", scheme: "Mir" },
  { prefix: "A0000000651010", scheme: "JCB" },
  { prefix: "325041592E5359532E4444463031", scheme: "PPSE (2PAY.SYS.DDF01)" },
  { prefix: "315041592E5359532E4444463031", scheme: "PSE (1PAY.SYS.DDF01)" },
];

export function schemeForAid(aid: string): string | undefined {
  const a = aid.toUpperCase().replace(/[^0-9A-F]/g, "");
  let best: { len: number; scheme: string } | null = null;
  for (const s of SCHEMES) if (a.startsWith(s.prefix) && (!best || s.prefix.length > best.len)) best = { len: s.prefix.length, scheme: s.scheme };
  return best?.scheme;
}

/** The common candidate AIDs, for a card that offers no PPSE directory. */
export const CANDIDATE_AIDS: Array<{ aid: string; scheme: string }> = [
  { aid: "A0000000031010", scheme: "Visa credit/debit" },
  { aid: "A0000000032010", scheme: "Visa Electron" },
  { aid: "A0000000033010", scheme: "Visa Interlink" },
  { aid: "A0000000041010", scheme: "Mastercard credit/debit" },
  { aid: "A0000000043060", scheme: "Maestro" },
  { aid: "A000000004306001", scheme: "Maestro UK" },
  { aid: "A00000002501", scheme: "American Express" },
  { aid: "A0000000651010", scheme: "JCB" },
  { aid: "A0000001523010", scheme: "Discover" },
  { aid: "A000000333010101", scheme: "UnionPay debit" },
  { aid: "A000000333010102", scheme: "UnionPay credit" },
];

/** A few ISO-3166 numeric country codes seen in issuer-country tags. */
export const COUNTRY_NUM: Record<string, string> = {
  "0056": "Belgium", "0203": "Czechia", "0276": "Germany", "0250": "France",
  "0826": "United Kingdom", "0840": "United States", "0616": "Poland", "0703": "Slovakia",
  "0040": "Austria", "0380": "Italy", "0724": "Spain", "0528": "Netherlands",
  "0756": "Switzerland", "0208": "Denmark", "0752": "Sweden", "0578": "Norway",
};

/** A few ISO-4217 numeric currency codes. */
export const CURRENCY_NUM: Record<string, string> = {
  "0203": "CZK", "0978": "EUR", "0840": "USD", "0826": "GBP", "0985": "PLN",
  "0756": "CHF", "0208": "DKK", "0752": "SEK", "0578": "NOK", "0348": "HUF",
};
