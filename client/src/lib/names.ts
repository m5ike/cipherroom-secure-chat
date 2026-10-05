// Display names a member chose (6.12, F-22 of the security analysis).
//
// A name is whatever another client typed — or what a server (or a function
// writing operator notices) claims. Before 6.12 it was shown as sent: right-to-
// left overrides ("\u202EecilA" reads "Alice"), zero-width characters, a Cyrillic
// "А" in "Аlice" next to the real Alice, a name made of Hangul fillers that
// looks empty. Now every name from outside goes through `normalizeDisplayName`
// (format characters out, NFKC, whitespace collapsed, a length cap), and a
// name that only LOOKS like the name of a member who was there first is
// flagged next to it (`nameWarning`): the same skeleton (a small confusables
// map for Latin / Cyrillic / Greek, digits that pass for letters, accents
// dropped), or letters from several scripts in one name.
//
// The skeleton is deliberately small — not UTS #39's full table. It covers the
// look-alikes a person can type on a phone keyboard; a determined impostor with
// an exotic script still shows as "mixed scripts" or as a different name.

/** The longest name shown (code points). */
export const NAME_MAX = 48;

/** Characters that draw nothing yet are letters (so `\p{Cf}` misses them): Hangul fillers, the braille blank, … */
const INVISIBLE_LETTERS = /[\u115F\u1160\u3164\uFFA0\u2800\u180E]/gu;

/**
 * A name as it may be shown: format characters (bidi controls, zero-width
 * joiners and spaces, soft hyphens, the BOM — every `\p{Cf}`), control
 * characters and invisible fillers removed, NFKC (full-width and styled
 * letters become plain ones), at most two combining marks in a row, every
 * run of white space one space, trimmed, at most `max` code points.
 */
export function normalizeDisplayName(raw: unknown, max = NAME_MAX): string {
  if (typeof raw !== "string") return "";
  let s = raw.normalize("NFKC");
  s = s.replace(/[\p{Cf}\p{Cc}\p{Co}\p{Cs}]/gu, (c) => (/[\t\n\r\v\f]/.test(c) ? " " : ""));
  s = s.replace(INVISIBLE_LETTERS, "");
  // "Zalgo": a letter buried under dozens of marks covers the lines around it.
  s = s.replace(/(\p{M}{2})\p{M}+/gu, "$1");
  s = s.replace(/[\s\p{Z}]+/gu, " ").trim();
  const points = [...s];
  return points.length > max ? points.slice(0, max).join("").trim() : s;
}

/** Cyrillic and Greek letters that look like Latin ones (lower- and upper-case), and digits that pass for letters. */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  "а": "a", "в": "b", "г": "r", "д": "d", "е": "e", "ё": "e", "з": "3", "и": "u", "к": "k", "л": "n", "м": "m", "н": "h", "о": "o", "п": "n",
  "р": "p", "с": "c", "т": "t", "у": "y", "х": "x", "ч": "4", "ь": "b", "ѕ": "s", "і": "l", "ї": "l", "ј": "j", "ԁ": "d", "ԛ": "q", "ԝ": "w", "һ": "h", "ү": "y", "ө": "o", "ӏ": "l",
  "А": "a", "В": "b", "Е": "e", "Ё": "e", "З": "3", "К": "k", "М": "m", "Н": "h", "О": "o", "Р": "p", "С": "c", "Т": "t", "У": "y", "Х": "x",
  "Ѕ": "s", "І": "l", "Ї": "l", "Ј": "j", "Ү": "y", "Һ": "h", "Ԛ": "q", "Ԝ": "w", "Ӏ": "l", "Ь": "b",
  // Greek
  "α": "a", "β": "b", "γ": "y", "ε": "e", "η": "n", "ι": "l", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ω": "w", "ς": "c",
  "Α": "a", "Β": "b", "Ε": "e", "Ζ": "z", "Η": "h", "Ι": "l", "Κ": "k", "Μ": "m", "Ν": "n", "Ο": "o", "Ρ": "p", "Τ": "t", "Υ": "y", "Χ": "x",
  // Latin and digits that pass for each other
  "0": "o", "1": "l", "i": "l", "|": "l", "!": "l", "5": "s", "$": "s", "@": "a",
};

/**
 * What a name looks like, for comparing two names: NFKC, accents dropped,
 * look-alike letters mapped to one of them, lower case, "rn" → "m", "vv" → "w",
 * separators and punctuation gone. Two names with the same skeleton are
 * visibly similar.
 */
