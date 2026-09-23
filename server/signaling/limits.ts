// Rate limits for the signaling socket.
//
// Every frame type belongs to a class with its own token bucket per
// socket, so a flood of one kind (signals, receipts, proxy chunks) cannot
// starve the others or the server. Proxy frames also have a byte budget.
// A socket that keeps hitting its limits is closed.
//
// Connections themselves are limited per client address (opened per
// minute and open at once) in the upgrade handshake — see hub.ts.

export type LimitClass =
  | "signaling" | "relay" | "receipt" | "presence" | "storage"
  | "proxy" | "heartbeat" | "command" | "other";

type Bucket = { tokens: number; updatedAt: number };

/** capacity = burst, refill = tokens per second. */
export const LIMITS: Record<LimitClass, { capacity: number; refillPerSec: number }> = {
  signaling: { capacity: 120, refillPerSec: 10 },   // SDP + ICE bursts on connect
  relay:     { capacity: 60,  refillPerSec: 2 },
  receipt:   { capacity: 30,  refillPerSec: 1 },
  presence:  { capacity: 10,  refillPerSec: 0.2 },  // auth / presence toggles
  storage:   { capacity: 120, refillPerSec: 10 },
  proxy:     { capacity: 400, refillPerSec: 60 },
  heartbeat: { capacity: 6,   refillPerSec: 0.5 },
  command:   { capacity: 20,  refillPerSec: 0.5 },
  other:     { capacity: 30,  refillPerSec: 1 },
};

/** Bytes per second a socket may push through the file proxy. */
export const PROXY_BYTES = { capacity: 8 * 1024 * 1024, refillPerSec: 2 * 1024 * 1024 };

/** Violations in a minute after which the socket is closed. */
export const MAX_VIOLATIONS_PER_MINUTE = 20;

export function limitClassOf(type: string): LimitClass {
  switch (type) {
    case "join": case "leave": case "signal": case "auth":
      return "signaling";
    case "relay": case "relay-ack":
      return "relay";
    case "receipt":
      return "receipt";
    case "presence":
      return "presence";
    case "storage":
      return "storage";
    case "ping":
      return "heartbeat";
    case "command-poll": case "command-ack":
      return "command";
    default:
      return type.startsWith("proxy-") ? "proxy" : "other";
  }
}

export class SocketLimiter {
  private buckets = new Map<LimitClass, Bucket>();
  private bytes: Bucket = { tokens: PROXY_BYTES.capacity, updatedAt: Date.now() };
  private violations: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  private take(bucket: Bucket, capacity: number, refillPerSec: number, cost: number): boolean {
    const at = this.now();
    const elapsed = Math.max(0, at - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSec);
    bucket.updatedAt = at;
    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }

  /** May this frame pass? `bytes` counts toward the proxy byte budget. */
  allow(cls: LimitClass, bytes = 0): boolean {
    const spec = LIMITS[cls];
    let bucket = this.buckets.get(cls);
    if (!bucket) {
      bucket = { tokens: spec.capacity, updatedAt: this.now() };
      this.buckets.set(cls, bucket);
    }
    if (!this.take(bucket, spec.capacity, spec.refillPerSec, 1)) return this.violate();
    if (cls === "proxy" && bytes > 0 && !this.take(this.bytes, PROXY_BYTES.capacity, PROXY_BYTES.refillPerSec, bytes)) {
      return this.violate();
    }
    return true;
  }

  private violate(): false {
    const at = this.now();
    this.violations.push(at);
    while (this.violations.length && at - this.violations[0] > 60_000) this.violations.shift();
    return false;
  }

  /** Too many refusals in the last minute: time to close the socket. */
  get abusive(): boolean {
    return this.violations.length >= MAX_VIOLATIONS_PER_MINUTE;
  }

  /** Milliseconds until one token of `cls` is available again. */
  retryAfter(cls: LimitClass): number {
    const spec = LIMITS[cls];
    const bucket = this.buckets.get(cls);
    if (!bucket || bucket.tokens >= 1) return 0;
    return Math.ceil(((1 - bucket.tokens) / spec.refillPerSec) * 1000);
  }
}

/**
 * Connections per client address: how many were opened in the last
 * minute, and how many are open now. Kept small and bounded.
 */
export class ConnectionGate {
  private opened = new Map<string, number[]>();
  private open = new Map<string, number>();
  private total = 0;

  /** Limits from the environment: WS_CONNECTS_PER_MINUTE (per client
   *  address, default 30), WS_CONNECTIONS_PER_CLIENT (open at once, 20),
   *  WS_CONNECTIONS_TOTAL (5000). A load test from one machine needs them
   *  raised on the test server (scripts/load-test.mjs). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): ConnectionGate {
    const num = (name: string, fallback: number) => {
      const n = Number(env[name]);
      return Number.isInteger(n) && n > 0 ? n : fallback;
    };
    return new ConnectionGate({
      perMinute: num("WS_CONNECTS_PER_MINUTE", 30),
      concurrentPerClient: num("WS_CONNECTIONS_PER_CLIENT", 20),
      concurrentTotal: num("WS_CONNECTIONS_TOTAL", 5_000),
    });
  }

  constructor(
    private readonly limits = { perMinute: 30, concurrentPerClient: 20, concurrentTotal: 5_000 },
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns a reason when the connection must be refused. */
  admit(client: string): string | null {
    const at = this.now();
    if (this.total >= this.limits.concurrentTotal) return "server-full";
    if ((this.open.get(client) ?? 0) >= this.limits.concurrentPerClient) return "too-many-connections";
    const recent = (this.opened.get(client) ?? []).filter((t) => at - t < 60_000);
    if (recent.length >= this.limits.perMinute) {
      this.opened.set(client, recent);
      return "rate-limited";
    }
    recent.push(at);
    this.opened.set(client, recent);
    this.open.set(client, (this.open.get(client) ?? 0) + 1);
    this.total += 1;
    // Forget quiet clients so the map cannot grow without bound.
    if (this.opened.size > 10_000) {
      for (const [key, times] of this.opened) if (!times.some((t) => at - t < 60_000) && !this.open.get(key)) this.opened.delete(key);
    }
    return null;
  }

  release(client: string): void {
    const n = (this.open.get(client) ?? 0) - 1;
    if (n <= 0) this.open.delete(client); else this.open.set(client, n);
    this.total = Math.max(0, this.total - 1);
  }

  stats() {
    return { total: this.total, clients: this.open.size };
  }
}
