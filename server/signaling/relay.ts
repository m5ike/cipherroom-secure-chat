// The away relay, second edition.
//
// A signed-in member whose page is suspended, or whose connection went,
// stays in the room as AWAY. Others keep writing: the sender's client hands
// the room-key ciphertext to the server, which queues it (OfflineQueue —
// SQLite, or memory when there is no database), answers "stored" on the
// member's behalf and tries to wake their browser with a push. When the
// member is back, the queue is handed over in order under a lease; only an
// acknowledgement removes an item, and each acknowledgement turns into
// "delivered" for its sender.
//
// What changed from the first version, and why:
//   - members are addressed by room-scoped references, never by account id
//     (refs.ts): a room name no longer reveals who has an account;
//   - away is tracked per socket: one backgrounded tab no longer diverts
//     messages away from the same person's active tab;
//   - receipts are accepted only for messages this server actually relayed
//     to the reader, and only reach that message's sender — no more forged
//     "read" marks or status items planted in someone else's mailbox;
//   - rejections are generic: they no longer reveal account names or
//     whether an account exists;
//   - signing out (or being deleted) ends the relay for that account at
//     once, including on sockets that are still open.

import type { WebSocket } from "ws";
import type { AccountStore, PushTarget } from "../accounts/store";
import type { OfflineQueue, QueueEnvelope, QueueItem } from "../accounts/mailqueue";
import { accountRef, resolveRef } from "./refs";
import { audit } from "../monitor/audit";
import { hashRoom } from "../monitor/traffic";

export type RelayPeer = {
  id: string;
  connId: string;
  room: string | null;
  name: string;
  socket: WebSocket;
  accountId?: string;
  /** The user asked the server to cover for them (retention "server"). */
  awayEnabled?: boolean;
  /** This socket's page is suspended (presence: away). */
  suspended?: boolean;
  /** Queue items handed to this socket and not yet acknowledged. */
  leased?: Set<string>;
};

type Rooms = Map<string, Map<string, RelayPeer>>;
type SendFn = (socket: WebSocket, payload: unknown) => boolean;
type PushFn = (target: PushTarget, payload: { title: string; body: string; url: string; tag: string; kind?: string }) => Promise<{ ok: boolean; error?: string }>;

type AwayEntry = { name: string; since: number };

const PUSH_THROTTLE_MS = 30_000;
const DELIVER_BATCH = 50;

export class AwayRelay {
  /** room → accountId → away entry. The truth lives here, not on disk. */
  private awayByRoom = new Map<string, Map<string, AwayEntry>>();
  private lastPush = new Map<string, number>();

  constructor(
    private readonly accounts: AccountStore,
    private readonly rooms: Rooms,
    private readonly send: SendFn,
    private readonly queue: () => OfflineQueue | null,
    private readonly push?: PushFn,
    private readonly now: () => number = Date.now,
  ) {}

  /* ------------------------------------------------------------ helpers */

  ref(room: string, accountId: string): string {
    return accountRef(room, accountId);
  }

  /** `account` and its deprecated alias `accountId` (protocol 1 clients) carry the same reference. */
  private refs(room: string, accountId: string): { account: string; accountId: string } {
    const ref = this.ref(room, accountId);
    return { account: ref, accountId: ref };
  }

  private members(room: string): RelayPeer[] {
    return [...(this.rooms.get(room)?.values() ?? [])];
  }

  /** Sockets of `accountId` in `room` that are awake. */
  private awake(room: string, accountId: string, except?: RelayPeer): RelayPeer[] {
    return this.members(room).filter((p) => p !== except && p.accountId === accountId && !p.suspended);
  }

  private broadcast(room: string, payload: unknown, except?: RelayPeer): void {
    for (const p of this.members(room)) if (p !== except) this.send(p.socket, payload);
  }

  isAway(accountId: string, room: string): boolean {
    return this.awayByRoom.get(room)?.has(accountId) ?? false;
  }

