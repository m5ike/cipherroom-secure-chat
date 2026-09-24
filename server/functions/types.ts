// M5cet Functions — the domain (4.15).
//
// A *package* is a set of files in one language with a manifest; a published
// *version* of it is immutable. A *model* is a runnable assembly: an entry
// point in a package version, an input schema, outputs, limits, and the
// executors that can start it (chat "/keyword", the console, later webhooks
// and schedules). One start is a *run*; runs of the same model, caller and
// room share a *session* (a small key–value store with TTL).
//
// Scripts are written by the operator, not by arbitrary users: the boundary
// that matters is the interpreter (WebAssembly, no host access) and the
// separate runner process (a crash or a loop there does not touch the main
// service), not a defence against a hostile author.

import type { Lang, Output, RunLimits } from "./sandbox/protocol";

export type { Lang, Output, RunLimits };

/* ------------------------------------------------------------- packages */

export type PackageManifest = {
  name: string;
  version: string;
  language: Lang;
  /** The file that `pkg:name` (without a path) imports. */
  main: string;
  /** Other packages this one may import, at a fixed version each. */
  dependencies: Record<string, string>;
  description: string;
};

export type Package = {
  id: string;
  name: string;
  language: Lang;
  description: string;
  /** The version currently open for editing (a draft), if any. */
  draft: string | null;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
};

/** Files of a package: path inside the package → text. */
export type FileMap = Record<string, string>;

export type PackageVersion = {
  packageId: string;
  version: string;
  manifest: PackageManifest;
  files: FileMap;
  /** sha256 of the sorted files; a published version is sealed to it. */
  fingerprint: string;
  status: "draft" | "published";
  /** The last time the package's tests ran (tests/ files), if ever. */
  test: { at: number; ok: boolean; passed: number; failed: number; message: string } | null;
  createdAt: number;
  createdBy: string;
  publishedAt: number | null;
};

/* --------------------------------------------------------------- models */

export type InputType =
  | "string" | "text" | "integer" | "number" | "boolean" | "enum"
  | "date" | "time" | "duration" | "url" | "hostname" | "email" | "ip" | "json"
  | "user" | "file" | "secret";

export type InputSpec = {
  name: string;
  type: InputType;
  label?: string;
  help?: string;
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  pattern?: string;
  /** For "enum". */
  values?: string[];
};

export type OutputKind = Output["type"];

/** Where a model runs. "auto": in the browser unless it needs the server. */
export type Runtime = "browser" | "server" | "auto";

export type ChatExecutor = { enabled: boolean; visibility: "room" | "caller" };
export type ConsoleExecutor = { enabled: boolean };
export type Executors = { chat: ChatExecutor; console: ConsoleExecutor };

export type Model = {
  id: string;
  name: string;
  /** The chat command word (without the slash); "" = no chat command. */
  keyword: string;
  summary: string;
  /** "package@version:file#fn". */
  entry: string;
  /** Called when an awaited event arrives; "" = none. */
  onEvent: string;
  runtime: Runtime;
  inputs: InputSpec[];
  outputs: OutputKind[];
  limits: Partial<RunLimits>;
  executors: Executors;
  /** Groups (from 4.0) that may use the model; empty = everyone allowed by the module switch. */
  groups: string[];
  enabled: boolean;
  revision: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
};

/* ----------------------------------------------------------------- runs */

export type RunStatus = "queued" | "running" | "waiting" | "done" | "failed" | "cancelled" | "timed-out";

export type Caller = {
  kind: "console" | "user" | "guest" | "webhook" | "schedule" | "api";
  /** Account id ("" for a guest or the console); the display name is `name`. */
  account: string;
  name: string;
  groups: string[];
  room: string | null;
  client: string | null;
  lang: string;
  tz: string;
};

export type RunError = { type: string; message: string; stack?: string };

export type Run = {
  id: string;
  modelId: string;
  /** The exact entry the run used (a model's entry can change between runs). */
  entry: string;
  lang: Lang;
  executor: string;
  caller: Caller;
  sessionId: string;
  parent: string | null;
  status: RunStatus;
  inputs: Record<string, unknown>;
  outputs: Output[];
  error: RunError | null;
  test: boolean;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  ms: number;
  memMb: number;
};

export type RunLogLevel = "debug" | "info" | "warn" | "error" | "stdout" | "stderr";
export type RunLog = { runId: string; seq: number; ts: number; level: RunLogLevel; msg: string; fields: Record<string, unknown> | null };

/* ------------------------------------------------------------- helpers */

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const KEYWORD_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SEMVER_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

/** "package@version:file#fn" → its parts, or null when it is malformed. */
export function parseEntry(entry: string): { pkg: string; version: string; file: string; fn: string } | null {
  const m = /^([a-z0-9][a-z0-9-]{0,63})@(\d{1,6}\.\d{1,6}\.\d{1,6}):([^#]+)#([A-Za-z_$][\w$]*)$/.exec(entry);
  return m ? { pkg: m[1], version: m[2], file: m[3], fn: m[4] } : null;
}

export function formatEntry(pkg: string, version: string, file: string, fn: string): string {
  return `${pkg}@${version}:${file}#${fn}`;
}
