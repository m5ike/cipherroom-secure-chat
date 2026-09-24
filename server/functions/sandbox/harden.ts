// Inside a sandbox process, before any function code: take away what the
// Node process itself could still do (4.15).
//
// The first walls are outside this file: the interpreter is WebAssembly
// (QuickJS, Pyodide), the process runs under Node's permission model (reads
// only its own files, writes nothing, no child processes, workers, addons,
// WASI or inspector), strings never become code, the environment is empty
// and, on Linux with bubblewrap, the process has no network namespace at all.
//
// Python code in Pyodide can reach this process's JavaScript (`import js`
// is blocked, but a determined script finds a way), so this layer assumes
// it has: the network modules Node's permission model does not cover
// (net, tls, dgram, http, https, http2, dns) refuse, the ES module views of
// them are resynchronised, and the process-level escape hatches (signals to
// other processes, raw bindings, native addons, reports) throw.

import { createRequire } from "node:module";

const req = createRequire(process.argv[1] || __filename);

export class SandboxDenied extends Error {
  readonly code = "ERR_SANDBOX_DENIED";
  constructor(what: string) {
    super(`${what} is not available in the sandbox`);
    this.name = "SandboxDenied";
  }
}

const deny = (what: string) => function denied(): never { throw new SandboxDenied(what); };

function stub(target: Record<string, unknown> | undefined, names: string[], what: string): void {
  if (!target) return;
  for (const name of names) {
    if (!(name in target)) continue;
    try {
      Object.defineProperty(target, name, { value: deny(what), writable: false, configurable: false, enumerable: true });
    } catch { /* already frozen: leave it */ }
  }
}

const proto = (ctor: unknown): Record<string, unknown> | undefined =>
  (ctor && typeof ctor === "function" ? (ctor as { prototype: Record<string, unknown> }).prototype : undefined);

/** Globals the function code has no use for and that talk to the world. */
export const SCRUBBED_GLOBALS = ["process", "fetch", "WebSocket", "EventSource", "XMLHttpRequest", "require", "module", "exports", "Buffer", "global", "navigator", "Worker", "Request", "Response", "Headers", "FormData", "localStorage", "sessionStorage"];

