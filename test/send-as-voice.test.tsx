// 6.8 "Send as voice" is a checkbox of the send options ("Message type"):
// ticked, Send (the button, Enter) sends the text as a voice message (the
// server's text to speech) instead of the text; unticked, the text. It stays
// on after a send like the other kinds (only unticking or Clear turns it
// off); sealed + voice is refused (the text never goes in clear instead);
// the composer layout shows it ($sendAsVoice).

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { createRef, useState } from "react";
import { SendOptions, DEFAULT_SEND_STATE, activeCount, type SendState } from "../client/src/components/SendOptions";
import { composerSendRoute, sendFromComposer, voiceTooBigFor, SPEAK_SEND_MAX } from "../client/src/lib/speak-send";
import { renderLayout, type LayoutEnv } from "../client/src/components/LayoutView";
import { DEFAULT_LAYOUTS } from "../client/src/lib/layouts";
import { LAYOUT_CONTRACTS } from "../client/src/lib/layouts/contracts";
import { PREVIEW_VARIANTS } from "../client/src/lib/layouts/samples";
import { t, type Lang } from "../client/src/lib/i18n";

afterEach(() => cleanup());

/** The send options as the app holds them: the state lives outside, Send goes to `onSend`. */
function Harness({ initial = DEFAULT_SEND_STATE, onSend, onState, voiceBusy = false }: { initial?: SendState; onSend: () => void; onState?: (s: SendState) => void; voiceBusy?: boolean }) {
  const [value, setValue] = useState(initial);
  return <SendOptions value={value} onChange={(s) => { setValue(s); onState?.(s); }} onSend={onSend} canSend lang="en" voiceOption voiceBusy={voiceBusy} />;
}

describe("the send state", () => {
  it("is off by default and counts as an option when on", () => {
    expect(DEFAULT_SEND_STATE.asVoice).toBe(false);
    expect(activeCount(DEFAULT_SEND_STATE)).toBe(0);
    expect(activeCount({ ...DEFAULT_SEND_STATE, asVoice: true })).toBe(1);
    expect(activeCount({ ...DEFAULT_SEND_STATE, asVoice: true, tap: true, vanishSeconds: 15 })).toBe(3);
  });
});