  private setAway(accountId: string, room: string, name: string): boolean {
    let map = this.awayByRoom.get(room);
    if (!map) { map = new Map(); this.awayByRoom.set(room, map); }
    if (map.has(accountId)) return false;
    const since = this.now();
    map.set(accountId, { name, since });
    this.accounts.noteAway(accountId, room, name, since);
    this.accounts.addAudit(accountId, "away", { room: hashRoom(room) ?? "" });
    this.broadcast(room, { type: "peer-away", ...this.refs(room, accountId), name, since });
    audit.add({ category: "account", event: "relay.away", accountId, roomHash: hashRoom(room) });
    return true;
  }

  private clearAway(accountId: string, room: string, back?: RelayPeer): boolean {
    const map = this.awayByRoom.get(room);
    if (!map?.delete(accountId)) return false;
    if (map.size === 0) this.awayByRoom.delete(room);
    this.accounts.noteBack(accountId, room);
    this.accounts.addAudit(accountId, "back", { room: hashRoom(room) ?? "" });
    this.broadcast(room, { type: "peer-back", ...this.refs(room, accountId), ...(back ? { peerId: back.id, name: back.name } : {}) }, back);
    audit.add({ category: "account", event: "relay.back", accountId, roomHash: hashRoom(room) });
    return true;
  }

  /** Away members to list in the `joined` frame. */
  awayList(room: string, viewer?: string): Array<{ account: string; name: string; since: number }> {
    const out: Array<{ account: string; name: string; since: number }> = [];
    for (const [accountId, entry] of this.awayByRoom.get(room) ?? []) {
      if (accountId === viewer) continue;
      out.push({ account: this.ref(room, accountId), name: entry.name, since: entry.since });
    }
    return out;
  }

  /** Away members with their real account ids — for the operator only. */
  awayAccounts(room: string): Array<{ accountId: string; name: string; since: number }> {
    return [...(this.awayByRoom.get(room) ?? [])].map(([accountId, e]) => ({ accountId, name: e.name, since: e.since }));
  }

  /** Restores away state after a restart (from the account store). */
  restore(entries: Array<{ accountId: string; room: string; name: string; since: number }>): void {
    for (const e of entries) {
      let map = this.awayByRoom.get(e.room);
      if (!map) { map = new Map(); this.awayByRoom.set(e.room, map); }
      map.set(e.accountId, { name: e.name, since: e.since });
    }
  }

  /* ---------------------------------------------------------- lifecycle */

  /** A client entered `room` (or re-authenticated in it). */
  onJoin(client: RelayPeer): void {
    if (!client.accountId || !client.room) return;
    if (!client.suspended) this.clearAway(client.accountId, client.room, client);
    if (!client.suspended) this.deliver(client);
  }

  /** The page was put aside (away: true) or handed back (false). Returns
   *  whether the account is now away in the room. */
  setPresence(client: RelayPeer, away: boolean): boolean {
    client.suspended = away;
    if (!client.accountId || !client.room) return false;
    const room = client.room;
    if (away) {
      if (!client.awayEnabled) return false;
      // Another awake tab of the same person keeps them present.
      if (this.awake(room, client.accountId, client).length > 0) return false;
      this.setAway(client.accountId, room, client.name);
      return true;
    }
    this.clearAway(client.accountId, room, client);
    return false;
  }

  /** A client left (explicitly or by losing the socket). */
  onLeave(client: RelayPeer, room: string, wantsAway: boolean): boolean {
    if (!client.accountId || !client.awayEnabled || !wantsAway) return false;
    if (this.awake(room, client.accountId, client).length > 0) return false;
    if (!this.accounts.get(client.accountId)) return false; // deleted meanwhile
    return this.setAway(client.accountId, room, client.name);
  }

  /** Hands the client what waited for it in this room, under a lease. */
  deliver(client: RelayPeer): number {
    const queue = this.queue();
    if (!queue || !client.accountId || !client.room || client.suspended) return 0;
    const items = queue.lease(client.accountId, client.room, 500);
    if (items.length) {
      client.leased ??= new Set();
      for (const item of items) client.leased.add(item.id);
    }
    for (let i = 0; i < items.length; i += DELIVER_BATCH) {
      this.send(client.socket, { type: "relay-deliver", items: items.slice(i, i + DELIVER_BATCH).map((item) => this.publicItem(item)) });
    }
    return items.length;
  }

