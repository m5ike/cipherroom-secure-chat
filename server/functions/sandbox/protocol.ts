// What the runner and a sandbox process say to each other (4.15).
//
// One sandbox process runs one function run and exits. It speaks
// newline-delimited JSON: the runner writes to its stdin, it writes to its
// stdout. Everything a sandbox says is untrusted — the code inside it may
// have reached the process's own JavaScript — so the runner checks every
// message (shape, size, limits) and only ever affects the run it belongs to.

import { checkFnOutput, type FnOutput } from "../../../client/src/lib/fn-outputs";

export type Lang = "js" | "py";

/** The limits of one run. The runner enforces them; the sandbox also
 *  checks them itself so a well-behaved function gets a readable error. */
export type RunLimits = {
  /** Wall time of the whole run. */
  wallMs: number;
  /** Longest piece of work between two waits (JS only; Python gets the wall time). */
  stepMs: number;
  /** Memory of the interpreter (QuickJS heap / Python's WebAssembly memory). */
  memoryMb: number;
  /** Bytes of outputs, all together. */
  outputBytes: number;
  /** Bytes of log lines, all together. */
  logBytes: number;
};

export const DEFAULT_LIMITS: RunLimits = { wallMs: 30_000, stepMs: 2_000, memoryMb: 128, outputBytes: 1_048_576, logBytes: 262_144 };
export const MAX_LIMITS: RunLimits = { wallMs: 300_000, stepMs: 30_000, memoryMb: 1024, outputBytes: 8_388_608, logBytes: 2_097_152 };

/** Files of one package: path inside the package → text. */
export type FileMap = Record<string, string>;

/** 5.3: m5.model — the model, the entry point and its processing session. */
export type ModelContext = {
  id: string | null;
  name: string;
  keyword: string;
  /** The entry point type of this call, and its id ("execute", "wh-…"). */
  type: string;
  endpoint: string;
  /** The processing session (chain) and this call's index in it. */
  chain: string;
  call: number;
  /** Every call so far (this one last: result null, status "running"). */
  calls: Array<{ id: number; type: string; parms: unknown; result: unknown; status: string; err_msg: string; http: unknown; run: string; at: number; by: string }>;
  /** The entry point types the model has (a function can tell whether a button will reach it). */
  endpoints: string[];
};

export type RunContext = {
  run: { id: string; model: string | null; executor: string; parent: string | null; startedAt: number; deadline: number; test: boolean; entry: string };
  caller: { kind: "console" | "user" | "guest" | "webhook" | "schedule" | "api"; name: string; groups: string[]; room: string | null; client: string | null; lang: string; tz: string };
  sys: { version: string; instance: string };
  session: { id: string };
  model?: ModelContext;
};

export type RunSpec = {
  id: string;
  lang: Lang;
  /** The package the entry is in. */
  files: FileMap;
  /** Packages it imports (`pkg:name` / `pkg.name`), resolved to one version each. */
  deps: Record<string, { version: string; main: string; files: FileMap }>;
  entry: { file: string; fn: string };
  inputs: Record<string, unknown>;
  context: RunContext;
  limits: RunLimits;
};

/** One output of a run (m5.out.*) — the shared description in client/src/lib/fn-outputs.ts.
 *  Bytes travel as base64 in `data`. */
export type Output = FnOutput;

/** 5.3: a result item that was not a valid output (its index in the returned list, and why). */
export type Rejected = { index: number; reason: string };

export type LogLevel = "debug" | "info" | "warn" | "error" | "stdout" | "stderr";

export type RunError = { type: string; message: string; stack?: string };

/** runner → sandbox */
export type ToSandbox =
  | { t: "run"; spec: RunSpec }
  | { t: "ret"; id: number; ok: true; v: unknown }
  | { t: "ret"; id: number; ok: false; e: { code: string; message: string } }
  | { t: "cancel" };

/** sandbox → runner */
export type FromSandbox =
  | { t: "ready"; engine: string; version: string; ms: number }
  | { t: "log"; level: LogLevel; msg: string; fields?: Record<string, unknown> }
  | { t: "out"; out: Output }
  /** 5.3: an output sent during the run (m5.caller.send, m5.browser.*) that is not a valid one. */
  | { t: "bad-out"; reason: string }
  | { t: "progress"; p: number; text: string }
  | { t: "call"; id: number; fn: string; args: unknown[] }
  /** values: what the entry function returned, as outputs (a list returns several);
   *  result: the returned value as plain data (m5.model.calls[i].result); rejected: items that were not outputs. */
  | { t: "done"; ok: true; values: Output[]; result: unknown; rejected: Rejected[]; ms: number; mem: number }
  | { t: "done"; ok: false; error: RunError; ms: number; mem: number }
  | { t: "fatal"; message: string };