describe("the checkbox in the send options", () => {
  it("ticks and unticks asVoice; the send button then shows a speaker and says it sends as voice", () => {
    const states: SendState[] = [];
    const r = render(<Harness onSend={() => undefined} onState={(s) => states.push(s)} />);
    const send = r.getByTestId("button-send");
    expect(send.getAttribute("aria-label")).toBe("Send");
    expect(send.hasAttribute("data-voice")).toBe(false);
    fireEvent.click(r.getByTestId("button-send-options"));
    fireEvent.click(r.getByTestId("opt-send-voice"));
    expect(states.at(-1)).toEqual({ ...DEFAULT_SEND_STATE, asVoice: true });
    expect((r.getByTestId("opt-send-voice") as HTMLInputElement).checked).toBe(true);
    expect(send.getAttribute("aria-label")).toBe(t("en", "speakSend.button"));
    expect(send.getAttribute("title")).toBe(t("en", "speakSend.button"));
    expect(send.getAttribute("data-voice")).toBe("on");
    // the badge on the options chevron counts it like a message kind
    expect(r.getByTestId("button-send-options").textContent).toBe("1");
    expect(r.getByText(t("en", "speakSend.optHint"))).toBeTruthy();
    fireEvent.click(r.getByTestId("opt-send-voice"));
    expect(states.at(-1)).toEqual(DEFAULT_SEND_STATE);
    expect(send.getAttribute("aria-label")).toBe("Send");
  });

  it("is not offered when the app does not give it", () => {
    const r = render(<SendOptions value={DEFAULT_SEND_STATE} onChange={() => undefined} onSend={() => undefined} canSend lang="en" />);
    fireEvent.click(r.getByTestId("button-send-options"));
    expect(r.queryByTestId("opt-send-voice")).toBeNull();
  });

  it("stays on after Send, like the other kinds — only unticking or Clear turns it off", () => {
    const onSend = vi.fn();
    const states: SendState[] = [];
    const r = render(<Harness initial={{ ...DEFAULT_SEND_STATE, asVoice: true, tap: true }} onSend={onSend} onState={(s) => states.push(s)} />);
    fireEvent.click(r.getByTestId("button-send"));
    fireEvent.click(r.getByTestId("button-send"));
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(states).toEqual([]); // sending changes no option
    expect(r.getByTestId("button-send").getAttribute("data-voice")).toBe("on");
    fireEvent.click(r.getByTestId("button-send-options"));
    fireEvent.click(r.getByText(t("en", "msgkind.clear")));
    expect(states.at(-1)).toEqual(DEFAULT_SEND_STATE);
    expect(r.getByTestId("button-send").hasAttribute("data-voice")).toBe(false);
  });

  it("while the text is being turned into speech, Send is disabled and says so", () => {
    const onSend = vi.fn();
    const r = render(<Harness initial={{ ...DEFAULT_SEND_STATE, asVoice: true }} onSend={onSend} voiceBusy />);
    const send = r.getByTestId("button-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.getAttribute("aria-busy")).toBe("true");
    expect(send.getAttribute("aria-label")).toBe(t("en", "speakSend.busy"));
    fireEvent.click(send);
    expect(onSend).not.toHaveBeenCalled();
    cleanup();
    // busy with a voice message from elsewhere (the Speech panel) does not block a text send
    const plain = render(<Harness onSend={onSend} voiceBusy />);
    expect((plain.getByTestId("button-send") as HTMLButtonElement).disabled).toBe(false);
  });

  it("says, under the option, that a sealed message cannot go as voice", () => {
    const r = render(<Harness initial={{ ...DEFAULT_SEND_STATE, asVoice: true }} onSend={() => undefined} />);
    fireEvent.click(r.getByTestId("button-send-options"));
    expect(r.queryByTestId("opt-send-voice-sealed")).toBeNull();
    fireEvent.click(r.getByTestId("opt-sealed"));
    expect(r.getByTestId("opt-send-voice-sealed").textContent).toBe(t("en", "speakSend.err.sealed"));
  });
});

describe("what Send does with the composer's text", () => {
  const paths = () => ({ text: vi.fn(async () => undefined), voice: vi.fn(async () => true), refuse: vi.fn() });

  it("unticked: the text message, not the voice", async () => {
    const p = paths();
    expect(await sendFromComposer("Ahoj", DEFAULT_SEND_STATE, p)).toBe("text");
    expect(p.text).toHaveBeenCalledTimes(1);
    expect(p.voice).not.toHaveBeenCalled();
    expect(p.refuse).not.toHaveBeenCalled();
  });

  it("ticked: the voice message, not the text (tap and vanish go along)", async () => {
    const p = paths();
    expect(await sendFromComposer("Ahoj", { ...DEFAULT_SEND_STATE, asVoice: true, tap: true, vanishSeconds: 60 }, p)).toBe("voice");
    expect(p.voice).toHaveBeenCalledTimes(1);
    expect(p.text).not.toHaveBeenCalled();
    expect(p.refuse).not.toHaveBeenCalled();
  });

  it("ticked with a sealed message: nothing goes — neither the voice unsealed nor the text", async () => {
    const p = paths();
    expect(await sendFromComposer("tajné", { ...DEFAULT_SEND_STATE, asVoice: true, sealed: true, sealCode: "1234" }, p)).toBe("refused");
    expect(p.refuse).toHaveBeenCalledWith("sealed");
    expect(p.text).not.toHaveBeenCalled();
    expect(p.voice).not.toHaveBeenCalled();
    // a sealed text without the voice option is an ordinary (sealed) text send
    expect(composerSendRoute("tajné", { sealed: true })).toEqual({ route: "text" });
  });

  it("ticked with a text longer than a voice message holds: refused, not spoken cut short", async () => {
    const p = paths();
    const long = "a".repeat(SPEAK_SEND_MAX + 1);
    expect(await sendFromComposer(long, { asVoice: true }, p)).toBe("refused");
    expect(p.refuse).toHaveBeenCalledWith("too-long");
    expect(p.voice).not.toHaveBeenCalled();
    expect(composerSendRoute(`  ${"a".repeat(SPEAK_SEND_MAX)}  `, { asVoice: true })).toEqual({ route: "voice" });
  });

  it("a big voice message (a file transfer to everyone, no kinds) only goes to everyone as an ordinary message", () => {
    const limit = 512 * 1024;
    const plain = { toChosen: false, tap: false, vanish: false };
    expect(voiceTooBigFor(limit, limit, { toChosen: true, tap: true, vanish: true })).toBe(false);
    expect(voiceTooBigFor(limit + 1, limit, plain)).toBe(false);
    expect(voiceTooBigFor(limit + 1, limit, { ...plain, toChosen: true })).toBe(true);
    expect(voiceTooBigFor(limit + 1, limit, { ...plain, tap: true })).toBe(true);
    expect(voiceTooBigFor(limit + 1, limit, { ...plain, vanish: true })).toBe(true);
  });

  it("every reason has words in cs / en / de", () => {
    for (const lang of ["cs", "en", "de"] as Lang[]) {
      for (const key of ["speakSend.optHint", "speakSend.offHint", "speakSend.on", "speakSend.err.sealed", "speakSend.err.too-long", "speakSend.err.too-big"]) {
        expect(t(lang, key), `${lang} ${key}`).not.toBe(key);
      }
    }
    expect(t("cs", "speakSend.err.too-long")).toContain("{max}");
  });
});

describe("the composer layout", () => {
  const env = (data: Record<string, unknown>): LayoutEnv => ({
    data, lang: "en", translate: (k) => t("en", k),
    refs: { fileInput: createRef() as never, imageInput: createRef() as never },
    slots: { recorder: () => <i data-slot="recorder" />, sendOptions: () => <i data-slot="send" /> },
  });
  const base = { replyTo: null, emojiOpen: false, emojis: [], filesOn: true, openPeerCount: 1, room: "brno", placeholder: "Write…", messageInput: "draft", everyone: true, recipientNames: "" };

  it("shows under the field that the message goes as voice ($sendAsVoice, $voiceBusy)", () => {
    const off = render(<>{renderLayout(DEFAULT_LAYOUTS.composer, env(base))}</>);
    expect(off.queryByTestId("composer-hint-voice")).toBeNull();
    cleanup();
    const on = render(<>{renderLayout(DEFAULT_LAYOUTS.composer, env({ ...base, sendAsVoice: true, voiceBusy: false }))}</>);
    expect(on.getByTestId("composer-hint-voice").textContent?.trim()).toBe(t("en", "speakSend.on"));
    cleanup();
    const busy = render(<>{renderLayout(DEFAULT_LAYOUTS.composer, env({ ...base, sendAsVoice: true, voiceBusy: true }))}</>);
    expect(busy.getByTestId("composer-hint-voice").textContent?.trim()).toBe(t("en", "speakSend.busy"));
  });

  it("declares the new values to designers and previews the situation", () => {
    const vars = LAYOUT_CONTRACTS.composer.vars.map((v) => v.path);
    expect(vars).toContain("$sendAsVoice");
    expect(vars).toContain("$voiceBusy");
    expect(PREVIEW_VARIANTS.composer.map((v) => v.id)).toContain("voice");
  });
});
