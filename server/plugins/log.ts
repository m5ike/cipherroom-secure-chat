// Real-time plugin activity log. A bounded ring buffer plus an EventEmitter so
// the admin console can stream entries live (SSE). Entries never contain the
// message text, audio, API keys or provider responses — only metadata: which
// connector ran, whether it succeeded, and how long it took.

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export type PluginLogLevel = "info" | "warn" | "error";
export type PluginLogKind = "ai" | "tts" | "stt" | "admin";

export type PluginLogEntry = {
  id: string;
  ts: number;
  level: PluginLogLevel;
  kind: PluginLogKind;
  connector?: string;
  message: string;
  ms?: number;
};

class PluginLog {
  private buf: PluginLogEntry[] = [];
  private max = 500;
  readonly emitter = new EventEmitter();

  constructor() {
    // Many SSE clients may subscribe; lift the default listener cap.
    this.emitter.setMaxListeners(64);
  }

  record(entry: Omit<PluginLogEntry, "id" | "ts">): PluginLogEntry {
    const full: PluginLogEntry = { ...entry, id: randomUUID(), ts: Date.now() };
    this.buf.push(full);
    if (this.buf.length > this.max) this.buf.splice(0, this.buf.length - this.max);
    this.emitter.emit("entry", full);
    return full;
  }

  /** Convenience wrapper: time an async operation and log start/finish. */
  async time<T>(kind: PluginLogKind, connector: string, message: string, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const out = await run();
      this.record({ level: "info", kind, connector, message: `${message} ok`, ms: Date.now() - started });
      return out;
    } catch (err) {
      this.record({ level: "error", kind, connector, message: `${message} failed: ${(err as Error).message}`, ms: Date.now() - started });
      throw err;
    }
  }

  recent(n = 200): PluginLogEntry[] {
    return this.buf.slice(-Math.max(1, Math.min(this.max, n)));
  }

  clear(): void {
    this.buf = [];
  }
}

export const pluginLog = new PluginLog();