/** The host calls a sandbox may make to the runner (everything else is refused). */
export const HOST_CALLS = [
  "session.get", "session.set", "session.delete", "session.keys",
  "cache.get", "cache.set", "cache.incr", "cache.delete", "cache.lock", "cache.unlock",
  "prompt", "form",
  "http.request", "dns.resolve",
  "webhook.create", "webhook.wait",
  "crypto", "codes", "ai",
  "functions.list",
  // 6.0: m5adm — the administration, as the owner granted the model.
  "adm", "adm.info",
  // 6.0: m5.telephony.
  "telephony",
  // 6.3: m5.nfc — drive the caller's NFC hardware (an "nfc" run interaction).
  "nfc",
  // 5.3: m5.model.session — the processing session's own key–value store.
  "model.session.get", "model.session.set", "model.session.delete", "model.session.keys",
] as const;
export type HostCall = (typeof HOST_CALLS)[number];

/** Longest line either side accepts; a longer one ends the run. */
export const MAX_FRAME = 12 * 1024 * 1024;

const LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error", "stdout", "stderr"]);
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** An output as the sandbox claimed it, or null when it is not one. */
export function checkOutput(v: unknown): Output | null {
  const r = checkFnOutput(v, MAX_LIMITS.outputBytes * 2);
  return r.ok ? r.output : null;
}

/** An output, or why it is not one (for the run's log and its error entry point). */
export function explainOutput(v: unknown): { ok: true; output: Output } | { ok: false; reason: string } {
  return checkFnOutput(v, MAX_LIMITS.outputBytes * 2);
}

/** A message from a sandbox, checked; null for anything malformed. */
export function checkFromSandbox(v: unknown): FromSandbox | null {
  if (!isObj(v) || typeof v.t !== "string") return null;
  switch (v.t) {
    case "ready": return { t: "ready", engine: String(v.engine ?? "").slice(0, 60), version: String(v.version ?? "").slice(0, 60), ms: Number(v.ms) || 0 };
    case "log": {
      const level = typeof v.level === "string" && LEVELS.has(v.level as LogLevel) ? v.level as LogLevel : null;
      const msg = typeof v.msg === "string" ? v.msg : null;
      if (!level || msg === null) return null;
      return { t: "log", level, msg, ...(isObj(v.fields) ? { fields: v.fields } : {}) };
    }
    case "out": { const r = explainOutput(v.out); return r.ok ? { t: "out", out: r.output } : { t: "bad-out", reason: r.reason }; }
    case "progress": {
      const p = Number(v.p);
      return { t: "progress", p: Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 0, text: String(v.text ?? "").slice(0, 300) };
    }
    case "call": {
      if (!Number.isSafeInteger(v.id) || typeof v.fn !== "string" || !Array.isArray(v.args)) return null;
      return { t: "call", id: v.id as number, fn: v.fn, args: v.args };
    }
    case "done": {
      const ms = Number(v.ms) || 0; const mem = Number(v.mem) || 0;
      if (v.ok === true) {
        // Each returned item on its own: a bad one is reported (and the error
        // entry point runs), the good ones are still shown.
        const raw = Array.isArray(v.values) ? v.values.slice(0, 200) : [];
        const values: Output[] = [];
        const rejected: Rejected[] = [];
        raw.forEach((item, index) => { const r = explainOutput(item); if (r.ok) values.push(r.output); else rejected.push({ index, reason: r.reason }); });
        if (Array.isArray(v.values) && v.values.length > 200) rejected.push({ index: 200, reason: `${v.values.length - 200} more items were left out (200 at most)` });
        return { t: "done", ok: true, values, result: v.result ?? null, rejected, ms, mem };
      }
      const e = isObj(v.error) ? v.error : {};
      return { t: "done", ok: false, error: { type: String(e.type ?? "Error").slice(0, 100), message: String(e.message ?? "").slice(0, 4000), ...(typeof e.stack === "string" ? { stack: e.stack.slice(0, 8000) } : {}) }, ms, mem };
    }
    case "fatal": return { t: "fatal", message: String(v.message ?? "").slice(0, 2000) };
  }
  return null;
}
