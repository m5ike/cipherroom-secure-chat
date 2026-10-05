// Replay and freshness (docs/protocol-v4.md § 11, F-21).
//
// Protocol 3 remembered accepted message ids in memory only: after a reload
// the relay (or anyone who recorded traffic) could deliver an old message
// again. Protocol 4 remembers them PERSISTENTLY per room, as
//
//   key = b64url(H(join("m5cet/p4/seen", roomId, id))[0:16])
//
// (the store never holds a readable id), for REPLAY.windowMs (31 days),
// at most REPLAY.maxIdsPerRoom per room. A message created before the window
// or more than REPLAY.futureMs ahead is refused outright — so forgetting ids
// older than the window can never re-admit a replay. History the user
// restores from their own encrypted store is exempt.
//
// The store is an interface; the integrator persists it encrypted like the
// rest of the device's data. `MemoryReplayStore` is the in-memory one.

import { LABEL, REPLAY } from "./contract";
import { b64url, H, isSafeCount, join, Mutex, P4Error } from "./primitives";

/** § 11: the stored form of a message id. */
export async function replayKey(roomId: string, id: string): Promise<string> {
  return b64url((await H(join(LABEL.replay, roomId, id))).slice(0, 16));
}

export interface ReplayStore {
  has(roomId: string, key: string): Promise<boolean>;
  /** Remembers `key` with its time (the message's createdAt). */
  add(roomId: string, key: string, at: number): Promise<void>;
  /** Forgets keys with `at < before`, then the oldest beyond `max`. */
  prune(roomId: string, before: number, max: number): Promise<void>;
}

export class MemoryReplayStore implements ReplayStore {
  private readonly rooms = new Map<string, Map<string, number>>();
  async has(roomId: string, key: string): Promise<boolean> { return this.rooms.get(roomId)?.has(key) ?? false; }
  async add(roomId: string, key: string, at: number): Promise<void> {
    let room = this.rooms.get(roomId);
    if (!room) this.rooms.set(roomId, (room = new Map()));
    room.set(key, at);
  }
  async prune(roomId: string, before: number, max: number): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const [key, at] of room) if (at < before) room.delete(key);
    if (room.size > max) {
      const byAge = [...room.entries()].sort((a, b) => a[1] - b[1]);
      for (const [key] of byAge.slice(0, room.size - max)) room.delete(key);
    }
  }
  size(roomId: string): number { return this.rooms.get(roomId)?.size ?? 0; }
}

export type ReplayVerdict = "ok" | "replay" | "too-old" | "future" | "malformed";

export class ReplayGuard {
  private readonly mutex = new Mutex();
  private readonly added = new Map<string, number>();

  /** `pruneEvery`: prune a room after this many accepted ids (and on the first). */
  constructor(private readonly store: ReplayStore, private readonly opts: { pruneEvery?: number } = {}) {}

  /**
   * One incoming message: "ok" (accepted and remembered), "replay", "too-old",
   * "future" or "malformed". `restored`: from the user's own history — no
   * freshness or replay check, only remembered.
   */
  check(roomId: string, id: string, createdAt: unknown, opts: { now?: number; restored?: boolean } = {}): Promise<ReplayVerdict> {
    return this.mutex.run(async () => {
      const now = opts.now ?? Date.now();
      let key: string;
      try { key = await replayKey(roomId, id); } catch (error) { if (error instanceof P4Error) return "malformed"; throw error; }
      if (!opts.restored) {
        if (!isSafeCount(createdAt)) return "malformed";
        if (createdAt < now - REPLAY.windowMs) return "too-old";
        if (createdAt > now + REPLAY.futureMs) return "future";
        if (await this.store.has(roomId, key)) return "replay";
      }
      await this.store.add(roomId, key, isSafeCount(createdAt) ? createdAt : now);
      const count = (this.added.get(roomId) ?? 0) + 1;
      this.added.set(roomId, count);
      if (count === 1 || count % (this.opts.pruneEvery ?? 256) === 0) await this.store.prune(roomId, now - REPLAY.windowMs, REPLAY.maxIdsPerRoom);
      return "ok";
    });
  }
}
