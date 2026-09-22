// "Away" presence + store-and-forward relay for signed-in users.
//
// A signed-in user (server-enhanced chat, passkey account) whose connection
// goes away — tab closed, network gone, Disconnect — stays in the room as
// AWAY instead of leaving. Others keep seeing them (peer-away) and can keep
// writing: the sender's client hands the already room-key-encrypted envelope
// to the server (relay), which
//   - stores it in the account's mailbox (ciphertext only; it cannot read it),
//   - answers on the user's behalf: relay-status "stored" to the sender,
//   - wakes the user's browser with a Web Push ("flash message"), if linked.
// When the user comes back (join with the account token) the server marks
// them back (peer-back), delivers the mailbox for that room (relay-deliver);
// the client decrypts, acknowledges (relay-ack) and the server tells each
// sender "delivered" — directly if they are online, via their own mailbox if
// they are signed in but away themselves. Read receipts travel the same way.
//
// Everything is audited per account (away / back / relay-stored /
// relay-delivered / push-sent) — metadata only.

import type { WebSocket } from "ws";
import type { AccountStore, MailFrom, MailItem, PushTarget } from "./store";

export type RelayPeer = {
  id: string;
  room: string | null;
  name: string;
  socket: WebSocket;
  accountId?: string;
  /** The user asked for server-side away / relay (chat retention "server"). */
  awayEnabled?: boolean;
};

type Rooms = Map<string, Map<string, RelayPeer>>;
type SendFn = (socket: WebSocket, payload: unknown) => void;
type PushFn = (target: PushTarget, payload: { title: string; body: string; url: string; tag: string }) => Promise<{ ok: boolean; error?: string }>;

const MSG_ID = /^[A-Za-z0-9_:-]{1,80}$/;
const PUSH_THROTTLE_MS = 30_000;
/** Relay frames one socket may send per minute (mailboxes are bounded too). */
const RELAY_PER_MINUTE = 120;

export class AwayRelay {
  private lastPush = new Map<string, number>();
  private budget = new WeakMap<RelayPeer, { windowStart: number; count: number }>();

  constructor(
    private readonly store: AccountStore,
    private readonly rooms: Rooms,
    private readonly send: SendFn,
    private readonly push?: PushFn,
    private readonly now: () => number = Date.now,
  ) {}

  /** Sockets of `accountId` currently in `room`. */
  private present(room: string, accountId: string): RelayPeer[] {
    return Array.from(this.rooms.get(room)?.values() ?? []).filter((p) => p.accountId === accountId);
  }

  private broadcast(room: string, payload: unknown, except?: RelayPeer) {
    this.rooms.get(room)?.forEach((p) => { if (p !== except) this.send(p.socket, payload); });
  }

  /** Away accounts to list in the `joined` frame (never ones already present). */
  awayList(room: string): Array<{ accountId: string; name: string; since: number }> {
    return this.store.awayInRoom(room).filter((a) => this.present(room, a.accountId).length === 0);
  }

  /** After a client entered `room`. */
  onJoin(client: RelayPeer): void {
    if (!client.accountId || !client.room) return;
    const room = client.room;
    if (this.store.clearAway(client.accountId, room, this.now())) {
      this.broadcast(room, { type: "peer-back", accountId: client.accountId, peerId: client.id, name: client.name }, client);
    }
    this.deliver(client);
  }

  /** Sends this account's pending mailbox for the client's room. */
  deliver(client: RelayPeer): number {
    if (!client.accountId || !client.room) return 0;
    const items = this.store.mailbox(client.accountId, client.room);
    if (items.length === 0) return 0;
    const out = items.map((i) => ({ id: i.id, kind: i.kind, messageId: i.messageId, from: i.from, envelope: i.envelope, status: i.status, storedAt: i.storedAt }));
    for (let i = 0; i < out.length; i += 50) this.send(client.socket, { type: "relay-deliver", items: out.slice(i, i + 50) });
    return items.length;
  }

