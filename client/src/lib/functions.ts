// Chat commands — the client side of Functions (4.15). A user types
// "/keyword args" in the composer; this recognises it, turns the arguments
// into the model's inputs, asks the server to run the model (in a sandbox
// process, off the E2EE path — only what is typed here leaves the device),
// and gives back the outputs to show and, when the model posts to the room,
// to send as an ordinary end-to-end-encrypted message.

export type CommandInput = { name: string; type: string; label?: string; help?: string; required: boolean; default?: unknown; values?: string[] };
/** events (5.3): what a reply, a click or a form of the command's messages reaches (response, button, form, error). */
export type Command = { keyword: string; name: string; summary: string; runtime: string; visibility: "room" | "caller"; mine: boolean; inputs: CommandInput[]; events?: string[]; model?: string };

import type { FnOutput } from "./fn-outputs";
export type { FnOutput } from "./fn-outputs";
export { outputsToMarkdown } from "./fn-outputs";

export type RunOutcome =
  | { ok: true; outputs: FnOutput[]; visibility: "room" | "caller"; status: string; ms: number }
  | { ok: false; code: string; message: string };

import { readEvents } from "./ai";

const authHeaders = (token: string | null): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});

/** A live question a running command asks the caller (m5.prompt / m5.form). */
export type PromptSpec = { text?: string; choices?: string[]; placeholder?: string };
export type FormField = { name: string; label?: string; type?: string; required?: boolean; placeholder?: string; values?: string[] };
export type FormSpec = { title?: string; text?: string; fields: FormField[]; submit?: string };
import type { NfcCommand } from "./nfc/command";
/** 6.3: an "nfc" interaction carries an NfcCommand the caller's device runs (no dialog). */
export type NfcSpec = { command?: NfcCommand };
export type InteractionKind = "prompt" | "form" | "nfc";
export type Interaction = { runId: string; id: string; kind: InteractionKind; spec: PromptSpec & FormSpec & NfcSpec };

/** A finished run as the chat gets it (5.3: the processing session, the call, what the model answers). */
export type RunDone = {
  runId: string; status: string; outputs: FnOutput[]; error: { type: string; message: string } | null; visibility: "room" | "caller";
  chain?: string; call?: number; model?: string; keyword?: string; name?: string; events?: string[];
  /** The function failed and its error entry point answered (outputs are that answer). */
  handled?: boolean; failed?: { type: string; message: string } | null;
};

export type StreamHandlers = {
  onStart?: (runId: string) => void;
  onInteraction?: (i: Interaction) => void;
  onProgress?: (p: number, text: string) => void;
  onDone?: (r: RunDone) => void;
  onError?: (e: { code: string; message: string }) => void;
};

/** Runs a command with a live stream: progress, questions, then the outputs. */
export async function runCommandStream(opts: { keyword: string; inputs: Record<string, unknown>; room: string | null; client: string | null; lang: string; tz?: string; token: string | null; signal?: AbortSignal }, h: StreamHandlers): Promise<void> {
  return streamFunction("/api/functions/run", { keyword: opts.keyword, inputs: opts.inputs, room: opts.room, client: opts.client, lang: opts.lang, tz: opts.tz }, opts.token, opts.signal, h);
}

/** 5.3: what the app sends to a model's other entry points. */
export type FnEventBody =
  | { type: "response"; text: string; message?: { text: string } }
  | { type: "button"; name: string; data?: unknown; source?: "js" }
  | { type: "form"; name: string; values: Record<string, unknown>; source?: "js" }
  | { type: "error"; error: { type: string; message: string; stack?: string }; output?: number; fromError?: boolean }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string };

/** 5.3: a reply to the model's message, a click, a form — the entry point runs in the message's processing session (streamed like a command). */
export async function sendFnEventStream(opts: { model?: string; keyword: string; chain: string; call?: number; room: string | null; client: string | null; lang: string; tz?: string; token: string | null; signal?: AbortSignal }, ev: FnEventBody, h: StreamHandlers): Promise<void> {
  return streamFunction("/api/functions/event", { model: opts.model, keyword: opts.keyword, chain: opts.chain, call: opts.call, room: opts.room, client: opts.client, lang: opts.lang, tz: opts.tz, ...ev }, opts.token, opts.signal, h);
}

/** 5.3: a report from the browser (an output it could not show, a log line); the error entry point may answer. */
export async function sendFnReport(opts: { model?: string; keyword: string; chain: string; call?: number; room: string | null; client: string | null; lang: string; token: string | null }, ev: Extract<FnEventBody, { type: "error" | "log" }>): Promise<RunDone | null> {
  try {
    const res = await fetch("/api/functions/event", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(opts.token) },
      body: JSON.stringify({ model: opts.model, keyword: opts.keyword, chain: opts.chain, call: opts.call, room: opts.room, client: opts.client, lang: opts.lang, ...ev }),
    });
    const d = await res.json().catch(() => null);
    return res.ok && d && Array.isArray(d.outputs) && d.outputs.length ? d as RunDone : null;
  } catch { return null; }
}

