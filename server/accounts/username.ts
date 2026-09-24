// Usernames — the identity of a passkey account (4.0).
//
// The server gives every new account a unique username when it registers:
// two words and a short random tail, e.g. "bystry-sokol-7k3q". It is
//
//   the account's primary key   accounts.json, sessions, the vault, the
//                               mailbox, the storage index (users,
//                               passkeys, databases, logs, audit) and the
//                               relay queue all refer to it
//   in the passkey              user.name and user.displayName, so the
//                               passkey manager lists it, and user.id (the
//                               user handle) is its UTF-8 bytes — a signed
//                               sign-in names the account it belongs to
//   immutable                   it never changes; the name a user types
//                               for a room is only a nickname for it
//
// Accounts created before 4.0 keep the id they had (22 characters derived
// from the first passkey): that id is their username.

import { randomBytes } from "node:crypto";

const ADJECTIVES = [
  "tichy", "rychly", "modry", "zlaty", "bystry", "klidny", "smely", "jasny", "lesni", "nocni",
  "horsky", "ranni", "zeleny", "stribrny", "divoky", "vesely", "moudry", "hbity", "pevny", "lehky",
  "mlzny", "polni", "ricni", "snezny", "slunny", "hvezdny", "vetrny", "teply", "chladny", "hluboky",
] as const;
const NOUNS = [
  "rys", "sokol", "vlk", "jezek", "kos", "bobr", "jelen", "sova", "lin", "kuna",
  "orel", "lisak", "medved", "srnec", "vydra", "ledňacek", "cap", "dub", "javor", "buk",
  "potok", "vrch", "kamen", "mrak", "blesk", "maják", "kompas", "prapor", "stit", "most",
].map((w) => w.normalize("NFD").replace(/[̀-ͯ]/g, ""));
/** Letters and digits without look-alikes (no i, l, o, 0, 1). */
const TAIL = "abcdefghjkmnpqrstuvwxyz23456789";

/** A generated username: two words and a 4–6 character tail. */
export const USERNAME_RE = /^[a-z]+-[a-z]+-[a-z0-9]{4,6}$/;
/** Any account id — a generated username or a pre-4.0 id. */
export const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{10,64}$/;

export function isUsername(value: unknown): value is string {
  return typeof value === "string" && USERNAME_RE.test(value) && value.length <= 40;
}

function pick<T>(list: readonly T[], byte: number): T {
  return list[byte % list.length];
}

/** Unbiased characters from TAIL (rejection sampling). */
function tail(length: number, random: (n: number) => Uint8Array): string {
  const limit = 256 - (256 % TAIL.length);
  let out = "";
  while (out.length < length) {
    for (const b of random(16)) if (b < limit && out.length < length) out += TAIL[b % TAIL.length];
  }
  return out;
}

/**
 * A username nobody has: `taken` answers for the store (case-insensitively).
 * Four characters of tail give ~7.7 million names per word pair; after a
 * few collisions the tail grows.
 */
export function generateUsername(taken: (name: string) => boolean, random: (n: number) => Uint8Array = (n) => randomBytes(n)): string {
  for (let attempt = 0; attempt < 60; attempt++) {
    const [a, b] = random(2);
    const length = attempt < 20 ? 4 : attempt < 40 ? 5 : 6;
    const name = `${pick(ADJECTIVES, a)}-${pick(NOUNS, b)}-${tail(length, random)}`;
    if (!taken(name.toLowerCase())) return name;
  }
  throw new Error("no free username");
}

/** The user handle a passkey carries for a username (its UTF-8 bytes). */
export function userHandleFor(username: string): string {
  return Buffer.from(username, "utf8").toString("base64url");
}

/** The username a user handle names, or "" when it is not one. */
export function usernameFromHandle(handle: unknown): string {
  if (typeof handle !== "string" || !handle) return "";
  try { return Buffer.from(handle, "base64url").toString("utf8"); } catch { return ""; }
}