  private publicItem(item: QueueItem) {
    return {
      id: item.id,
      seq: item.seq,
      kind: item.kind,
      messageId: item.messageId,
      from: {
        peerId: item.from.peerId,
        name: item.from.name,
        ...(item.from.accountId ? this.refs(item.room, item.from.accountId) : {}),
      },
      ...(item.envelope ? { envelope: item.envelope } : {}),
      ...(item.status ? { status: item.status } : {}),
      storedAt: item.storedAt,
      attempts: item.attempts,
    };
  }

  /* -------------------------------------------------------------- relay */

  /** A sender relays room-key ciphertext to members it cannot reach. */
  async relay(client: RelayPeer, frame: { messageId: string; to: string[]; envelope: QueueEnvelope; expiresAt?: number }): Promise<void> {
    const room = client.room;
    if (!room) return;
    const queue = this.queue();
    const status = (ref: string, state: string, name = "", reason?: string) =>
      this.send(client.socket, { type: "relay-status", messageId: frame.messageId, recipient: { account: ref, accountId: ref, name }, state, at: this.now(), ...(reason ? { reason } : {}) });

    // Only accounts that belong to this room — present or away — can be
    // addressed; anything else gets the same answer, whatever the reason.
    const candidates = new Set<string>([
      ...[...(this.awayByRoom.get(room)?.keys() ?? [])],
      ...this.members(room).map((p) => p.accountId).filter((a): a is string => Boolean(a)),
    ]);
    const from = { peerId: client.id, name: client.name, ...(client.accountId ? { accountId: client.accountId } : {}) };

    for (const ref of frame.to) {
      const accountId = resolveRef(room, ref, candidates);
      if (!accountId || accountId === client.accountId) { status(ref, "rejected", "", "not reachable"); continue; }
      if (!queue) { status(ref, "rejected", "", "relay unavailable"); continue; }

      const awayEntry = this.awayByRoom.get(room)?.get(accountId);
      const name = awayEntry?.name ?? this.members(room).find((p) => p.accountId === accountId)?.name ?? "";
      const result = queue.enqueue({ accountId, room, kind: "message", messageId: frame.messageId, from, envelope: frame.envelope, expiresAt: frame.expiresAt });
      if (!result.ok) {
        status(ref, "rejected", name, result.reason === "too-large" ? "too large" : "mailbox full");
        audit.add({ category: "security", level: "warn", event: "relay.refused", actor: client.id, accountId, roomHash: hashRoom(room), status: result.reason });
        continue;
      }
      // The ledger (in the queue's database) routes receipts back later,
      // also after a restart.
      queue.rememberRelay(frame.messageId, room, { peerId: client.id, name: client.name, ...(client.accountId ? { accountId: client.accountId } : {}) }, accountId);
      if (result.duplicate) { status(ref, "duplicate", name); continue; }

      this.accounts.addAudit(accountId, "relay-stored", { bytes: result.item.bytes });
      audit.add({ category: "communication", event: "relay.stored", actor: client.accountId ?? client.id, target: accountId, roomHash: hashRoom(room), bytes: result.item.bytes, status: "stored" });

      const awake = this.awake(room, accountId);
      if (awake.length > 0 && !awayEntry) {
        // Present and awake but without a direct channel: hand it over now
        // (still leased — the acknowledgement is what completes it).
        for (const p of awake) this.deliver(p);
        status(ref, "forwarded", name);
      } else {
        status(ref, "stored", name);
        await this.wake(accountId, room, client.name);
      }
    }
  }

  /** The recipient processed delivered items: drop them, tell the senders. */
  ack(client: RelayPeer, ids: string[]): number {
    const queue = this.queue();
    if (!queue || !client.accountId || !client.room) return 0;
    const taken = queue.ack(client.accountId, ids);
    for (const id of ids) client.leased?.delete(id);
    if (taken.length) this.accounts.addAudit(client.accountId, "relay-delivered", { items: taken.length });
    for (const item of taken) {
      if (item.kind !== "message") continue;
      audit.add({ category: "communication", event: "relay.delivered", actor: item.from.accountId ?? item.from.peerId, target: client.accountId, roomHash: hashRoom(item.room), bytes: item.bytes, status: "delivered" });
      this.notifySender(item.room, item.messageId, { peerId: item.from.peerId, accountId: item.from.accountId }, client, "delivered");
    }
    return taken.length;
  }

