// The runner (4.15): turns a model and its inputs into a run and carries it
// out. It resolves the entry's package version and its dependencies from the
// store, builds the spec, hands it to a sandbox process (pool.ts — one child
// per run, so a loop or a crash never touches the main service), streams logs
// and outputs into the store as they arrive, answers the run's m5.* host
// calls (session and cache, backed by the store), and records the finished
// run.
//
// Runs are executed in-process here: the weight of a model is in its sandbox
// child, not in this event loop, which only shuttles small JSON messages. A
// separate `m5cet-runner` daemon can later own the queue for scale; the
// execute() path is written so it can move there unchanged.

import { EventEmitter } from "node:events";
import { SandboxPool, type RunHandlers } from "./sandbox/pool";
import { DEFAULT_LIMITS, MAX_LIMITS, type Output, type RunLimits, type RunSpec } from "./sandbox/protocol";
import { buildInfo } from "../build-info";
import { functionsStore, newId } from "./store";
import { validateInputs } from "./inputs";
import { formatEntry, parseEntry, type Caller, type Lang, type Model, type Run, type RunLog } from "./types";

export class RunRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RunRefused";
  }
}

let pool: SandboxPool | null = null;
function thePool(): SandboxPool {
  pool ??= new SandboxPool({ warmPerLang: Number(process.env.FUNCTIONS_WARM ?? 1) });
  return pool;
}
export function closeRunner(): void { pool?.close(); pool = null; }

/** Live run events for the console (SSE): a log line, an output, progress, a state change. */
export const runEvents = new EventEmitter();
runEvents.setMaxListeners(0);

/* -------------------------------------------------------------- limits */

function limitsFor(model: Model): RunLimits {
  const l = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(l) as (keyof RunLimits)[]) {
    const v = model.limits[k];
    // A model may lower a limit; only the owner's ceiling (MAX_LIMITS) caps it.
    if (typeof v === "number" && v > 0) l[k] = Math.min(v, MAX_LIMITS[k]);
  }
  return l;
}

/* -------------------------------------------------------- build a spec */

/** Resolves a model's entry and its package dependencies into a run spec. */
export function buildSpec(model: Model, inputs: Record<string, unknown>, caller: Caller, executor: string, opts: { test: boolean; runId: string; sessionId: string; parent: string | null }): RunSpec {
  const entry = parseEntry(model.entry);
  if (!entry) throw new RunRefused("bad-entry", `The model's entry point "${model.entry}" is malformed.`);
  const version = functionsStore.versionByName(entry.pkg, entry.version);
  if (!version) throw new RunRefused("no-package", `The package ${entry.pkg}@${entry.version} is not published.`);
  if (!Object.prototype.hasOwnProperty.call(version.files, entry.file)) throw new RunRefused("no-file", `${entry.pkg}@${entry.version} has no file ${entry.file}.`);

  const deps: RunSpec["deps"] = {};
  const seen = new Set<string>();
  const resolveDeps = (name: string, ver: string, chain: string[]): void => {
    const key = `${name}@${ver}`;
    if (seen.has(key)) return;
    if (chain.includes(name)) throw new RunRefused("dep-cycle", `The packages import each other in a circle (${[...chain, name].join(" → ")}).`);
    seen.add(key);
    const dv = functionsStore.versionByName(name, ver);
    if (!dv) throw new RunRefused("no-package", `The dependency ${name}@${ver} is not published.`);
    deps[name] = { version: ver, main: dv.manifest.main, files: dv.files };
    for (const [dn, dver] of Object.entries(dv.manifest.dependencies ?? {})) resolveDeps(dn, dver, [...chain, name]);
  };
  for (const [name, ver] of Object.entries(version.manifest.dependencies ?? {})) resolveDeps(name, ver, [entry.pkg]);

  const limits = limitsFor(model);
  const now = Date.now();
  return {
    id: opts.runId,
    lang: version.manifest.language,
    files: version.files,
    deps,
    entry: { file: entry.file, fn: entry.fn },
    inputs,
    context: {
      run: { id: opts.runId, model: model.id, executor, parent: opts.parent, startedAt: now, deadline: now + limits.wallMs, test: opts.test, entry: model.entry },
      caller: { kind: caller.kind, name: caller.name, groups: caller.groups, room: caller.room, client: caller.client, lang: caller.lang, tz: caller.tz },
      sys: { version: buildInfo().version, instance: process.env.INSTANCE_ID?.trim() || "m5cet" },
      session: { id: opts.sessionId },
    },
    limits,
  };
}

/* ------------------------------------------------------------ host calls */

