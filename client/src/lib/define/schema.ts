// m5mobile.define (6.3) — typed variables and constants the operator defines
// once and the framework hands to every runtime as real, typed values.
//
// The operator builds them in the console (Android › Define) with a GUI
// builder; they are stored as the JSON below and delivered to the Android app,
// the web app and the Functions sandbox, where each becomes a live value under
// `m5mobile.define.<name>`. So a Package, a Model, a Function and both apps all
// read the same constant (an APDU template list, a colour set, a config
// object…) without hard-coding it.
//
// A definition is a NODE — a scalar (string/text/integer/float/boolean/bytes/
// script/enum) or a container (object/array/class). A container's entries each
// carry a key, a typed value and an optional max size, and nest to any depth.
// materialize() turns a node into the plain JS value the runtimes expose;
// sanitizeDefineSet() validates and bounds the JSON (sizes, depth, names) so a
// bad or oversized definition can never reach a runtime.
//
// The Java port (Android) reads the same JSON and materializes the same values.

export type ScalarType = "string" | "text" | "integer" | "float" | "boolean" | "bytes" | "script" | "enum";
export type ContainerType = "object" | "array" | "class";
export type DefType = ScalarType | ContainerType;

export const DEF_TYPES: DefType[] = ["string", "text", "integer", "float", "boolean", "bytes", "script", "enum", "object", "array", "class"];
export const SCALAR_TYPES = new Set<DefType>(["string", "text", "integer", "float", "boolean", "bytes", "script", "enum"]);

/** One typed value. Containers hold entries (object/class) or items (array). */
export type DefNode =
  | { type: "string" | "text"; value: string }
  | { type: "integer" | "float"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "bytes"; value: string } // hex
  | { type: "script"; value: string; lang?: "js" | "py" }
  | { type: "enum"; options: string[]; value: string }
  | { type: "object" | "class"; name?: string; entries: DefEntry[] }
  | { type: "array"; items: DefNode[] };

/** A key → value pair inside an object/class, with its own size bound. */
export type DefEntry = { key: string; node: DefNode; maxSize?: number };

/** A named definition (a variable or a constant). */
export type Definition = {
  name: string;
  kind: "variable" | "constant";
  node: DefNode;
  /** 0 = unlimited. Bytes of the materialized JSON. */
  maxSize?: number;
  /** Where the value is materialized (default both). */
  scope?: "android" | "web" | "both";
  note?: string;
};

export type DefineSet = { version: 1; updatedAt: number; defs: Definition[] };

export const DEFAULT_DEFINE_SET: DefineSet = { version: 1, updatedAt: 0, defs: [] };

/* limits — a definition set is small config, not storage. */
export const DEFINE_LIMITS = {
  maxDefs: 200,
  maxDepth: 12,
  maxEntries: 500,       // per container
  maxScalarChars: 65_536, // per scalar value
  maxNameLen: 64,
  hardScalarCap: 262_144, // absolute per-value cap regardless of maxSize
} as const;

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export function isValidDefName(name: unknown): name is string {
  return typeof name === "string" && NAME_RE.test(name);
}

/* --------------------------------------------------------------- sanitize */

function num(v: unknown, dflt = 0): number { return typeof v === "number" && Number.isFinite(v) ? v : dflt; }
function str(v: unknown, cap: number): string {
  return typeof v === "string" ? v.slice(0, Math.min(cap, DEFINE_LIMITS.hardScalarCap)) : "";
}

