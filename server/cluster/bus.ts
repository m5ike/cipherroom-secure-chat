// The cluster bus: how several server instances behind one load balancer
// tell each other about rooms, signals and relayed frames (see
// server/signaling/cluster.ts for what travels on it).
//
//   local   one instance (the default): nothing leaves the process
//   redis   REDIS_URL set: Redis pub/sub on CLUSTER_CHANNEL (m5cet:cluster)
//   memory  tests: several hubs in one process
//
// Messages are JSON. With CLUSTER_SECRET set every message carries an
// HMAC-SHA256 over its body and unsigned or forged ones are dropped — so
// anyone who can PUBLISH on the Redis server still cannot steer the rooms.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { parseRedisUrl, RedisConnection } from "./resp";

export type ClusterMessage = { t: string; from?: string; [key: string]: unknown };

export type ClusterStatus = {
  kind: "local" | "redis" | "memory";
  instanceId: string;
  connected: boolean;
  signed: boolean;
  published: number;
  received: number;
  dropped: number;
  lastError?: string | null;
};

export interface ClusterBus {
  readonly instanceId: string;
  readonly kind: ClusterStatus["kind"];
  /** Sends to every other instance (never back to this one). */
  publish(msg: ClusterMessage): void;
  subscribe(handler: (msg: ClusterMessage) => void): () => void;
  status(): ClusterStatus;
  close(): Promise<void>;
}

export function newInstanceId(): string {
  return `${hostname().replace(/[^A-Za-z0-9-]/g, "").slice(0, 24) || "node"}-${process.pid}-${randomBytes(3).toString("hex")}`;
}

/** Signs and checks message bodies (CLUSTER_SECRET). */
class Envelope {
  constructor(private readonly secret: string | null) {}
  get signed(): boolean { return this.secret !== null; }

  wrap(msg: ClusterMessage): string {
    const body = JSON.stringify(msg);
    if (!this.secret) return body;
    const mac = createHmac("sha256", this.secret).update(body).digest("base64url");
    return JSON.stringify({ m: mac, b: body });
  }

  unwrap(raw: string): ClusterMessage | null {
    try {
      if (!this.secret) {
        const msg = JSON.parse(raw) as ClusterMessage;
        return msg && typeof msg.t === "string" ? msg : null;
      }
      const outer = JSON.parse(raw) as { m?: unknown; b?: unknown };
      if (typeof outer.m !== "string" || typeof outer.b !== "string") return null;
      const want = createHmac("sha256", this.secret).update(outer.b).digest();
      const got = Buffer.from(outer.m, "base64url");
      if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
      const msg = JSON.parse(outer.b) as ClusterMessage;
      return msg && typeof msg.t === "string" ? msg : null;
    } catch {
      return null;
    }
  }
}

abstract class BaseBus implements ClusterBus {
  abstract readonly kind: ClusterStatus["kind"];
  protected handlers = new Set<(msg: ClusterMessage) => void>();
  protected counters = { published: 0, received: 0, dropped: 0 };
  protected readonly envelope: Envelope;

  constructor(readonly instanceId: string, secret: string | null) {
    this.envelope = new Envelope(secret);
  }

  abstract publish(msg: ClusterMessage): void;
  abstract status(): ClusterStatus;
  abstract close(): Promise<void>;

  subscribe(handler: (msg: ClusterMessage) => void): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  /** A raw message from the wire: checked, then handed to the handlers. */
  protected deliver(raw: string): void {
    const msg = this.envelope.unwrap(raw);
    if (!msg) { this.counters.dropped += 1; return; }
    if (msg.from === this.instanceId) return;
    this.counters.received += 1;
    for (const h of this.handlers) {
      try { h(msg); } catch (err) { console.warn(`[cluster] handler failed for ${msg.t}: ${(err as Error).message}`); }
    }
  }
}

/** One instance: nothing to talk to. */
export class LocalBus extends BaseBus {
  readonly kind = "local" as const;
  constructor(instanceId = newInstanceId()) { super(instanceId, null); }
  publish(): void { /* alone */ }
  status(): ClusterStatus {
    return { kind: this.kind, instanceId: this.instanceId, connected: true, signed: false, ...this.counters };
  }
  async close(): Promise<void> { this.handlers.clear(); }
}

