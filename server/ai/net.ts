// HTTP for the adapters (4.14): the errors of 4.0.6 (what went wrong, the
// provider's own message), a time limit for the first answer and — while a
// stream runs — for each silence between its pieces, cancelling with the
// caller, one more try without a parameter the model refused, and reading
// Server-Sent Events or newline-delimited JSON.

import { describeFetchError, providerMessage, ProviderError } from "../plugins/http";
import type { CallTrace } from "./types";

export { ProviderError };

/** Waiting for the provider to start answering. */
export const FIRST_BYTE_MS = 60_000;
/** Silence allowed between two pieces of a stream (reasoning models pause). */
export const IDLE_MS = 90_000;

type Json = Record<string, unknown>;

export type SendOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** A JSON body (the only kind that can be adjusted and retried), or raw. */
  json?: Json;
  raw?: BodyInit;
  signal?: AbortSignal;
  /** Called with the body and the provider's message after a 400: a new body to try, or null. */
  adjust?: (body: Json, message: string) => Json | null;
  trace?: CallTrace[];
  firstByteMs?: number;
};

/** The response once the provider has started answering (status 2xx), else a ProviderError. */
export async function send(provider: string, url: string, opts: SendOptions): Promise<{ res: Response; controller: AbortController }> {
  let body = opts.json;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(opts.signal?.reason);
    if (opts.signal?.aborted) throw abortError(provider);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), opts.firstByteMs ?? FIRST_BYTE_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method ?? (body || opts.raw ? "POST" : "GET"),
        headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...opts.headers },
        body: body ? JSON.stringify(body) : opts.raw,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.signal?.aborted) throw abortError(provider);
      const timedOut = (controller.signal.reason as { name?: string } | undefined)?.name === "TimeoutError";
      throw new ProviderError(provider, 0, timedOut ? `no answer from ${hostOf(url)} within ${Math.round((opts.firstByteMs ?? FIRST_BYTE_MS) / 1000)} s` : describeFetchError(err, url));
    }
    clearTimeout(timer);
    opts.trace?.push({ url, body: body ?? (opts.raw ? "(binary)" : undefined), status: res.status, attempts: attempt });
    if (res.ok) {
      // The caller's cancel still reaches the body being read.
      return { res, controller };
    }
    opts.signal?.removeEventListener("abort", onAbort);
    const detail = providerMessage(await res.text().catch(() => ""));
    const next = res.status === 400 && body && opts.adjust ? opts.adjust(body, detail) : null;
    if (!next) throw new ProviderError(provider, res.status, detail || res.statusText || "request failed");
    body = next;
  }
  throw new ProviderError(provider, 400, "the request was refused");
}

export async function sendJson<T>(provider: string, url: string, opts: SendOptions): Promise<T> {
  const { res } = await send(provider, url, opts);
  const text = await withIdle(res.text(), opts.signal, provider);
  try { return JSON.parse(text) as T; } catch { throw new ProviderError(provider, res.status, `not JSON: ${text.slice(0, 200)}`); }
}

function abortError(provider: string): ProviderError {
  return new ProviderError(provider, 0, "cancelled");
}

async function withIdle<T>(p: Promise<T>, signal: AbortSignal | undefined, provider: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProviderError(provider, 0, `the answer stopped for ${IDLE_MS / 1000} s`)), IDLE_MS); });
  try {
    if (signal?.aborted) throw abortError(provider);
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The lines of a streamed body; a silence longer than IDLE_MS ends it with an error. */
export async function* lines(res: Response, provider: string, signal?: AbortSignal): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      if (signal?.aborted) throw abortError(provider);
      const { value, done } = await withIdle(reader.read(), signal, provider);
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        yield line;
      }
    }
    buf += decoder.decode();
    if (buf) yield buf.replace(/\r$/, "");
  } catch (err) {
    if (signal?.aborted) throw abortError(provider);
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(provider, 0, `the stream broke: ${(err as Error).message}`);
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

/** Server-Sent Events: { event, data } per blank-line-separated block. */
export async function* sse(res: Response, provider: string, signal?: AbortSignal): AsyncGenerator<{ event: string; data: string }> {
  let event = "";
  let data: string[] = [];
  for await (const line of lines(res, provider, signal)) {
    if (line === "") {
      if (data.length) yield { event, data: data.join("\n") };
      event = "";
      data = [];
      continue;
    }
    if (line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length) yield { event, data: data.join("\n") };
}

/** Newline-delimited JSON (Ollama). */
export async function* ndjson<T>(res: Response, provider: string, signal?: AbortSignal): AsyncGenerator<T> {
  for await (const line of lines(res, provider, signal)) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line) as T; } catch { throw new ProviderError(provider, res.status, `a line of the stream is not JSON: ${line.slice(0, 120)}`); }
  }
}

export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/**
 * The parameter a model refused, left out (or renamed): sampling parameters,
 * reasoning settings a model does not take, max_tokens → max_completion_tokens.
 * Null when the refusal was about something else.
 */
export function withoutRefused(body: Json, message: string): Json | null {
  const m = message.toLowerCase();
  const next = { ...body };
  for (const p of ["temperature", "top_p", "top_k", "reasoning_effort", "response_format", "stream_options"]) {
    if (p in next && m.includes(p)) { delete next[p]; return next; }
  }
  if ("output_config" in next && (m.includes("effort") || m.includes("output_config"))) { delete next.output_config; return next; }
  if ("thinking" in next && m.includes("display") && (next.thinking as { display?: string } | undefined)?.display) {
    const { display: _display, ...rest } = next.thinking as Record<string, unknown>;
    next.thinking = rest;
    return next;
  }
  if ("thinking" in next && m.includes("thinking")) {
    const t = next.thinking as { type?: string } | undefined;
    // Adaptive refused: a model of an older generation takes a budget; disabled refused: leave it to the model.
    if (t?.type === "adaptive") {
      const max = typeof next.max_tokens === "number" ? next.max_tokens : 4096;
      next.thinking = { type: "enabled", budget_tokens: Math.max(1024, Math.min(8000, Math.floor(max / 2))) };
      next.max_tokens = max + (next.thinking as { budget_tokens: number }).budget_tokens;
      return next;
    }
    delete next.thinking;
    return next;
  }
  if ("max_tokens" in next && m.includes("max_tokens") && m.includes("max_completion_tokens")) {
    next.max_completion_tokens = next.max_tokens;
    delete next.max_tokens;
    return next;
  }
  return null;
}
