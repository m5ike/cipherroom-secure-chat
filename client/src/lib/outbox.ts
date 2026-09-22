// Messages that have nowhere to go yet.
//
// In light mode there is no server to hold a message for an absent
// recipient: if nobody's data channel is open, the message would simply be
// refused. Instead it waits here — the bubble shows it as *sending* — and
// every time a channel opens, or the page comes back from the background,
// the queue tries again.
//
// What is kept is the already-encrypted envelope, so a queued message is no
// more readable in memory than one on the wire. The queue is bounded, drops
// what has expired, and gives up on a message after enough attempts so it
// cannot rattle forever.

export type QueuedMessage<Envelope = unknown> = {
  /** The chat message this belongs to, so the bubble can follow it. */
  messageId: string;
  room: string;
  envelope: Envelope;
  /** Peer ids this was meant for; empty = everyone in the room. */
  targets: string[];
  /** Display names, for the "waiting for …" line. */
  toNames: string[];
  createdAt: number;
  attempts: number;
  lastAttemptAt: number;
  /** After this the message is pointless (TTL); 0 = no expiry. */
  expiresAt: number;
};

export type OutboxLimits = {
  maxMessages: number;
  maxAttempts: number;
  /** Stop retrying a message older than this (ms). */
  maxAgeMs: number;
};

export const OUTBOX_LIMITS: OutboxLimits = {
  maxMessages: 200,
  maxAttempts: 60,
  maxAgeMs: 24 * 60 * 60 * 1000,
};

export type DeliveryResult = { delivered: number; failed: string[] };

/** Sends one queued message; returns how many peers took it. */
export type OutboxSender<Envelope> = (entry: QueuedMessage<Envelope>) => number | Promise<number>;

export type Outbox<Envelope = unknown> = {
  /** Queues a message. Returns the entry, or null when the queue is full. */
  add(entry: Omit<QueuedMessage<Envelope>, "attempts" | "lastAttemptAt">): QueuedMessage<Envelope> | null;
  /** Tries every waiting message once. */
  flush(now?: number): Promise<DeliveryResult>;
  remove(messageId: string): boolean;
  has(messageId: string): boolean;
  list(): QueuedMessage<Envelope>[];
  size(): number;
  /** Drops what expired or ran out of attempts; returns their ids. */
  prune(now?: number): string[];
  clear(): void;
};

export function createOutbox<Envelope>(
  send: OutboxSender<Envelope>,
  limits: OutboxLimits = OUTBOX_LIMITS,
): Outbox<Envelope> {
  const entries = new Map<string, QueuedMessage<Envelope>>();

  const expired = (entry: QueuedMessage<Envelope>, now: number): boolean =>
    (entry.expiresAt > 0 && entry.expiresAt <= now)
    || entry.attempts >= limits.maxAttempts
    || now - entry.createdAt > limits.maxAgeMs;

  return {
    add(entry) {
      if (entries.has(entry.messageId)) return entries.get(entry.messageId)!;
      if (entries.size >= limits.maxMessages) return null;
      const full: QueuedMessage<Envelope> = { ...entry, attempts: 0, lastAttemptAt: 0 };
      entries.set(entry.messageId, full);
      return full;
    },

    async flush(now = Date.now()) {
      const result: DeliveryResult = { delivered: 0, failed: [] };
      for (const entry of [...entries.values()]) {
        if (expired(entry, now)) { entries.delete(entry.messageId); continue; }
        entry.attempts += 1;
        entry.lastAttemptAt = now;
        let sent = 0;
        try {
          sent = await send(entry);
        } catch {
          sent = 0;
        }
        if (sent > 0) {
          entries.delete(entry.messageId);
          result.delivered += 1;
        } else {
          result.failed.push(entry.messageId);
        }
      }
      return result;
    },

    remove: (messageId) => entries.delete(messageId),
    has: (messageId) => entries.has(messageId),
    list: () => [...entries.values()],
    size: () => entries.size,

    prune(now = Date.now()) {
      const gone: string[] = [];
      for (const entry of [...entries.values()]) {
        if (expired(entry, now)) { entries.delete(entry.messageId); gone.push(entry.messageId); }
      }
      return gone;
    },

    clear: () => entries.clear(),
  };
}
