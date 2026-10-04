// Members whose connection went but who did not leave (6.7).
//
// A transport drop, a backgrounded app, a hidden tab or a lost network is
// not a goodbye: the member stays in the room's list as away ("held") until
//
//   - they come back — the resume secret of their last `joined` gives them
//     the same peer id, so the room sees them return, not a second person;
//     a signed-in member joining again replaces held entries of the same
//     account in that room;
//   - they leave on purpose (a `leave` frame: the Disconnect button);
//   - the server removes them: the operator (disconnect a member or a room),
//     a revoked session, or PRESENCE_MAX_AWAY_DAYS without coming back
//     (default 7, decimals allowed, 0 = never).
//
// Held members are kept in memory: a restart forgets them (signed-in
// members the away relay covers are restored from the account store, see
// relay.ts). In a cluster every instance keeps a copy, learned from the
// cluster's leave messages, and removes it when the member joins anywhere.

const DAY_MS = 24 * 60 * 60_000;

/** At most this many held members per room, and in all; the oldest go first. */
export const HELD_LIMITS = { perRoom: 200, total: 20_000 };

export type HeldMember = {
  peerId: string;
  name: string;
  joinedAt: number;
  accountId?: string;
  /** The session the connection carried (a revoked session removes it). */
  tokenHash?: string;
  /** SHA-256 of the resume secret: only the same client takes the peer id back. */
  resumeHash?: string;
  /** When they last had the app open while connected. */
  lastSeen: number;
  /** When the connection went. */
  since: number;
  /** Learned from another instance (cluster). */
  remote?: boolean;
};

/** PRESENCE_MAX_AWAY_DAYS in ms (default 7 days); 0 = held members are never removed for time. */
export function maxAwayMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PRESENCE_MAX_AWAY_DAYS?.trim();
  if (!raw) return 7 * DAY_MS;
  const days = Number(raw);
  return Number.isFinite(days) && days >= 0 ? Math.round(days * DAY_MS) : 7 * DAY_MS;
}

export class HeldBook {
  /** room → peerId → held member, in the order they were held. */
  private readonly rooms = new Map<string, Map<string, HeldMember>>();
  private size = 0;

  /** Holds a member; returns those pushed out by the limits (the oldest), with their rooms. */
  hold(room: string, member: HeldMember): Array<{ room: string; member: HeldMember }> {
    this.take(room, member.peerId);
    let map = this.rooms.get(room);
    if (!map) { map = new Map(); this.rooms.set(room, map); }
    map.set(member.peerId, member);
    this.size += 1;
    const out: Array<{ room: string; member: HeldMember }> = [];
    while (map.size > HELD_LIMITS.perRoom) {
      const oldest = map.values().next().value as HeldMember;
      this.take(room, oldest.peerId);
      out.push({ room, member: oldest });
    }
    while (this.size > HELD_LIMITS.total) {
      const oldest = this.oldest();
      if (!oldest) break;
      this.take(oldest.room, oldest.member.peerId);
      out.push(oldest);
    }
    return out;
  }

  get(room: string, peerId: string): HeldMember | undefined {
    return this.rooms.get(room)?.get(peerId);
  }

  /** Removes and returns a held member (null when not held). */
  take(room: string, peerId: string): HeldMember | null {
    const map = this.rooms.get(room);
    const member = map?.get(peerId);
    if (!map || !member) return null;
    map.delete(peerId);
    this.size -= 1;
    if (map.size === 0) this.rooms.delete(room);
    return member;
  }

  list(room: string): HeldMember[] {
    return [...(this.rooms.get(room)?.values() ?? [])];
  }

  count(room: string): number {
    return this.rooms.get(room)?.size ?? 0;
  }

  roomNames(): string[] {
    return [...this.rooms.keys()];
  }

  total(): number {
    return this.size;
  }

  /** Every held member of an account (any room). */
  ofAccount(accountId: string): Array<{ room: string; member: HeldMember }> {
    const out: Array<{ room: string; member: HeldMember }> = [];
    for (const [room, map] of this.rooms) for (const m of map.values()) if (m.accountId === accountId) out.push({ room, member: m });
    return out;
  }

  /** Removes and returns members held longer than `maxMs` (none when maxMs is 0). */
  expire(now: number, maxMs: number): Array<{ room: string; member: HeldMember }> {
    if (maxMs <= 0) return [];
    const out: Array<{ room: string; member: HeldMember }> = [];
    for (const [room, map] of [...this.rooms]) {
      for (const m of [...map.values()]) if (now - m.since > maxMs) { this.take(room, m.peerId); out.push({ room, member: m }); }
    }
    return out;
  }

  private oldest(): { room: string; member: HeldMember } | null {
    let best: { room: string; member: HeldMember } | null = null;
    for (const [room, map] of this.rooms) {
      const first = map.values().next().value as HeldMember | undefined;
      if (first && (!best || first.since < best.member.since)) best = { room, member: first };
    }
    return best;
  }
}