/** Network and process escape hatches off. Call first, before loading an interpreter. */
export function hardenNode(): void {
  // Load every module first: some set properties on prototypes they
  // inherit (https.Agent from http.Agent) while loading, which a frozen
  // stub on the parent would break.
  const [net, tls, dgram, http, https, http2, dns, childProcess, workers, inspector, cluster, repl, vm, v8, sqlite, mod, crypto, os] =
    ["net", "tls", "dgram", "http", "https", "http2", "dns", "child_process", "worker_threads", "inspector", "cluster", "repl", "vm", "v8", "sqlite", "module", "crypto", "os"].map((m) => req(`node:${m}`));

  stub(net, ["connect", "createConnection", "createServer"], "networking");
  stub(proto(net.Socket), ["connect"], "networking");
  stub(proto(net.Server), ["listen"], "networking");

  stub(tls, ["connect", "createServer", "createSecureContext"], "TLS");
  stub(proto(tls.Server), ["listen"], "networking");

  stub(dgram, ["createSocket"], "UDP");
  stub(proto(dgram.Socket), ["bind", "connect", "send", "sendto", "addMembership", "addSourceSpecificMembership"], "UDP");

  for (const mod of [https, http]) {
    stub(mod, ["request", "get", "createServer"], "HTTP");
    stub(proto(mod.Agent), ["createConnection"], "HTTP");
    stub(proto(mod.Server), ["listen"], "networking");
  }

  stub(http2, ["connect", "createServer", "createSecureServer"], "HTTP/2");

  const DNS = ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTlsa", "resolveTxt", "reverse", "setServers"];
  stub(dns, DNS, "DNS");
  stub(proto(dns.Resolver), DNS, "DNS");
  stub(dns.promises, DNS, "DNS");
  stub(proto(dns.promises?.Resolver), DNS, "DNS");

  // Denied by the permission model already; refused here too so a
  // development run without it (or a future flag change) is not open.
  stub(childProcess, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"], "starting processes");
  stub(workers, ["Worker"], "worker threads");
  stub(inspector, ["open", "url", "waitForDebugger"], "the inspector");
  stub(proto(inspector.Session), ["connect", "connectToMainThread"], "the inspector");
  stub(cluster, ["fork", "setupPrimary", "setupMaster"], "starting processes");
  stub(repl, ["start"], "the REPL");

  // Not covered by the permission model (checked on Node 24): vm compiles
  // strings despite --disallow-code-generation-from-strings, node:sqlite
  // opens and writes files despite a read-only file system permission,
  // v8.setFlagsFromString turns on natives syntax, crypto.setEngine loads a
  // shared library, the compile cache writes files, execve replaces the
  // process.
  stub(vm, ["Script", "createScript", "runInThisContext", "runInNewContext", "runInContext", "compileFunction", "createContext", "SourceTextModule", "SyntheticModule", "measureMemory"], "vm");
  stub(v8, ["setFlagsFromString", "writeHeapSnapshot", "getHeapSnapshot", "setHeapSnapshotNearHeapLimit", "takeCoverage", "stopCoverage"], "v8 internals");
  stub(sqlite, ["DatabaseSync", "StatementSync", "backup", "Session"], "node:sqlite");
  stub(mod, ["enableCompileCache", "flushCompileCache", "register", "registerHooks"], "module hooks");
  stub(crypto, ["setEngine"], "crypto engines");
  stub(os, ["userInfo", "networkInterfaces", "setPriority"], "this os call");

  // Pyodide reads fs.constants through process.binding("constants"); nothing
  // else of the raw bindings is reachable.
  const fsConstants = req("node:fs").constants;
  const binding = (name: string) => {
    if (name === "constants") return { fs: fsConstants, os: req("node:os").constants };
    throw new SandboxDenied(`process.binding("${String(name).slice(0, 40)}")`);
  };
  Object.defineProperty(process, "binding", { value: binding, writable: false, configurable: false });
  stub(process as unknown as Record<string, unknown>, ["_linkedBinding", "dlopen", "kill", "setuid", "setgid", "seteuid", "setegid", "setgroups", "initgroups", "_debugProcess", "_debugEnd", "_startProfilerIdleNotifier", "_stopProfilerIdleNotifier", "loadEnvFile", "chdir", "execve", "abort"], "this process call");
  try { stub(process.report as unknown as Record<string, unknown>, ["writeReport", "getReport"], "process reports"); } catch { /* no reports */ }
  try { Object.defineProperty(process, "env", { value: Object.freeze({}), writable: false, configurable: false }); } catch { /* keep the empty env */ }

  // The ES module namespaces of builtins (import("node:net")) are separate
  // objects; bring them in line with the patched CommonJS exports.
  req("node:module").syncBuiltinESMExports();
}

/**
 * WebAssembly memory growth past the cap fails: the interpreter's malloc
 * gets NULL and Python raises MemoryError (instead of the process growing
 * until the runner kills it). Installed before the interpreter loads; the
 * cap is set when the run (and its limit) arrives.
 */
export function installWasmMemoryCap(): (maxBytes: number) => void {
  let cap = Number.POSITIVE_INFINITY;
  const Memory = WebAssembly.Memory as unknown as { prototype: { grow(pages: number): number; buffer: ArrayBuffer } };
  const grow = Memory.prototype.grow;
  Object.defineProperty(Memory.prototype, "grow", {
    value: function (this: { buffer: ArrayBuffer }, pages: number): number {
      const after = this.buffer.byteLength + Number(pages) * 65536;
      if (after > cap) throw new RangeError(`WebAssembly memory limit (${Math.round(cap / 1048576)} MB) reached`);
      return grow.call(this, pages);
    },
    writable: false,
    configurable: false,
  });
  return (maxBytes) => { cap = maxBytes; };
}

/** Removes the globals the function code must not see. */
export function scrubGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  for (const name of SCRUBBED_GLOBALS) {
    try { delete g[name]; } catch { /* non-configurable */ }
    if (name in g) {
      try { Object.defineProperty(g, name, { value: undefined, writable: false, configurable: false }); } catch { /* leave */ }
    }
  }
}
