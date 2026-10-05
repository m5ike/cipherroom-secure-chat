// 6.11: a command's run never hangs and ends exactly once — the client's
// clock (no sign of life for 30 s → failed), questions that stop it, progress
// that winds it up, and every way a stream can end (done, the server's error,
// an abort by a newer command, a stream cut short, HTTP 429 / 401, the network,
// an answer that is not a stream).

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { runCommandStream, type StreamHandlers } from "../client/src/lib/functions";
import { callFailure, callOutcome, guardRun, runFailure, type RunEnd } from "../client/src/lib/fn-run";
import { FN_RUN_TIMEOUT_MS } from "../client/src/lib/system-messenger";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const enc = new TextEncoder();
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A response whose body the test feeds by hand (and may leave open). */
function liveSse() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
  return {
    response: new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    send: (event: string, data: unknown) => ctrl.enqueue(enc.encode(frame(event, data))),
    ping: () => ctrl.enqueue(enc.encode(": ping\n\n")),
    close: () => ctrl.close(),
  };
}

function sseResponse(frames: string[], close = true): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) { for (const f of frames) c.enqueue(enc.encode(f)); if (close) c.close(); },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** Runs /x through the guard with fetch answering `res`; collects every end. */
function run(res: Response | (() => Promise<Response>), opts: { timeoutMs?: number; onInteraction?: () => void; onProgress?: (p: number, t: string) => void } = {}) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const r = typeof res === "function" ? await res() : res;
    // A real fetch rejects once its signal aborts; the body of a live stream errors.
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    return r;
  });
  vi.stubGlobal("fetch", fetchMock);
  const ends: RunEnd[] = [];
  const guard = guardRun({ timeoutMs: opts.timeoutMs, onEnd: (e) => ends.push(e), onInteraction: opts.onInteraction, onProgress: opts.onProgress });
  const done = guard.run((h: StreamHandlers, signal) => runCommandStream({ keyword: "x", inputs: {}, room: null, client: null, lang: "cs", token: null, signal }, h));
  return { guard, ends, done, fetchMock };
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

describe("the run's clock (FN_RUN_TIMEOUT_MS)", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });

  it("is 30 seconds", () => { expect(FN_RUN_TIMEOUT_MS).toBe(30_000); });

  it("a run that never says anything fails after 30 s — and its stream is aborted", async () => {
    const live = liveSse();
    const { guard, ends } = run(live.response);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(ends).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(ends).toEqual([{ kind: "timeout", ms: 30_000 }]);
    expect(guard.signal.aborted).toBe(true);
    expect(guard.isSettled()).toBe(true);
    // Whatever the stream does afterwards changes nothing.
    try { live.send("done", { runId: "r", status: "done", outputs: [], error: null, visibility: "caller" }); } catch { /* aborted */ }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ends).toHaveLength(1);
  });

  it("the keep-alive pings do not count as a sign of life", async () => {
    const live = liveSse();
    const { ends } = run(live.response);
    for (let s = 0; s < 3; s++) { live.ping(); await vi.advanceTimersByTimeAsync(10_000); }
    expect(ends.map((e) => e.kind)).toEqual(["timeout"]);
  });

  it("progress (any event) winds the clock up again — and its text reaches the call", async () => {
    const live = liveSse();
    const progress: string[] = [];
    const { ends } = run(live.response, { onProgress: (_p, text) => progress.push(text) });
    await vi.advanceTimersByTimeAsync(10);
    live.send("start", { runId: "run_1" });
    await vi.advanceTimersByTimeAsync(25_000);
    live.send("progress", { p: 0.2, text: "looking up MX…" });
    await vi.advanceTimersByTimeAsync(25_000);
    live.send("progress", { p: 0.6, text: "DKIM…" });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(ends).toEqual([]);
    expect(progress).toEqual(["looking up MX…", "DKIM…"]);
    live.send("done", { runId: "run_1", status: "done", outputs: [{ type: "text", text: "ok" }], error: null, visibility: "caller" });
    await vi.advanceTimersByTimeAsync(10);
    expect(ends.map((e) => e.kind)).toEqual(["done"]);
  });

  it("an open question (a form) stops the clock until it is answered", async () => {
    const live = liveSse();
    let asked = 0;
    const { guard, ends } = run(live.response, { onInteraction: () => { asked++; } });
    await vi.advanceTimersByTimeAsync(10);
    live.send("interaction", { runId: "run_1", id: "int_1", kind: "form", spec: { fields: [{ name: "domain" }] } });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(asked).toBe(1);
    expect(ends).toEqual([]);
    guard.resume(); // the person answered
    await vi.advanceTimersByTimeAsync(29_000);
    expect(ends).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(ends.map((e) => e.kind)).toEqual(["timeout"]);
  });

  it("the timeout becomes the call's error chip and the flash", () => {
    const out = callOutcome("cs", "mail", { kind: "timeout", ms: 30_000 });
    expect(out.status).toEqual({ kind: "error", label: "Model neodpověděl do 30 s.", code: "timeout" });
    expect(out.flash).toEqual({ text: "Chyba při provádění funkce modelu /mail", detail: "Model neodpověděl do 30 s." });
    expect(callOutcome("en", "mail", { kind: "timeout", ms: 30_000 }).flash?.text).toBe("Error while running the model's function /mail");
    expect(callOutcome("de", "mail", { kind: "timeout", ms: 30_000 }).flash?.text).toBe("Fehler beim Ausführen der Modellfunktion /mail");
  });
});

