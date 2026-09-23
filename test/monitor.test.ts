// @vitest-environment node
//
// The operator's view of the wire and of the process (server/monitor/*):
// traffic is classified and counted without content, the audit journal
// keeps communication records only when asked to, and the system monitor
// reports what the process is using.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { TrafficMonitor, classifyFrame, classifyRoute, clientClass, hashRoom, truncateIp } from "../server/monitor/traffic";
import { AuditJournal } from "../server/monitor/audit";
import { SystemMonitor } from "../server/monitor/system";

describe("classifying traffic", () => {
  it("names every frame the protocol has", () => {
    expect(classifyFrame("join")).toBe("signaling");
    expect(classifyFrame("signal")).toBe("signaling");
    expect(classifyFrame("presence")).toBe("presence");
    expect(classifyFrame("peer-away")).toBe("presence");
    expect(classifyFrame("relay")).toBe("relay");
    expect(classifyFrame("relay-deliver")).toBe("relay");
    expect(classifyFrame("storage")).toBe("storage");
    expect(classifyFrame("ping")).toBe("heartbeat");
    expect(classifyFrame("proxy-chunk")).toBe("file-proxy");
    expect(classifyFrame("command-poll")).toBe("admin");
    expect(classifyFrame("something-new")).toBe("other");
  });

  it("names routes", () => {
    expect(classifyRoute("POST", "/api/account/signin/verify")).toBe("account");
    expect(classifyRoute("PUT", "/api/storage/kv")).toBe("storage");
    expect(classifyRoute("GET", "/api/admin/overview")).toBe("admin");
    expect(classifyRoute("POST", "/api/push/subscribe")).toBe("push");
    expect(classifyRoute("GET", "/api/health")).toBe("api");
    expect(classifyRoute("GET", "/assets/index.js")).toBe("static");
  });

  it("identifies a client without keeping more than it needs", () => {
    expect(truncateIp("203.0.113.77")).toBe("203.0.113.0/24");
    expect(truncateIp("::ffff:198.51.100.9")).toBe("198.51.100.0/24");
    expect(truncateIp("2001:db8:abcd:12::1")).toBe("2001:db8:abcd::/48");
    expect(clientClass("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605 Version/17 Safari/605")).toBe("Safari/macOS");
    expect(clientClass("Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile")).toBe("Chrome/Android");
    expect(clientClass("curl/8.4")).toBe("script/other");
    expect(hashRoom("alpha")).toMatch(/^[0-9a-f]{16}$/);
    expect(hashRoom("alpha")).not.toContain("alpha");
  });
});

