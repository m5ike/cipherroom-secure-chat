// 6.11: a model's run in the chat, guarded — it ends exactly once, and it
// never hangs.
//
// A run that shows no sign of life (no start, progress, question, output or
// answer — the server's 15 s keep-alive pings do not count) for
// FN_RUN_TIMEOUT_MS fails: the stream is aborted, the call's loading goes and
// an error says why. An open question (a form, a prompt, an NFC tap) stops the
// clock until it is answered; every event winds it up again. A newer command
// cancels the older run ("cancelled"); the server's error, an HTTP error, the
// network gone or a stream that closes without an answer end it as a failure
// (functions.ts › streamFunction reports each of them once).

import { FN_RUN_TIMEOUT_MS } from "./system-messenger";
import type { Interaction, RunDone, StreamError, StreamHandlers } from "./functions";
import type { FnStatus } from "./message-kinds";
import { t, tf, type Lang } from "./i18n";

export type RunEnd =
  | { kind: "done"; result: RunDone }
  | { kind: "failed"; error: StreamError }
  | { kind: "timeout"; ms: number }
  | { kind: "cancelled" };

export type RunGuardOptions = {
  timeoutMs?: number;
  onStart?: (runId: string) => void;
  onInteraction?: (i: Interaction) => void;
  onProgress?: (p: number, text: string) => void;
  /** Called exactly once, however the run ends. */
  onEnd: (end: RunEnd) => void;
};

export type RunGuard = {
  readonly signal: AbortSignal;
  /** What the stream is given: they wind the clock and end the run once. */
  readonly handlers: StreamHandlers;
  /** A question was answered (or dismissed): the clock runs again. */
  resume(): void;
  /** A newer command (or the person): the run ends as "cancelled" and its stream is aborted. */
  cancel(): void;
  isSettled(): boolean;
  /** Runs the stream with these handlers and signal; resolves with how it ended. */
  run(start: (h: StreamHandlers, signal: AbortSignal) => Promise<void>): Promise<RunEnd>;
};

export function guardRun(opts: RunGuardOptions): RunGuard {
  const timeoutMs = opts.timeoutMs ?? FN_RUN_TIMEOUT_MS;
  const ctrl = new AbortController();
  let settled = false;
  let paused = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveEnd: (e: RunEnd) => void = () => undefined;
  const ended = new Promise<RunEnd>((resolve) => { resolveEnd = resolve; });

  const clear = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  const arm = () => {
    clear();
    if (!settled && !paused) timer = setTimeout(() => finish({ kind: "timeout", ms: timeoutMs }), timeoutMs);
  };
  const finish = (end: RunEnd) => {
    if (settled) return;
    settled = true;
    clear();
    if (end.kind === "timeout" || end.kind === "cancelled") ctrl.abort();
    try { opts.onEnd(end); } finally { resolveEnd(end); }
  };

  const handlers: StreamHandlers = {
    // Every event the server sends is a sign of life (an open question keeps the clock stopped).
    onEvent: () => arm(),
    onStart: (id) => { if (!settled) opts.onStart?.(id); },
    onInteraction: (i) => {
      if (settled) return;
      paused = true;
      clear();
      opts.onInteraction?.(i);
    },
    onProgress: (p, text) => { if (!settled) opts.onProgress?.(Number.isFinite(p) ? p : 0, text); },
    onDone: (r) => finish({ kind: "done", result: r }),
    onError: (e) => finish(e.code === "aborted" ? { kind: "cancelled" } : { kind: "failed", error: e }),
  };

  return {
    signal: ctrl.signal,
    handlers,
    resume: () => { if (settled) return; paused = false; arm(); },
    cancel: () => finish({ kind: "cancelled" }),
    isSettled: () => settled,
    run: (start) => {
      arm();
      // streamFunction ends every stream in onDone / onError; this is the backstop for one that does not.
      void Promise.resolve()
        .then(() => start(handlers, ctrl.signal))
        .then(
          () => finish(ctrl.signal.aborted ? { kind: "cancelled" } : { kind: "failed", error: { code: "incomplete", message: "The connection closed before the function answered." } }),
          (err) => finish(ctrl.signal.aborted || (err as { name?: string } | null)?.name === "AbortError"
            ? { kind: "cancelled" }
            : { kind: "failed", error: { code: "network", message: (err as Error)?.message || "The connection was lost." } }),
        );
      return ended;
    },
  };
}

/** The failure codes said in the person's language (the rest show the server's message). */
const LOCAL_REASONS: Record<string, string> = {
  network: "functions.fail.network",
  incomplete: "functions.fail.incomplete",
  rate: "functions.fail.rate",
  unauthorized: "functions.fail.unauthorized",
  "bad-answer": "functions.fail.badAnswer",
};

/** Why a run failed, for the call's error chip and the flash: a code and a sentence. */
export function runFailure(lang: Lang, end: Exclude<RunEnd, { kind: "done" | "cancelled" }>): { code: string; reason: string } {
  if (end.kind === "timeout") return { code: "timeout", reason: tf(lang, "functions.fail.timeout", { s: Math.round(end.ms / 1000) }) };
  const { code, message } = end.error;
  if (LOCAL_REASONS[code]) return { code, reason: t(lang, LOCAL_REASONS[code]) };
  if (code === "server") return { code, reason: tf(lang, "functions.fail.server", { message }) };
  return { code, reason: message || t(lang, "functions.fail.unknown") };
}

export type CallOutcome = { status: FnStatus; flash: { text: string; detail: string } | null };

/** A failed call: its bubble's error chip (the reason; the code beside it) and the flash
 *  "Error while running the model's function /keyword" with the reason. */
export function callFailure(lang: Lang, keyword: string, reason: string, code?: string): CallOutcome {
  return {
    status: { kind: "error", label: reason, ...(code && code !== "error" ? { code } : {}) },
    flash: { text: tf(lang, "functions.runFailed", { keyword }), detail: reason },
  };
}

/** How a call that got no answer ends: cancelled (a quiet chip, no flash) or failed (callFailure). */
export function callOutcome(lang: Lang, keyword: string, end: Exclude<RunEnd, { kind: "done" }>): CallOutcome {
  if (end.kind === "cancelled") return { status: { kind: "info", label: t(lang, "functions.cancelled"), code: "cancelled" }, flash: null };
  const f = runFailure(lang, end);
  return callFailure(lang, keyword, f.reason, f.code);
}
