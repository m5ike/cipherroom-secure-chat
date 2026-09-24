// The app's AI assistant (client/src/components/AiPanel.tsx, 4.14) with a
// pretend server: Enter sends, the answer appears as it is written (as
// Markdown), Stop keeps what came, a refusal is said in the user's language,
// a failed answer is not sent back to the model, the last answer goes into
// the message, the model and reasoning are remembered.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import { AiPanel } from "../client/src/components/AiPanel";
import type { AiStatus, aiChat } from "../client/src/lib/ai";

afterEach(() => cleanup());
beforeEach(() => { try { localStorage.clear(); } catch { /* none */ } });

const STATUS: AiStatus = {
  enabled: true, state: "ready", default: "p/big", limits: { maxOutputTokens: 1000, maxInputChars: 5000 },
  models: [{ ref: "p/big", label: "Big", provider: "P", reasoning: true, vision: false }, { ref: "p/small", label: "Small", provider: "P", reasoning: false, vision: false }],
};
const status = async () => STATUS;
const tick = (ms = 30) => act(async () => { await new Promise((ok) => setTimeout(ok, ms)); });

type Call = Parameters<typeof aiChat>[0];

function fakeChat(script: Array<(h: Parameters<typeof aiChat>[1], signal?: AbortSignal) => Promise<Awaited<ReturnType<typeof aiChat>>>>) {
  const calls: Call[] = [];
  const chat: typeof aiChat = async (input, h, signal) => { calls.push(input); return script.shift()!(h, signal); };
  return { calls, chat };
}
const done = (text: string) => ({ ok: true as const, done: { text, model: "big", ref: "p/big", usage: { input: 5, output: 7 }, cost: null, ms: 1200, finish: "end_turn" } });

async function type(el: Element, text: string) {
  fireEvent.change(el, { target: { value: text } });
  await tick(5);
}

describe("the assistant", () => {
  it("sends on Enter, draws the answer as it streams (Markdown), then says how long it took", async () => {
    let release!: () => void;
    const { calls, chat } = fakeChat([async (h) => {
      h.onReasoning?.("hmm");
      h.onText?.("**Ahoj**, ");
      await new Promise<void>((ok) => { release = ok; });
      h.onText?.("jak se máš?");
      return done("**Ahoj**, jak se máš?");
    }]);
    const r = render(<AiPanel lang="cs" onInsert={() => undefined} loadStatus={status} chat={chat} />);
    await tick();
    const input = r.getByTestId("ai-input");
    await type(input, "Ahoj");
    fireEvent.keyDown(input, { key: "Enter" });
    await tick(40);
    expect(r.getByTestId("ai-stop")).toBeTruthy();
    expect(r.getAllByTestId("ai-answer")[0].innerHTML).toContain("<strong>Ahoj</strong>");
    expect(r.container.querySelector(".ai-cursor")).not.toBeNull();
    release();
    await tick(40);
    expect(r.getByTestId("ai-answer").textContent).toBe("Ahoj, jak se máš?");
    expect(r.container.querySelector(".ai-msg__stats")!.textContent).toBe("1.2 s · 7 tokenů");
    expect(r.container.querySelector(".ai-msg__reasoning-text")!.textContent).toBe("hmm");
    expect(calls[0]).toEqual({ model: "p/big", reasoning: "off", messages: [{ role: "user", content: "Ahoj" }] });
    // Shift+Enter is a new line, not a send.
    await type(input, "a");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    await tick();
    expect(calls).toHaveLength(1);
  });

  it("Stop keeps what came; a refusal is in the user's words; a failed turn is not sent again", async () => {
    const { calls, chat } = fakeChat([
      async (h, signal) => { h.onText?.("část"); await new Promise<void>((ok) => signal?.addEventListener("abort", () => ok())); return { ok: false, code: "cancelled", message: "" }; },
      async () => ({ ok: false, code: "user-limit", message: "You have used today's AI requests; more tomorrow." }),
      async () => done("OK"),
    ]);
    const r = render(<AiPanel lang="cs" onInsert={() => undefined} loadStatus={status} chat={chat} />);
    await tick();
    const input = r.getByTestId("ai-input");
    await type(input, "první");
    fireEvent.submit(r.getByTestId("ai-form"));
    await tick(40);
    fireEvent.click(r.getByTestId("ai-stop"));
    await tick(40);
    expect(r.getAllByTestId("ai-answer")[0].textContent).toBe("část");
    expect(r.container.querySelector(".ai-msg__stats")!.textContent).toBe("Zastaveno");
    await type(input, "druhá");
    fireEvent.submit(r.getByTestId("ai-form"));
    await tick(40);
    expect(r.getByTestId("ai-error").textContent).toBe("Dnešní limit AI jste vyčerpali; zítra zase.");
    await type(input, "třetí");
    fireEvent.submit(r.getByTestId("ai-form"));
    await tick(40);
    // The stopped answer (with text) is history; the refused turn is not.
    expect(calls[2].messages).toEqual([{ role: "user", content: "první" }, { role: "assistant", content: "část" }, { role: "user", content: "třetí" }]);
  });

  it("inserts the last answer; remembers the model and reasoning; reasoning only for a model that has it", async () => {
    const inserted: string[] = [];
    const { calls, chat } = fakeChat([async () => done("Hotovo."), async () => done("Znovu.")]);
    const r = render(<AiPanel lang="en" onInsert={(t) => inserted.push(t)} loadStatus={status} chat={chat} />);
    await tick();
    fireEvent.change(r.getByTestId("ai-reasoning"), { target: { value: "high" } });
    await tick(5);
    await type(r.getByTestId("ai-input"), "x");
    fireEvent.submit(r.getByTestId("ai-form"));
    await tick(40);
    expect(calls[0].reasoning).toBe("high");
    fireEvent.click(r.getByTestId("ai-insert"));
    expect(inserted).toEqual(["Hotovo."]);
    fireEvent.change(r.getByTestId("ai-model"), { target: { value: "p/small" } });
    await tick(5);
    expect(r.queryByTestId("ai-reasoning")).toBeNull();
    await type(r.getByTestId("ai-input"), "y");
    fireEvent.submit(r.getByTestId("ai-form"));
    await tick(40);
    expect(calls[1]).toMatchObject({ model: "p/small", reasoning: "off" });
    expect(JSON.parse(localStorage.getItem("m5cet:ai")!)).toEqual({ model: "p/small", reasoning: "high" });
    // A new conversation forgets the turns.
    fireEvent.click(r.getByTestId("ai-new"));
    await tick(5);
    expect(r.queryAllByTestId("ai-msg")).toHaveLength(0);
  });

  it("says why it cannot be used, and offers signing in", async () => {
    let signIn = 0;
    const r = render(<AiPanel lang="cs" onInsert={() => undefined} onSignIn={() => { signIn += 1; }} loadStatus={async () => ({ ...STATUS, state: "sign-in", enabled: false, models: [] })} />);
    await tick();
    expect(r.getByTestId("ai-state").textContent).toContain("jen přihlášení uživatelé");
    fireEvent.click(r.getByTestId("ai-sign-in"));
    expect(signIn).toBe(1);
    cleanup();
    const off = render(<AiPanel lang="en" onInsert={() => undefined} loadStatus={async () => ({ ...STATUS, state: "no-limit", enabled: false })} />);
    await tick();
    expect(off.getByTestId("ai-state").textContent).toContain("waiting for the server's owner to set a monthly limit");
    expect(off.queryByTestId("ai-input")).toBeNull();
  });
});
