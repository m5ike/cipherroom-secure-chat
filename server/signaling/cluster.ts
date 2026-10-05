// Rooms across instances.
//
// Every instance knows its own sockets; through the cluster bus
// (server/cluster/bus.ts) it also learns who sits in the same rooms on the
// other instances, and routes what those members need:
//
//   join / leave / update   membership, announced by the member's instance
//                           (6.7: a leave carries `held` when the connection
//                           went without a goodbye — presence.ts)
//   state / hello / bye     a whole instance's members (start, stop, resync)
//   beat                    liveness; an instance silent for 20 s is gone
//   room / chunk            a frame for everyone in a room (proxy frames,
//                           peer-updated, away notices); `chunk` is a binary
//                           proxy chunk, sent on as binary where understood
//   signal                  SDP/ICE for a member on another instance
//   to-sender               proxy-need / proxy-cancel for a transfer whose
//                           sender is elsewhere
//   evict                   the same client resumed on another instance
//   revoke / away           account events (sign-out, away relay state)
//
// Account ids travel inside the cluster (it is the server's own network);
// clients only ever see room-scoped references computed by their instance.

import type { ClusterBus, ClusterMessage } from "../cluster/bus";

export type MemberView = {
  peerId: string;
  name: string;
  joinedAt: number;
  accountId?: string;
  resumeHash?: string;
  binary?: boolean;
  /** 6.7: presence — the app in the foreground, and when it last was. */
  foreground?: boolean;
  lastSeen?: number;
  /** 6.12: the member's join proved the room key (signaling/proof.ts). */
  proven?: boolean;
};

/** 6.7: a member whose connection went without a goodbye (presence.ts › HeldMember). */
export type HeldView = { name: string; joinedAt: number; lastSeen: number; since: number; accountId?: string; resumeHash?: string; tokenHash?: string; proven?: boolean };

export type RemoteMember = MemberView & { inst: string };

export type ClusterHooks = {
  /** Local members of every room: for `state` answers. */
  localRooms(): Array<{ room: string; members: MemberView[] }>;
  /** A member elsewhere came (peer-joined) or changed (peer-updated): the
   *  hub tells its sockets, with references it computes itself. */
  joined(room: string, member: MemberView): void;
  updated(room: string, member: MemberView): void;
  /** Tell local members of `room` (except one peer id). */
  toLocal(room: string, payload: Record<string, unknown>, except?: string): void;
  /** A binary proxy chunk for local members (JSON to those without "bin"). */
  chunkToLocal(room: string, raw: Buffer, json: Record<string, unknown>, except?: string): void;
  /** One local member; false when it is not here. */
  toLocalPeer(room: string, peerId: string, payload: Record<string, unknown>): boolean;
  /** The local sender of a relayed transfer. */
  toTransferSender(room: string, transferId: string, payload: Record<string, unknown>): void;
  evictLocal(room: string, peerId: string): void;
  revoke(accountId: string, hash: string | null, reason: string): void;
  away(room: string, accountId: string, entry: { name: string; since: number; lastSeen?: number } | null): void;
  /** 6.7: a member elsewhere is gone — for good (null), or held (its connection went, or its instance did). */
  left(room: string, peerId: string, held: HeldView | null): void;
};

const BEAT_MS = 5_000;
const GONE_MS = 20_000;

export class ClusterRooms {
  /** room → peerId → member on another instance */
  private readonly remote = new Map<string, Map<string, RemoteMember>>();
  private readonly seen = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly unsubscribe: () => void;

  constructor(readonly bus: ClusterBus, private readonly hooks: ClusterHooks, private readonly now: () => number = Date.now) {
    this.unsubscribe = bus.subscribe((msg) => this.onMessage(msg));
  }

  get instanceId(): string { return this.bus.instanceId; }