/** The session and cache calls a run may make, scoped to it. */
function hostHandler(model: Model, sessionId: string): RunHandlers["host"] {
  return async (fn, args) => {
    const scopeName = (raw: unknown): string => {
      const s = String(raw ?? "model");
      const scope = s === "run" || s === "session" || s === "model" || s === "global" ? s : "model";
      return scope === "global" ? "global" : scope === "model" ? `model:${model.id}` : scope === "session" ? `session:${sessionId}` : `session:${sessionId}`;
    };
    const ttl = (v: unknown): number | null => {
      if (v === null || v === undefined) return null;
      if (typeof v === "number") return v > 0 ? v : null;
      const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(String(v).trim());
      if (!m) return null;
      const n = Number(m[1]); const unit = m[2] || "ms";
      return n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1);
    };
    switch (fn) {
      case "session.get": return functionsStore.sessionGet(sessionId, String(args[0]));
      case "session.set": functionsStore.sessionSet(sessionId, String(args[0]), args[1], ttl(args[2])); return true;
      case "session.delete": functionsStore.sessionDelete(sessionId, String(args[0])); return true;
      case "session.keys": return functionsStore.sessionKeys(sessionId);
      case "cache.get": return functionsStore.cacheGet(scopeName(args[0]), String(args[1]));
      case "cache.set": functionsStore.cacheSet(scopeName(args[0]), String(args[1]), args[2], ttl(args[3])); return true;
      case "cache.incr": return functionsStore.cacheIncr(scopeName(args[0]), String(args[1]), Number(args[2]) || 1, ttl(args[3]));
      case "cache.delete": functionsStore.cacheDelete(scopeName(args[0]), String(args[1])); return true;
      case "cache.lock": case "cache.unlock": return null; // etapa 4
      default: throw new RunRefused("unknown-call", `m5: no such host call "${String(fn).slice(0, 60)}"`);
    }
  };
}

/* ------------------------------------------------------------- execute */

export type ExecuteOptions = {
  executor: string;
  test?: boolean;
  parent?: string | null;
  /** Reuse a session (repeat runs of the same model, caller and room share one). */
  sessionScope?: string;
};

/** The result the caller (chat, console) sees. */
export type ExecuteResult = {
  run: Run;
  outputs: Output[];
  value: Output | null;
};

const scopeKey = (model: Model, caller: Caller): string => `${model.id}\0${caller.account || caller.client || "anon"}\0${caller.room ?? ""}`;

/**
 * Validates the inputs, records a run, carries it out in a sandbox process,
 * streams logs and outputs to the store (and to runEvents for the console),
 * and finalizes the run. Never throws for a function's own failure — that is
 * a finished run with an error; it throws only when the run cannot start
 * (RunRefused: an unknown model, an unpublished package, bad inputs).
 */
export async function execute(model: Model, rawInputs: Record<string, unknown>, caller: Caller, opts: ExecuteOptions): Promise<ExecuteResult> {
  await functionsStore.ready();
  const inputs = validateInputs(model.inputs, rawInputs); // throws RunRefused on a bad input
  const runId = newId("run");
  const sessionId = functionsStore.session(model.id, opts.sessionScope ?? scopeKey(model, caller));
  const spec = buildSpec(model, inputs, caller, opts.executor, { test: Boolean(opts.test), runId, sessionId, parent: opts.parent ?? null });

  const run: Run = {
    id: runId, modelId: model.id, entry: model.entry, lang: spec.lang as Lang, executor: opts.executor, caller, sessionId, parent: opts.parent ?? null,
    status: "running", inputs, outputs: [], error: null, test: Boolean(opts.test), queuedAt: Date.now(), startedAt: Date.now(), finishedAt: null, ms: 0, memMb: 0,
  };
  functionsStore.saveRun(run);
  runEvents.emit("run", { runId, type: "status", status: "running", modelId: model.id });

  const outputs: Output[] = [];
  let seq = 0;
  const buffer: RunLog[] = [];
  const flush = () => { if (buffer.length) { functionsStore.addLogs(buffer.splice(0)); } };
  const log = (level: RunLog["level"], msg: string, fields?: Record<string, unknown>) => {
    const entry: RunLog = { runId, seq: seq++, ts: Date.now(), level, msg, fields: fields ?? null };
    buffer.push(entry);
    runEvents.emit("run", { type: "log", ...entry });
    if (buffer.length >= 20) flush();
  };
  const flushTimer = setInterval(flush, 500);

  const handlers: RunHandlers = {
    host: hostHandler(model, sessionId),
    onLog: (level, msg, fields) => log(level as RunLog["level"], msg, fields),
    onOutput: (out) => { outputs.push(out); runEvents.emit("run", { runId, type: "output", output: out }); },
    onProgress: (p, text) => runEvents.emit("run", { runId, type: "progress", p, text }),
  };

  const result = await thePool().run(spec, handlers);
  clearInterval(flushTimer);
  flush();

  const value = result.ok ? result.value : null;
  const finalOutputs = value && !outputs.includes(value) ? [...outputs, value] : outputs;
  run.status = result.ok ? "done" : result.error.type === "TimeLimit" ? "timed-out" : "failed";
  run.outputs = finalOutputs;
  run.error = result.ok ? null : result.error;
  run.finishedAt = Date.now();
  run.ms = result.ms;
  run.memMb = result.memMb;
  functionsStore.saveRun(run);
  runEvents.emit("run", { runId, type: "status", status: run.status, error: run.error, ms: run.ms, memMb: run.memMb });

  return { run, outputs: finalOutputs, value };
}

