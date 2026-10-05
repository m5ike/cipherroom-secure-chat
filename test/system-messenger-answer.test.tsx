// 6.11: a model's answer is an INCOMING message from "system-messenger" —
// the model's name as the nickname, its icon as the avatar, a reply to the
// command's message — as wide as its content. A room answer is the caller's
// own message shown under the model's identity "via <caller>", and no peer
// can pass a message off as the system's. The call's own bubble keeps the
// query and a short status (running with its progress / done / error).

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { MessageBubble } from "../client/src/components/MessageBubble";
import { ModelBadge, modelIconName } from "../client/src/components/fn/ModelBadge";
import { validatePayload, isReservedSender } from "../client/src/lib/validate";
import { modelAnswerView } from "../client/src/lib/fn-answer";
import { SYSTEM_MESSENGER_ID, cleanModelIcon, isModelSender, modelIdentity } from "../client/src/lib/system-messenger";
import { prepareHistory, sanitizeRestored } from "../client/src/lib/chat-history";
import type { ChatMessage } from "../client/src/lib/chat-types";
import type { MsgFlags } from "../client/src/lib/message-kinds";

afterEach(() => cleanup());

const noop = () => undefined;
const plain = (s: string) => <span>{s}</span>;

function bubble(m: Pick<ChatMessage, "id" | "senderId" | "senderName" | "mine" | "text"> & { flags?: MsgFlags; replyTo?: ChatMessage["replyTo"] }, extra: Record<string, unknown> = {}) {
  const model = modelAnswerView({ senderId: m.senderId, senderName: m.senderName, mine: m.mine, flags: m.flags });
  return render(
    <MessageBubble
      id={m.id} senderId={m.senderId} senderName={m.senderName} mine={m.mine} isSystem={false} secure
      createdAt={0} timeLabel="10:42" text={m.text} flags={m.flags} replyTo={m.replyTo}
      onVanish={noop} lang="cs" renderText={plain} formatSize={(n) => `${n} B`}
      badge={undefined as never} model={model} {...extra}
    />,
  );
}

const mailAnswer = {
  id: "fn-1", senderId: SYSTEM_MESSENGER_ID, senderName: "E-mail analysis", mine: false,
  text: "## ✉️ E-mail — example.org",
  flags: { fn: { keyword: "mail", name: "E-mail analysis", icon: "mail", chain: "chn_abc123def", call: 0, events: ["button", "form"], outputs: [{ type: "markdown" as const, text: "## E-mail — example.org\n\n| a | b |\n|---|---|\n| 1 | 2 |" }, { type: "button" as const, name: "again", title: "Check again" }] } },
  replyTo: { id: "fncall_abc", senderName: "Michael", text: "/mail example.org" },
};

describe("who may be system-messenger", () => {
  it("a peer can never send as system-messenger (or as a function, or the system)", () => {
    for (const id of [SYSTEM_MESSENGER_ID, `${SYSTEM_MESSENGER_ID}:mail`, "function:mail", "system"]) {
      expect(isReservedSender(id)).toBe(true);
      expect(validatePayload({ id: "m1", senderId: id, senderName: "E-mail analysis", text: "hi", flags: { fn: { keyword: "mail", name: "E-mail analysis" } } }, { transportSender: id, myId: "me" })).toBeNull();
    }
    expect(isReservedSender("peer-1234")).toBe(false);
    expect(isModelSender(SYSTEM_MESSENGER_ID)).toBe(true);
    expect(isModelSender("function:mail")).toBe(true);
    expect(isModelSender("peer-1")).toBe(false);
  });

  it("a room answer carries the model's icon — display only, checked like anything else from a peer", () => {
    const ok = validatePayload({ id: "m1", senderId: "p2", senderName: "Alice", text: "x", flags: { fn: { keyword: "mail", name: "E-mail analysis", icon: "mail" } } }, { transportSender: "p2", myId: "me" });
    expect((ok as { flags: MsgFlags }).flags.fn).toEqual({ keyword: "mail", name: "E-mail analysis", icon: "mail" });
    const emoji = validatePayload({ id: "m2", senderId: "p2", senderName: "Alice", text: "x", flags: { fn: { keyword: "w", name: "W", icon: "🌦️" } } }, { transportSender: "p2", myId: "me" });
    expect((emoji as { flags: MsgFlags }).flags.fn?.icon).toBe("🌦️");
    for (const bad of ["<img src=x>", "javascript:alert(1)", "M", "Ab", "‮evil", "a".repeat(60), 5]) {
      const p = validatePayload({ id: "m3", senderId: "p2", senderName: "Alice", text: "x", flags: { fn: { keyword: "w", name: "W", icon: bad } } }, { transportSender: "p2", myId: "me" });
      expect((p as { flags: MsgFlags }).flags.fn?.icon).toBeUndefined();
    }
    expect(cleanModelIcon("shield-check")).toBe("shield-check");
    expect(cleanModelIcon("📞")).toBe("📞");
    expect(cleanModelIcon("1")).toBeUndefined();
  });
});

