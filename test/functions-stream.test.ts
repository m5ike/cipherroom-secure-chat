// The client's streaming command run parses SSE into handler calls, and
// answering posts the value to the run's events endpoint (4.15).

import { describe, it, expect, vi, afterEach } from "vitest";
import { runCommandStream, answerInteraction } from "../client/src/lib/functions";

afterEach(() => { vi.restoreAllMocks(); });

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("runCommandStream", () => {
  it("turns SSE events into handler calls in order", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      "event: start\ndata: {\"runId\":\"run_1\",\"name\":\"Kviz\"}\n\n",
      "event: interaction\ndata: {\"runId\":\"run_1\",\"id\":\"int_1\",\"kind\":\"prompt\",\"spec\":{\"text\":\"x\",\"choices\":[\"a\",\"b\"]}}\n\n",
      "event: done\ndata: {\"runId\":\"run_1\",\"status\":\"done\",\"outputs\":[{\"type\":\"text\",\"text\":\"hi\"}],\"error\":null,\"visibility\":\"caller\"}\n\n",
    ])));
    const calls: string[] = [];
    let runId = "";
    let interaction: { id: string; kind: string } | null = null;
    let done: { status: string; outputs: unknown[] } | null = null;
    await runCommandStream(
      { keyword: "kviz", inputs: {}, room: null, client: null, lang: "cs", token: "t" },
      {
        onStart: (id) => { runId = id; calls.push("start"); },
        onInteraction: (i) => { interaction = { id: i.id, kind: i.kind }; calls.push("interaction"); },
        onDone: (d) => { done = { status: d.status, outputs: d.outputs }; calls.push("done"); },
        onError: () => calls.push("error"),
      },
    );
    expect(calls).toEqual(["start", "interaction", "done"]);
    expect(runId).toBe("run_1");
    expect(interaction).toEqual({ id: "int_1", kind: "prompt" });
    expect(done).toEqual({ status: "done", outputs: [{ type: "text", text: "hi" }] });
  });

  it("reports a non-ok response as an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, code: "off", message: "off" }), { status: 404 })));
    let err: { code: string } | null = null;
    await runCommandStream({ keyword: "x", inputs: {}, room: null, client: null, lang: "cs", token: null }, { onError: (e) => { err = e; } });
    expect(err).toEqual({ code: "off", message: "off" });
  });
});

describe("answerInteraction", () => {
  it("posts the value to the run's events endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await answerInteraction("run_9", "int_2", "ano", "tok");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/functions/runs/run_9/events");
    expect(JSON.parse(init.body as string)).toEqual({ interactionId: "int_2", value: "ano" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });
});