/* ------------------------------------------------------- ad-hoc test run */

export type AdhocSpec = {
  lang: Lang;
  files: Record<string, string>;
  deps?: RunSpec["deps"];
  entry: { file: string; fn: string };
  inputs: Record<string, unknown>;
  limits?: Partial<RunLimits>;
};

/**
 * Runs code straight from the editor (the current draft), before it is a
 * published model — the console's "Run" button. It is always a test run,
 * scoped to its own throwaway session, and streams to runEvents like any run.
 */
export async function runAdhoc(spec: AdhocSpec, caller: Caller, handlers?: Partial<RunHandlers>): Promise<ExecuteResult> {
  await functionsStore.ready();
  const runId = newId("run");
  const sessionId = functionsStore.session("__adhoc__", `adhoc\0${runId}`);
  const limits = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(limits) as (keyof RunLimits)[]) { const v = spec.limits?.[k]; if (typeof v === "number" && v > 0) limits[k] = Math.min(v, MAX_LIMITS[k]); }
  const now = Date.now();
  const full: RunSpec = {
    id: runId, lang: spec.lang, files: spec.files, deps: spec.deps ?? {}, entry: spec.entry, inputs: spec.inputs,
    context: {
      run: { id: runId, model: null, executor: "console", parent: null, startedAt: now, deadline: now + limits.wallMs, test: true, entry: `${spec.entry.file}#${spec.entry.fn}` },
      caller: { kind: caller.kind, name: caller.name, groups: caller.groups, room: caller.room, client: caller.client, lang: caller.lang, tz: caller.tz },
      sys: { version: buildInfo().version, instance: process.env.INSTANCE_ID?.trim() || "m5cet" },
      session: { id: sessionId },
    },
    limits,
  };
  const run: Run = { id: runId, modelId: "", entry: full.context.run.entry, lang: spec.lang, executor: "console", caller, sessionId, parent: null, status: "running", inputs: spec.inputs, outputs: [], error: null, test: true, queuedAt: now, startedAt: now, finishedAt: null, ms: 0, memMb: 0 };
  functionsStore.saveRun(run);
  runEvents.emit("run", { runId, type: "status", status: "running", modelId: "" });

  const outputs: Output[] = [];
  let seq = 0;
  const runHandlers: RunHandlers = {
    host: hostHandler({ id: "__adhoc__" } as Model, sessionId),
    onLog: (level, msg, fields) => { const e = { runId, seq: seq++, ts: Date.now(), level: level as RunLog["level"], msg, fields: fields ?? null }; functionsStore.addLogs([e]); runEvents.emit("run", { type: "log", ...e }); handlers?.onLog?.(level, msg, fields); },
    onOutput: (out) => { outputs.push(out); runEvents.emit("run", { runId, type: "output", output: out }); handlers?.onOutput?.(out); },
    onProgress: (p, text) => { runEvents.emit("run", { runId, type: "progress", p, text }); handlers?.onProgress?.(p, text); },
  };
  const result = await thePool().run(full, runHandlers);
  const value = result.ok ? result.value : null;
  const finalOutputs = value && !outputs.includes(value) ? [...outputs, value] : outputs;
  run.status = result.ok ? "done" : result.error.type === "TimeLimit" ? "timed-out" : "failed";
  run.outputs = finalOutputs; run.error = result.ok ? null : result.error; run.finishedAt = Date.now(); run.ms = result.ms; run.memMb = result.memMb;
  functionsStore.saveRun(run);
  runEvents.emit("run", { runId, type: "status", status: run.status, error: run.error, ms: run.ms, memMb: run.memMb });
  return { run, outputs: finalOutputs, value };
}

export { formatEntry };