describe("modelAnswerView", () => {
  it("system-messenger's own answer, a peer's room answer (via them), my room answer (via me)", () => {
    expect(modelAnswerView(mailAnswer)).toMatchObject({ identity: { keyword: "mail", name: "E-mail analysis", icon: "mail" }, via: null });
    const peer = modelAnswerView({ senderId: "p2", senderName: "Alice", mine: false, flags: { fn: { keyword: "hlr", name: "HLR lookup" } } });
    expect(peer).toMatchObject({ identity: { keyword: "hlr", name: "HLR lookup", icon: "phone" }, via: { name: "Alice", mine: false } });
    expect(modelAnswerView({ senderId: "me", senderName: "Michael", mine: true, flags: { fn: { keyword: "hlr", name: "HLR lookup" } } })?.via).toEqual({ name: "Michael", mine: true });
    // An older caller-only answer ("function:<keyword>") shows the same way.
    expect(modelAnswerView({ senderId: "function:pocasi", senderName: "Počasí", mine: false, flags: { fn: { keyword: "pocasi", name: "Počasí" } } })?.via).toBeNull();
  });

  it("a call's own bubble and an ordinary message are not answers", () => {
    expect(modelAnswerView({ senderId: "me", senderName: "M", mine: true, flags: { fn: { keyword: "mail", name: "E", query: "/mail", pending: true } } })).toBeNull();
    expect(modelAnswerView({ senderId: "me", senderName: "M", mine: true, flags: { fn: { keyword: "mail", name: "E", query: "/mail", status: { kind: "ok", label: "x" } } } })).toBeNull();
    expect(modelAnswerView({ senderId: "p2", senderName: "A", mine: false })).toBeNull();
    expect(modelAnswerView({ senderId: "p2", senderName: "A", mine: false, flags: { tap: true } })).toBeNull();
  });
});

describe("the answer's bubble", () => {
  it("is incoming, from the model (its name, its icon), a reply to the command — and wide", () => {
    const jump = vi.fn();
    const r = bubble(mailAnswer, { onReplyJump: jump });
    const row = r.getByTestId("message-fn-1");
    const b = row.querySelector(".msg-bubble")!;
    expect(b.className).toContain("msg-bubble--theirs");
    expect(b.className).toContain("msg-bubble--fn-answer");
    expect(row.className).toContain("justify-start");
    const badge = r.getByTestId("model-badge-mail");
    expect(badge.textContent).toContain("E-mail analysis");
    expect(badge.textContent).toContain("/mail");
    expect(badge.querySelector(".model-avatar")?.getAttribute("data-icon")).toBe("mail");
    expect(badge.querySelector(".model-avatar svg")).not.toBeNull();
    expect((badge.querySelector(".model-avatar") as HTMLElement).style.background).not.toBe("");
    expect(r.queryByTestId("model-badge-via")).toBeNull();
    // The reply quote: the command line; a tap goes to the command's bubble.
    const quote = r.getByTestId("msg-quote-fn-1");
    expect(quote.textContent).toContain("/mail example.org");
    fireEvent.click(quote);
    expect(jump).toHaveBeenCalledWith("fncall_abc");
    // The outputs are this browser's own: they act (a table, an active button).
    expect(r.getByTestId("fn-answer").querySelector("table")).not.toBeNull();
    const btn = Array.from(row.querySelectorAll("button")).find((x) => x.textContent?.includes("Check again")) as HTMLButtonElement;
    expect(btn).toBeDefined();
    expect(btn.disabled).toBe(false);
  });

  it("an emoji icon is drawn as it is, in the model's colour", () => {
    const r = bubble({ ...mailAnswer, id: "fn-2", flags: { fn: { ...mailAnswer.flags.fn, keyword: "pocasi", name: "Počasí", icon: "🌦️" } } });
    const avatar = r.getByTestId("model-badge-pocasi").querySelector(".model-avatar") as HTMLElement;
    expect(avatar.textContent).toBe("🌦️");
    expect(avatar.getAttribute("data-icon")).toBe("emoji");
    expect(avatar.style.background).toBeTruthy();
  });

  it("a room answer from another member names them: 'via Alice' (a click opens their details)", () => {
    const via = vi.fn();
    const r = bubble({ id: "m-room", senderId: "p2", senderName: "Alice", mine: false, text: "**+420603123456**: O2", flags: { fn: { keyword: "hlr", name: "HLR lookup", icon: "phone", outputs: [{ type: "markdown", text: "**+420603123456**: O2" }] } }, replyTo: { id: "fncall_x", senderName: "Alice", text: "/hlr" } }, { onVia: via });
    const badge = r.getByTestId("model-badge-hlr");
    expect(badge.textContent).toContain("HLR lookup");
    const v = r.getByTestId("model-badge-via");
    expect(v.textContent).toBe("přes Alice");
    fireEvent.click(v);
    expect(via).toHaveBeenCalledOnce();
    expect(r.getByTestId("message-m-room").querySelector(".msg-bubble")!.className).toContain("msg-bubble--fn-answer");
  });

  it("my own room answer is drawn as the model's too, 'via you'", () => {
    const r = bubble({ id: "m-mine", senderId: "me", senderName: "Michael", mine: true, text: "x", flags: { fn: { keyword: "hlr", name: "HLR lookup", outputs: [{ type: "text", text: "x" }] } } });
    expect(r.getByTestId("message-m-mine").querySelector(".msg-bubble")!.className).toContain("msg-bubble--theirs");
    expect(r.getByTestId("model-badge-via").textContent).toBe("přes vás");
  });

  it("ModelBadge works on its own (English), and unknown lucide names fall back to a near one / 'bot'", () => {
    const r = render(<ModelBadge identity={modelIdentity({ keyword: "hlr", name: "HLR lookup" })} via={{ name: "Bob", mine: false }} lang="en" />);
    expect(r.getByTestId("model-badge-via").textContent).toBe("via Bob");
    expect(modelIconName("mail")).toBe("mail");
    expect(modelIconName("phone-call")).toBe("phone-outgoing");
    expect(modelIconName("help-circle")).toBe("circle-question-mark");
    expect(modelIconName("no-such-icon")).toBe("bot");
  });
});

