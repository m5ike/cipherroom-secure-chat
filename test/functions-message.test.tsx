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
