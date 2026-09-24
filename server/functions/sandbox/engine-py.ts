// Python in Pyodide (4.15). The interpreter loads when the sandbox warms up
// (about a second), before any run: the prelude builds `m5`, keeps
// `_m5_execute`, and the bridges to JavaScript are dropped. A run writes the
// package into Pyodide's in-memory file system (/m5/app, dependencies under
// /m5/deps/pkg/<name>) and calls the entry function with the inputs as
// keyword arguments.
//
// Python has no interrupt here (that needs a second thread writing to a
// shared buffer); a run over its time is ended by the runner killing the
// process. Memory is capped by refusing WebAssembly memory growth.

import { join } from "node:path";
import { createRequire } from "node:module";
import { PRELUDE_PY } from "./prelude-py";
import { RunFailure, type Bridge } from "./engine-js";
import type { RunSpec } from "./protocol";

type PyProxy = ((...args: unknown[]) => unknown) & { destroy?: () => void };
type Pyodide = {
  version: string;
  runPython(code: string): unknown;
  registerJsModule(name: string, module: object): void;
  globals: { get(name: string): PyProxy };
  _module?: { HEAPU8?: Uint8Array };
  [key: string]: unknown;
};

export type PythonEngine = { version: string; heapBytes: () => number; execute: (specJson: string) => Promise<string> };

/** Pyodide's public API calls that would load code or reach the host. */
const NEUTERED = ["loadPackage", "loadPackagesFromImports", "mountNodeFS", "mountNativeFS", "registerJsModule", "unregisterJsModule", "pyimport", "runPython", "runPythonAsync", "setStdin", "setStdout", "setStderr", "setInterruptBuffer", "checkInterrupt", "registerComlink", "unpackArchive", "loadSnapshot", "makeMemorySnapshot", "_api", "FS", "PATH", "ERRNO_CODES"];

export async function loadPython(dir: string, bridge: () => Bridge): Promise<PythonEngine> {
  const req = createRequire(join(dir, "pyodide.js"));
  const { loadPyodide } = req(join(dir, "pyodide.js")) as { loadPyodide: (o: object) => Promise<Pyodide> };
  const emitLine = (level: string) => (line: string) => bridge().emit("log", JSON.stringify({ level, msg: line }));
  const py = await loadPyodide({
    indexURL: `${dir}/`,
    stdout: emitLine("stdout"),
    stderr: emitLine("stderr"),
    stdin: () => null,
    checkAPIVersion: true,
    env: { HOME: "/m5", PYTHONHASHSEED: "random" },
  });
  const version = py.version;
  py.registerJsModule("_m5host", {
    sync: (fn: string, args: string) => bridge().sync(String(fn), String(args)),
    call_async: (fn: string, args: string) => bridge().async(String(fn), String(args)),
    emit: (kind: string, json: string) => bridge().emit(String(kind), String(json)),
  });
  py.runPython(PRELUDE_PY);
  const execute = py.globals.get("_m5_execute");
  py.runPython("_seal()");
  const heap = () => py._module?.HEAPU8?.buffer.byteLength ?? 0;
  for (const name of NEUTERED) {
    try {
      Object.defineProperty(py, name, { value: undefined, writable: false, configurable: false });
    } catch { /* not configurable: leave */ }
  }
  return {
    version,
    heapBytes: heap,
    execute: async (specJson: string) => {
      try {
        const r = await (execute(specJson) as Promise<unknown>);
        return String(r);
      } catch (err) {
        throw pythonFailure(err);
      }
    },
  };
}

/** A Python exception as the console shows it: the type, the last line,
 *  and the traceback frames of the package (not of the SDK or Pyodide). */
export function pythonFailure(err: unknown): RunFailure {
  const e = err as { type?: string; message?: string; name?: string };
  if (e?.name === "RangeError" && /memory limit/.test(String(e.message))) return new RunFailure("MemoryLimit", "the function used more memory than its limit");
  const text = String(e?.message ?? err);
  const type = typeof e?.type === "string" ? e.type : e?.name === "PythonError" ? "Error" : String(e?.name ?? "Error");
  if (type === "MemoryError") return new RunFailure("MemoryLimit", "the function used more memory than its limit");
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const frame = /^\s+File "([^"]+)"/.exec(line);
    if (frame) {
      const own = frame[1].startsWith("/m5/app/") || frame[1].startsWith("/m5/deps/");
      if (own) {
        kept.push(line.replace("/m5/app/", "").replace("/m5/deps/pkg/", "pkg:"));
        if (lines[i + 1] && !/^\s+File "/.test(lines[i + 1]) && /^\s{4,}/.test(lines[i + 1])) kept.push(lines[i + 1]);
      }
    }
  }
  const last = [...lines].reverse().find((l) => l.trim() && !/^\s/.test(l)) ?? text;
  const message = last.startsWith(`${type}: `) ? last.slice(type.length + 2) : last;
  const trace = kept.length ? ["Traceback (most recent call last):", ...kept, last].join("\n") : undefined;
  return new RunFailure(type, message, trace);
}

export const PYODIDE_ENGINE = "Pyodide";
export type { RunSpec };
