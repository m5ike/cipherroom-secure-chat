// Profiles inside a room (6.7): what a member marked "room members" (and
// "public") travels as a "profile" payload, sealed with the pair key to one
// peer at a time — end-to-end encrypted on the data channel, never through
// the server. It is versioned so nobody sends a photo twice:
//
//   announce   {rev}               "this is my profile's version" ("" = none),
//                                  to a peer whose hello offered caps "profile",
//                                  and to everyone when it changes
//   request    {rev, want: true}   "I do not have that one, send it"
//   full       {rev, profile}      the view itself (normalizeShared on arrival)
//
// The receiver keeps what it got by the sender's device key and rev (never by
// rev alone: another member could otherwise plant a copy under someone else's
// rev), so a member who leaves and comes back (or sits in two rooms) costs
// one small frame. Android mirrors this in ProfileRoom.java.

import { normalizeShared, type SharedProfile } from "./model";

export const PROFILE_CAP = "profile";

export type ProfileFrame = { rev: string; want?: true; profile?: SharedProfile };

const REV = /^[0-9a-z]{0,40}$/;

/** The profile part of a payload (after the envelope opened and the sender checked out), or null. */
export function parseProfileFrame(p: Record<string, unknown>): ProfileFrame | null {
  const rev = typeof p.rev === "string" && REV.test(p.rev) ? p.rev : null;
  if (rev === null) return null;
  if (p.want === true) return rev ? { rev, want: true } : null;
  if (p.profile !== undefined) {
    const profile = normalizeShared(p.profile);
    return profile && rev ? { rev, profile } : null;
  }
  return { rev };
}

/** My announcement: the rev of what room members may see, or "" when there is nothing. */
export function announceOf(view: SharedProfile | null): ProfileFrame {
  return { rev: view ? view.rev : "" };
}

/** The full frame; `lite` leaves the background out (when the sealed frame would not fit a data channel message). */
export function fullFrameOf(view: SharedProfile, lite = false): ProfileFrame {
  if (!lite || !view.cover) return { rev: view.rev, profile: view };
  const { cover: _c, ...rest } = view;
  return { rev: view.rev, profile: rest };
}

/** A sealed frame longer than this is sent again without the background. */
export const FRAME_MAX_CHARS = 240_000;

export type AnnounceOutcome = "cached" | "request" | "cleared" | "same";

/** What this device knows of the other members' profiles. `owner` is the
 *  peer's device key (the pair's), the half of the cache key a peer cannot choose. */
export class RoomProfiles {
  private byRev = new Map<string, SharedProfile>();
  /** peer id → owner|rev */
  private peers = new Map<string, string>();
  private listeners = new Set<() => void>();

  constructor(private readonly maxCached = 64) {}

  /** A peer announced its rev: use a cached copy, ask for it, or forget theirs. */
  announced(peerId: string, owner: string, rev: string): AnnounceOutcome {
    const before = this.peers.get(peerId);
    if (!rev || !owner) {
      if (before === undefined) return "same";
      this.peers.delete(peerId);
      this.emit();
      return "cleared";
    }
    const key = `${owner}|${rev}`;
    if (before === key && this.byRev.has(key)) return "same";
    if (this.byRev.has(key)) {
      this.peers.set(peerId, key);
      this.touch(key);
      this.emit();
      return "cached";
    }
    return "request";
  }

  /** A full profile arrived. Kept under the rev the sender named. */
  received(peerId: string, owner: string, frame: ProfileFrame): SharedProfile | null {
    if (!frame.profile || !frame.rev || !owner) return null;
    const key = `${owner}|${frame.rev}`;
    this.byRev.set(key, frame.profile);
    this.touch(key);
    this.peers.set(peerId, key);
    while (this.byRev.size > this.maxCached) {
      const oldest = this.byRev.keys().next().value as string;
      this.byRev.delete(oldest);
    }
    this.emit();
    return frame.profile;
  }

  of(peerId: string): SharedProfile | null {
    const key = this.peers.get(peerId);
    return key ? this.byRev.get(key) ?? null : null;
  }

  /** Every peer's profile, for a render. */
  snapshot(): Record<string, SharedProfile> {
    const out: Record<string, SharedProfile> = {};
    for (const [peer, key] of this.peers) {
      const p = this.byRev.get(key);
      if (p) out[peer] = p;
    }
    return out;
  }

  /** The peer left: its copy stays cached (by rev) for when it comes back. */
  forget(peerId: string): void {
    if (this.peers.delete(peerId)) this.emit();
  }

  /** Signed out / wiped: nothing of anybody's profile stays. */
  clear(): void {
    this.byRev.clear();
    this.peers.clear();
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private touch(key: string): void {
    const p = this.byRev.get(key);
    if (!p) return;
    this.byRev.delete(key);
    this.byRev.set(key, p);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

export type ExchangeDeps = {
  /** Seals the frame with the pair key and sends it to that one peer; false when it could not go (or would not fit). */
  send: (peerId: string, frame: ProfileFrame) => Promise<boolean>;
  /** What room members may see of me now (null: nothing). */
  myView: () => SharedProfile | null;
  /** The peer's device key (the cache's owner) — null before its hello was accepted. */
  ownerOf: (peerId: string) => string | null;
  now?: () => number;
};

/** A peer asking for the same profile again within this long gets no second copy. */
export const ANSWER_EVERY_MS = 30_000;

/** The protocol above, between this device and the peers of one room. */
export class ProfileExchange {
  /** Peers whose hello offered the "profile" capability. */
  readonly peers = new Set<string>();
  private answered = new Map<string, number>();

  constructor(readonly profiles: RoomProfiles, private readonly deps: ExchangeDeps) {}

  /** Their hello was accepted: if they speak profiles, they learn my rev. */
  async hello(peerId: string, caps: unknown): Promise<void> {
    if (!Array.isArray(caps) || !caps.includes(PROFILE_CAP)) { this.peers.delete(peerId); return; }
    this.peers.add(peerId);
    await this.deps.send(peerId, announceOf(this.deps.myView()));
  }

  async receive(peerId: string, frame: ProfileFrame): Promise<void> {
    const owner = this.deps.ownerOf(peerId);
    if (!owner) return;
    if (frame.want) {
      const view = this.deps.myView();
      if (!view || view.rev !== frame.rev) return;
      const now = (this.deps.now ?? Date.now)();
      const key = `${peerId}|${view.rev}`;
      if (now - (this.answered.get(key) ?? -Infinity) < ANSWER_EVERY_MS) return;
      this.answered.set(key, now);
      if (!(await this.deps.send(peerId, fullFrameOf(view)))) await this.deps.send(peerId, fullFrameOf(view, true));
      return;
    }
    if (frame.profile) { this.profiles.received(peerId, owner, frame); return; }
    if (this.profiles.announced(peerId, owner, frame.rev) === "request") await this.deps.send(peerId, { rev: frame.rev, want: true });
  }

  /** My profile changed (saved, signed in or out): everyone who speaks profiles learns the new rev. */
  async changed(): Promise<void> {
    const frame = announceOf(this.deps.myView());
    for (const peerId of [...this.peers]) await this.deps.send(peerId, frame);
  }

  forget(peerId: string): void {
    this.peers.delete(peerId);
    this.profiles.forget(peerId);
    for (const key of this.answered.keys()) if (key.startsWith(`${peerId}|`)) this.answered.delete(key);
  }
}