/** Checks and bounds one node (unknown → a valid DefNode, or null). */
export function sanitizeNode(raw: unknown, depth = 0): DefNode | null {
  if (depth > DEFINE_LIMITS.maxDepth) return null;
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const type = r.type as DefType;
  switch (type) {
    case "string": case "text":
      return { type, value: str(r.value, DEFINE_LIMITS.maxScalarChars) };
    case "integer":
      return { type, value: Math.trunc(num(r.value)) };
    case "float":
      return { type, value: num(r.value) };
    case "boolean":
      return { type, value: r.value === true };
    case "bytes": {
      const hex = str(r.value, DEFINE_LIMITS.maxScalarChars).replace(/[^0-9a-fA-F]/g, "");
      return { type, value: (hex.length % 2 ? hex.slice(0, -1) : hex).toLowerCase() };
    }
    case "script":
      return { type, value: str(r.value, DEFINE_LIMITS.maxScalarChars), lang: r.lang === "py" ? "py" : "js" };
    case "enum": {
      const options = Array.isArray(r.options) ? r.options.filter((x): x is string => typeof x === "string").slice(0, DEFINE_LIMITS.maxEntries).map((x) => x.slice(0, DEFINE_LIMITS.maxNameLen)) : [];
      const value = typeof r.value === "string" && options.includes(r.value) ? r.value : options[0] ?? "";
      return { type, value, options };
    }
    case "object": case "class": {
      const entries: DefEntry[] = [];
      const seen = new Set<string>();
      for (const e of Array.isArray(r.entries) ? r.entries : []) {
        if (entries.length >= DEFINE_LIMITS.maxEntries) break;
        const er = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
        const key = typeof er.key === "string" ? er.key.slice(0, DEFINE_LIMITS.maxNameLen) : "";
        if (!key || seen.has(key)) continue;
        const node = sanitizeNode(er.node, depth + 1);
        if (!node) continue;
        seen.add(key);
        entries.push({ key, node, ...(typeof er.maxSize === "number" ? { maxSize: Math.max(0, Math.trunc(er.maxSize)) } : {}) });
      }
      const name = typeof r.name === "string" ? r.name.slice(0, DEFINE_LIMITS.maxNameLen) : undefined;
      return { type, ...(name ? { name } : {}), entries };
    }
    case "array": {
      const items: DefNode[] = [];
      for (const it of Array.isArray(r.items) ? r.items : []) {
        if (items.length >= DEFINE_LIMITS.maxEntries) break;
        const node = sanitizeNode(it, depth + 1);
        if (node) items.push(node);
      }
      return { type, items };
    }
    default:
      return null;
  }
}

export function sanitizeDefinition(raw: unknown): Definition | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!isValidDefName(r.name)) return null;
  const node = sanitizeNode(r.node);
  if (!node) return null;
  return {
    name: r.name,
    kind: r.kind === "variable" ? "variable" : "constant",
    node,
    ...(typeof r.maxSize === "number" ? { maxSize: Math.max(0, Math.trunc(r.maxSize)) } : {}),
    scope: r.scope === "android" || r.scope === "web" ? r.scope : "both",
    ...(typeof r.note === "string" ? { note: r.note.slice(0, 200) } : {}),
  };
}

export function sanitizeDefineSet(raw: unknown): DefineSet {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const defs: Definition[] = [];
  const seen = new Set<string>();
  for (const d of Array.isArray(r.defs) ? r.defs : []) {
    if (defs.length >= DEFINE_LIMITS.maxDefs) break;
    const def = sanitizeDefinition(d);
    if (!def || seen.has(def.name)) continue;
    seen.add(def.name);
    defs.push(def);
  }
  return { version: 1, updatedAt: num(r.updatedAt, 0), defs };
}

/* ------------------------------------------------------------ materialize */

/** A script value as the runtimes see it: the code plus its language. */
export type ScriptValue = { __m5script: true; code: string; lang: "js" | "py" };

/** Turns a node into the plain value a runtime exposes. bytes → hex string
 *  (the runtimes decode as they wish); script → a tagged object. */
export function materialize(node: DefNode): unknown {
  switch (node.type) {
    case "string": case "text": return node.value;
    case "integer": case "float": return node.value;
    case "boolean": return node.value;
    case "bytes": return node.value; // hex
    case "enum": return node.value;
    case "script": return { __m5script: true, code: node.value, lang: node.lang ?? "js" } as ScriptValue;
    case "array": return node.items.map(materialize);
    case "object": case "class": {
      const out: Record<string, unknown> = {};
      for (const e of node.entries) out[e.key] = materialize(e.node);
      return out;
    }
  }
}

/** The whole set as the `m5mobile.define` object: name → value, filtered by
 *  scope ("android" | "web" | "both"; the server passes "both"). */
export function defineValues(set: DefineSet, scope: "android" | "web" | "both" = "both"): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of set.defs) {
    if (scope !== "both" && d.scope && d.scope !== "both" && d.scope !== scope) continue;
    out[d.name] = materialize(d.node);
  }
  return out;
}

/** The materialized JSON's byte length (for the per-definition maxSize check). */
export function definitionBytes(def: Definition): number {
  return new TextEncoder().encode(JSON.stringify(materialize(def.node))).length;
}

/** Definitions that exceed their own maxSize (0 = unlimited). */
export function oversized(set: DefineSet): string[] {
  return set.defs.filter((d) => d.maxSize && d.maxSize > 0 && definitionBytes(d) > d.maxSize).map((d) => d.name);
}
