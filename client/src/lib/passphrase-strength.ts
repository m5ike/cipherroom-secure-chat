// How hard a room key is to guess (6.7, finding F-04 of the security analysis).
//
// A room's keys come from Argon2id(passphrase, room name) (envelope.ts), and
// the blind room id the server routes by is derived from the same Argon2id
// output — so whoever holds the server's data can test guesses offline, at
// the cost of one Argon2id (64 MiB, 3 passes) each. Against a random key
// that is hopeless; against "heslo123" in the room "rodina" it is minutes.
// The app cannot raise the cost of a guess without splitting existing rooms,
// so it makes weak keys visible and refuses them for a room typed in by hand
// unless the user confirms they are joining a room that already uses the key.
//
// The estimate is deliberately simple and conservative (no 30 MB dictionary
// as zxcvbn): the key is split into runs of letters, digits and the rest;
// common passwords and words (cs/en/de) inside a run, years, repeats and
// sequences, the room's name and the user's name count for almost nothing;
// the rest counts by its character set. The smaller of that and the plain
// "length × log2(alphabet)" is the estimate.

export type KeyStrengthLevel = "empty" | "weak" | "fair" | "strong";
export type KeyHint = "short" | "common" | "pattern" | "year" | "context" | "classes";
export type KeyEstimate = { bits: number; level: KeyStrengthLevel; hints: KeyHint[] };

/** Below this, a key for a new room is refused (~1e12 Argon2id guesses — feasible offline). */
export const WEAK_BITS = 40;
/** From here on, a key is strong. */
export const STRONG_BITS = 64;

/** Passwords and words people use first (lowercase): any of them counts as a few bits, wherever it appears. */
const COMMON = [
  // passwords everywhere
  "password", "passwort", "heslo", "123456", "12345678", "123456789", "1234567890", "qwerty", "qwertz", "asdfgh", "yxcvbn", "zxcvbn",
  "admin", "root", "letmein", "welcome", "monkey", "dragon", "iloveyou", "abc123", "111111", "000000", "secret", "master", "login",
  "test", "default", "changeme", "trustno", "sunshine", "princess", "football", "baseball", "shadow", "superman", "batman", "pokemon",
  "starwars", "hello", "freedom", "whatever", "qazwsx", "zaq12wsx", "1q2w3e4r", "pass", "guest", "user", "chat", "room", "m5cet",
  // English words in passwords
  "love", "family", "house", "home", "summer", "winter", "spring", "autumn", "friend", "friends", "money", "happy", "secure", "private",
  "office", "team", "work", "company", "group", "party", "mother", "father", "baby", "honey", "angel", "golden", "silver", "black",
  "white", "blue", "green", "orange", "purple", "cookie", "coffee", "pizza", "music", "magic", "tiger", "lion", "eagle", "hunter",
  // Czech
  "tajne", "tajny", "heslicko", "ahoj", "rodina", "domov", "doma", "laska", "miluju", "kocka", "pejsek", "pes", "praha", "brno",
  "ostrava", "plzen", "moje", "muj", "nase", "nas", "kluci", "holky", "prace", "firma", "skupina", "mistnost", "klic", "chata", "chalupa",
  "leto", "zima", "jaro", "podzim", "mama", "tata", "babicka", "deda", "pivo", "fotbal", "hokej", "sparta", "slavia", "banik",
  // German
  "geheim", "hallo", "liebe", "familie", "haus", "zuhause", "schatz", "sommer", "winter", "freund", "freunde", "arbeit", "firma",
  "gruppe", "raum", "schluessel", "schlussel", "katze", "hund", "mutter", "vater", "berlin", "munchen", "muenchen", "wien", "fussball",
  "bayern", "sonne", "blume", "herz",
].filter((w, i, all) => all.indexOf(w) === i).sort((a, b) => b.length - a.length);

const KEYBOARD_ROWS = ["qwertyuiop", "qwertzuiop", "asdfghjkl", "yxcvbnm", "zxcvbnm", "1234567890", "0987654321"];

const log2 = (n: number) => Math.log(n) / Math.LN2;

function charsetSize(s: string): number {
  let pool = 0;
  if (/[a-z]/.test(s)) pool += 26;
  if (/[A-Z]/.test(s)) pool += 26;
  if (/[0-9]/.test(s)) pool += 10;
  if (/[^a-zA-Z0-9\p{L}]/u.test(s)) pool += 33;
  if (/[^\x00-\x7f]/.test(s) && /\p{L}/u.test(s)) pool += 40; // accented letters
  return Math.max(pool, 1);
}

/** Strips accents so "heslíčko" meets "heslicko". */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Repeats ("aaaa", "abab") and runs ("abcd", "4321", keyboard rows) in a token. */
function isPattern(token: string): boolean {
  const t = token.toLowerCase();
  if (t.length < 3) return false;
  if (/^(.+?)\1+$/.test(t)) return true;
  const codes = [...t].map((c) => c.codePointAt(0)!);
  const step = codes[1] - codes[0];
  if (Math.abs(step) === 1 && codes.every((c, i) => i === 0 || c - codes[i - 1] === step)) return true;
  return KEYBOARD_ROWS.some((row) => (row + row).includes(t)); // "…7890123" wraps around
}

