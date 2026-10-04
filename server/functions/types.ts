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
import type { AdminRole } from "../admin-users";

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
  /** 5.3: JSON bodies (webhooks) — a plain object, a list. */
  | "object" | "array"
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
/** A model reachable by an inbound HTTP webhook. `token` is the capability in
 *  the URL (POST /hooks/m/:model/:token); `auth` adds an HMAC check on top. */
/**
 * mode (5.2): sync — answer with the outputs; async — answer at once (202) with the run id and
 * a status URL; auto — answer with the outputs when the run ends within 25 s, else as async.
 * callback: POST the result to ?callback= / X-Callback-URL when the run ends. log: what the
 * webhook log keeps (full: headers + bodies; meta: without the bodies; off).
 */
export type WebhookExecutor = { enabled: boolean; token?: string; auth?: "none" | "hmac"; secret?: string; mode?: "sync" | "async" | "auto"; callback?: boolean; log?: "full" | "meta" | "off" };
/** A model callable programmatically at POST /api/functions/call/:id with a
 *  bearer token (distinct from a webhook's capability URL). */
export type ApiExecutor = { enabled: boolean; token?: string };
export type Executors = { chat: ChatExecutor; console: ConsoleExecutor; webhook?: WebhookExecutor; api?: ApiExecutor };

/**
 * 5.3: a model's entry points, by what calls them. The function is "file#fn"
 * in the model's package version (the one `entry` names).
 *   execute  — the start: "/keyword" in the chat, the console, the API, a schedule
 *   response — someone replied to a message the model sent
 *   button   — someone clicked a button the model rendered (m5.out.button)
 *   form     — someone submitted a form the model rendered (m5.out.form)
 *   error    — another entry point failed (a JavaScript / Python error, a time
 *              limit, a bad result) or a result could not be shown in the browser
 *   webhook  — an inbound HTTP call; a model may have several, each with its own URL
 * execute, response, button, form and error are unique; webhooks are not.
 */
export type EndpointType = "execute" | "response" | "webhook" | "error" | "button" | "form";
export const ENDPOINT_TYPES: readonly EndpointType[] = ["execute", "response", "button", "form", "error", "webhook"];
export const UNIQUE_ENDPOINTS: readonly EndpointType[] = ["execute", "response", "button", "form", "error"];

export type Endpoint = {
  /** "execute", "response"… for the unique ones; "wh-…" for a webhook (stable across saves). */
  id: string;
  type: EndpointType;
  /** "file#function" in the model's package version. */
  fn: string;
  /** A webhook's label (several webhooks: "GitHub", "Stripe"…). */
  name?: string;
  /** What the entry point reads from its payload (the reply, the button's data, the form's
   *  values, the JSON body) — checked and typed like a command's inputs. */
  inputs: InputSpec[];
  enabled: boolean;
} & Partial<Omit<WebhookExecutor, "enabled">>;

/** One call in a model's processing session (m5.model.calls[i]). */
export type ChainCall = {
  id: number;
  type: EndpointType;
  /** The parameters the entry function got. */
  parms: Record<string, unknown>;
  /** What the entry function returned (plain data; large values are cut). */
  result: unknown;
  /** running · done · failed · timed-out · cancelled */
  status: string;
  err_msg: string;
  /** A webhook call: the URL (token masked), the method, GET (query) and POST (body). */
  http: { url: string; method: string; get: Record<string, unknown>; post: unknown } | null;
  run: string;
  at: number;
  by: string;
};

/** A model's processing session: the first call (execute or a webhook) and
 *  everything that follows from it — replies, clicks, forms, errors. */
export type Chain = {
  id: string;
  modelId: string;
  /** The session m5.model.session keeps its values in. */
  sessionId: string;
  /** Where its calls run: the model, or (console) a package draft. */
  source: { kind: "model" } | { kind: "draft"; packageId: string; file: string; inline?: { lang: Lang; files: FileMap } };
  calls: ChainCall[];
  createdAt: number;
  updatedAt: number;
  /** 6.7: who opened it, and the (blind) room its outputs were posted to — who may continue it (chain-access.ts). */
  opener?: ChainOpener;
};

