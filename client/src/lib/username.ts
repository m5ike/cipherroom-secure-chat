// Who a session is (4.0).
//
//   signed in      the account's username — unique, given by the server,
//                  stored in the passkey (server/accounts/username.ts)
//   P2P (light)    a username made from the nickname for this session only:
//                  the nickname as a slug and four random characters,
//                  e.g. "Tomáš K." → "tomas-k-7k3q"
//
// Either way the name typed for a room is just the nickname shown to others;
// the username is what the session is known by (peers see it in the user's
// details, sent in the hello next to the signed keys).

/** Letters and digits without look-alikes (no i, l, o, 0, 1). */
const TAIL = "abcdefghjkmnpqrstuvwxyz23456789";

export function slugify(text: string, max = 20): string {
  return text
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

function tail(length: number, random: (n: number) => Uint8Array): string {
  const limit = 256 - (256 % TAIL.length);
  let out = "";
  while (out.length < length) {
    for (const b of random(16)) if (b < limit && out.length < length) out += TAIL[b % TAIL.length];
  }
  return out;
}

/** A P2P session's username from its nickname ("host" when there is none). */
export function sessionUsername(nickname: string, random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return `${slugify(nickname) || "host"}-${tail(4, random)}`;
}

/** What a peer says its username is: short, plain, or nothing. */
export function cleanUsername(value: unknown): string {
  if (typeof value !== "string") return "";
  const v = value.trim();
  return /^[A-Za-z0-9_-]{3,64}$/.test(v) ? v : "";
}
