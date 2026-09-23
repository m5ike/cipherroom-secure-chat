// How the process itself is doing: memory, heap, event-loop lag, CPU,
// load, open resources — sampled every few seconds so the console can
// draw the last half hour, and read on demand for the current picture.

import { cpus, freemem, loadavg, totalmem } from "node:os";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";

export type SystemSample = {
  t: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  /** Event-loop delay, p99 over the sample window (ms). */
  loopP99: number;
  loopMean: number;
  /** Process CPU over the sample window, % of one core. */
  cpu: number;
};

const SAMPLE_MS = 5_000;
const KEEP = 360; // 30 minutes

export class SystemMonitor {
  private samples: SystemSample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private histogram: IntervalHistogram | null = null;
  private lastCpu = process.cpuUsage();
  private lastCpuAt = Date.now();
  private readonly startedAt = Date.now();

  start(): void {
    if (this.timer) return;
    try {
      this.histogram = monitorEventLoopDelay({ resolution: 20 });
      this.histogram.enable();
    } catch {
      this.histogram = null;
    }
    this.sample();
    this.timer = setInterval(() => this.sample(), SAMPLE_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.histogram?.disable();
  }

  private sample(): SystemSample {
    const mem = process.memoryUsage();
    const now = Date.now();
    const cpu = process.cpuUsage(this.lastCpu);
    const elapsedMs = Math.max(1, now - this.lastCpuAt);
    this.lastCpu = process.cpuUsage();
    this.lastCpuAt = now;
    const h = this.histogram;
    const sample: SystemSample = {
      t: now,
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      // An empty histogram reports NaN (which JSON turns into null).
      loopP99: h && Number.isFinite(h.percentile(99)) ? Math.round((h.percentile(99) / 1e6) * 100) / 100 : 0,
      loopMean: h && Number.isFinite(h.mean) ? Math.round((h.mean / 1e6) * 100) / 100 : 0,
      cpu: Math.round(((cpu.user + cpu.system) / 1000 / elapsedMs) * 1000) / 10,
    };
    h?.reset();
    this.samples.push(sample);
    if (this.samples.length > KEEP) this.samples.splice(0, this.samples.length - KEEP);
    return sample;
  }

  history(): SystemSample[] {
    return [...this.samples];
  }

  snapshot() {
    const mem = process.memoryUsage();
    const heap = getHeapStatistics();
    const resources = typeof process.getActiveResourcesInfo === "function" ? process.getActiveResourcesInfo() : [];
    const byKind: Record<string, number> = {};
    for (const kind of resources) byKind[kind] = (byKind[kind] ?? 0) + 1;
    return {
      pid: process.pid,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      startedAt: this.startedAt,
      uptimeSec: Math.round(process.uptime()),
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        heapLimit: heap.heap_size_limit,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers,
        mallocedMemory: heap.malloced_memory,
        detachedContexts: heap.number_of_detached_contexts,
      },
      host: {
        cpus: cpus().length,
        load: loadavg().map((n) => Math.round(n * 100) / 100),
        freeMem: freemem(),
        totalMem: totalmem(),
      },
      resources: byKind,
      latest: this.samples.at(-1) ?? null,
    };
  }
}

export const system = new SystemMonitor();
