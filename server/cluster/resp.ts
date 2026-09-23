// A small Redis client: RESP2 over TCP or TLS, enough for a cluster bus —
// commands (AUTH, SELECT, PUBLISH, PING, CLIENT SETNAME) and one subscriber
// connection. No dependency; reconnects with backoff and re-subscribes.
//
//   redis://[user:password@]host[:port][/db]      rediss:// for TLS

import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { EventEmitter } from "node:events";

export type RespValue = string | number | Buffer | null | RespValue[] | RespError;
export class RespError extends Error {}

export type RedisTarget = { host: string; port: number; tls: boolean; username?: string; password?: string; db: number };

export function parseRedisUrl(url: string): RedisTarget {
  const u = new URL(url);
  if (u.protocol !== "redis:" && u.protocol !== "rediss:") throw new Error("REDIS_URL must start with redis:// or rediss://");
  return {
    host: u.hostname || "127.0.0.1",
    port: Number(u.port) || 6379,
    tls: u.protocol === "rediss:",
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    db: Number(u.pathname.replace(/^\//, "")) || 0,
  };
}

/** Encodes one command as a RESP array of bulk strings. */
export function encodeCommand(args: Array<string | Buffer | number>): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
    parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from("\r\n"));
  }
  return Buffer.concat(parts);
}

/** A length or integer header; anything else is a broken stream. */
function integer(head: string): number {
  if (!/^-?\d{1,19}$/.test(head)) throw new Error(`RESP protocol error: bad number ${JSON.stringify(head.slice(0, 20))}`);
  return Number(head);
}

/** Parses one value at `offset`; null when the buffer does not hold all of
 *  it yet. Throws on a stream that is not RESP (the caller drops the link). */
export function parseReply(buf: Buffer, offset = 0): { value: RespValue; next: number } | null {
  if (offset >= buf.length) return null;
  const line = buf.indexOf("\r\n", offset);
  if (line < 0) return null;
  const type = String.fromCharCode(buf[offset]);
  const head = buf.toString("utf8", offset + 1, line);
  const after = line + 2;
  switch (type) {
    case "+": return { value: head, next: after };
    case "-": return { value: new RespError(head), next: after };
    case ":": return { value: integer(head), next: after };
    case "$": {
      const len = integer(head);
      if (len < 0) return { value: null, next: after };
      if (len > 512 * 1024 * 1024) throw new Error("RESP protocol error: bulk string too long");
      if (buf.length < after + len + 2) return null;
      if (buf[after + len] !== 0x0d || buf[after + len + 1] !== 0x0a) throw new Error("RESP protocol error: bulk string not terminated");
      return { value: buf.subarray(after, after + len), next: after + len + 2 };
    }
    case "*": {
      const count = integer(head);
      if (count < 0) return { value: null, next: after };
      const items: RespValue[] = [];
      let at = after;
      for (let i = 0; i < count; i++) {
        const item = parseReply(buf, at);
        if (!item) return null;
        items.push(item.value);
        at = item.next;
      }
      return { value: items, next: at };
    }
    default:
      throw new Error(`RESP protocol error: unexpected type ${JSON.stringify(type)}`);
  }
}

type Pending = { resolve: (v: RespValue) => void; reject: (e: Error) => void };

/**
 * One connection. `subscribe()` turns it into a subscriber (no other
 * commands then). Emits "ready" after every (re)connect, "down" when the
 * link drops, "message" (channel, payload Buffer) in subscriber mode.
 */
export class RedisConnection extends EventEmitter {
  private socket: Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private pending: Pending[] = [];
  private channels = new Set<string>();
  private closed = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  ready = false;
  lastError: string | null = null;

  constructor(private readonly target: RedisTarget, private readonly name: string) {
    super();
    this.open();
  }

  private open(): void {
    if (this.closed) return;
    const { host, port } = this.target;
    const socket = this.target.tls ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.once(this.target.tls ? "secureConnect" : "connect", () => { void this.handshake(); });
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (err) => { this.lastError = err.message; });
    socket.on("close", () => this.onClose());
  }

  private async handshake(): Promise<void> {
    try {
      if (this.target.password) {
        await this.raw(this.target.username ? ["AUTH", this.target.username, this.target.password] : ["AUTH", this.target.password]);
      }
      if (this.target.db) await this.raw(["SELECT", this.target.db]);
      await this.raw(["CLIENT", "SETNAME", this.name]).catch(() => undefined);
      if (this.channels.size) await this.raw(["SUBSCRIBE", ...this.channels], false);
      this.attempt = 0;
      this.ready = true;
      this.lastError = null;
      this.emit("ready");
    } catch (err) {
      this.lastError = (err as Error).message;
      this.socket?.destroy();
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let at = 0;
    for (;;) {
      let parsed: ReturnType<typeof parseReply>;
      try { parsed = parseReply(this.buffer, at); } catch (err) { this.lastError = (err as Error).message; this.socket?.destroy(); return; }
      if (!parsed) break;
      at = parsed.next;
      this.dispatch(parsed.value);
    }
    this.buffer = at >= this.buffer.length ? Buffer.alloc(0) : this.buffer.subarray(at);
  }

  private dispatch(value: RespValue): void {
    // Subscriber pushes: ["message", channel, payload]; ["subscribe", channel, n] answers SUBSCRIBE.
    if (Array.isArray(value) && Buffer.isBuffer(value[0])) {
      const kind = value[0].toString();
      if (kind === "message" && value.length === 3) {
        this.emit("message", String(value[1]), value[2] as Buffer);
        return;
      }
      if (kind === "subscribe" || kind === "unsubscribe") {
        if (kind === "subscribe" && this.pending.length && this.subscribeAcks > 0) {
          this.subscribeAcks -= 1;
          if (this.subscribeAcks === 0) this.pending.shift()?.resolve(value);
        }
        return;
      }
    }
    const job = this.pending.shift();
    if (!job) return;
    if (value instanceof RespError) job.reject(value);
    else job.resolve(value);
  }

  private subscribeAcks = 0;

  private raw(args: Array<string | Buffer | number>, oneReply = true): Promise<RespValue> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) return reject(new Error("redis: not connected"));
      if (!oneReply) this.subscribeAcks = args.length - 1;
      this.pending.push({ resolve, reject });
      this.socket.write(encodeCommand(args));
    });
  }

  /** Runs a command; rejects while the link is down. */
  command(...args: Array<string | Buffer | number>): Promise<RespValue> {
    if (!this.ready) return Promise.reject(new Error(`redis: not connected${this.lastError ? ` (${this.lastError})` : ""}`));
    return this.raw(args);
  }

  async subscribe(channel: string): Promise<void> {
    this.channels.add(channel);
    if (this.ready) await this.raw(["SUBSCRIBE", channel], false);
  }

  private onClose(): void {
    const wasReady = this.ready;
    this.ready = false;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.subscribeAcks = 0;
    for (const job of this.pending.splice(0)) job.reject(new Error("redis: connection closed"));
    if (wasReady) this.emit("down");
    if (this.closed) return;
    const delay = Math.min(10_000, 250 * 2 ** this.attempt++);
    this.timer = setTimeout(() => this.open(), delay);
    this.timer.unref?.();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.destroy();
  }
}
