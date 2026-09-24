// JavaScript in QuickJS (4.15): one runtime and context per run, ES modules
// from the package (and the packages it imports), `m5` from prelude-js.ts.
//
// Limits inside the interpreter: its heap (setMemoryLimit), its stack, and an
// interrupt handler that stops a piece of work running longer than the
// step limit, past the wall deadline, or after a cancel. None of the
// sandbox process's own objects are visible: the only way out is the three
// host functions.

import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSContext, type QuickJSHandle, type QuickJSWASMModule } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-ng-wasmfile-release-sync";
import { PRELUDE_JS } from "./prelude-js";
import type { RunSpec, FileMap } from "./protocol";

export type Bridge = {
  sync(fn: string, argsJson: string): string;
  async(fn: string, argsJson: string): Promise<string>;
  emit(kind: string, json: string): void;
};

export class RunFailure extends Error {
  constructor(readonly type: string, message: string, readonly trace?: string) {
    super(message);
    this.name = type;
  }
}

export async function loadQuickJs(wasm: Uint8Array): Promise<QuickJSWASMModule> {
  const binary = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer;
  return newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmBinary: binary }));
}

export const QUICKJS_ENGINE = "QuickJS-ng (quickjs-emscripten 0.32)";

const RESOLVE_TRIES = ["", ".js", ".mjs", "/index.js"];

function normalizePath(dir: string, rel: string): string | null {
  const parts = dir ? dir.split("/") : [];
  for (const p of rel.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(p);
  }
  return parts.join("/");
}