/** Several buses in one process (tests). Delivery is asynchronous, like the network. */
export class MemoryNetwork {
  readonly buses = new Set<MemoryBus>();
  bus(instanceId = newInstanceId(), secret: string | null = null): MemoryBus {
    const bus = new MemoryBus(this, instanceId, secret);
    this.buses.add(bus);
    return bus;
  }
}

export class MemoryBus extends BaseBus {
  readonly kind = "memory" as const;
  constructor(private readonly network: MemoryNetwork, instanceId: string, secret: string | null) { super(instanceId, secret); }
  publish(msg: ClusterMessage): void {
    const raw = this.envelope.wrap({ ...msg, from: this.instanceId });
    this.counters.published += 1;
    for (const other of this.network.buses) if (other !== this) setImmediate(() => other.deliver(raw));
  }
  /** For tests: something that is not a signed message from a peer instance. */
  inject(raw: string): void { this.deliver(raw); }
  status(): ClusterStatus {
    return { kind: this.kind, instanceId: this.instanceId, connected: true, signed: this.envelope.signed, ...this.counters };
  }
  async close(): Promise<void> { this.network.buses.delete(this); this.handlers.clear(); }
}

/** Redis pub/sub: one connection publishes, one listens. */
export class RedisBus extends BaseBus {
  readonly kind = "redis" as const;
  private readonly pub: RedisConnection;
  private readonly sub: RedisConnection;
  private readonly queue: string[] = [];

  constructor(url: string, private readonly channel = "m5cet:cluster", secret: string | null = null, instanceId = newInstanceId()) {
    super(instanceId, secret);
    const target = parseRedisUrl(url);
    this.pub = new RedisConnection(target, `m5cet-pub-${instanceId}`);
    this.sub = new RedisConnection(target, `m5cet-sub-${instanceId}`);
    this.sub.on("message", (ch: string, payload: Buffer) => { if (ch === this.channel) this.deliver(payload.toString("utf8")); });
    void this.sub.subscribe(channel).catch(() => undefined);
    // Messages published while the link was down go out once it is back
    // (bounded: stale room events are worth less than memory).
    this.pub.on("ready", () => this.flush());
    this.sub.on("ready", () => { for (const h of this.handlers) h({ t: "resync", from: "" }); });
  }

  publish(msg: ClusterMessage): void {
    const raw = this.envelope.wrap({ ...msg, from: this.instanceId });
    if (!this.pub.ready) {
      this.queue.push(raw);
      if (this.queue.length > 1000) this.queue.splice(0, this.queue.length - 1000);
      return;
    }
    this.counters.published += 1;
    this.pub.command("PUBLISH", this.channel, raw).catch(() => { this.queue.push(raw); });
  }

  private flush(): void {
    for (const raw of this.queue.splice(0)) {
      this.counters.published += 1;
      this.pub.command("PUBLISH", this.channel, raw).catch(() => undefined);
    }
  }

  /** Resolves once both links are up (or rejects after `timeoutMs`). */
  ready(timeoutMs = 5000): Promise<void> {
    const wait = (c: RedisConnection) => c.ready ? Promise.resolve() : new Promise<void>((resolve) => c.once("ready", () => resolve()));
    return Promise.race([
      Promise.all([wait(this.pub), wait(this.sub)]).then(() => undefined),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`redis not reachable: ${this.pub.lastError ?? this.sub.lastError ?? "timeout"}`)), timeoutMs).unref?.()),
    ]);
  }

  status(): ClusterStatus {
    return {
      kind: this.kind, instanceId: this.instanceId, connected: this.pub.ready && this.sub.ready, signed: this.envelope.signed,
      ...this.counters, lastError: this.pub.lastError ?? this.sub.lastError,
    };
  }

  async close(): Promise<void> {
    this.handlers.clear();
    this.pub.close();
    this.sub.close();
  }
}

let shared: ClusterBus | null = null;

/** The process-wide bus, from the environment. */
export function clusterBus(): ClusterBus {
  if (shared) return shared;
  const url = process.env.REDIS_URL?.trim();
  const secret = process.env.CLUSTER_SECRET?.trim() || null;
  if (url) {
    if (!secret) console.warn("[cluster] REDIS_URL is set without CLUSTER_SECRET: cluster messages are not signed.");
    shared = new RedisBus(url, process.env.CLUSTER_CHANNEL?.trim() || "m5cet:cluster", secret);
  } else {
    shared = new LocalBus();
  }
  return shared;
}
