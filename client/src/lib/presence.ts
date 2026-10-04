// A room member's presence (6.7): online, away or far away — derived from
// whether they are connected with the app in the foreground, and else from
// when they were last seen (the last time they had the app open while
// connected). Pure and dependency-free: the server (server/signaling/hub.ts)
// imports it too, and the Android app mirrors it (contacts/LastSeen.java).
//
//   connected and in the foreground       online     (green)
//   last seen at most 5 minutes ago        online     (green)
//   last seen 5 to 60 minutes ago          away       (yellow)
//   last seen more than an hour ago        far        (orange)

/** Seen within this long: still online. */
export const PRESENCE_ONLINE_MS = 5 * 60_000;
/** Seen within this long (and longer than PRESENCE_ONLINE_MS): away; longer: far away. */
export const PRESENCE_AWAY_MS = 60 * 60_000;

export type PresenceState = "online" | "away" | "far";

export type PresenceFacts = {
  /** The member's socket is open (a held member's is not). */
  connected: boolean;
  /** Their app is in the foreground right now (only meaningful while connected). */
  foreground: boolean;
  /** When they last had the app open while connected (ms; 0 = unknown). */
  lastSeen: number;
};

/** The presence at `now`. An unknown lastSeen (0) of someone not in the foreground counts as far away. */
export function presenceOf(f: PresenceFacts, now: number): PresenceState {
  if (f.connected && f.foreground) return "online";
  if (!f.lastSeen) return "far";
  const age = now - f.lastSeen;
  if (age <= PRESENCE_ONLINE_MS) return "online";
  if (age <= PRESENCE_AWAY_MS) return "away";
  return "far";
}

/** When the member was last seen as of `now`: now while connected in the foreground. */
export function seenAt(f: PresenceFacts, now: number): number {
  return f.connected && f.foreground ? now : f.lastSeen;
}

/** Milliseconds until presenceOf() changes by itself (null: not without news). */
export function presenceChangeIn(f: PresenceFacts, now: number): number | null {
  if ((f.connected && f.foreground) || !f.lastSeen) return null;
  const age = now - f.lastSeen;
  if (age <= PRESENCE_ONLINE_MS) return PRESENCE_ONLINE_MS - age + 1;
  if (age <= PRESENCE_AWAY_MS) return PRESENCE_AWAY_MS - age + 1;
  return null;
}

/** "How long ago" as a unit and a count, for the words: now (< 1 min), min, h, d. */
export function agoParts(lastSeen: number, now: number): { unit: "now" | "min" | "h" | "d"; n: number } {
  const ms = Math.max(0, now - lastSeen);
  if (ms < 60_000) return { unit: "now", n: 0 };
  if (ms < 60 * 60_000) return { unit: "min", n: Math.floor(ms / 60_000) };
  if (ms < 24 * 60 * 60_000) return { unit: "h", n: Math.floor(ms / (60 * 60_000)) };
  return { unit: "d", n: Math.floor(ms / (24 * 60 * 60_000)) };
}