describe("the traffic monitor", () => {
  let clock = 1_700_000_000_000;
  let monitor: TrafficMonitor;
  beforeEach(() => {
    clock = 1_700_000_000_000;
    monitor = new TrafficMonitor(() => clock);
  });

  it("counts frames and bytes by class and direction", () => {
    monitor.record({ channel: "ws", direction: "in", cls: "relay", type: "relay", bytes: 500 });
    monitor.record({ channel: "ws", direction: "out", cls: "relay", type: "relay-status", bytes: 120 });
    monitor.record({ channel: "ws", direction: "in", cls: "heartbeat", type: "ping", bytes: 20 });
    monitor.record({ channel: "http", direction: "in", cls: "account", type: "POST /api/account/signin/verify", bytes: 900, status: 401 });

    const summary = monitor.summary();
    expect(summary.classes.relay).toEqual({ frames: 2, bytesIn: 500, bytesOut: 120, errors: 0 });
    expect(summary.classes.account.errors).toBe(1);
    expect(summary.totals).toMatchObject({ framesIn: 2, framesOut: 1, http: 1, bytesIn: 1420, bytesOut: 120, errors: 1 });
  });

  it("answers filtered queries, newest first", () => {
    for (let i = 0; i < 10; i++) {
      monitor.record({ channel: "ws", direction: "in", cls: i % 2 ? "relay" : "signaling", type: i % 2 ? "relay" : "signal", bytes: i, peerId: `p${i % 3}` });
    }
    const relays = monitor.query({ cls: "relay" });
    expect(relays).toHaveLength(5);
    expect(relays[0].id).toBeGreaterThan(relays[1].id);
    expect(monitor.query({ peerId: "p0" }).every((r) => r.peerId === "p0")).toBe(true);
    expect(monitor.query({ limit: 3 })).toHaveLength(3);
  });

  it("keeps a per-second series with the gaps filled", () => {
    monitor.record({ channel: "ws", direction: "in", cls: "signaling", type: "join", bytes: 10 });
    clock += 2_000;
    monitor.record({ channel: "ws", direction: "out", cls: "signaling", type: "joined", bytes: 30 });
    const rates = monitor.rates(3);
    expect(rates).toHaveLength(3);
    expect(rates.map((r) => r.framesIn + r.framesOut)).toEqual([1, 0, 1]);
  });

  it("tracks live connections and their load", () => {
    const conn = monitor.openConnection({ ip: "203.0.113.5", userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/130" });
    monitor.updateConnection(conn.id, { room: "alpha", peerId: "peer-1", name: "Alice" });
    monitor.record({ channel: "ws", direction: "in", cls: "relay", type: "relay", bytes: 300, conn: conn.id });

    const [live] = monitor.liveConnections();
    expect(live).toMatchObject({ ip: "203.0.113.0/24", client: "Chrome/Windows", peerId: "peer-1", framesIn: 1, bytesIn: 300 });
    expect(live.roomHash).toBe(hashRoom("alpha"));
    monitor.closeConnection(conn.id);
    expect(monitor.liveConnections()).toHaveLength(0);
  });

  it("streams to subscribers and counts what a slow one missed", () => {
    const seen: number[] = [];
    const off = monitor.subscribe((r) => { seen.push(r.id); return seen.length < 2; });
    for (let i = 0; i < 3; i++) monitor.record({ channel: "ws", direction: "in", cls: "other", type: "x", bytes: 1 });
    expect(seen).toEqual([1, 2, 3]);
    off();
    monitor.record({ channel: "ws", direction: "in", cls: "other", type: "x", bytes: 1 });
    expect(seen).toHaveLength(3);
  });

  it("stays bounded", () => {
    for (let i = 0; i < 6_000; i++) monitor.record({ channel: "ws", direction: "in", cls: "heartbeat", type: "ping", bytes: 1 });
    expect(monitor.summary().buffered).toBe(5_000);
    expect(monitor.query({ limit: 5_000 })).toHaveLength(2_000); // queries are capped too
  });
});

describe("the audit journal", () => {
  let journal: AuditJournal;
  beforeEach(() => {
    delete process.env.AUDIT_COMMUNICATION;
    journal = new AuditJournal();
  });

  it("records security, account and admin events always", () => {
    journal.add({ category: "security", level: "warn", event: "auth.token.invalid", ip: "203.0.113.0/24" });
    journal.add({ category: "account", event: "account.sign-in", accountId: "acc-1" });
    journal.add({ category: "admin", event: "retention.run", actor: "admin" });
    expect(journal.recent()).toHaveLength(3);
    expect(journal.stats().byCategory).toMatchObject({ security: 1, account: 1, admin: 1 });
  });

  it("keeps who-talked-to-whom only when the operator asked for it", () => {
    expect(journal.add({ category: "communication", event: "relay.stored", actor: "peer-a", target: "acc-b" })).toBeNull();
    expect(journal.recent()).toHaveLength(0);

    journal.setCommunication(true, "admin");
    const entry = journal.add({ category: "communication", event: "relay.stored", actor: "peer-a", target: "acc-b", bytes: 512, status: "stored" });
    expect(entry).toMatchObject({ category: "communication", target: "acc-b" });
    // Switching it on is itself audited.
    expect(journal.recent({ category: "admin" })[0].event).toBe("audit.communication.on");
  });

  it("filters by level, actor, account and free text", () => {
    journal.add({ category: "security", level: "error", event: "frame.too-large", actor: "peer-x", detail: { bytes: 900_000 } });
    journal.add({ category: "security", level: "info", event: "frame.ok", actor: "peer-y" });
    journal.add({ category: "account", level: "notice", event: "account.delete", accountId: "acc-9" });

    expect(journal.recent({ minLevel: "notice" }).map((e) => e.event)).toEqual(["account.delete", "frame.too-large"]);
    expect(journal.recent({ actor: "peer-y" })).toHaveLength(1);
    expect(journal.recent({ accountId: "acc-9" })).toHaveLength(1);
    expect(journal.recent({ search: "900000" })).toHaveLength(1);
  });

  it("persists through its sink and never lets the sink break a request", () => {
    const sink = vi.fn();
    journal.setSink(sink);
    journal.add({ category: "system", event: "start" });
    expect(sink).toHaveBeenCalledOnce();

    journal.setSink(() => { throw new Error("disk full"); });
    expect(() => journal.add({ category: "system", event: "still fine" })).not.toThrow();
  });
});

describe("the system monitor", () => {
  it("reports memory, heap, host and resources", () => {
    const monitor = new SystemMonitor();
    monitor.start();
    const snap = monitor.snapshot();
    expect(snap.memory.rss).toBeGreaterThan(0);
    expect(snap.memory.heapLimit).toBeGreaterThan(snap.memory.heapUsed);
    expect(snap.host.cpus).toBeGreaterThan(0);
    expect(monitor.history().length).toBeGreaterThanOrEqual(1);
    expect(snap.latest).toMatchObject({ rss: expect.any(Number), loopP99: expect.any(Number) });
    monitor.stop();
  });
});