  /** "I have read these": only for messages relayed to this reader. */
  receipt(client: RelayPeer, messageIds: string[], state: "read" | "delivered"): number {
    const queue = this.queue();
    if (!queue || !client.accountId || !client.room) return 0;
    let routed = 0;
    for (const messageId of messageIds) {
      const entry = queue.relayOf(messageId);
      if (!entry || entry.room !== client.room || !entry.recipients.includes(client.accountId)) continue;
      this.notifySender(entry.room, messageId, { peerId: entry.sender.peerId, accountId: entry.sender.accountId }, client, state);
      routed += 1;
    }
    return routed;
  }

  private notifySender(room: string, messageId: string, sender: { peerId: string; accountId?: string }, recipient: RelayPeer, state: "delivered" | "read"): void {
    const payload = {
      type: "relay-status",
      messageId,
      recipient: { ...this.refs(room, recipient.accountId!), name: recipient.name },
      state,
      at: this.now(),
    };
    const online = this.members(room).filter((p) => (sender.peerId && p.id === sender.peerId) || (sender.accountId && p.accountId === sender.accountId));
    if (online.length > 0) {
      for (const p of online) this.send(p.socket, payload);
      return;
    }
    // The sender is gone; a signed-in sender finds it in their own queue.
    const queue = this.queue();
    if (!queue || !sender.accountId || !this.accounts.get(sender.accountId)) return;
    const statusBody = { state, at: payload.at, recipientName: recipient.name };
    if (!queue.upgradeStatus(sender.accountId, messageId, statusBody)) {
      queue.enqueue({
        accountId: sender.accountId,
        room,
        kind: "status",
        messageId,
        from: { peerId: recipient.id, name: recipient.name, accountId: recipient.accountId },
        status: statusBody,
      });
    }
  }

  /** The socket went before acknowledging: its items are due again now
   *  (a reload must not wait for the lease to run out). */
  release(client: RelayPeer): number {
    const queue = this.queue();
    if (!queue || !client.accountId || !client.leased?.size) return 0;
    const n = queue.release(client.accountId, [...client.leased]);
    client.leased.clear();
    return n;
  }

  /* ------------------------------------------------------------ signing out */

  /** The account signed out everywhere or was deleted: stop covering for it. */
  forget(accountId: string): void {
    for (const [room, map] of this.awayByRoom) {
      if (!map.delete(accountId)) continue;
      if (map.size === 0) this.awayByRoom.delete(room);
      this.broadcast(room, { type: "peer-gone", ...this.refs(room, accountId) });
    }
    this.accounts.clearAllAway(accountId);
  }

  /* ---------------------------------------------------------------- wake */

  private async wake(accountId: string, room: string, fromName: string): Promise<void> {
    if (!this.push) return;
    const acc = this.accounts.get(accountId);
    if (!acc || acc.push.length === 0) return;
    const key = `${accountId}|${room}`;
    if (this.now() - (this.lastPush.get(key) ?? 0) < PUSH_THROTTLE_MS) return;
    this.lastPush.set(key, this.now());
    if (this.lastPush.size > 20_000) this.lastPush.clear();
    let sent = 0;
    // A neutral wake-up: the push payload is encrypted for the browser
    // (RFC 8291), but the notification shows on a locked screen — no name,
    // no room. The service worker words it in the device's language.
    void fromName;
    for (const target of acc.push) {
      const r = await this.push(target, {
        title: "M5cet",
        body: "",
        url: "/signin",
        tag: `m5cet-away-${hashRoom(room)}`,
        kind: "relay",
      });
      if (r.ok) sent += 1;
      else if (/\b(404|410)\b/.test(r.error ?? "")) this.accounts.removePushEndpoint(accountId, target.endpoint);
    }
    this.accounts.addAudit(accountId, "push-sent", { devices: sent });
    audit.add({ category: "account", event: "relay.push", accountId, roomHash: hashRoom(room), status: `${sent}/${acc.push.length}` });
  }

  stats() {
    let away = 0;
    for (const map of this.awayByRoom.values()) away += map.size;
    return { away, rooms: this.awayByRoom.size };
  }
}
