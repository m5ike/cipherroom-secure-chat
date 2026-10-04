// Telephony & SIP Applications (TSA, 6.9): a call flow drawn in the console's
// visual editor — a graph of tools (catalog.ts) wired port to port — that the
// server runs on a live call (runtime.ts), inbound or outbound, step by step:
// what the caller hears, what they type or say, where the call goes.
//
// This file is the CONTRACT every part shares — the store and the API
// (control/), the runtime (tsa/runtime.ts), the provider adapters, the
// simulator and the console's editor. Pure types and tiny helpers, no I/O.
//
// Ports
//   flow in      "in" — one control input on the node's left; any number of
//                edges may arrive (a menu that repeats, a loop's body that ends)
//   flow out     named control outputs: "next", "on_true" / "on_false",
//                "on_timeout", "on_success" / "on_code_error" / "on_failed",
//                "body" / "done", "case_<n>" / "default"… (catalog.ts says
//                which a tool has); at most ONE edge leaves a flow output
//   data in      on the node's top: dynamic "IN1" … "IN<n>" (the node's
//                `inputs` count, the tool's min / max) or fixed names
//                ("KEY" of route_audio); at most one edge arrives at each
//   data out     values a node produced ("digits", "text", "value", "from"…);
//                any number of edges may leave
//
// A node's data inputs are read when the node runs: the value its source node
// produced last (undefined when that node has not run). Formulas (formula.ts)
// and templates ({IN1}, {$name}, {call.from}) see IN<n>, the TSA's variables
// ($name, set by "set") and the call (call.from, call.to, call.did,
// call.direction, call.provider, call.id).
//
// Control flow may form cycles (a menu that asks again). A loop tool's "body"
// runs once per iteration; when a body path ends (a flow output with no edge)
// control returns to the innermost running loop; "break" leaves it through
// its "done". Every run is bounded: TSA_LIMITS below.

/** The tools (catalog.ts has each one's ports and parameters). */
export const TSA_NODE_TYPES = [
  // call
  "start", "hangup", "dial", "pause", "send_dtmf",
  // audio
  "tts", "play", "record", "stt", "route_audio",
  // input
  "read_dtmf",
  // logic
  "condition", "switch", "for", "while", "break", "set", "formula", "text", "time_condition",
  // integration
  "sms", "room_message", "http", "function", "lookup", "inroute_add", "log",
] as const;
export type TsaNodeType = typeof TSA_NODE_TYPES[number];

export const isTsaNodeType = (v: unknown): v is TsaNodeType => (TSA_NODE_TYPES as readonly string[]).includes(v as string);

/** Where an edge starts or ends: a node and one of its ports. */
export type TsaPortRef = { node: string; port: string };

export type TsaEdge = {
  id: string;
  from: TsaPortRef;
  to: TsaPortRef;
  /** flow: control (out → "in"); data: a value (data out → IN<n> / a fixed data input). */
  kind: "flow" | "data";
};

export type TsaNode = {
  /** Unique in the graph: [a-z][a-z0-9_]{0,31} ("n1", "menu", "ask_code"). */
  id: string;
  type: TsaNodeType;
  /** Canvas position (px, top-left) and, for wide tools (condition), a width. */
  x: number;
  y: number;
  w?: number;
  /** Shown on the canvas instead of the tool's name. */
  label?: string;
  /** The author's note (never runs). */
  note?: string;
  /** Number of dynamic data inputs IN1 … IN<inputs> (tools with dynamic inputs only). */
  inputs?: number;
  /** The tool's parameters (catalog.ts: keys, kinds, defaults). */
  params: Record<string, unknown>;
};

export type TsaGraph = { nodes: TsaNode[]; edges: TsaEdge[] };

/** A TSA as stored: a draft being edited and, once published, the version calls run. */
export type Tsa = {
  /** [a-z0-9][a-z0-9-]{1,47} ("main-ivr"). */
  id: string;
  name: string;
  description: string;
  /** The draft. */
  graph: TsaGraph;
  /** What calls run (null until published). */
  published: { version: number; graph: TsaGraph; at: number; by: string } | null;
  /** Incremented on each publish. */
  version: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
  tags: string[];
};

/** A problem found by validate() — the editor marks the node / edge. */
export type TsaProblem = { level: "error" | "warning"; message: string; node?: string; edge?: string; port?: string };

/** Hard limits of one run (the runtime enforces them; the editor shows them). */
export const TSA_LIMITS = {
  nodes: 300,
  edges: 900,
  dynamicInputs: 100,
  /** Nodes executed in one call (a runaway cycle ends the call with a log line). */
  stepsPerCall: 2_000,
  /** Nodes executed between two waits for the caller (a busy cycle without audio). */
  stepsPerTurn: 200,
  loopIterations: 1_000,
  /** One call's TSA time. */
  maxCallSeconds: 4 * 3600,
  textLength: 4_000,
  formulaLength: 1_000,
} as const;

/* -------------------------------------------------------------- runtime */

/**
 * What the outside world tells a running TSA — from the provider's webhooks
 * (gather, record, dial status, hangup), the media bridge (route_audio), the
 * speech pipeline (stt) or the simulator. The runtime is waiting for exactly
 * one of these (TsaSession.waiting) or for nothing.
 */
export type TsaEvent =
  | { kind: "started" }
  | { kind: "digits"; digits: string; timedOut?: boolean; finishedBy?: string }
  | { kind: "speech"; text: string; confidence?: number; timedOut?: boolean }
  | { kind: "recording"; url: string; id?: string; durationSec: number; digit?: string; timedOut?: boolean }
  | { kind: "played" }
  | { kind: "dial"; status: "answered" | "busy" | "no-answer" | "failed" | "canceled"; durationSec?: number }
  | { kind: "route"; ok: boolean; reason?: "code" | "failed"; detail?: string }
  | { kind: "hangup"; cause?: string }
  | { kind: "error"; message: string };

/** Where a running TSA is. Stored per call (tel-store) — webhooks resume it in whichever process they reach. */
export type TsaSession = {
  id: string;
  tsaId: string;
  tsaVersion: number;
  /** The call it runs on (tel-store TelCall.id), or a simulator call ("sim:<id>"). */
  callId: string;
  provider: string;
  direction: "inbound" | "outbound";
  call: { id: string; from: string; to: string; did: string; direction: "inbound" | "outbound"; provider: string };
  /** $name variables. */
  vars: Record<string, unknown>;
  /** Each node's data outputs, by node id then port. */
  values: Record<string, Record<string, unknown>>;
  /** The node running or waiting; null when ended. */
  at: string | null;
  waiting: { node: string; for: TsaEvent["kind"]; since: number; timeoutSec?: number } | null;
  /** Running loops, innermost last. */
  loops: Array<{ node: string; index: number; until?: number; step?: number }>;
  steps: number;
  status: "running" | "waiting" | "ended" | "failed";
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  /** The last few hundred steps, for the log and the editor's replay. */
  trace: TsaTraceEntry[];
};

export type TsaTraceEntry = { at: number; node: string; type: TsaNodeType; port?: string; note?: string; level?: "info" | "warn" | "error" };

/* ------------------------------------------------------------- helpers */

/** "IN1" … "IN100" → 1 … 100, else 0. */
export function dynamicInputIndex(port: string): number {
  const m = /^IN([1-9]\d{0,2})$/.exec(port);
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= TSA_LIMITS.dynamicInputs ? n : 0;
}

export const NODE_ID = /^[a-z][a-z0-9_]{0,31}$/;
export const TSA_ID = /^[a-z0-9][a-z0-9-]{1,47}$/;