  /** A client left `room` (explicitly or by losing the socket). Returns true
   *  when the account is now away there. */
  onLeave(client: RelayPeer, room: string, wantsAway: boolean): boolean {
    if (!client.accountId || !client.awayEnabled || !wantsAway) return false;
    // Still here in another tab / device → not away.
    if (this.present(room, client.accountId).some((p) => p !== client)) return false;
    this.store.setAway(client.accountId, room, client.name, this.now());
    this.broadcast(room, { type: "peer-away", accountId: client.accountId, peerId: client.id, name: client.name, since: this.now() });
    return true;
  }

  /** Signed out / deleted: no longer away anywhere; rooms drop the entry. */
  forget(accountId: string): void {
    for (const room of this.store.clearAllAway(accountId, this.now())) {
      if (this.present(room, accountId).length === 0) this.broadcast(room, { type: "peer-gone", accountId });
    }
  }

  private withinBudget(client: RelayPeer): boolean {
    const now = this.now();
    const b = this.budget.get(client);
    if (!b || now - b.windowStart >= 60_000) { this.budget.set(client, { windowStart: now, count: 1 }); return true; }
    b.count += 1;
    return b.count <= RELAY_PER_MINUTE;
  }

  /** A sender relays an encrypted message to away (or unreachable) accounts. */
  async relay(client: RelayPeer, msg: { messageId?: unknown; to?: unknown; envelope?: unknown }): Promise<void> {
    const room = client.room;
    if (!room) return;
    if (!this.withinBudget(client)) {
      this.send(client.socket, { type: "error", message: "Relay rate limit reached; slow down." });
      return;
    }
    const messageId = typeof msg.messageId === "string" && MSG_ID.test(msg.messageId) ? msg.messageId : null;
    const env = msg.envelope as { iv?: unknown; ciphertext?: unknown } | undefined;
    const to = Array.isArray(msg.to) ? msg.to.filter((x): x is string => typeof x === "string").slice(0, 50) : [];
    if (!messageId || !env || typeof env.iv !== "string" || typeof env.ciphertext !== "string" || to.length === 0) {
      this.send(client.socket, { type: "error", message: "Malformed relay frame." });
      return;
    }
    const from: MailFrom = { peerId: client.id, name: client.name, ...(client.accountId ? { accountId: client.accountId } : {}) };
    for (const accountId of new Set(to)) {
      const acc = this.store.get(accountId);
      const awayName = acc?.away.find((a) => a.room === room)?.name;
      const status = (state: string, extra: { reason?: string; name?: string } = {}) =>
        this.send(client.socket, {
          type: "relay-status",
          messageId,
          recipient: { accountId, name: extra.name || awayName || acc?.userName || accountId.slice(0, 6) },
          state,
          at: this.now(),
          ...(extra.reason ? { reason: extra.reason } : {}),
        });
      if (!acc) { status("rejected", { reason: "unknown recipient" }); continue; }

      const here = this.present(room, accountId);
      if (here.length > 0) {
        // Online but without a direct channel (P2P failed): forward now; the
        // recipient's relay-ack turns into "delivered".
        const r = this.store.addMail(accountId, { room, kind: "message", from, messageId, envelope: { iv: env.iv, ciphertext: env.ciphertext } }, this.now());
        if (!r.ok) { status("rejected", { reason: r.reason }); continue; }
        here.forEach((p) => this.send(p.socket, { type: "relay-deliver", items: [publicItem(r.item)] }));
        status("forwarded", { name: here[0].name });
        continue;
      }
      if (!this.store.isAway(accountId, room)) { status("rejected", { reason: "recipient is not in this room" }); continue; }

      const r = this.store.addMail(accountId, { room, kind: "message", from, messageId, envelope: { iv: env.iv, ciphertext: env.ciphertext } }, this.now());
      if (!r.ok) { status("rejected", { reason: r.reason }); continue; }
      this.store.addAudit(accountId, "relay-stored", { room, from: from.name.slice(0, 32), bytes: r.item.bytes }, this.now());
      // Answered on the away user's behalf.
      status("stored");
      await this.wake(accountId, room, from.name);
    }
  }

