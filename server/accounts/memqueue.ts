// The offline queue without a database: same behaviour as MailQueue
// (ordered, deduplicated, leased, bounded, expiring, dead-letter), kept in
// memory. Used when the SQLite driver or a writable data directory is
// missing, so the away relay keeps working — it just does not survive a
// restart, and the console says so (persistent: false).

import { randomBytes } from "node:crypto";
import { QUEUE_LIMITS, queueTtlMs, type EnqueueResult, type OfflineQueue, type QueueItem } from "./mailqueue";

export class MemoryQueue implements OfflineQueue {
  readonly persistent = false;
  private items = new Map<string, QueueItem & { senderKey: string }>();
  private seqs = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  enqueue(input: Parameters<OfflineQueue["enqueue"]>[0]): EnqueueResult {
    if (!input.accountId || !input.room || !input.messageId) return { ok: false, reason: "invalid", detail: "account, room and message id are required" };
    const at = this.now();
    for (const item of this.items.values()) {
      if (item.accountId === input.accountId && item.kind === input.kind && item.messageId === input.messageId) {
        return { ok: true, item: strip(item), duplicate: true };
      }
    }
    const envelope = input.envelope ? JSON.stringify(input.envelope) : "";
    const status = input.status ? JSON.stringify(input.status) : "";
    const bytes = envelope.length + status.length + JSON.stringify(input.from ?? {}).length;
    if (bytes > QUEUE_LIMITS.maxItemBytes) return { ok: false, reason: "too-large", detail: `${bytes} bytes` };
    const live = [...this.items.values()].filter((i) => i.accountId === input.accountId && i.state !== "dead");
    const total = live.reduce((n, i) => n + i.bytes, 0);
    if (live.length >= QUEUE_LIMITS.maxItemsPerAccount || total + bytes > QUEUE_LIMITS.maxBytesPerAccount) {
      return { ok: false, reason: "quota", detail: `${live.length} items, ${total} bytes waiting` };
    }
    const senderKey = input.from?.accountId || input.from?.peerId || "anonymous";
    if (input.kind === "message" && live.filter((i) => i.senderKey === senderKey).length >= QUEUE_LIMITS.maxItemsPerSender) {
      return { ok: false, reason: "sender-quota", detail: "too many items from this sender" };
    }
    const key = `${input.accountId}\u0000${input.room}`;
    const seq = (this.seqs.get(key) ?? 0) + 1;
    this.seqs.set(key, seq);
    const ttl = queueTtlMs();
    const expiresAt = input.expiresAt && input.expiresAt > at ? Math.min(input.expiresAt, at + ttl) : at + ttl;
    const item: QueueItem & { senderKey: string } = {
      id: `mq-${randomBytes(10).toString("base64url")}`,
      accountId: input.accountId,
      room: input.room,
      seq,
      kind: input.kind,
      messageId: input.messageId,
      from: input.from,
      ...(input.envelope ? { envelope: input.envelope } : {}),
      ...(input.status ? { status: input.status } : {}),
      state: "queued",
      attempts: 0,
      storedAt: at,
      leaseUntil: 0,
      expiresAt,
      bytes,
      senderKey,
    };
    this.items.set(item.id, item);
    return { ok: true, item: strip(item), duplicate: false };
  }

  lease(accountId: string, room: string | undefined, limit = 200): QueueItem[] {
    const at = this.now();
    const ready = [...this.items.values()]
      .filter((i) => i.accountId === accountId && (room === undefined || i.room === room) && i.expiresAt > at
        && (i.state === "queued" || (i.state === "delivering" && i.leaseUntil <= at)))
      .sort((a, b) => (a.room === b.room ? a.seq - b.seq : a.room < b.room ? -1 : 1));
    const out: QueueItem[] = [];
    for (const item of ready) {
      if (out.length >= limit) break;
      if (item.attempts >= QUEUE_LIMITS.maxAttempts) {
        item.state = "dead";
        item.deadReason = `delivered ${item.attempts} times without an acknowledgement`;
        item.leaseUntil = 0;
        continue;
      }
      item.state = "delivering";
      item.attempts += 1;
      item.leaseUntil = at + QUEUE_LIMITS.leaseMs;
      out.push(strip(item));
    }
    return out;
  }