function pick(files: FileMap, path: string): string | null {
  for (const suffix of RESOLVE_TRIES) {
    const candidate = `${path}${suffix}`.replace(/^\//, "");
    if (Object.prototype.hasOwnProperty.call(files, candidate)) return candidate;
  }
  return null;
}

/** The module names: "app/<path>", "pkg:<name>/<path>", "m5". */
export function resolveModule(spec: Pick<RunSpec, "files" | "deps">, base: string, requested: string): string {
  if (requested === "m5") return "m5";
  // The driver names the entry module by its resolved name.
  if (base === "m5:main" && requested.startsWith("app/") && Object.prototype.hasOwnProperty.call(spec.files, requested.slice(4))) return requested;
  if (requested.startsWith("pkg:")) {
    const rest = requested.slice(4);
    const name = rest.split("/")[0];
    const dep = Object.prototype.hasOwnProperty.call(spec.deps, name) ? spec.deps[name] : null;
    if (!dep) throw new Error(`cannot import "${requested}": the package "${name}" is not a dependency of this package`);
    const sub = rest.slice(name.length + 1) || dep.main;
    const file = pick(dep.files, normalizePath("", sub) ?? "");
    if (!file) throw new Error(`cannot import "${requested}": no such file in ${name}`);
    return `pkg:${name}/${file}`;
  }
  if (requested.startsWith("./") || requested.startsWith("../")) {
    let files: FileMap, prefix: string, path: string;
    if (base.startsWith("pkg:")) {
      const name = base.slice(4).split("/")[0];
      files = spec.deps[name].files;
      prefix = `pkg:${name}/`;
      path = base.slice(prefix.length);
    } else {
      files = spec.files;
      prefix = "app/";
      path = base.startsWith("app/") ? base.slice(4) : "";
    }
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const joined = normalizePath(dir, requested);
    const file = joined === null ? null : pick(files, joined);
    if (!file) throw new Error(`cannot import "${requested}" from ${base.replace(/^app\//, "")}: no such file in the package`);
    return `${prefix}${file}`;
  }
  throw new Error(`cannot import "${requested}": only files of the package ("./x.js"), other packages ("pkg:name") and "m5" can be imported`);
}

export function moduleSource(spec: Pick<RunSpec, "files" | "deps">, name: string): string {
  if (name === "m5") {
    return "const m = globalThis.m5; export default m; export const { sys, run, caller, log, out, session, cache, codec, id, crypto, sleep } = m;";
  }
  if (name.startsWith("pkg:")) {
    const dep = name.slice(4).split("/")[0];
    return spec.deps[dep].files[name.slice(5 + dep.length)];
  }
  return spec.files[name.slice(4)];
}

type Dumped = { name?: string; message?: string; stack?: string } | string | null;

function failureOf(vm: QuickJSContext, handle: QuickJSHandle, reason: () => string | null): RunFailure {
  let d: Dumped;
  try { d = vm.dump(handle) as Dumped; } catch { d = null; }
  handle.dispose();
  const why = reason();
  if (why) return new RunFailure(why === "cancelled" ? "Cancelled" : why === "memory" ? "MemoryLimit" : "TimeLimit", why === "cancelled" ? "the run was cancelled" : why === "step" ? "a piece of work ran longer than the step limit without waiting" : "the run took longer than its time limit");
  if (d && typeof d === "object") {
    const msg = String(d.message ?? "");
    if (/out of memory/i.test(msg)) return new RunFailure("MemoryLimit", "the function used more memory than its limit");
    return new RunFailure(String(d.name ?? "Error"), msg, typeof d.stack === "string" ? d.stack : undefined);
  }
  return new RunFailure("Error", typeof d === "string" ? d : "the function failed");
}

/**
 * Runs the entry function. Resolves with the result as the prelude encoded
 * it (JSON of an output or null); rejects with a RunFailure.
 */
export async function runJs(QuickJS: QuickJSWASMModule, spec: RunSpec, bridge: Bridge, state: { cancelled: boolean }): Promise<string> {
  const rt = QuickJS.newRuntime();
  rt.setMemoryLimit(spec.limits.memoryMb * 1024 * 1024);
  rt.setMaxStackSize(1024 * 1024);
  let stepStart = Date.now();
  let stopped: string | null = null;
  rt.setInterruptHandler(() => {
    const now = Date.now();
    if (state.cancelled) stopped = "cancelled";
    else if (now > spec.context.run.deadline) stopped = "wall";
    else if (now - stepStart > spec.limits.stepMs) stopped = "step";
    return stopped !== null;
  });
  rt.setModuleLoader(
    (name) => {
      const src = moduleSource(spec, name);
      return typeof src === "string" ? src : { error: new Error(`no module ${name}`) };
    },
    (base, requested) => {
      try { return resolveModule(spec, base, requested); } catch (err) { return { error: err as Error }; }
    },
  );
  const vm = rt.newContext();
  const pump = () => {
    stepStart = Date.now();
    const r = rt.executePendingJobs();
    if (r.error) r.error.dispose();
  };

  const host = vm.newObject();
  const fSync = vm.newFunction("sync", (fnH, argsH) => vm.newString(bridge.sync(vm.getString(fnH), vm.getString(argsH))));
  const fAsync = vm.newFunction("async", (fnH, argsH) => {
    const d = vm.newPromise();
    bridge.async(vm.getString(fnH), vm.getString(argsH)).then((json) => {
      if (!vm.alive) return;
      const s = vm.newString(json);
      d.resolve(s);
      s.dispose();
      d.dispose();
      pump();
    });
    return d.handle;
  });
  const fEmit = vm.newFunction("emit", (kindH, jsonH) => { bridge.emit(vm.getString(kindH), vm.getString(jsonH)); });
  vm.setProp(host, "sync", fSync);
  vm.setProp(host, "async", fAsync);
  vm.setProp(host, "emit", fEmit);
  fSync.dispose(); fAsync.dispose(); fEmit.dispose();

  const ctxJson = JSON.stringify({ ...spec.context, inputs: spec.inputs, limits: spec.limits });
  const why = () => stopped;
  const unwrap = (r: ReturnType<QuickJSContext["evalCode"]>): QuickJSHandle => {
    if (r.error) throw failureOf(vm, r.error, why);
    return r.value;
  };
  const settle = async (h: QuickJSHandle): Promise<QuickJSHandle> => {
    const state = vm.getPromiseState(h);
    if (state.type === "fulfilled" && state.notAPromise) return h;
    const p = vm.resolvePromise(h);
    h.dispose();
    pump();
    const r = await p;
    if (r.error) throw failureOf(vm, r.error, why);
    return r.value;
  };

  const setup = unwrap(vm.evalCode(PRELUDE_JS, "m5:prelude", { type: "global", strict: true }));
  const ctxH = vm.newString(ctxJson);
  stepStart = Date.now();
  const main = unwrap(vm.callFunction(setup, vm.undefined, host, ctxH));
  setup.dispose(); ctxH.dispose(); host.dispose();

  const entry = resolveModule(spec, "app/", `./${spec.entry.file}`);
  stepStart = Date.now();
  const ns = await settle(unwrap(vm.evalCode(`export * as mod from ${JSON.stringify(entry)};`, "m5:main", { type: "module" })));
  const mod = vm.getProp(ns, "mod");
  ns.dispose();
  const fnName = vm.newString(spec.entry.fn);
  stepStart = Date.now();
  const promise = unwrap(vm.callFunction(main, vm.undefined, mod, fnName));
  mod.dispose(); fnName.dispose(); main.dispose();
  const result = await settle(promise);
  const json = vm.getString(result);
  result.dispose();
  return json;
}
