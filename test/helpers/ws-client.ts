// A small promise-based WebSocket client for the signaling tests: every
// frame is buffered, so `next("peer-away")` also matches a frame that
// arrived before the test asked for it.

import { WebSocket } from "ws";

export type Frame = Record<string, unknown> & { type: string };

export class WsClient {
  private readonly buffer: Frame[] = [];
  private consumed = 0;
  private waiters: Array<() => void> = [];

  private constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      try { this.buffer.push(JSON.parse(data.toString("utf8")) as Frame); } catch { return; }
      this.waiters.splice(0).forEach((w) => w());
    });
  }

  static async connect(base: string): Promise<WsClient> {
    const socket = new WebSocket(`${base.replace(/^http/, "ws")}/ws`);
    // The listener has to exist before the handshake completes: the server
    // greets every connection immediately and ws drops unheard events.
    const client = new WsClient(socket);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return client;
  }

  send(frame: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** The next frame of this type that no earlier `next()` has taken. */
  async next<T extends Frame = Frame>(type: string, timeoutMs = 3000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let i = this.consumed; i < this.buffer.length; i++) {
        if (this.buffer[i].type === type) {
          this.consumed = i + 1;
          return this.buffer[i] as T;
        }
      }
      this.consumed = this.buffer.length;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for "${type}"; got: ${this.buffer.map((f) => f.type).join(", ") || "nothing"}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 50));
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }

  /** True when no frame of this type arrives within the window. */
  async none(type: string, windowMs = 250): Promise<boolean> {
    try { await this.next(type, windowMs); return false; } catch { return true; }
  }

  seen(type: string): Frame[] {
    return this.buffer.filter((f) => f.type === type);
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.close();
    });
  }
}
