// What the runner and a sandbox process say to each other (4.15).
//
// One sandbox process runs one function run and exits. It speaks
// newline-delimited JSON: the runner writes to its stdin, it writes to its
// stdout. Everything a sandbox says is untrusted — the code inside it may
// have reached the process's own JavaScript — so the runner checks every
// message (shape, size, limits) and only ever affects the run it belongs to.

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

export type RunContext = {
  run: { id: string; model: string | null; executor: string; parent: string | null; startedAt: number; deadline: number; test: boolean; entry: string };
  caller: { kind: "console" | "user" | "guest" | "webhook" | "schedule" | "api"; name: string; groups: string[]; room: string | null; client: string | null; lang: string; tz: string };
  sys: { version: string; instance: string };
  session: { id: string };
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

/** One output of a run (m5.out.*). Bytes travel as base64 in `data`. */
export type Output =
  | { type: "text"; text: string }
  | { type: "markdown"; text: string }
  | { type: "code"; text: string; lang: string }
  | { type: "table"; columns: string[]; rows: unknown[][]; title?: string }
  | { type: "json"; value: unknown; title?: string }
  | { type: "image"; mime: string; data: string; alt?: string }
  | { type: "file"; name: string; mime: string; data: string }
  | { type: "flash"; text: string; level: "info" | "success" | "warning" | "error" }
  | { type: "window"; id: string; args: unknown };

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
  | { t: "progress"; p: number; text: string }
  | { t: "call"; id: number; fn: string; args: unknown[] }
  | { t: "done"; ok: true; value: Output | null; ms: number; mem: number }
  | { t: "done"; ok: false; error: RunError; ms: number; mem: number }
  | { t: "fatal"; message: string };

/** The host calls a sandbox may make to the runner (everything else is refused). */
export const HOST_CALLS = [
  "session.get", "session.set", "session.delete", "session.keys",
  "cache.get", "cache.set", "cache.incr", "cache.delete", "cache.lock", "cache.unlock",
] as const;
export type HostCall = (typeof HOST_CALLS)[number];

/** Longest line either side accepts; a longer one ends the run. */
export const MAX_FRAME = 12 * 1024 * 1024;

const LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error", "stdout", "stderr"]);
const OUT_TYPES = new Set(["text", "markdown", "code", "table", "json", "image", "file", "flash", "window"]);
const FLASH_LEVELS = new Set(["info", "success", "warning", "error"]);

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** An output as the sandbox claimed it, or null when it is not one. */
export function checkOutput(v: unknown): Output | null {
  if (!isObj(v) || typeof v.type !== "string" || !OUT_TYPES.has(v.type)) return null;
  const MAX = MAX_LIMITS.outputBytes * 2;
  switch (v.type) {
    case "text": case "markdown": { const text = str(v.text, MAX); return text === null ? null : { type: v.type, text }; }
    case "code": { const text = str(v.text, MAX); const lang = str(v.lang ?? "", 40); return text === null || lang === null ? null : { type: "code", text, lang }; }
    case "table": {
      if (!Array.isArray(v.columns) || !Array.isArray(v.rows) || !v.rows.every(Array.isArray)) return null;
      const columns = v.columns.map((c) => String(c).slice(0, 200));
      const title = v.title === undefined ? undefined : str(v.title, 500);
      return { type: "table", columns, rows: v.rows as unknown[][], ...(title ? { title } : {}) };
    }
    case "json": { const title = v.title === undefined ? undefined : str(v.title, 500); return { type: "json", value: v.value ?? null, ...(title ? { title } : {}) }; }
    case "image": {
      const mime = str(v.mime, 100); const data = str(v.data, MAX);
      if (!mime || !/^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(mime) || data === null || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
      const alt = v.alt === undefined ? undefined : str(v.alt, 500);
      return { type: "image", mime, data, ...(alt ? { alt } : {}) };
    }
    case "file": {
      const name = str(v.name, 200); const mime = str(v.mime, 100); const data = str(v.data, MAX);
      if (!name || !mime || !/^[\w.+-]+\/[\w.+-]+$/.test(mime) || data === null || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
      return { type: "file", name: name.replace(/[\\/\0]/g, "_"), mime, data };
    }
    case "flash": {
      const text = str(v.text, 2000); const level = typeof v.level === "string" && FLASH_LEVELS.has(v.level) ? v.level as "info" : "info";
      return text === null ? null : { type: "flash", text, level };
    }
    case "window": { const id = str(v.id, 100); return id ? { type: "window", id, args: v.args ?? null } : null; }
  }
  return null;
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
    case "out": { const out = checkOutput(v.out); return out ? { t: "out", out } : null; }
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
        const value = v.value === null || v.value === undefined ? null : checkOutput(v.value);
        if (v.value !== null && v.value !== undefined && !value) return null;
        return { t: "done", ok: true, value, ms, mem };
      }
      const e = isObj(v.error) ? v.error : {};
      return { t: "done", ok: false, error: { type: String(e.type ?? "Error").slice(0, 100), message: String(e.message ?? "").slice(0, 4000), ...(typeof e.stack === "string" ? { stack: e.stack.slice(0, 8000) } : {}) }, ms, mem };
    }
    case "fatal": return { t: "fatal", message: String(v.message ?? "").slice(0, 2000) };
  }
  return null;
}
