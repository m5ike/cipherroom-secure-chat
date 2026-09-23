// Alert rules: the console is not always open, so the server watches a few
// numbers itself and says so — in the audit journal, in the console, and
// (with ALERT_WEBHOOK_URL) as a JSON POST to a chat or paging hook.
//
//   security-warnings   security events of level warn+ in the last minute
//   http-errors         failed requests / frames in the last minute
//   event-loop          event-loop delay p99 (ms)
//   heap                heap used, % of the V8 limit
//   dead-letters        dead items in the offline queue
//   storage             a failed backup, a failed integrity check, or a
//                       broken audit chain (reported by those, not measured)
//
// A rule fires when its value crosses the threshold and resolves when it
// falls back; each change is written once, not on every evaluation.
// Thresholds come from ALERT_<RULE>=n and can be changed in the console
// (kept in alert-rules.json next to the data).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hostname } from "node:os";
import { audit, type AuditEntry } from "./audit";

export type RuleId = "security-warnings" | "http-errors" | "event-loop" | "heap" | "dead-letters" | "storage";
export type Rule = { id: RuleId; label: string; threshold: number; unit: string; enabled: boolean };
export type AlertState = { rule: RuleId; firing: boolean; value: number; threshold: number; since: number; lastChange: number; message: string };

export type AlertInputs = {
  securityWarningsPerMin: number;
  errorsPerMin: number;
  loopP99: number;
  heapRatio: number;
  deadLetters: number;
};

const DEFAULTS: Record<RuleId, Omit<Rule, "id">> = {
  "security-warnings": { label: "Security warnings per minute", threshold: 20, unit: "/min", enabled: true },
  "http-errors": { label: "Errors per minute", threshold: 120, unit: "/min", enabled: true },
  "event-loop": { label: "Event-loop delay p99", threshold: 200, unit: "ms", enabled: true },
  heap: { label: "Heap used of the limit", threshold: 85, unit: "%", enabled: true },
  "dead-letters": { label: "Dead letters in the queue", threshold: 1, unit: "", enabled: true },
  storage: { label: "Backup / integrity / audit-chain failure", threshold: 1, unit: "", enabled: true },
};

const envKey = (id: RuleId) => `ALERT_${id.toUpperCase().replace(/-/g, "_")}`;

export class AlertEngine {
  private rules = new Map<RuleId, Rule>();
  private states = new Map<RuleId, AlertState>();
  private securityWarnings: number[] = [];
  private storageFailure: { at: number; message: string } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly file: string;
  history: Array<{ at: number; rule: RuleId; firing: boolean; value: number; message: string }> = [];

  constructor(dataDir = process.env.DATA_DIR?.trim() ? resolve(process.env.DATA_DIR.trim()) : resolve(process.cwd(), ".m5cet"), private readonly now: () => number = Date.now) {
    this.file = join(dataDir, "alert-rules.json");
    let saved: Partial<Record<RuleId, Partial<Rule>>> = {};
    try { saved = JSON.parse(readFileSync(this.file, "utf8")) as typeof saved; } catch { /* defaults */ }
    for (const [id, def] of Object.entries(DEFAULTS) as Array<[RuleId, Omit<Rule, "id">]>) {
      const fromEnv = Number(process.env[envKey(id)]);
      const s = saved[id] ?? {};
      this.rules.set(id, {
        id, label: def.label, unit: def.unit,
        threshold: typeof s.threshold === "number" ? s.threshold : Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : def.threshold,
        enabled: typeof s.enabled === "boolean" ? s.enabled : def.enabled,
      });
    }
  }

  /** Feed from the audit journal: counts security warnings, catches storage failures. */
  observe(entry: AuditEntry): void {
    if (entry.category === "security" && (entry.level === "warn" || entry.level === "error")) this.securityWarnings.push(entry.at);
    if ((entry.event === "backup.failed" || (entry.event === "integrity.check" && entry.level === "error") || (entry.event === "admin.audit.verify" && entry.level === "error"))) {
      this.storageFailure = { at: entry.at, message: entry.event };
    }
  }

  start(inputs: () => AlertInputs, intervalMs = 30_000): void {
    if (this.timer) return;
    audit.subscribe((e) => { this.observe(e); return true; });
    this.timer = setInterval(() => void this.evaluate(inputs()), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  listRules(): Rule[] { return [...this.rules.values()]; }
  active(): AlertState[] { return [...this.states.values()].filter((s) => s.firing); }
  all(): AlertState[] { return [...this.states.values()]; }

  setRule(id: RuleId, patch: { threshold?: number; enabled?: boolean }): Rule | null {
    const rule = this.rules.get(id);
    if (!rule) return null;
    if (typeof patch.threshold === "number" && Number.isFinite(patch.threshold) && patch.threshold >= 0) rule.threshold = patch.threshold;
    if (typeof patch.enabled === "boolean") rule.enabled = patch.enabled;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(this.file, JSON.stringify(Object.fromEntries([...this.rules].map(([k, r]) => [k, { threshold: r.threshold, enabled: r.enabled }]))), { mode: 0o600 });
    } catch { /* kept in memory */ }
    return rule;
  }

  /** One round of checks. Returns the rules whose state changed. */
  async evaluate(inputs: AlertInputs): Promise<AlertState[]> {
    const at = this.now();
    this.securityWarnings = this.securityWarnings.filter((t) => at - t < 60_000);
    const values: Record<RuleId, number> = {
      "security-warnings": this.securityWarnings.length,
      "http-errors": inputs.errorsPerMin,
      "event-loop": inputs.loopP99,
      heap: Math.round(inputs.heapRatio * 100),
      "dead-letters": inputs.deadLetters,
      storage: this.storageFailure && at - this.storageFailure.at < 24 * 60 * 60 * 1000 ? 1 : 0,
    };
    const changed: AlertState[] = [];
    for (const rule of this.rules.values()) {
      const value = values[rule.id];
      const firing = rule.enabled && value >= rule.threshold;
      const previous = this.states.get(rule.id);
      if (previous && previous.firing === firing) { previous.value = value; continue; }
      if (!previous && !firing) continue;
      const message = firing
        ? `${rule.label}: ${value}${rule.unit} (threshold ${rule.threshold}${rule.unit})${rule.id === "storage" && this.storageFailure ? ` — ${this.storageFailure.message}` : ""}`
        : `${rule.label} back to normal: ${value}${rule.unit}`;
      const state: AlertState = { rule: rule.id, firing, value, threshold: rule.threshold, since: firing ? at : previous?.since ?? at, lastChange: at, message };
      this.states.set(rule.id, state);
      this.history.unshift({ at, rule: rule.id, firing, value, message });
      if (this.history.length > 200) this.history.length = 200;
      audit.add({ category: "system", level: firing ? "warn" : "notice", event: firing ? "alert.fired" : "alert.resolved", target: rule.id, status: `${value}${rule.unit}`, detail: { threshold: rule.threshold } });
      changed.push(state);
      await this.notify(state);
    }
    return changed;
  }

  private async notify(state: AlertState): Promise<void> {
    const url = process.env.ALERT_WEBHOOK_URL?.trim();
    if (!url) return;
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // "text" is what Slack, Mattermost, Rocket.Chat and Discord-compatible hooks show.
        body: JSON.stringify({ text: `[M5cet ${hostname()}] ${state.firing ? "🔴" : "🟢"} ${state.message}`, alert: state, host: hostname(), at: state.lastChange }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      console.warn(`[alerts] webhook failed: ${(err as Error).message}`);
    }
  }
}

export const alerts = new AlertEngine();