  ack(accountId: string, ids: string[]): QueueItem[] {
    const taken: QueueItem[] = [];
    for (const id of ids.slice(0, 1_000)) {
      const item = this.items.get(id);
      if (!item || item.accountId !== accountId || item.state === "dead") continue;
      this.items.delete(id);
      taken.push(strip(item));
    }
    return taken;
  }

  release(accountId: string, ids: string[]): number {
    let n = 0;
    for (const id of ids) {
      const item = this.items.get(id);
      if (!item || item.accountId !== accountId || item.state !== "delivering") continue;
      item.state = "queued";
      item.leaseUntil = 0;
      n += 1;
    }
    return n;
  }

  pending(accountId: string, room?: string): QueueItem[] {
    return [...this.items.values()]
      .filter((i) => i.accountId === accountId && i.state !== "dead" && (room === undefined || i.room === room))
      .sort((a, b) => a.seq - b.seq)
      .map(strip);
  }

  dead(accountId?: string, limit = 200): QueueItem[] {
    return [...this.items.values()]
      .filter((i) => i.state === "dead" && (!accountId || i.accountId === accountId))
      .sort((a, b) => b.storedAt - a.storedAt)
      .slice(0, limit)
      .map(strip);
  }

  revive(id: string): boolean {
    const item = this.items.get(id);
    if (!item || item.state !== "dead") return false;
    item.state = "queued";
    item.attempts = 0;
    item.leaseUntil = 0;
    delete item.deadReason;
    return true;
  }

  stats(accountId?: string) {
    const list = [...this.items.values()].filter((i) => !accountId || i.accountId === accountId);
    const live = list.filter((i) => i.state !== "dead");
    return {
      queued: list.filter((i) => i.state === "queued").length,
      delivering: list.filter((i) => i.state === "delivering").length,
      dead: list.filter((i) => i.state === "dead").length,
      bytes: live.reduce((n, i) => n + i.bytes, 0),
      oldestAt: live.length ? Math.min(...live.map((i) => i.storedAt)) : null,
    };
  }

  overview(limit = 200) {
    const accounts = new Set([...this.items.values()].map((i) => i.accountId));
    return [...accounts].slice(0, limit).map((accountId) => ({
      accountId,
      ...this.stats(accountId),
      rooms: new Set([...this.items.values()].filter((i) => i.accountId === accountId).map((i) => i.room)).size,
    }));
  }

  sweep() {
    const at = this.now();
    let expired = 0;
    let purged = 0;
    for (const item of [...this.items.values()]) {
      if (item.state !== "dead" && item.expiresAt <= at) {
        item.state = "dead";
        item.deadReason = "expired before delivery";
        item.leaseUntil = 0;
        expired += 1;
      } else if (item.state === "dead" && item.storedAt < at - QUEUE_LIMITS.deadRetentionMs) {
        this.items.delete(item.id);
        purged += 1;
      }
    }
    return { expired, purged };
  }

  purgeAccount(accountId: string): number {
    let n = 0;
    for (const [id, item] of this.items) if (item.accountId === accountId) { this.items.delete(id); n += 1; }
    for (const key of this.seqs.keys()) if (key.startsWith(`${accountId}\u0000`)) this.seqs.delete(key);
    return n;
  }

  upgradeStatus(accountId: string, messageId: string, status: { state: "delivered" | "read"; at: number; recipientName: string }): boolean {
    for (const item of this.items.values()) {
      if (item.accountId !== accountId || item.kind !== "status" || item.messageId !== messageId || item.state === "dead") continue;
      if (item.status?.state === "read" || item.status?.state === status.state) return false;
      item.status = status;
      item.state = "queued";
      item.leaseUntil = 0;
      return true;
    }
    return false;
  }
}

function strip(item: QueueItem & { senderKey?: string }): QueueItem {
  const { senderKey: _ignored, ...rest } = item;
  return { ...rest };
}
