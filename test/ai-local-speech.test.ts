// @vitest-environment node
// The built-in speech engine (server/ai/local-speech.ts, 5.1): WAV in and
// out, the model catalogue, downloading and unpacking a model (from a local
// HTTP server, no internet), and — when real models are at hand — Czech
// speech synthesized by Piper and transcribed back by Whisper.
//
// The real-model tests need SPEECH_TEST_MODELS=<dir> with the unpacked
// vits-piper-cs_CZ-jirka-medium-int8 and sherpa-onnx-whisper-tiny folders
// (from the sherpa-onnx releases); they are skipped otherwise.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createReadStream, statSync } from "node:fs";

const DATA = mkdtempSync(join(tmpdir(), "m5speech-"));
process.env.DATA_DIR = DATA;

const L = await import("../server/ai/local-speech");
const MODELS = process.env.SPEECH_TEST_MODELS || "";
const PIPER = MODELS && join(MODELS, "vits-piper-cs_CZ-jirka-medium-int8");
const WHISPER = MODELS && join(MODELS, "sherpa-onnx-whisper-tiny");
const haveModels = Boolean(MODELS && existsSync(PIPER) && existsSync(WHISPER));
const haveEngine = Boolean(await L.loadEngine());

describe("WAV", () => {
  it("round-trips 16-bit mono", () => {
    const n = 1600;
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = Math.sin(i / 10) * 0.5;
    const wav = L.encodeWav(s, 16000);
    expect(Buffer.from(wav.subarray(0, 4)).toString()).toBe("RIFF");
    const back = L.decodeWav(wav)!;
    expect(back.sampleRate).toBe(16000);
    expect(back.samples.length).toBe(n);
    expect(Math.abs(back.samples[100] - s[100])).toBeLessThan(1e-3);
  });

  it("mixes stereo 32-bit float down to mono", () => {
    const frames = 4;
    const buf = Buffer.alloc(44 + frames * 8);
    buf.write("RIFF", 0); buf.writeUInt32LE(36 + frames * 8, 4); buf.write("WAVE", 8);
    buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(3, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(64000, 28); buf.writeUInt16LE(8, 32); buf.writeUInt16LE(32, 34);
    buf.write("data", 36); buf.writeUInt32LE(frames * 8, 40);
    for (let i = 0; i < frames; i++) { buf.writeFloatLE(0.2, 44 + i * 8); buf.writeFloatLE(0.6, 48 + i * 8); }
    const out = L.decodeWav(new Uint8Array(buf))!;
    expect(out.sampleRate).toBe(8000);
    expect(out.samples[0]).toBeCloseTo(0.4, 5);
  });

  it("is not fooled by something else", () => {
    expect(L.decodeWav(new TextEncoder().encode("not a wav file at all, just text......................"))).toBeNull();
  });
});

describe("catalogue", () => {
  it("has unique ids, speech kinds and release URLs", () => {
    const ids = L.LOCAL_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of L.LOCAL_MODELS) {
      expect(["tts", "stt"]).toContain(m.kind);
      expect(m.url).toMatch(/^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\//);
    }
    expect(ids).toContain("piper-cs_CZ-jirka-medium");
    expect(ids).toContain("whisper-small");
  });

  it("reports what is installed (nothing yet)", async () => {
    const st = await L.status();
    expect(st.models.every((m) => !m.installed)).toBe(true);
    expect(st.dir).toBe(join(DATA, "ai", "speech-models"));
  });
});

describe.skipIf(!haveModels)("download and unpack", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    // A release archive, as GitHub serves it: one top folder inside a .tar.bz2.
    const work = mkdtempSync(join(tmpdir(), "m5speech-rel-"));
    execFileSync("tar", ["-cjf", join(work, "voice.tar.bz2"), "-C", MODELS, "vits-piper-cs_CZ-jirka-medium-int8"]);
    server = createServer((req, res) => {
      const file = join(work, "voice.tar.bz2");
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(statSync(file).size) });
      createReadStream(file).pipe(res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(() => server?.close());

  it("fetches, unpacks and finds the files", async () => {
    const def = L.LOCAL_MODEL.get("piper-cs_CZ-jirka-medium")! as { url: string };
    const real = def.url;
    def.url = `${base}/voice.tar.bz2`;
    try {
      let done = false;
      const job = L.install("piper-cs_CZ-jirka-medium", () => { done = true; });
      for (let i = 0; i < 200 && job.state !== "done" && job.state !== "failed"; i++) await new Promise((r) => setTimeout(r, 100));
      expect(job.error ?? null).toBeNull();
      expect(job.state).toBe("done");
      expect(done).toBe(true);
      expect(job.received).toBeGreaterThan(1_000_000);
      const files = L.modelFiles("piper-cs_CZ-jirka-medium")!;
      expect(files.model).toMatch(/cs_CZ-jirka-medium\.onnx$/);
      expect(readdirSync(join(DATA, "ai", "speech-models")).filter((n) => n.startsWith("."))).toEqual([]);
      expect(L.voicesOf("piper-cs_CZ-jirka-medium").length).toBe(1);
      L.uninstall("piper-cs_CZ-jirka-medium");
      expect(L.modelFiles("piper-cs_CZ-jirka-medium")).toBeNull();
    } finally { def.url = real; }
  }, 60_000);
});

describe.skipIf(!haveModels || !haveEngine)("Czech speech, offline", () => {
  beforeAll(() => {
    const root = join(DATA, "ai", "speech-models");
    mkdirSync(root, { recursive: true });
    if (!existsSync(join(root, "piper-cs_CZ-jirka-medium"))) symlinkSync(PIPER, join(root, "piper-cs_CZ-jirka-medium"));
    if (!existsSync(join(root, "whisper-tiny"))) symlinkSync(WHISPER, join(root, "whisper-tiny"));
  });

  it("speaks Czech (Piper) and hears it back (Whisper)", async () => {
    const said = await L.synthesize("piper-cs_CZ-jirka-medium", "Dobrý den. Jak se máte?");
    expect(said.mime).toBe("audio/wav");
    expect(said.seconds).toBeGreaterThan(0.8);
    const heard = await L.transcribe("whisper-tiny", said.audio, "audio/wav", "cs");
    expect(heard.text.toLowerCase()).toMatch(/dobr/);
  }, 120_000);

  it("works through the AI layer as the local provider", async () => {
    const { saveAiConfig, aiConfig } = await import("../server/ai/config");
    const { tts, stt } = await import("../server/ai/service");
    const now = Date.now();
    const cfg = aiConfig();
    const r = saveAiConfig({ ...cfg, providers: [{ id: "local", type: "local", label: "Built-in", baseUrl: "", key: null, keyHint: "", enabled: true, groups: ["user"], source: "console", createdAt: now, updatedAt: now, updatedBy: "t",
      models: [
        { id: "piper-cs_CZ-jirka-medium", label: "Jirka", kind: "tts", enabled: true, caps: { stream: false, reasoning: "none", noSampling: false, vision: false, json: false, tools: false }, price: null, source: "discovered" },
        { id: "whisper-tiny", label: "tiny", kind: "stt", enabled: true, caps: { stream: false, reasoning: "none", noSampling: false, vision: false, json: false, tools: false }, price: null, source: "discovered" },
      ] }], defaults: { ...cfg.defaults, tts: "local/piper-cs_CZ-jirka-medium", stt: "local/whisper-tiny" } }, "test");
    expect(r.ok).toBe(true);
    const caller = { source: "app" as const, actor: "t", account: "", groups: [], console: true };
    const audio = await tts({ text: "Dobrý den." }, caller);
    expect(audio.mime).toBe("audio/wav");
    const text = await stt({ audio: audio.audio, mime: "audio/wav", language: "cs" }, caller);
    expect(text.text.toLowerCase()).toMatch(/dobr/);
  }, 120_000);
});
