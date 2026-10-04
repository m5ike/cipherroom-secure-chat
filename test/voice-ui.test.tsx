// 6.7 voice in the web app: speak and send (a text → the server's voice →
// an audio file sent like a recorded voice message; clear errors without a
// voice), the composer's dictation button (tap again / leaving the room
// stops it and the last words still land in the field), the recorder letting
// go of the microphone when the composer goes away (and sending nothing),
// the Speech panel's "send as voice", the send options' row, and the voice
// changer's window (the operator's gate, presets, custom values).

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import { textToVoiceFile, voiceFileName } from "../client/src/lib/speak-send";
import type { ServerSpeechStatus } from "../client/src/lib/speech";
import { ComposerVoice, dictationMessage } from "../client/src/components/ComposerVoice";
import { AudioRecorder } from "../client/src/components/AudioRecorder";
import { SendOptions, DEFAULT_SEND_STATE } from "../client/src/components/SendOptions";
import { SpeechPanel } from "../client/src/components/ToolPanels";
import { VoiceChangerPanel } from "../client/src/components/VoiceChangerPanel";
import { setMicEnvForTests } from "../client/src/lib/mic";
import { getVoiceFx, resetVoiceFxForTests } from "../client/src/lib/voice-fx-settings";

const tick = (ms = 10) => act(async () => { await new Promise((ok) => setTimeout(ok, ms)); });

const ON: ServerSpeechStatus = { tts: { enabled: true, connectors: [{ id: "local/piper-cs", label: "Piper cs" }, { id: "openai/tts-1", label: "OpenAI" }] }, stt: { enabled: true, connectors: [] } };
const OFF: ServerSpeechStatus = { tts: { enabled: false, connectors: [] }, stt: { enabled: false, connectors: [] } };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); setMicEnvForTests(null); });
beforeEach(() => { resetVoiceFxForTests(); try { localStorage.clear(); } catch { /* none */ } });

describe("speak and send", () => {
  it("makes a voice message file of the text with the server's voice (the chosen one when offered)", async () => {
    const asked: Array<[string, string | undefined]> = [];
    const tts = async (text: string, o: { connector?: string }) => { asked.push([text, o.connector]); return { ok: true as const, blob: new Blob([new Uint8Array([82, 73, 70, 70])], { type: "audio/wav" }), mime: "audio/wav" }; };
    const r = await textToVoiceFile("  Ahoj, jak se máš?  ", { status: async () => ON, tts, now: () => 1234 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file.name).toBe("hlas-1234.wav");
    expect(r.file.type).toBe("audio/wav");
    expect(r.file.size).toBe(4);
    expect(asked).toEqual([["Ahoj, jak se máš?", "local/piper-cs"]]);
    await textToVoiceFile("x", { status: async () => ON, tts, connector: "openai/tts-1" });
    await textToVoiceFile("x", { status: async () => ON, tts, connector: "gone" });
    expect(asked.slice(1).map((a) => a[1])).toEqual(["openai/tts-1", "local/piper-cs"]);
  });

  it("says why not: no text, no voice on the server, the voice failed", async () => {
    const never = vi.fn();
    expect(await textToVoiceFile("   ", { status: async () => ON, tts: never })).toEqual({ ok: false, error: "empty" });
    expect(await textToVoiceFile("hi", { status: async () => OFF, tts: never })).toEqual({ ok: false, error: "no-tts" });
    expect(await textToVoiceFile("hi", { status: async () => { throw new Error("offline"); }, tts: never })).toEqual({ ok: false, error: "no-tts" });
    expect(never).not.toHaveBeenCalled();
    expect(await textToVoiceFile("hi", { status: async () => ON, tts: async () => ({ ok: false as const, message: "HTTP 503" }) })).toEqual({ ok: false, error: "tts-failed", message: "HTTP 503" });
    expect(await textToVoiceFile("hi", { status: async () => ON, tts: async () => ({ ok: true as const, blob: new Blob([]), mime: "audio/mpeg" }) })).toMatchObject({ ok: false, error: "tts-failed" });
  });

  it("names the file like a recorded voice message, with the type's extension", () => {
    expect(voiceFileName("audio/mpeg", 5)).toBe("hlas-5.mp3");
    expect(voiceFileName("audio/ogg; codecs=opus", 5)).toBe("hlas-5.ogg");
    expect(voiceFileName("audio/mp4", 5)).toBe("hlas-5.m4a");
    expect(voiceFileName("audio/x-unknown", 5)).toBe("hlas-5.mp3");
  });

  it("the send options offer it (and only when the app gives it)", () => {
    const onSendAsVoice = vi.fn();
    const r = render(<SendOptions value={DEFAULT_SEND_STATE} onChange={() => undefined} onSend={() => undefined} canSend lang="en" onSendAsVoice={onSendAsVoice} />);
    fireEvent.click(r.getByTestId("button-send-options"));
    fireEvent.click(r.getByTestId("opt-send-voice"));
    expect(onSendAsVoice).toHaveBeenCalledTimes(1);
    cleanup();
    const plain = render(<SendOptions value={DEFAULT_SEND_STATE} onChange={() => undefined} onSend={() => undefined} canSend lang="en" />);
    fireEvent.click(plain.getByTestId("button-send-options"));
    expect(plain.queryByTestId("opt-send-voice")).toBeNull();
  });

  it("the Speech panel sends its text as voice and clears it when it went", async () => {
    const sent: string[] = [];
    const r = render(<SpeechPanel lang="en" serverMode={false} recognitionRef={{ current: null }} onSendText={() => undefined} onInsertText={() => undefined} onSendVoice={async (t) => { sent.push(t); return true; }} loadServerStatus={async () => OFF} />);
    const area = r.container.querySelector("textarea")!;
    fireEvent.change(area, { target: { value: "Text to speak" } });
    await tick();
    fireEvent.click(r.getByTestId("speech-send-voice"));
    await tick();
    expect(sent).toEqual(["Text to speak"]);
    expect((r.container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  });
});

/* ------------------------------------------------------------ dictation */

class FakeRecognition {
  static all: FakeRecognition[] = [];
  lang = ""; interimResults = false; continuous = false; maxAlternatives = 0;
  onstart: (() => void) | null = null;
  onresult: ((ev: unknown) => void) | null = null;
  onerror: ((ev: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  calls: string[] = [];
  constructor() { FakeRecognition.all.push(this); }
  start() { this.calls.push("start"); }
  stop() { this.calls.push("stop"); }
  abort() { this.calls.push("abort"); }
  say(text: string, isFinal: boolean) { this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal })] }); }
}