  start(): void {
    this.bus.publish({ t: "hello" });
    this.timer = setInterval(() => this.tick(), BEAT_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.bus.publish({ t: "bye" });
    this.unsubscribe();
  }

  /* ------------------------------------------------------------- queries */

  members(room: string): RemoteMember[] {
    return [...(this.remote.get(room)?.values() ?? [])];
  }

  member(room: string, peerId: string): RemoteMember | undefined {
    return this.remote.get(room)?.get(peerId);
  }

  instances(): Array<{ id: string; lastSeen: number; members: number }> {
    const counts = new Map<string, number>();
    for (const room of this.remote.values()) for (const m of room.values()) counts.set(m.inst, (counts.get(m.inst) ?? 0) + 1);
    return [...this.seen].map(([id, lastSeen]) => ({ id, lastSeen, members: counts.get(id) ?? 0 }));
  }

  /* ------------------------------------------------------------ announces */

  join(room: string, member: MemberView): void { this.bus.publish({ t: "join", room, member }); }
  leave(room: string, peerId: string, held?: HeldView): void { this.bus.publish({ t: "leave", room, peerId, ...(held ? { held } : {}) }); }
  update(room: string, member: MemberView): void { this.bus.publish({ t: "update", room, member }); }
  broadcast(room: string, payload: Record<string, unknown>, except?: string): void { this.bus.publish({ t: "room", room, payload, ...(except ? { except } : {}) }); }
  chunk(room: string, raw: Buffer, json: Record<string, unknown>, except?: string): void {
    this.bus.publish({ t: "chunk", room, raw: raw.toString("base64"), json, ...(except ? { except } : {}) });
  }
  toSender(room: string, transferId: string, payload: Record<string, unknown>): void { this.bus.publish({ t: "to-sender", room, transferId, payload }); }
  revoke(accountId: string, hash: string | null, reason: string): void { this.bus.publish({ t: "revoke", accountId, hash, reason }); }
  away(room: string, accountId: string, entry: { name: string; since: number; lastSeen?: number } | null): void { this.bus.publish({ t: "away", room, accountId, entry }); }

  /** SDP/ICE for a member elsewhere; false when nobody holds that peer id. */
  signal(room: string, target: string, payload: Record<string, unknown>): boolean {
    const member = this.member(room, target);
    if (!member) return false;
    this.bus.publish({ t: "signal", room, target, to: member.inst, payload });
    return true;
  }

  evict(room: string, peerId: string): void {
    const member = this.member(room, peerId);
    if (!member) return;
    this.bus.publish({ t: "evict", room, peerId, to: member.inst });
    this.drop(room, peerId);
  }

  /* ------------------------------------------------------------- incoming */

  private onMessage(msg: ClusterMessage): void {
    const from = typeof msg.from === "string" ? msg.from : "";
    if (msg.t === "resync") {
      // Our own link came back: say who we have, ask the others the same.
      this.bus.publish({ t: "hello" });
      return;
    }
    if (!from) return;
    if (msg.t !== "bye") this.seen.set(from, this.now());
    const room = typeof msg.room === "string" ? msg.room : "";
    switch (msg.t) {
      case "hello":
        // A new (or reconnected) instance: tell it who is here.
        this.bus.publish({ t: "state", to: from, rooms: this.hooks.localRooms() });
        return;
      case "state": {
        if (msg.to !== this.instanceId) return;
        const rooms = Array.isArray(msg.rooms) ? (msg.rooms as Array<{ room: string; members: MemberView[] }>) : [];
        for (const r of rooms) for (const m of r.members ?? []) if (typeof r.room === "string" && isView(m)) this.add(r.room, m, from);
        return;
      }
      case "beat":
        return;
      case "bye":
        this.seen.delete(from);
        this.dropInstance(from);
        return;
      case "join":
        if (room && isView(msg.member)) this.add(room, msg.member, from);
        return;
      case "update":
        if (room && isView(msg.member)) {
          const known = this.member(room, msg.member.peerId);
          if (!known) return;
          this.remote.get(room)!.set(msg.member.peerId, { ...msg.member, inst: from });
          // 6.7: only the presence changed (peer-presence went as a room frame): nothing to announce.
          if (known.name === msg.member.name && known.accountId === msg.member.accountId) return;
          this.hooks.updated(room, msg.member);
        }
        return;
      case "leave":
        if (room && typeof msg.peerId === "string" && this.member(room, msg.peerId)?.inst === from) {
          this.drop(room, msg.peerId);
          this.hooks.left(room, msg.peerId, isHeld(msg.held) ? msg.held : null);
        }
        return;
      case "room":
        if (room && isObject(msg.payload)) this.hooks.toLocal(room, msg.payload, str(msg.except));
        return;
      case "chunk":
        if (room && typeof msg.raw === "string" && isObject(msg.json)) this.hooks.chunkToLocal(room, Buffer.from(msg.raw, "base64"), msg.json, str(msg.except));
        return;
      case "signal":
        if (msg.to === this.instanceId && room && typeof msg.target === "string" && isObject(msg.payload)) this.hooks.toLocalPeer(room, msg.target, msg.payload);
        return;
      case "to-sender":
        if (room && typeof msg.transferId === "string" && isObject(msg.payload)) this.hooks.toTransferSender(room, msg.transferId, msg.payload);
        return;
      case "evict":
        if (msg.to === this.instanceId && room && typeof msg.peerId === "string") this.hooks.evictLocal(room, msg.peerId);
        return;
      case "revoke":
        if (typeof msg.accountId === "string") this.hooks.revoke(msg.accountId, typeof msg.hash === "string" ? msg.hash : null, str(msg.reason) ?? "admin");
        return;
      case "away":
        if (room && typeof msg.accountId === "string") {
          const e = msg.entry as { name?: unknown; since?: unknown; lastSeen?: unknown } | null;
          this.hooks.away(room, msg.accountId, e && typeof e.name === "string" && typeof e.since === "number"
            ? { name: e.name, since: e.since, ...(typeof e.lastSeen === "number" ? { lastSeen: e.lastSeen } : {}) } : null);
        }
        return;
    }
  }

  private add(room: string, member: MemberView, inst: string): void {
    let map = this.remote.get(room);
    if (!map) { map = new Map(); this.remote.set(room, map); }
    const known = map.has(member.peerId);
    map.set(member.peerId, { ...member, inst });
    // A member we already listed (a resync, or a move between instances)
    // is not news for the local sockets.
    if (!known) this.hooks.joined(room, member);
  }

  private drop(room: string, peerId: string): void {
    const map = this.remote.get(room);
    if (!map) return;
    map.delete(peerId);
    if (map.size === 0) this.remote.delete(room);
  }

  /** An instance went: its members lost their connection, they did not leave (6.7: held). */
  private dropInstance(inst: string): void {
    const now = this.now();
    for (const [room, map] of this.remote) {
      for (const [peerId, m] of map) {
        if (m.inst !== inst) continue;
        map.delete(peerId);
        this.hooks.left(room, peerId, {
          name: m.name, joinedAt: m.joinedAt, lastSeen: m.foreground === false ? m.lastSeen ?? now : now, since: now,
          ...(m.accountId ? { accountId: m.accountId } : {}), ...(m.resumeHash ? { resumeHash: m.resumeHash } : {}),
          ...(m.proven === true ? { proven: true } : {}),
        });
      }
      if (map.size === 0) this.remote.delete(room);
    }
  }

  /** Beat, and forget instances that went quiet. */
  tick(): void {
    this.bus.publish({ t: "beat" });
    const cutoff = this.now() - GONE_MS;
    for (const [inst, at] of this.seen) {
      if (at >= cutoff) continue;
      this.seen.delete(inst);
      this.dropInstance(inst);
    }
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function isHeld(v: unknown): v is HeldView {
  const h = v as HeldView | null;
  return Boolean(h) && typeof h === "object" && typeof h!.name === "string" && typeof h!.joinedAt === "number" && typeof h!.lastSeen === "number" && typeof h!.since === "number";
}
function isView(v: unknown): v is MemberView {
  const m = v as MemberView | null;
  return Boolean(m) && typeof m!.peerId === "string" && typeof m!.name === "string" && typeof m!.joinedAt === "number";
}