describe("every way a stream ends settles the run exactly once", () => {
  it("done", async () => {
    const { ends, done } = run(sseResponse([frame("start", { runId: "r1" }), frame("done", { runId: "r1", status: "done", outputs: [{ type: "text", text: "hi" }], error: null, visibility: "caller" })]));
    await done; await flush();
    expect(ends).toHaveLength(1);
    expect(ends[0].kind).toBe("done");
    expect((ends[0] as { result: { outputs: unknown[] } }).result.outputs).toEqual([{ type: "text", text: "hi" }]);
  });

  it("the server's error event (with what it carries)", async () => {
    const { ends, done } = run(sseResponse([frame("start", { runId: "r1" }), frame("error", { code: "bad-input", message: "Číslo: is required", inputs: [{ name: "number", type: "phone", required: true }] })]));
    await done; await flush();
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ kind: "failed", error: { code: "bad-input", message: "Číslo: is required" } });
    expect((ends[0] as { error: { inputs?: unknown[] } }).error.inputs).toHaveLength(1);
  });

  it("a stream that closes without an answer (a restart, a proxy) — 'incomplete'", async () => {
    const { ends, done } = run(sseResponse([frame("start", { runId: "r1" }), frame("progress", { p: 0.1, text: "…" })]));
    await done; await flush();
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ kind: "failed", error: { code: "incomplete" } });
    expect(runFailure("en", ends[0] as never).reason).toBe("The connection to the server ended before the model answered.");
  });

  it("an abort by a newer command — 'cancelled', no unhandled rejection", async () => {
    const live = liveSse();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const { guard, ends, done } = run(live.response);
    await flush();
    live.send("start", { runId: "r1" });
    await flush();
    guard.cancel();
    await done; await flush();
    expect(ends).toEqual([{ kind: "cancelled" }]);
    expect(guard.signal.aborted).toBe(true);
    expect(callOutcome("cs", "x", ends[0] as never)).toEqual({ status: { kind: "info", label: "Zrušeno — spustili jste další příkaz", code: "cancelled" }, flash: null });
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("HTTP 429 (the rate limiter, no code in its body) — 'rate'", async () => {
    const { ends, done } = run(new Response(JSON.stringify({ ok: false, message: "Too many requests" }), { status: 429, headers: { "Content-Type": "application/json" } }));
    await done; await flush();
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ kind: "failed", error: { code: "rate", message: "Too many requests" } });
    expect(runFailure("cs", ends[0] as never)).toEqual({ code: "rate", reason: "Příliš mnoho spuštění za sebou — chvíli počkejte." });
  });

  it("HTTP 401 — 'unauthorized'", async () => {
    const { ends, done } = run(new Response("Unauthorized", { status: 401, headers: { "Content-Type": "text/plain" } }));
    await done; await flush();
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ kind: "failed", error: { code: "unauthorized", message: "HTTP 401" } });
  });

  it("HTTP 404 with the server's code and message", async () => {
    const { ends, done } = run(new Response(JSON.stringify({ ok: false, code: "no-command", message: "No such command, or it is not available to you." }), { status: 404 }));
    await done; await flush();
    expect(ends[0]).toMatchObject({ kind: "failed", error: { code: "no-command", message: "No such command, or it is not available to you." } });
    expect(runFailure("cs", ends[0] as never).reason).toBe("No such command, or it is not available to you.");
  });

  it("the network gone — 'network'", async () => {
    const { ends, done } = run(() => Promise.reject(new TypeError("Failed to fetch")));
    await done; await flush();
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ kind: "failed", error: { code: "network" } });
  });

  it("a 200 that is not a stream: JSON outputs are the answer, a proxy's page an error", async () => {
    const a = run(new Response(JSON.stringify({ ok: true, status: "done", outputs: [{ type: "text", text: "hi" }], error: null, visibility: "caller" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await a.done; await flush();
    expect(a.ends.map((e) => e.kind)).toEqual(["done"]);
    vi.unstubAllGlobals();
    const b = run(new Response("<html>gateway</html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    await b.done; await flush();
    expect(b.ends).toHaveLength(1);
    expect(b.ends[0]).toMatchObject({ kind: "failed", error: { code: "bad-answer" } });
  });

  it("the stream's own handlers fire once even when the server writes after its answer", async () => {
    const onDone = vi.fn();
    const onError = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      frame("done", { runId: "r", status: "done", outputs: [], error: null, visibility: "caller" }),
      frame("error", { code: "late", message: "late" }),
    ])));
    await runCommandStream({ keyword: "x", inputs: {}, room: null, client: null, lang: "cs", token: null }, { onDone, onError });
    expect(onDone).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("callFailure", () => {
  it("a done run with the function's error: the error chip (its type as the code) and the flash", () => {
    expect(callFailure("en", "hlr", "Number unknown", "LookupError")).toEqual({
      status: { kind: "error", label: "Number unknown", code: "LookupError" },
      flash: { text: "Error while running the model's function /hlr", detail: "Number unknown" },
    });
    expect(callFailure("en", "hlr", "x", "error").status).toEqual({ kind: "error", label: "x" });
  });
});