describe("the call's own bubble (6.11)", () => {
  const call = (fn: Record<string, unknown>) => render(
    <MessageBubble id="call-1" senderId="me" senderName="Me" mine isSystem={false} secure createdAt={0} timeLabel="" text="/mail"
      flags={{ fn: { keyword: "mail", name: "E-mail analysis", query: "/mail", ...fn } } as MsgFlags}
      onVanish={noop} lang="cs" renderText={plain} formatSize={(n) => `${n} B`} />,
  );

  it("while running: the loading and what the run says of its progress", () => {
    const r = call({ pending: true, progress: { p: 0.4, text: "looking up MX…" } });
    expect(r.getByTestId("fn-loading").textContent).toContain("Spouštím E-mail analysis…");
    expect(r.getByTestId("fn-progress").textContent).toContain("looking up MX…");
    expect((r.getByTestId("fn-progress").querySelector(".fn-loading__bar i") as HTMLElement).style.width).toBe("40%");
  });

  it("failed: no loading, no pulse, an error icon with the reason and the code", () => {
    const r = call({ pending: false, status: { kind: "error", label: "Model neodpověděl do 30 s.", code: "timeout" } });
    expect(r.queryByTestId("fn-loading")).toBeNull();
    const chip = r.getByTestId("fn-status");
    expect(chip.className).toContain("fn-status--error");
    expect(chip.querySelector("svg.fn-status__icon")).not.toBeNull();
    expect(chip.textContent).toContain("Model neodpověděl do 30 s.");
    expect(chip.textContent).toContain("timeout");
    const b = r.getByTestId("message-call-1").querySelector(".msg-bubble")!;
    expect(b.className).not.toContain("msg-bubble--fn-running");
    expect(b.className).toContain("msg-bubble--fn-failed");
    expect(b.className).toContain("msg-bubble--mine");
  });

  it("a status said by its code (stored ones: interrupted; a wrong call: bad-input), in the viewer's language", () => {
    const r = call({ pending: false, status: { kind: "error", label: "", code: "interrupted" } });
    expect(r.getByTestId("fn-status").textContent).toContain("Přerušeno — stránka se mezitím znovu načetla");
    cleanup();
    const b = call({ pending: false, status: { kind: "error", label: "", code: "bad-input" } });
    expect(b.getByTestId("fn-status").textContent).toContain("Chybné parametry — viz odpověď");
  });

  it("cancelled by a newer command: a quiet chip", () => {
    const r = call({ pending: false, status: { kind: "info", label: "Zrušeno — spustili jste další příkaz", code: "cancelled" } });
    const chip = r.getByTestId("fn-status");
    expect(chip.className).toContain("fn-status--info");
    expect(chip.getAttribute("data-code")).toBe("cancelled");
    expect(chip.querySelector(".fn-status__code")).toBeNull();
  });
});

describe("history", () => {
  it("system-messenger's answers round-trip; a call stored while running comes back interrupted", () => {
    const stored: ChatMessage[] = [
      { id: "fncall_1", senderId: "peer-me", senderName: "Michael", text: "/mail", createdAt: 1, mine: true, secure: true, flags: { fn: { keyword: "mail", name: "E-mail analysis", icon: "mail", query: "/mail", pending: true, progress: { p: 0.2, text: "…" } } } },
      { ...mailAnswer, createdAt: 2, secure: true } as ChatMessage,
    ];
    const back = sanitizeRestored(JSON.parse(JSON.stringify(prepareHistory(stored))), "peer-new");
    expect(back[0].flags?.fn).toEqual({ keyword: "mail", name: "E-mail analysis", icon: "mail", query: "/mail", pending: false, status: { kind: "error", label: "", code: "interrupted" } });
    expect(back[1].senderId).toBe(SYSTEM_MESSENGER_ID);
    expect(back[1].mine).toBe(false);
    expect(back[1].replyTo).toEqual(mailAnswer.replyTo);
    expect(back[1].flags?.fn?.icon).toBe("mail");
    expect(modelAnswerView(back[1])?.identity.name).toBe("E-mail analysis");
  });
});