describe("dictation in the composer", () => {
  function setup(initial = "Hi") {
    FakeRecognition.all = [];
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    let text = initial;
    const setText = vi.fn((t: string) => { text = t; });
    const errors: string[] = [];
    const view = (t: string) => <ComposerVoice lang="en" text={t} setText={setText} onRecorded={() => undefined} onError={(m) => errors.push(m)} />;
    const r = render(view(text));
    const rerender = () => r.rerender(view(text));
    return { r, setText, errors, rerender, get text() { return text; }, rec: () => FakeRecognition.all[FakeRecognition.all.length - 1] };
  }

  it("writes into the field as it hears, and stops with the same button (the last words still come)", async () => {
    const s = setup();
    const button = s.r.getByTestId("button-dictate");
    fireEvent.click(button);
    expect(s.rec().calls).toEqual(["start"]);
    expect(s.rec().lang).toBe("en-US");
    act(() => s.rec().onstart?.());
    expect(s.r.getByTestId("button-dictate").getAttribute("data-state")).toBe("listening");
    act(() => s.rec().say("how are", false));
    expect(s.text).toBe("Hi how are");
    act(() => s.rec().say("how are you", true));
    s.rerender();
    fireEvent.click(s.r.getByTestId("button-dictate"));
    expect(s.rec().calls).toEqual(["start", "stop"]);
    expect(s.r.getByTestId("button-dictate").getAttribute("data-state")).toBe("stopping");
    act(() => s.rec().say("today", true));
    act(() => s.rec().onend?.());
    expect(s.text).toBe("Hi how are you today ");
    expect(s.r.getByTestId("button-dictate").getAttribute("data-state")).toBe("idle");
  });

  it("leaving the room (the composer goes away) stops it; the last words still land", async () => {
    const s = setup("");
    fireEvent.click(s.r.getByTestId("button-dictate"));
    act(() => s.rec().onstart?.());
    s.r.unmount();
    expect(s.rec().calls).toEqual(["start", "stop"]);
    s.rec().say("dobrý den", true);
    s.rec().onend?.();
    expect(s.text).toBe("dobrý den ");
  });

  it("the field sent while dictating: it stops and does not bring the old text back", async () => {
    const s = setup("");
    fireEvent.click(s.r.getByTestId("button-dictate"));
    act(() => { s.rec().onstart?.(); s.rec().say("send this", true); });
    expect(s.text).toBe("send this ");
    s.rerender(); // the field shows it
    s.setText(""); // the message went
    s.rerender();
    expect(s.rec().calls).toEqual(["start", "abort"]);
    s.rec().say("ghost", true);
    expect(s.text).toBe("");
  });

  it("no permission: said in words, and it is off", async () => {
    const s = setup();
    fireEvent.click(s.r.getByTestId("button-dictate"));
    act(() => s.rec().onerror?.({ error: "not-allowed" }));
    expect(s.errors).toEqual(["The microphone is not allowed."]);
    expect(s.r.getByTestId("button-dictate").getAttribute("data-state")).toBe("idle");
    expect(dictationMessage("cs", "weird")).toBe("Diktování selhalo (weird).");
  });

  it("no recogniser and no server transcription: no dictation button (the recorder stays)", () => {
    const r = render(<ComposerVoice lang="en" text="" setText={() => undefined} onRecorded={() => undefined} onError={() => undefined} />);
    expect(r.queryByTestId("button-dictate")).toBeNull();
    expect(r.getByTestId("button-audio-record")).toBeTruthy();
  });
});

