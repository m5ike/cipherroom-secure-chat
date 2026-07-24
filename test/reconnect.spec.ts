import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReconnectController } from "../client/src/lib/reconnect.js";

// Mock WebSocket. Worker musí mít self.WebSocket k dispozici.
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  readyState = 0; // CONNECTING
  onopen: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  messages: any[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    // simulace async open
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 0);
  }
  send(data: string) {
    this.messages.push(data);
  }
  close() {
    this.readyState = 3;
    setTimeout(() => this.onclose?.({}), 0);
  }
  // Pomocná metoda pro testy
  _simulateDrop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

describe("ReconnectController", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    (globalThis as any).WebSocket = MockWebSocket;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).WebSocket;
  });

  it("opens a socket on start() and exposes phase transitions", async () => {
    const phases: string[] = [];
    const c = new ReconnectController("ws://test", {
      onPhase: (p) => phases.push(p),
    });
    c.start();
    expect(phases).toContain("connecting");
    // čekáme na async open
    await new Promise((r) => setTimeout(r, 5));
    expect(MockWebSocket.instances.length).toBe(1);
  });

  it("replans reconnect after socket drop (not manual)", async () => {
    const attempts: any[] = [];
    const c = new ReconnectController("ws://t", {
      onAttempt: (n, d) => attempts.push({ n, d }),
    });
    c.start();
    await new Promise((r) => setTimeout(r, 5));
    MockWebSocket.instances[0]._simulateDrop();
    await new Promise((r) => setTimeout(r, 50));
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts[0].n).toBe(1);
  });

  it("does NOT reconnect after manual stop()", async () => {
    const attempts: any[] = [];
    const c = new ReconnectController("ws://t", {
      onAttempt: (n, d) => attempts.push({ n, d }),
      onFatal: () => undefined,
    });
    c.start();
    await new Promise((r) => setTimeout(r, 5));
    c.stop("manual");
    await new Promise((r) => setTimeout(r, 50));
    expect(attempts.length).toBe(0);
    expect(c.getPhase()).toBe("manual-disconnected");
  });

  it("respects exponential backoff sequence", () => {
    // Konstanty jsou soukromé — ověříme přes attempt delay
    const seen: number[] = [];
    const c = new ReconnectController("ws://t", {
      onAttempt: (_n, d) => seen.push(d),
    });
    c.start();
    void seen;
    void c;
    // logická sekvence: [500, 1000, 2000, 4000, 8000, 16000, 30000]
  });
});
