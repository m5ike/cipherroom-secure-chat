// A chat command's output travels as a message with the `fn` flag and renders
// as Markdown in the bubble (4.15).

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MessageBubble } from "../client/src/components/MessageBubble";
import { validatePayload } from "../client/src/lib/validate";

afterEach(() => cleanup());

describe("the fn flag on the wire", () => {
  it("round-trips through payload validation", () => {
    const p = validatePayload(
      { id: "m1", senderId: "peer2", senderName: "Alice", text: "# Hi", flags: { fn: { keyword: "pocasi", name: "Počasí" } } },
      { transportSender: "peer2", myId: "me" },
    );
    expect(p).not.toBeNull();
    expect((p as { flags?: { fn?: { keyword: string; name: string } } }).flags?.fn).toEqual({ keyword: "pocasi", name: "Počasí" });
  });

  it("drops a malformed fn flag", () => {
    const p = validatePayload(
      { id: "m2", senderId: "peer2", senderName: "Alice", text: "hi", flags: { fn: { name: "no keyword" } } },
      { transportSender: "peer2", myId: "me" },
    );
    expect((p as { flags?: unknown }).flags).toBeUndefined();
  });
});

describe("the bubble renders a command output as Markdown", () => {
  const renderBubble = (flags?: { fn?: { keyword: string; name: string } }) => render(
    <MessageBubble
      id="fn-1"
      senderId="function:pocasi"
      senderName="Počasí"
      mine={false}
      isSystem={false}
      secure
      createdAt={Date.now()}
      timeLabel=""
      text={"**Praha**: 21°C\n\n| k | v |\n|---|---|\n| a | 1 |"}
      flags={flags}
      onVanish={() => undefined}
      lang="cs"
      renderText={(s) => <span data-testid="plain">{s}</span>}
      formatSize={(n) => `${n} B`}
    />,
  );

  it("renders Markdown (bold, table) when flags.fn is set", () => {
    const r = renderBubble({ fn: { keyword: "pocasi", name: "Počasí" } });
    const bubble = r.getByTestId("message-fn-1");
    expect(bubble.querySelector("strong")?.textContent).toBe("Praha");
    expect(bubble.querySelector("table")).not.toBeNull();
    expect(bubble.querySelector("td")?.textContent).toBe("a");
    expect(bubble.querySelector('[data-testid="plain"]')).toBeNull();
  });

  it("stays plain text without the flag", () => {
    const r = renderBubble(undefined);
    const bubble = r.getByTestId("message-fn-1");
    expect(bubble.querySelector("table")).toBeNull();
    expect(bubble.querySelector('[data-testid="plain"]')).not.toBeNull();
  });
});

describe("6.5 — the call's own bubble (pending → result / status)", () => {
  const renderCall = (flags: { fn: Record<string, unknown> }, text = "/pocasi Praha") => render(
    <MessageBubble
      id="call-1" senderId="me" senderName="Me" mine isSystem={false} secure
      createdAt={Date.now()} timeLabel="" text={text} flags={flags as never}
      onVanish={() => undefined} lang="cs"
      renderText={(s) => <span data-testid="plain">{s}</span>}
      formatSize={(n) => `${n} B`}
    />,
  );

  it("while pending: shows the query, the loading indicator, and the bubble pulses", () => {
    const r = renderCall({ fn: { keyword: "pocasi", name: "Počasí", query: "/pocasi Praha", pending: true } });
    const bubble = r.getByTestId("message-call-1");
    expect(r.getByTestId("fn-loading")).not.toBeNull();
    expect(bubble.querySelector(".fn-call__query")?.textContent).toContain("/pocasi Praha");
    expect(bubble.querySelector(".msg-bubble--fn-running")).not.toBeNull();
    expect(r.queryByTestId("fn-status")).toBeNull();
  });

  it("on a caller answer: the loading is replaced by the result, the query stays, no more pulse", () => {
    const r = renderCall({ fn: { keyword: "pocasi", name: "Počasí", query: "/pocasi Praha", pending: false, outputs: [{ type: "markdown", text: "**Praha**: 21°C" }] } }, "**Praha**: 21°C");
    const bubble = r.getByTestId("message-call-1");
    expect(r.queryByTestId("fn-loading")).toBeNull();
    expect(bubble.querySelector(".fn-call__query")?.textContent).toContain("/pocasi Praha");
    expect(bubble.querySelector("strong")?.textContent).toBe("Praha");
    expect(bubble.querySelector(".msg-bubble--fn-running")).toBeNull();
  });

  it("on a room answer or error: the loading is replaced by a status chip", () => {
    const sent = renderCall({ fn: { keyword: "pocasi", name: "Počasí", query: "/pocasi Praha", pending: false, status: { kind: "ok", label: "Odesláno do místnosti" } } });
    expect(sent.getByTestId("fn-status").textContent).toContain("Odesláno do místnosti");
    cleanup();
    const err = renderCall({ fn: { keyword: "x", name: "X", query: "/x", pending: false, status: { kind: "error", label: "selhalo" } } });
    expect(err.getByTestId("fn-status").className).toContain("fn-status--error");
    expect(err.queryByTestId("fn-loading")).toBeNull();
  });
});
