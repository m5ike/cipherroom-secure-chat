// Room-scoped account references.
//
// A signed-in member used to be announced to the room by their permanent
// account id, which let anyone who knew a room name link the same person
// across rooms and confirm whether an account exists. Now every room sees
// a different, unlinkable reference for the same account:
//
//   ref = base64url(HMAC-SHA256(secret, room ‖ 0x00 ‖ accountId))[0..22]
//
// The secret lives next to the server's data (signaling.secret, 0600) so
// references stay the same across restarts — a read receipt for a message
// relayed before a restart still finds its way. Without a writable data
// directory it is random per process, which only costs that continuity.
// The server maps a reference back by checking the members and away list
// of that one room.

import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let secret: Buffer = randomBytes(32);

/** Loads (or creates) the persistent secret in `dir`. Returns whether it is persistent. */
export function loadRefSecret(dir: string): boolean {
  const path = join(dir, "signaling.secret");
  try {
    const existing = readFileSync(path);
    if (existing.length === 32) { secret = existing; return true; }
  } catch { /* first start */ }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fresh = randomBytes(32);
    writeFileSync(path, fresh, { mode: 0o600, flag: "w" });
    secret = fresh;
    return true;
  } catch {
    return false;
  }
}

/** Tests: a known secret. */
export function setRefSecret(value: Buffer): void {
  secret = Buffer.from(value);
}

export function accountRef(room: string, accountId: string): string {
  return createHmac("sha256", secret).update(room).update("\u0000").update(accountId).digest("base64url").slice(0, 22);
}

/** Finds which of `candidates` a reference in `room` stands for. */
export function resolveRef(room: string, ref: string, candidates: Iterable<string>): string | null {
  for (const accountId of candidates) {
    if (accountRef(room, accountId) === ref) return accountId;
  }
  return null;
}