/* -------------------------------------------------------------- recorder */

class FakeTrack { stopped = 0; kind = "audio"; stop() { this.stopped += 1; } }
class FakeMediaRecorder {
  static last: FakeMediaRecorder | null = null;
  static isTypeSupported() { return false; }
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor() { FakeMediaRecorder.last = this; }
  start() { this.state = "recording"; }
  stop() { if (this.state === "inactive") return; this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["voice"]) }); this.onstop?.(); }
}

describe("the voice-message recorder", () => {
  function withMic() {
    const track = new FakeTrack();
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => undefined } });
    setMicEnvForTests({ getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] }) as unknown as MediaStream });
    return track;
  }

  it("records through mic.ts and sends the file when stopped", async () => {
    const track = withMic();
    const files: File[] = [];
    const r = render(<AudioRecorder lang="en" onRecorded={(f) => files.push(f)} onError={() => undefined} />);
    fireEvent.click(r.getByTestId("button-audio-record"));
    await tick();
    fireEvent.click(r.getByTestId("button-audio-stop"));
    expect(files).toHaveLength(1);
    expect(files[0].name).toMatch(/^hlas-\d+\.webm$/);
    expect(track.stopped).toBeGreaterThan(0);
  });

  it("going away mid-recording drops it (nothing is sent) and lets go of the microphone", async () => {
    const track = withMic();
    const files: File[] = [];
    const r = render(<AudioRecorder lang="en" onRecorded={(f) => files.push(f)} onError={() => undefined} />);
    fireEvent.click(r.getByTestId("button-audio-record"));
    await tick();
    expect(FakeMediaRecorder.last!.state).toBe("recording");
    r.unmount();
    expect(FakeMediaRecorder.last!.state).toBe("inactive");
    expect(track.stopped).toBeGreaterThan(0);
    expect(files).toEqual([]);
  });
});

/* --------------------------------------------------------- voice changer */

describe("the voice changer's window", () => {
  it("not allowed by the operator: says so and nothing can be switched on", () => {
    const r = render(<VoiceChangerPanel lang="en" allowed={false} supported />);
    expect(r.getByTestId("vfx-not-allowed").textContent).toContain("operator");
    expect((r.getByTestId("vfx-on") as HTMLInputElement).disabled).toBe(true);
  });

  it("allowed: switched on for this client, a preset, custom values (kept in this browser)", async () => {
    const r = render(<VoiceChangerPanel lang="cs" allowed supported />);
    expect(r.queryByTestId("vfx-not-allowed")).toBeNull();
    fireEvent.click(r.getByTestId("vfx-on"));
    expect(getVoiceFx().on).toBe(true);
    const preset = r.getByTestId("vfx-preset") as HTMLSelectElement;
    expect([...preset.options].map((o) => o.value)).toEqual(["off", "higher", "lower", "deep", "robot", "echo", "whisper", "anonymous", "custom"]);
    expect([...preset.options].map((o) => o.textContent)[3]).toBe("Hluboký (obr)");
    fireEvent.change(preset, { target: { value: "custom" } });
    expect(getVoiceFx().preset).toBe("custom");
    await tick();
    fireEvent.change(r.getByTestId("vfx-pitch"), { target: { value: "7" } });
    expect(getVoiceFx().custom.pitch).toBe(7);
    expect(JSON.parse(localStorage.getItem("m5cet.voiceFx") || "{}")).toMatchObject({ on: true, preset: "custom", custom: { pitch: 7 } });
  });
});
