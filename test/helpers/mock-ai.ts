// A pretend AI provider for the tests (4.14): a real HTTP server on
// 127.0.0.1 that answers like Anthropic, OpenAI-compatible servers, Ollama or
// ElevenLabs would — JSON, Server-Sent Events, newline-delimited JSON — and
// records what it was sent.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Seen = { method: string; path: string; headers: IncomingMessage["headers"]; body: unknown; raw: Buffer };
export type Handler = (req: Seen, res: ServerResponse) => void | Promise<void>;

export type MockProvider = {
  url: string;
  seen: Seen[];
  /** Handlers by "METHOD /path" (the query is ignored); the first matching wins. */
  on(route: string, handler: Handler): void;
  close(): Promise<void>;
};

export async function mockProvider(): Promise<MockProvider> {
  const routes: Array<[string, Handler]> = [];
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      let body: unknown = raw.length ? raw.toString("utf8") : undefined;
      if (String(req.headers["content-type"] ?? "").includes("application/json")) {
        try { body = JSON.parse(raw.toString("utf8")); } catch { /* keep text */ }
      }
      const path = (req.url ?? "/").split("?")[0];
      const entry: Seen = { method: req.method ?? "GET", path, headers: req.headers, body, raw };
      seen.push(entry);
      const hit = routes.find(([r]) => r === `${entry.method} ${path}`);
      if (!hit) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: `no route ${entry.method} ${path}` } })); return; }
      void Promise.resolve(hit[1](entry, res)).catch((err) => { res.writeHead(500); res.end(String(err)); });
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    on(route, handler) { routes.unshift([route, handler]); },
    close: () => new Promise<void>((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }),
  };
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Server-Sent Events, one piece every `gapMs`. */
export async function sse(res: ServerResponse, events: Array<{ event?: string; data: unknown }>, gapMs = 2): Promise<void> {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  for (const e of events) {
    res.write(`${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`);
    await new Promise((ok) => setTimeout(ok, gapMs));
  }
  res.end();
}

export async function ndjson(res: ServerResponse, lines: unknown[], gapMs = 2): Promise<void> {
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  for (const l of lines) {
    res.write(`${JSON.stringify(l)}\n`);
    await new Promise((ok) => setTimeout(ok, gapMs));
  }
  res.end();
}

/** An Anthropic stream that says `text` in pieces (and thinks first, when asked). */
export function anthropicStream(text: string, opts: { thinking?: string; model?: string; input?: number; output?: number } = {}): Array<{ event: string; data: unknown }> {
  const ev: Array<{ event: string; data: unknown }> = [
    { event: "message_start", data: { type: "message_start", message: { model: opts.model ?? "claude-sonnet-5", usage: { input_tokens: opts.input ?? 12, output_tokens: 1 } } } },
  ];
  if (opts.thinking) {
    ev.push({ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } });
    ev.push({ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: opts.thinking } } });
    ev.push({ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } });
  }
  const idx = opts.thinking ? 1 : 0;
  ev.push({ event: "content_block_start", data: { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } } });
  ev.push({ event: "ping", data: { type: "ping" } });
  for (const piece of text.match(/.{1,4}/gs) ?? []) ev.push({ event: "content_block_delta", data: { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: piece } } });
  ev.push({ event: "content_block_stop", data: { type: "content_block_stop", index: idx } });
  ev.push({ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: opts.output ?? 7 } } });
  ev.push({ event: "message_stop", data: { type: "message_stop" } });
  return ev;
}

/** An OpenAI-compatible stream (with usage at the end unless `noUsage`). */
export function openAiStream(text: string, opts: { reasoning?: string; model?: string; noUsage?: boolean; citations?: string[] } = {}): Array<{ data: unknown }> {
  const ev: Array<{ data: unknown }> = [];
  if (opts.reasoning) ev.push({ data: { model: opts.model ?? "m", choices: [{ delta: { reasoning_content: opts.reasoning } }] } });
  for (const piece of text.match(/.{1,3}/gs) ?? []) ev.push({ data: { model: opts.model ?? "m", choices: [{ delta: { content: piece } }] } });
  ev.push({ data: { model: opts.model ?? "m", choices: [{ delta: {}, finish_reason: "stop" }], ...(opts.citations ? { citations: opts.citations } : {}) } });
  if (!opts.noUsage) ev.push({ data: { model: opts.model ?? "m", choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 2 } } } });
  ev.push({ data: "[DONE]" });
  return ev;
}