  /** The recipient processed delivered items: drop them, tell the senders. */
  ack(client: RelayPeer, ids: unknown): number {
    if (!client.accountId || !client.room || !Array.isArray(ids)) return 0;
    const taken = this.store.takeMail(client.accountId, ids.filter((x): x is string => typeof x === "string").slice(0, 500));
    const delivered = taken.filter((i) => i.kind === "message");
    if (delivered.length) {
      this.store.addAudit(client.accountId, "relay-delivered", { room: client.room, count: delivered.length }, this.now());
    }
    for (const item of delivered) {
      this.notifySender(item.room, item.from, {
        messageId: item.messageId,
        recipient: { accountId: client.accountId, name: client.name },
        state: "delivered",
        at: this.now(),
      });
    }
    return taken.length;
  }

  /** Read (or delivered) receipt for relayed messages, recipient → sender. */
  receipt(client: RelayPeer, msg: { to?: unknown; messageIds?: unknown; state?: unknown }): void {
    if (!client.room) return;
    const to = msg.to as { peerId?: unknown; accountId?: unknown } | undefined;
    const state = msg.state === "read" || msg.state === "delivered" ? msg.state : null;
    const ids = Array.isArray(msg.messageIds) ? msg.messageIds.filter((x): x is string => typeof x === "string" && MSG_ID.test(x)).slice(0, 200) : [];
    if (!to || !state || ids.length === 0) return;
    const target: MailFrom = {
      peerId: typeof to.peerId === "string" ? to.peerId.slice(0, 64) : "",
      name: "",
      ...(typeof to.accountId === "string" ? { accountId: to.accountId.slice(0, 64) } : {}),
    };
    for (const messageId of ids) {
      this.notifySender(client.room, target, {
        messageId,
        recipient: { accountId: client.accountId, name: client.name },
        state,
        at: this.now(),
      });
    }
  }

  private notifySender(room: string, from: MailFrom, status: { messageId: string; recipient: { accountId?: string; name: string }; state: "delivered" | "read"; at: number }): void {
    const members = Array.from(this.rooms.get(room)?.values() ?? []);
    const online = members.filter((p) => (from.peerId && p.id === from.peerId) || (from.accountId && p.accountId === from.accountId));
    if (online.length > 0) {
      online.forEach((p) => this.send(p.socket, { type: "relay-status", ...status }));
      return;
    }
    // Sender gone: a signed-in sender gets it in their mailbox.
    if (from.accountId && this.store.get(from.accountId)) {
      this.store.addMail(from.accountId, {
        room,
        kind: "status",
        from: { peerId: "", name: status.recipient.name, ...(status.recipient.accountId ? { accountId: status.recipient.accountId } : {}) },
        messageId: status.messageId,
        status: { state: status.state, at: status.at, recipientName: status.recipient.name },
      }, this.now());
    }
  }

  /** Web Push "flash message" to the away user's linked devices. */
  private async wake(accountId: string, room: string, fromName: string): Promise<void> {
    if (!this.push) return;
    const acc = this.store.get(accountId);
    if (!acc || acc.push.length === 0) return;
    const key = `${accountId}|${room}`;
    const last = this.lastPush.get(key) ?? 0;
    if (this.now() - last < PUSH_THROTTLE_MS) return;
    this.lastPush.set(key, this.now());
    let sent = 0;
    for (const target of acc.push) {
      const r = await this.push(target, {
        title: "M5cet",
        body: `${fromName.slice(0, 40)} · ${room}`,
        url: "/signin",
        tag: `m5cet-away-${room}`.slice(0, 64),
      });
      if (r.ok) sent++;
      // Gone for good (404/410): forget the endpoint.
      else if (/\b(404|410)\b/.test(r.error ?? "")) this.store.removePushEndpoint(accountId, target.endpoint);
    }
    this.store.addAudit(accountId, "push-sent", { room, devices: acc.push.length, sent }, this.now());
  }
}

function publicItem(i: MailItem) {
  return { id: i.id, kind: i.kind, messageId: i.messageId, from: i.from, envelope: i.envelope, status: i.status, storedAt: i.storedAt };
}