/** Bits of one run of letters, of digits or of other characters. */
function tokenBits(token: string, hints: Set<KeyHint>): number {
  const len = [...token].length;
  if (isPattern(token)) { hints.add("pattern"); return log2(charsetSize(token)) + log2(len); }
  if (/^\d+$/.test(token)) {
    if (/^(19|20)\d\d$/.test(token) || /^(0?[1-9]|[12]\d|3[01])(0?[1-9]|1[0-2])((19|20)?\d\d)?$/.test(token)) { hints.add("year"); return 8; }
    return len * log2(10);
  }
  if (/^\p{L}+$/u.test(token)) {
    // Common words inside the run count for a few bits each; what is left, by its letters.
    let rest = fold(token);
    let bits = 0;
    for (const w of COMMON) {
      if (w.length < 3 || !/^\p{L}+$/u.test(w)) continue;
      while (rest.includes(w)) { rest = rest.replace(w, " "); bits += 5; hints.add("common"); }
    }
    const left = rest.replace(/ /g, "");
    const pool = token === token.toLowerCase() || token === token.toUpperCase() ? 26 : 52;
    // A capital only at the start adds a bit, not a doubled alphabet.
    const effPool = /^\p{Lu}\p{Ll}*$/u.test(token) ? 27 : pool;
    return bits + [...left].length * log2(effPool);
  }
  return len * log2(33);
}

/** How hard `passphrase` is to guess; `context` (the room's name, the user's name) counts for nothing in it. */
export function estimatePassphrase(passphrase: string, context: { room?: string; name?: string } = {}): KeyEstimate {
  const pass = (passphrase ?? "").normalize("NFC");
  const len = [...pass].length;
  if (!len) return { bits: 0, level: "empty", hints: [] };
  const hints = new Set<KeyHint>();
  const charsetBits = len * log2(charsetSize(pass));

  // Whole-key common passwords ("password1", "heslo123") and the context.
  let s = pass;
  let bits = 0;
  for (const c of [context.room, context.name]) {
    const needle = (c ?? "").trim();
    if (needle.length < 3) continue;
    const at = fold(s).indexOf(fold(needle));
    if (at >= 0) { s = s.slice(0, at) + " " + s.slice(at + [...needle].length); bits += 2; hints.add("context"); }
  }
  for (const token of s.match(/\p{L}+|\d+|[^\p{L}\d\s]+/gu) ?? []) bits += tokenBits(token, hints);
  // Where the runs change (a word, then digits, then a sign) the guesser has a few choices more.
  const runs = (s.match(/\p{L}+|\d+|[^\p{L}\d\s]+/gu) ?? []).length;
  bits += Math.max(0, runs - 1) * 2;
  if (/\s/.test(s)) bits += 1;

  const total = Math.max(0, Math.min(charsetBits, bits));
  if (len < 12) hints.add("short");
  if (charsetSize(pass) <= 26 && len < 20) hints.add("classes");
  const level: KeyStrengthLevel = total < WEAK_BITS ? "weak" : total < STRONG_BITS ? "fair" : "strong";
  return { bits: Math.round(total), level, hints: level === "strong" ? [] : [...hints] };
}

/** A strong room key: 24 characters from 57 look-alike-free ones (~140 bits), in groups of six, without modulo bias. */
export function generateRoomKey(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < 24) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < limit && out.length < 24) out += alphabet[b % alphabet.length];
    }
  }
  return out.replace(/(.{6})(?=.)/g, "$1-");
}

/**
 * May this key be used now? A weak key waits for the user's explicit "yes"
 * (`confirmed`) — EVERY time it is about to be used (6.12, F-04): a Connect in
 * the Room window, a Save or Connect of a saved connection. 6.7 held it back
 * once per room and let a saved connection's key through unmeasured; both
 * were how weak keys stayed in use. The app cannot know before it asks the
 * server whether the room already exists (asking is exactly what gives the
 * server the blind id to guess against), so the user says it — and is never
 * blocked from joining a room that already uses the key.
 * `known` (a saved connection holds this key) no longer lets it pass; it is
 * kept for callers of the 6.7 signature.
 */
export function weakKeyBlocks(estimate: KeyEstimate, opts: { known?: boolean; confirmed: boolean }): boolean {
  return estimate.level === "weak" && !opts.confirmed;
}

/**
 * The question before a saved connection's weak key is used (6.12): the
 * browser's own dialog. No dialog at all (an embedded view) counts as "no".
 */
export function askWeakSaved(text: string): boolean {
  return typeof window !== "undefined" && typeof window.confirm === "function" ? window.confirm(text) : false;
}

/** A saved connection's (or any stored) key, measured with its room and user name as context. */
export function estimateStoredKey(p: { passphrase: string; room?: string; userName?: string }): KeyEstimate {
  return estimatePassphrase(p.passphrase, { room: p.room, name: p.userName });
}
