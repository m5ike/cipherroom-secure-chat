// What the server may know of a room (6.7, audit S21 / F-10).
//
// The room's name is the salt of its key derivation (envelope.ts): whoever
// has the name and the blind id can try passphrases offline. Since crypto v3
// the server routes, relays and stores by the blind id alone
// ("r3.<HKDF(Argon2id(passphrase, name))>"), but a few side paths still sent
// the name in plain text — the guest's server history (read "as 3.0 wrote
// it"), the opt-in analytics on join, and the room of a function call. Every
// one of them now takes the room from here, and here there is no name.

import type { RoomKeys } from "./envelope";

/** The room as the server may see it: its blind id, or null (no v3 keys yet). Never the name. */
export function serverRoomId(keys: Pick<RoomKeys, "version" | "roomId"> | null | undefined): string | null {
  if (!keys || keys.version !== 3) return null;
  // v3 ids are "r3.<base64url>"; anything else would be the name (v2 keys keep it as their id).
  return /^r3\.[A-Za-z0-9_-]{16,}$/.test(keys.roomId) ? keys.roomId : null;
}

/** Where a guest's server-kept history is read from: the blind id only (the 3.0 rows under the plain name are left to expire). */
export function historyRoomsToRead(keys: Pick<RoomKeys, "version" | "roomId"> | null | undefined): string[] {
  const id = serverRoomId(keys);
  return id ? [id] : [];
}