/** 6.7: the first call's caller, as a session keeps it (chain-access.ts). */
export type ChainOpener = {
  kind: Caller["kind"];
  /** Account id, "" for a guest. */
  account: string;
  /** A guest's client id (the app's device id). */
  client: string | null;
  executor: string;
  /** The blind room id the outputs went to: set only for a chat run of a model that posts to the room. */
  room: string | null;
};

/**
 * 6.0: what a model's code may do beyond its caller's rights.
 *   admin      m5adm — the administration, with a role and areas (adm-token.ts).
 *              Only an owner grants or changes it; a model that has it can be
 *              changed only by an owner.
 *   telephony  m5.telephony for runs nobody started (a webhook, a schedule, the
 *              API): which parts — call, sms, lookup, hlr, message, did — and
 *              which numbers ("number:+420*"). A person's run also needs their own
 *              Telephony & SIP rights.
 *   nfc        m5.nfc for runs nobody started (a webhook, a schedule, the API):
 *              drive the caller's NFC hardware. A person's run needs their own
 *              NFC module access instead (6.3).
 */
export type ModelGrants = {
  admin?: { enabled: boolean; role: AdminRole; areas: string[] };
  telephony?: { enabled: boolean; rights: string[] };
  nfc?: { enabled: boolean };
};

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
  /** 5.3: the entry points (execute mirrors `entry` and `inputs`). */
  endpoints: Endpoint[];
  runtime: Runtime;
  inputs: InputSpec[];
  outputs: OutputKind[];
  limits: Partial<RunLimits>;
  executors: Executors;
  /** Groups (from 4.0) that may use the model; empty = everyone allowed by the module switch. */
  groups: string[];
  /** 6.0: m5adm and m5.telephony beyond the caller (see ModelGrants). */
  grants?: ModelGrants;
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
  /** 6.0: a console administrator's role (their test runs of drafts reach m5adm as that role). */
  adminRole?: AdminRole;
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
  /** 5.3: the processing session and the call in it; the entry point type. */
  chainId?: string;
  callId?: number;
  endpoint?: EndpointType;
  /** 6.7 (F-18): the run read a card (m5.nfc) — its record holds personal
   *  data (e-ID, card reports), so it is kept only FUNCTIONS_NFC_RUN_HOURS. */
  sensitive?: boolean;
};

/* ------------------------------------------------------------ schedules */

export type Schedule = {
  id: string;
  modelId: string;
  /** A five-field cron expression (or an @shortcut). */
  cron: string;
  tz: string;
  inputs: Record<string, unknown>;
  enabled: boolean;
  lastRun: number | null;
  createdAt: number;
  createdBy: string;
};

/* ------------------------------------------------- durable webhooks */

/** A webhook that survives a restart: an inbound POST runs the model's
 *  on_event in a new run of the saved session (persistent continuation). */
export type DurableWebhook = {
  token: string;
  modelId: string;
  sessionId: string;
  caller: Caller;
  /** "package@version:file#fn" — usually the model's on_event. */
  entry: string;
  once: boolean;
  expiresAt: number | null;
  createdAt: number;
};

/** 5.2: one call to a webhook, as the log keeps it (secrets masked). */
export type WebhookCall = {
  id: string;
  at: number;
  /** model: /hooks/m/…; run: a live m5.webhook.wait; durable: an on_event webhook; replay: from the console. */
  kind: "model" | "run" | "durable" | "replay";
  modelId: string;
  /** The token, masked (first 6 characters). */
  hook: string;
  method: string;
  path: string;
  query: Record<string, unknown>;
  headers: Record<string, string>;
  contentType: string;
  body: string;
  bodySize: number;
  /** The body as variables: { kind: json | form | multipart | text | xml | binary | empty, value }. */
  parsed: { kind: string; value: unknown } | null;
  ip: string;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  runId: string;
  ms: number;
  error: string;
  replayOf: string;
  /** Async / auto: how the run ended, and the callback. */
  result: { status: string; ms: number; outputs?: unknown; error?: unknown; callback?: { url: string; status: number; error?: string } } | null;
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
