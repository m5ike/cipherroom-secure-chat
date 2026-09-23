// @vitest-environment node
//
// Prometheus exposition (server/monitor/metrics.ts) and the alert engine
// (server/monitor/alerts.ts): values cross thresholds, fire once, resolve
// once, and a webhook hears about it.

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gauge, renderMetrics } from "../server/monitor/metrics";
import { AlertEngine } from "../server/monitor/alerts";

const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); delete process.env.ALERT_WEBHOOK_URL; dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "m5cet-alerts-")); dirs.push(d); return d; };

describe("metrics", () => {
  it("renders the text format with escaped labels", () => {
    const text = renderMetrics([
      gauge("m5cet_rooms", "Open rooms.", 3),
      { name: "m5cet_frames_total", help: "Frames.", type: "counter", samples: [{ labels: { class: 'we"ird\\\\' }, value: 7 }] },
    ]);
    expect(text).toContain("# TYPE m5cet_rooms gauge\nm5cet_rooms 3\n");
    expect(text).toContain('m5cet_frames_total{class="we\\"ird\\\\\\\\"} 7');
  });
});

describe("alerts", () => {
  const quiet = { securityWarningsPerMin: 0, errorsPerMin: 0, loopP99: 1, heapRatio: 0.1, deadLetters: 0 };

  it("fires once when a threshold is crossed and resolves once", async () => {
    let now = 1_000_000;
    const engine = new AlertEngine(tmp(), () => now);
    expect(await engine.evaluate(quiet)).toEqual([]);
    const fired = await engine.evaluate({ ...quiet, loopP99: 450 });
    expect(fired).toMatchObject([{ rule: "event-loop", firing: true, value: 450 }]);
    now += 30_000;
    expect(await engine.evaluate({ ...quiet, loopP99: 500 })).toEqual([]); // still firing: no repeat
    expect(engine.active().map((a) => a.rule)).toEqual(["event-loop"]);
    now += 30_000;
    expect(await engine.evaluate(quiet)).toMatchObject([{ rule: "event-loop", firing: false }]);
    expect(engine.history.map((h) => h.firing)).toEqual([false, true]);
  });

  it("counts security warnings from the journal and posts to the webhook", async () => {
    const posted: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => { posted.push(JSON.parse(String(init.body))); return new Response("ok"); }));
    process.env.ALERT_WEBHOOK_URL = "https://hooks.example/alert";
    const now = 5_000_000;
    const engine = new AlertEngine(tmp(), () => now);
    engine.setRule("security-warnings", { threshold: 3 });
    for (let i = 0; i < 3; i++) engine.observe({ id: i, at: now - 1_000, category: "security", level: "warn", event: "ws.kicked" });
    const fired = await engine.evaluate(quiet);
    expect(fired).toMatchObject([{ rule: "security-warnings", firing: true, value: 3 }]);
    expect(posted).toHaveLength(1);
    expect((posted[0] as { text: string }).text).toContain("Security warnings");
  });

  it("keeps rule changes across a restart", () => {
    const dir = tmp();
    new AlertEngine(dir).setRule("heap", { threshold: 70, enabled: false });
    expect(new AlertEngine(dir).listRules().find((r) => r.id === "heap")).toMatchObject({ threshold: 70, enabled: false });
  });
});
