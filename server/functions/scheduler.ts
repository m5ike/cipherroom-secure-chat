// The cron scheduler for functions (4.15, stage 4). Every minute it runs the
// models whose schedule fires now. It runs only in the main service (started
// from registerFunctionsRoutes), never in the admin service, so a schedule
// fires once. A scheduled run has no interactive caller and its output goes to
// the run record (console); it is for periodic work (fetching, caching, later
// sending via m5.ai), not for posting into an E2EE room.

import { cronMatches, parseCron, type Cron } from "./cron";
import { functionsStore } from "./store";
import { execute } from "./runner";
import type { Caller } from "./types";

let timer: ReturnType<typeof setInterval> | null = null;
const compiled = new Map<string, { src: string; cron: Cron }>();

function cronFor(expr: string): Cron | null {
  const hit = compiled.get(expr);
  if (hit && hit.src === expr) return hit.cron;
  try { const cron = parseCron(expr); compiled.set(expr, { src: expr, cron }); return cron; }
  catch { return null; }
}

async function tick(now = new Date()): Promise<void> {
  await functionsStore.ready();
  const minute = Math.floor(now.getTime() / 60_000);
  for (const s of functionsStore.schedules()) {
    if (!s.enabled) continue;
    const cron = cronFor(s.cron);
    if (!cron || !cronMatches(cron, now, s.tz)) continue;
    if (s.lastRun && Math.floor(s.lastRun / 60_000) >= minute) continue; // already fired this minute
    const model = functionsStore.model(s.modelId);
    if (!model || !model.enabled) continue;
    functionsStore.saveSchedule({ ...s, lastRun: now.getTime() });
    const caller: Caller = { kind: "schedule", account: "", name: "schedule", groups: [], room: null, client: "schedule", lang: "en", tz: s.tz };
    void execute(model, s.inputs, caller, { executor: "schedule", skipValidation: true })
      .catch((err) => console.warn(`[functions] schedule ${s.id} (${model.name}): ${(err as Error).message}`));
  }
}

/** Starts the once-a-minute check (idempotent). */
export function startScheduler(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), 30_000);
  timer.unref?.();
  void tick();
}

export function stopScheduler(): void { if (timer) clearInterval(timer); timer = null; }

/** For tests: run one pass at a given time. */
export const runSchedulerPass = tick;
