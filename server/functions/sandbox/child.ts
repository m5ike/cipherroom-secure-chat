// A sandbox process (dist/sandbox.cjs, 4.15): warms up one interpreter,
// runs one function, exits.
//
//   node --permission --allow-fs-read=<its own files> --disallow-code-generation-from-strings
//        --max-old-space-size=… sandbox.cjs --lang=js|py --pyodide=<dir> --quickjs=<wasm>
//
// The runner (pool.ts) starts it with an empty environment and speaks NDJSON
// over stdin/stdout (protocol.ts). Order matters: the Node escape hatches go
// first (harden.ts), then the interpreter loads, then the globals it needed
// while loading go, and only then does "ready" go out.

import { readFileSync } from "node:fs";
import { callPure } from "./host-pure";
import { hardenNode, installWasmMemoryCap, scrubGlobals } from "./harden";
import { loadQuickJs, runJs, RunFailure, QUICKJS_ENGINE, type Bridge } from "./engine-js";
import { loadPython, type PythonEngine } from "./engine-py";
import { HOST_CALLS, MAX_FRAME, type FromSandbox, type RunSpec, type ToSandbox } from "./protocol";

// What this process keeps for itself before the globals go.
const stdin = process.stdin;
const stdout = process.stdout;
const exit = process.exit.bind(process);
const rss = process.memoryUsage.rss;
const started = Date.now();

function arg(name: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
}

function send(msg: FromSandbox): void {
  stdout.write(`${JSON.stringify(msg)}\n`);
}

function finish(msg: FromSandbox, code = 0): void {
  stdout.write(`${JSON.stringify(msg)}\n`, () => exit(code));
  setTimeout(() => exit(code), 2000).unref();
}

const lang = arg("lang") === "py" ? "py" : "js";
const state = { cancelled: false };
let nextCall = 1;
const pending = new Map<number, (json: string) => void>();
let spec: RunSpec | null = null;
let outBytes = 0;
let logBytes = 0;
let stopped = false;

const ALLOWED = new Set<string>(HOST_CALLS);

const bridge: Bridge = {
  sync: (fn, argsJson) => {
    let args: unknown[];
    try { args = JSON.parse(argsJson) as unknown[]; } catch { return JSON.stringify({ ok: false, e: { code: "bad-argument", message: "unreadable arguments" } }); }
    return JSON.stringify(callPure(fn, Array.isArray(args) ? args : []));
  },
  async: (fn, argsJson) => new Promise<string>((resolve) => {
    let args: unknown[];
    try { args = JSON.parse(argsJson) as unknown[]; } catch { resolve(JSON.stringify({ ok: false, e: { code: "bad-argument", message: "unreadable arguments" } })); return; }
    if (state.cancelled) { resolve(JSON.stringify({ ok: false, e: { code: "cancelled", message: "the run was cancelled" } })); return; }
    if (fn === "sleep") {
      const left = spec ? spec.context.run.deadline - Date.now() : 0;
      const ms = Math.max(0, Math.min(Number(args[0]) || 0, left));
      setTimeout(() => resolve(JSON.stringify({ ok: true, v: null })), ms);
      return;
    }
    if (!ALLOWED.has(fn)) { resolve(JSON.stringify({ ok: false, e: { code: "unknown-call", message: `m5: no such call "${fn.slice(0, 60)}"` } })); return; }
    const id = nextCall++;
    pending.set(id, resolve);
    send({ t: "call", id, fn, args });
  }),
  emit: (kind, json) => {
    if (stopped || !spec) return;
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(json) as Record<string, unknown>; } catch { return; }
    if (kind === "log") {
      logBytes += json.length;
      if (logBytes > spec.limits.logBytes) {
        if (logBytes - json.length <= spec.limits.logBytes) send({ t: "log", level: "warn", msg: "the log limit was reached; further lines are dropped" });
        return;
      }
      send({ t: "log", level: payload.level as "info", msg: String(payload.msg ?? ""), ...(payload.fields ? { fields: payload.fields as Record<string, unknown> } : {}) });
    } else if (kind === "out") {
      outBytes += json.length;
      if (outBytes > spec.limits.outputBytes) throw new RunFailure("OutputLimit", "the outputs are larger than the limit");
      send({ t: "out", out: payload as never });
    } else if (kind === "progress") {
      send({ t: "progress", p: Number(payload.p), text: String(payload.text ?? "") });
    }
  },
};