async function streamFunction(path: string, body: Record<string, unknown>, token: string | null, signal: AbortSignal | undefined, h: StreamHandlers): Promise<void> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...authHeaders(token) },
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    });
  } catch (err) { h.onError?.({ code: "network", message: (err as Error).message }); return; }
  if (!res.ok || !res.body) { const d = await res.json().catch(() => ({})); h.onError?.({ code: (d as { code?: string }).code || "error", message: (d as { message?: string }).message || `HTTP ${res.status}` }); return; }
  for await (const { event, data } of readEvents(res.body)) {
    const d = data as Record<string, unknown>;
    if (event === "start") h.onStart?.(String(d.runId));
    else if (event === "interaction") h.onInteraction?.(d as never);
    else if (event === "progress") h.onProgress?.(Number(d.p), String(d.text ?? ""));
    else if (event === "done") h.onDone?.(d as never);
    else if (event === "error") h.onError?.(d as never);
  }
}

/** Sends the caller's answer to a running command's question. */
export async function answerInteraction(runId: string, interactionId: string, value: unknown, token: string | null): Promise<void> {
  try {
    await fetch(`/api/functions/runs/${encodeURIComponent(runId)}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({ interactionId, value }),
    });
  } catch { /* the run will time out on its own */ }
}

/** The commands this user may run, and whether the Functions module is on for them (5.2). */
export async function fetchCommandState(token: string | null): Promise<{ enabled: boolean; commands: Command[] }> {
  try {
    const res = await fetch("/api/functions/commands", { headers: authHeaders(token), cache: "no-store" });
    if (!res.ok) return { enabled: false, commands: [] };
    const data = await res.json();
    return { enabled: Boolean(data.enabled), commands: data.enabled && Array.isArray(data.commands) ? data.commands as Command[] : [] };
  } catch { return { enabled: false, commands: [] }; }
}

/** The commands this user may run ("/keyword"); empty when the module is off. */
export async function fetchCommands(token: string | null): Promise<Command[]> {
  return (await fetchCommandState(token)).commands;
}

/** "/word rest" → { keyword, argText }; null when the text is not a command. `chars`: the
 *  characters that start a command (5.2: the console may add "!" and others). */
export function parseCommandLine(text: string, chars: readonly string[] = ["/"]): { keyword: string; argText: string } | null {
  const t = text.trim();
  if (!t || !chars.includes([...t][0] ?? "")) return null;
  const m = /^([a-z0-9_-]{1,40})(?:\s+([\s\S]*))?$/i.exec(t.slice(([...t][0] ?? "").length));
  return m ? { keyword: m[1].toLowerCase(), argText: (m[2] ?? "").trim() } : null;
}

/** Splits an argument line into tokens, honouring "quoted values". */
function tokenize(argText: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(argText))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * Maps the argument line to the model's inputs: `key=value` pairs set that
 * input; bare tokens fill the required inputs in order (the last text input
 * takes the rest). Mirrors "/check example.org depth=full".
 */
export function buildInputs(command: Command, argText: string): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  const byName = new Map(command.inputs.map((i) => [i.name, i]));
  // Bare tokens fill the inputs in order (chat-typeable ones); a value picked
  // in the chat comes as text, so "user", "file" and "secret" are not filled here.
  const positional = command.inputs.filter((i) => i.type !== "user" && i.type !== "file" && i.type !== "secret");
  const tokens = tokenize(argText);
  const bare: string[] = [];
  for (const tok of tokens) {
    const eq = tok.indexOf("=");
    if (eq > 0 && byName.has(tok.slice(0, eq))) inputs[tok.slice(0, eq)] = tok.slice(eq + 1);
    else bare.push(tok);
  }
  let pi = 0;
  for (const spec of positional) {
    if (spec.name in inputs) continue;
    if (pi >= bare.length) break;
    // A free-text field at the end takes everything that is left.
    if ((spec.type === "text" || spec.type === "string") && spec === positional[positional.length - 1]) {
      inputs[spec.name] = bare.slice(pi).join(" ");
      pi = bare.length;
    } else {
      inputs[spec.name] = bare[pi++];
    }
  }
  return inputs;
}

/** Runs a command on the server; returns its outputs (or why it could not). */
export async function runCommand(opts: { keyword: string; inputs: Record<string, unknown>; room: string | null; client: string | null; lang: string; tz?: string; token: string | null; signal?: AbortSignal }): Promise<RunOutcome> {
  let res: Response;
  try {
    res = await fetch("/api/functions/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(opts.token) },
      body: JSON.stringify({ keyword: opts.keyword, inputs: opts.inputs, room: opts.room, client: opts.client, lang: opts.lang, tz: opts.tz }),
      signal: opts.signal,
    });
  } catch (err) {
    return { ok: false, code: "network", message: (err as Error).message };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) return { ok: false, code: data.code || "error", message: data.message || `HTTP ${res.status}` };
  if (data.error) return { ok: false, code: data.error.type || "failed", message: data.error.message || "The function failed." };
  return { ok: true, outputs: (data.outputs ?? []) as FnOutput[], visibility: data.visibility === "caller" ? "caller" : "room", status: data.status, ms: data.ms };
}