export function nameSkeleton(name: string): string {
  const base = normalizeDisplayName(name).normalize("NFD").replace(/\p{M}/gu, "");
  let out = "";
  for (const ch of base) {
    const mapped = CONFUSABLES[ch] ?? CONFUSABLES[ch.toLowerCase()];
    out += mapped ?? ch.toLowerCase();
  }
  // "I" (capital i) lowered is "i" → "l" above; do the same for what lowering produced.
  out = [...out].map((c) => CONFUSABLES[c] ?? c).join("");
  return out.replace(/rn/g, "m").replace(/vv/g, "w").replace(/[\s\p{P}\p{S}_]/gu, "");
}

type Script = "latin" | "cyrillic" | "greek" | "other";
function scriptOf(ch: string): Script | null {
  if (!/\p{L}/u.test(ch)) return null;
  if (/\p{Script=Latin}/u.test(ch)) return "latin";
  if (/\p{Script=Cyrillic}/u.test(ch)) return "cyrillic";
  if (/\p{Script=Greek}/u.test(ch)) return "greek";
  return "other";
}

/** Letters from more than one of Latin / Cyrillic / Greek in one name ("Аlice" with a Cyrillic А). */
export function hasMixedScripts(name: string): boolean {
  const scripts = new Set<Script>();
  for (const ch of normalizeDisplayName(name)) {
    const s = scriptOf(ch);
    if (s && s !== "other") scripts.add(s);
  }
  return scripts.size > 1;
}

export type NameWarning =
  /** Looks like the name of a member who is listed before (`like`). */
  | { kind: "confusable"; like: string }
  /** The very same name as a member listed before. */
  | { kind: "duplicate"; like: string }
  /** Letters of several scripts (Latin, Cyrillic, Greek) in one name. */
  | { kind: "mixed" };

export type NamedMember = { id: string; name: string };

/**
 * Is `name` (of the member `id`) one to be careful with? `members` lists who is
 * here in the order they came — this user first, then the others as they
 * joined. A name is flagged only against a member listed BEFORE it (the one
 * who had the name first), so the real Alice is not flagged because an
 * impostor arrived. A sender not in the list counts as the newest.
 */
export function nameWarning(name: string, id: string, members: readonly NamedMember[]): NameWarning | null {
  const shown = normalizeDisplayName(name);
  if (!shown) return null;
  const skeleton = nameSkeleton(shown);
  let at = members.findIndex((m) => m.id === id);
  // A sender no longer listed under that id, with the very same name as a member here, is most
  // likely that member before a reconnect (a new peer id): judged from that member's place.
  if (at < 0) at = members.findIndex((m) => normalizeDisplayName(m.name) === shown);
  const before = at < 0 ? members : members.slice(0, at);
  for (const m of before) {
    if (m.id === id) continue;
    const other = normalizeDisplayName(m.name);
    if (!other) continue;
    if (other === shown) return { kind: "duplicate", like: other };
    if (skeleton && nameSkeleton(other) === skeleton) return { kind: "confusable", like: other };
  }
  return hasMixedScripts(shown) ? { kind: "mixed" } : null;
}

/**
 * `nameWarning` for one list of members, remembered per (id, name): the same
 * answer object for the same sender until the members change — so a memoized
 * message row is not drawn again for nothing.
 */
export function nameWarningsFor(members: readonly NamedMember[]): (id: string, name: string) => NameWarning | null {
  const cache = new Map<string, NameWarning | null>();
  return (id, name) => {
    const key = `${id}\u0000${name}`;
    let hit = cache.get(key);
    if (hit === undefined) { hit = nameWarning(name, id, members); cache.set(key, hit); }
    return hit;
  };
}

/**
 * The names in a signaling frame (`joined`, `peer-joined`, `peer-away`,
 * `peer-updated`, `peer-back`, `relay-status`) made fit to show — in place.
 * The server relays what a client chose; it may itself lie.
 */
export function normalizeFrameNames(frame: unknown): void {
  if (!frame || typeof frame !== "object") return;
  const f = frame as Record<string, unknown>;
  const fix = (o: unknown) => {
    if (o && typeof o === "object" && typeof (o as { name?: unknown }).name === "string") {
      const r = o as { name: string };
      r.name = normalizeDisplayName(r.name);
    }
  };
  fix(f);
  if (Array.isArray(f.peers)) f.peers.forEach(fix);
  if (Array.isArray(f.away)) f.away.forEach(fix);
  if (f.recipient) fix(f.recipient);
}

/**
 * Who an operator notice is shown as: always the operator, whatever its
 * `from` says — a function writing notices (m5room.wall_msg / user_msg) must
 * not sign them with a member's name. `label` is the translated "operator".
 */
export function noticeSender(_claimedFrom: unknown, label: string): string {
  return label;
}