function onMessage(msg: ToSandbox): void {
  if (msg.t === "ret") {
    const resolve = pending.get(msg.id);
    if (!resolve) return;
    pending.delete(msg.id);
    resolve(JSON.stringify(msg.ok ? { ok: true, v: msg.v } : { ok: false, e: msg.e }));
  } else if (msg.t === "cancel") {
    state.cancelled = true;
    for (const [id, resolve] of pending) { pending.delete(id); resolve(JSON.stringify({ ok: false, e: { code: "cancelled", message: "the run was cancelled" } })); }
  } else if (msg.t === "run" && !spec) {
    spec = msg.spec;
    void execute(msg.spec);
  }
}

let buffer = "";
stdin.setEncoding("utf8");
stdin.on("data", (chunk: string) => {
  buffer += chunk;
  if (buffer.length > MAX_FRAME && !buffer.includes("\n")) { finish({ t: "fatal", message: "message too large" }, 2); return; }
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    try { onMessage(JSON.parse(line) as ToSandbox); } catch (err) { finish({ t: "fatal", message: `bad message: ${(err as Error).message}` }, 2); return; }
  }
});
// The runner went away: nothing to report to.
stdin.on("end", () => exit(0));

let engineJs: Awaited<ReturnType<typeof loadQuickJs>> | null = null;
let enginePy: PythonEngine | null = null;
let setCap: (bytes: number) => void = () => undefined;

async function execute(run: RunSpec): Promise<void> {
  const t0 = Date.now();
  const mem = () => Math.round(rss() / 1048576);
  try {
    let json: string;
    if (run.lang !== lang) throw new RunFailure("Error", `this sandbox runs ${lang}, not ${run.lang}`);
    if (lang === "js") {
      setCap(run.limits.memoryMb * 1048576 + 64 * 1048576);
      json = await runJs(engineJs!, run, bridge, state);
    } else {
      setCap(Math.max(run.limits.memoryMb * 1048576, enginePy!.heapBytes() + 32 * 1048576));
      json = await enginePy!.execute(JSON.stringify(run));
    }
    stopped = true;
    const value = json === "null" || !json ? null : JSON.parse(json);
    if (value) {
      outBytes += json.length;
      if (outBytes > run.limits.outputBytes) throw new RunFailure("OutputLimit", "the outputs are larger than the limit");
    }
    finish({ t: "done", ok: true, value, ms: Date.now() - t0, mem: mem() });
  } catch (err) {
    stopped = true;
    const e = err instanceof RunFailure ? err : new RunFailure((err as Error)?.name || "Error", String((err as Error)?.message ?? err));
    finish({ t: "done", ok: false, error: { type: e.type, message: e.message, ...(e.trace ? { stack: e.trace } : {}) }, ms: Date.now() - t0, mem: mem() });
  }
}

async function warm(): Promise<void> {
  try {
    setCap = installWasmMemoryCap();
    hardenNode();
    if (lang === "js") {
      engineJs = await loadQuickJs(readFileSync(arg("quickjs")));
    } else {
      enginePy = await loadPython(arg("pyodide"), () => bridge);
    }
    scrubGlobals();
    send({ t: "ready", engine: lang === "js" ? QUICKJS_ENGINE : "Pyodide", version: lang === "js" ? "0.32" : enginePy!.version, ms: Date.now() - started });
  } catch (err) {
    finish({ t: "fatal", message: `the sandbox did not start: ${(err as Error).message}` }, 3);
  }
}

// A failure outside the run's own promise chain (a host callback) must not
// leave the runner waiting.
const onCrash = (err: unknown) => {
  if (spec && !stopped) {
    stopped = true;
    const e = err instanceof RunFailure ? err : new RunFailure("Error", String((err as Error)?.message ?? err));
    finish({ t: "done", ok: false, error: { type: e.type, message: e.message }, ms: 0, mem: 0 }, 0);
  } else {
    finish({ t: "fatal", message: String((err as Error)?.message ?? err) }, 4);
  }
};
process.on("uncaughtException", onCrash);
process.on("unhandledRejection", onCrash);

void warm();
