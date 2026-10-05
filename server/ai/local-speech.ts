// The built-in speech engine (5.1): free, offline speech on this server —
// Whisper (speech → text, 99 languages) and Piper voices (text → speech:
// Czech, Slovak, English, German, Polish, …) run by sherpa-onnx (native,
// Apache-2.0; the optional dependency sherpa-onnx-node). No account, no key,
// nothing leaves the server.
//
// Models are downloaded on demand from the sherpa-onnx releases on GitHub
// (MIT / per-voice licences) into $DATA_DIR/ai/speech-models/<id> and show
// up as the models of the "local" provider (AI & speech → Offline speech).
//
//   audio in    WAV is read here; anything else (webm, ogg, mp3, m4a) goes
//               through ffmpeg when the server has it — the chat app sends
//               WAV already (it converts in the browser)
//   audio out   WAV (16-bit PCM), which every browser plays
//   CPU         calls to one model run one at a time; the engines stay
//               loaded (a Piper voice ≈ 60 MB of RAM, Whisper small ≈ 500 MB)

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { aiDataDir } from "./config";
import { checkArchive, forgetFiles, readManifest, recordInstall, trustInstalled, verifyInstalled } from "./speech-integrity";
import { createHash } from "node:crypto";

export type LocalModelDef = {
  id: string;
  kind: "tts" | "stt";
  engine: "whisper" | "piper";
  label: string;
  /** Language codes (Whisper: all of them). */
  langs: string[];
  /** Download size in MB. */
  mb: number;
  url: string;
  license: string;
  note?: string;
  /** 6.12 (F-29): the release archive's SHA-256, when it is known (SPEECH_MODEL_PINS adds or overrides). */
  sha256?: string;
};

const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
const whisper = (size: string, label: string, mb: number, note: string): LocalModelDef => ({ id: `whisper-${size}`, kind: "stt", engine: "whisper", label, langs: ["*"], mb, url: `${RELEASES}/asr-models/sherpa-onnx-whisper-${size}.tar.bz2`, license: "MIT (OpenAI Whisper)", note });
const piper = (voice: string, label: string, lang: string, mb = 21, note?: string): LocalModelDef => ({ id: `piper-${voice}`, kind: "tts", engine: "piper", label, langs: [lang], mb, url: `${RELEASES}/tts-models/vits-piper-${voice}-int8.tar.bz2`, license: "Piper voice — see its MODEL_CARD", ...(note ? { note } : {}) });

export const LOCAL_MODELS: readonly LocalModelDef[] = [
  whisper("tiny", "Whisper tiny", 116, "The fastest; rough on Czech. Short commands."),
  whisper("base", "Whisper base", 208, "Fast, decent — a good start on a small server."),
  whisper("small", "Whisper small", 640, "Good Czech; a few seconds per sentence on a small CPU."),
  whisper("turbo", "Whisper large-v3 turbo", 564, "The best quality; wants a strong CPU and ~2 GB of RAM."),
  piper("cs_CZ-jirka-medium", "Czech — Jirka (male)", "cs"),
  piper("sk_SK-lili-medium", "Slovak — Lili (female)", "sk"),
  piper("en_US-amy-medium", "English US — Amy (female)", "en"),
  piper("en_US-ryan-medium", "English US — Ryan (male)", "en"),
  piper("en_GB-alan-medium", "English UK — Alan (male)", "en"),
  piper("de_DE-thorsten-medium", "German — Thorsten (male)", "de"),
  piper("pl_PL-darkman-medium", "Polish — Darkman (male)", "pl"),
  piper("fr_FR-siwis-medium", "French — Siwis (female)", "fr"),
  piper("es_ES-davefx-medium", "Spanish — Davefx (male)", "es"),
  piper("it_IT-paola-medium", "Italian — Paola (female)", "it"),
  piper("uk_UA-ukrainian_tts-medium", "Ukrainian — 3 voices", "uk", 23),
];

export const LOCAL_MODEL = new Map(LOCAL_MODELS.map((m) => [m.id, m]));

export function modelsRoot(): string { return join(aiDataDir(), "speech-models"); }
export function modelDir(id: string): string {
  if (!LOCAL_MODEL.has(id)) throw new LocalSpeechError("no-model", `There is no built-in model ${id}.`);
  return join(modelsRoot(), id);
}

export class LocalSpeechError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "LocalSpeechError"; }
}

/* ============================================================ the engine */

type Sherpa = {
  OfflineTts: { createAsync(config: unknown): Promise<TtsEngine> };
  OfflineRecognizer: { createAsync(config: unknown): Promise<SttEngine> };
};
type TtsEngine = { numSpeakers: number; sampleRate: number; generateAsync(req: { text: string; sid: number; speed: number }): Promise<{ samples: Float32Array; sampleRate: number }> };
type SttEngine = { createStream(): { acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void }; decodeAsync(s: unknown): Promise<void>; getResult(s: unknown): { text: string; lang?: string } };

let engine: Promise<Sherpa | null> | null = null;
let engineError = "";

/** sherpa-onnx, when it is installed for this platform (it is an optional dependency). */
export function loadEngine(): Promise<Sherpa | null> {
  if (!engine) {
    engine = import(/* @vite-ignore */ "sherpa-onnx-node" as string)
      .then((m: { default?: Sherpa } & Sherpa) => { const s = (m.default ?? m) as Sherpa; if (!s.OfflineTts || !s.OfflineRecognizer) throw new Error("unexpected module"); return s; })
      .catch((err: Error) => { engineError = `The speech engine (sherpa-onnx-node) is not available on ${process.platform}-${process.arch}: ${err.message.split("\n")[0]}`; return null; });
  }
  return engine;
}

async function need(): Promise<Sherpa> {
  const s = await loadEngine();
  if (!s) throw new LocalSpeechError("no-engine", engineError || "The speech engine is not installed.");
  return s;
}

/* ============================================================ files */

/** The files of an installed model (or null: not installed / incomplete). */
export function modelFiles(id: string): Record<string, string> | null {
  const def = LOCAL_MODEL.get(id);
  if (!def) return null;
  const dir = join(modelsRoot(), id);
  if (!existsSync(dir)) return null;
  let names: string[];
  try { names = readdirSync(dir); } catch { return null; }
  const pick = (re: RegExp) => names.find((n) => re.test(n));
  if (def.engine === "whisper") {
    const encoder = pick(/-encoder\.int8\.onnx$/) ?? pick(/-encoder\.onnx$/);
    const decoder = pick(/-decoder\.int8\.onnx$/) ?? pick(/-decoder\.onnx$/);
    const tokens = pick(/tokens\.txt$/);
    if (!encoder || !decoder || !tokens) return null;
    return { encoder: join(dir, encoder), decoder: join(dir, decoder), tokens: join(dir, tokens) };
  }
  const model = pick(/\.onnx$/);
  const tokens = pick(/^tokens\.txt$/);
  if (!model || !tokens || !names.includes("espeak-ng-data")) return null;
  return { model: join(dir, model), tokens: join(dir, tokens), dataDir: join(dir, "espeak-ng-data"), ...(names.includes(`${model}.json`) ? { json: join(dir, `${model}.json`) } : {}) };
}

export function installed(): LocalModelDef[] { return LOCAL_MODELS.filter((m) => modelFiles(m.id)); }

function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      total += e.isDirectory() ? dirSize(p) : statSync(p).size;
    }
  } catch { /* gone */ }
  return total;
}

/** A Piper voice's speakers, by name (most have one). */
export function voicesOf(id: string): string[] {
  const def = LOCAL_MODEL.get(id);
  if (!def || def.engine !== "piper") return [];
  const f = modelFiles(id);
  const fallback = [id.split("-")[2] || "default"];
  if (!f?.json) return fallback;
  try {
    const meta = JSON.parse(readFileSync(f.json, "utf8")) as { speaker_id_map?: Record<string, number>; num_speakers?: number };
    const map = meta.speaker_id_map ?? {};
    const names = Object.entries(map).sort((a, b) => a[1] - b[1]).map(([n]) => n);
    return names.length ? names : fallback;
  } catch { return fallback; }
}

/* ============================================================ downloads */

export type Job = { id: string; state: "downloading" | "extracting" | "done" | "failed"; received: number; total: number; error?: string; startedAt: number };
const jobs = new Map<string, Job>();

export function jobOf(id: string): Job | null { return jobs.get(id) ?? null; }

/** Downloads and unpacks a model in the background; onDone runs when it is ready. */
export function install(id: string, onDone?: (def: LocalModelDef) => void): Job {
  const def = LOCAL_MODEL.get(id);
  if (!def) throw new LocalSpeechError("no-model", `There is no built-in model ${id}.`);
  const running = jobs.get(id);
  if (running && (running.state === "downloading" || running.state === "extracting")) return running;
  const job: Job = { id, state: "downloading", received: 0, total: def.mb * 1_000_000, startedAt: Date.now() };
  jobs.set(id, job);
  const root = modelsRoot();
  const dir = join(root, id);
  const archive = join(root, `.${id}.tar.bz2`);
  const staging = join(root, `.${id}.staging`);
  void (async () => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const res = await fetch(def.url, { redirect: "follow", signal: AbortSignal.timeout(60 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
    job.total = Number(res.headers.get("content-length")) || job.total;
    const out = createWriteStream(archive, { mode: 0o600 });
    const reader = res.body.getReader();
    // 6.12 (F-29): the archive is hashed as it arrives and checked against a pin or its first download.
    const sha = createHash("sha256");
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      job.received += value.length;
      sha.update(value);
      if (!out.write(value)) await once(out, "drain");
    }
    out.end();
    await once(out, "finish");
    const archiveSha = sha.digest("hex");
    const trust = checkArchive(root, id, archiveSha, def.sha256);
    job.state = "extracting";
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    await untar(archive, staging);
    prune(staging);
    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);
    rmSync(archive, { force: true });
    if (!modelFiles(id)) throw new Error("the archive did not have the expected files");
    // Every unpacked file's hash, checked again at each load.
    await recordInstall(root, id, def.url, archiveSha, job.received, trust === "pinned" ? "pinned" : "first-download");
    job.state = "done";
    onDone?.(def);
  })().catch((err: Error) => {
    job.state = "failed";
    job.error = err.message;
    rmSync(archive, { force: true });
    rmSync(staging, { recursive: true, force: true });
  });
  return job;
}

/** tar with bzip2 (GNU tar needs the bzip2 program; macOS tar has it built in). */
function untar(file: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("tar", ["-xjf", file, "-C", dest, "--strip-components=1"], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    p.on("error", (e) => reject(new Error(`cannot run tar: ${e.message}`)));
    p.on("close", (code) => {
      if (code === 0) return resolve();
      const hint = /bzip2/i.test(err) ? " — install bzip2 (e.g. apt install bzip2)" : "";
      reject(new Error(`unpacking failed (tar ${code}): ${err.trim().split("\n").slice(-1)[0] || "unknown error"}${hint}`));
    });
  });
}

/** Keeps what the engine loads: the int8 Whisper weights (not the float ones), no test clips. */
function prune(dir: string): void {
  try {
    const names = readdirSync(dir);
    for (const n of names) {
      const full = join(dir, n);
      if (n === "test_wavs") rmSync(full, { recursive: true, force: true });
      const m = /^(.*-(encoder|decoder))\.onnx$/.exec(n);
      if (m && names.includes(`${m[1]}.int8.onnx`)) rmSync(full, { force: true });
    }
  } catch { /* keep all */ }
}

export function uninstall(id: string): void {
  const running = jobs.get(id);
  if (running && (running.state === "downloading" || running.state === "extracting")) throw new LocalSpeechError("busy", "The model is being downloaded.");
  rmSync(modelDir(id), { recursive: true, force: true });
  // 6.12: the files go from the manifest; the archive's hash stays (a new download must match it).
  forgetFiles(modelsRoot(), id);
  jobs.delete(id);
  for (const k of [...ttsEngines.keys(), ...sttEngines.keys()]) if (k === id || k.startsWith(`${id}|`)) { ttsEngines.delete(k); sttEngines.delete(k); }
}

/** What the console shows: every model, installed or not, with its download. */
export async function status() {
  const s = await loadEngine();
  const manifest = (() => { try { return { models: readManifest(modelsRoot()), error: "" }; } catch (err) { return { models: {} as ReturnType<typeof readManifest>, error: (err as Error).message }; } })();
  return {
    engine: Boolean(s),
    engineError: s ? "" : engineError,
    ffmpeg: await hasProgram("ffmpeg"),
    dir: modelsRoot(),
    // 6.12 (F-29): how each model's files are vouched for (speech-integrity.ts).
    manifestError: manifest.error,
    models: LOCAL_MODELS.map((m) => {
      const files = modelFiles(m.id);
      const job = jobs.get(m.id);
      const rec = manifest.models[m.id];
      return { ...m, installed: Boolean(files), bytes: files ? dirSize(join(modelsRoot(), m.id)) : 0, voices: files ? voicesOf(m.id) : [], job: job && job.state !== "done" ? job : null,
        integrity: rec ? { source: rec.source, archive: rec.archive, files: Object.keys(rec.files).length, at: rec.at } : null };
    }),
  };
}

const programs = new Map<string, Promise<boolean>>();
function hasProgram(name: string): Promise<boolean> {
  if (!programs.has(name)) {
    programs.set(name, new Promise((resolve) => {
      const p = spawn(name, ["-version"], { stdio: "ignore" });
      p.on("error", () => resolve(false));
      p.on("close", (code) => resolve(code === 0));
    }));
  }
  return programs.get(name)!;
}

/* ============================================================ running */

const ttsEngines = new Map<string, Promise<TtsEngine>>();
const sttEngines = new Map<string, Promise<SttEngine>>();
const MAX_LOADED = 3;
function remember<T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
  let p = cache.get(key);
  if (p) { cache.delete(key); cache.set(key, p); return p; } // most recently used last
  p = make();
  p.catch(() => cache.delete(key));
  cache.set(key, p);
  while (cache.size > MAX_LOADED) cache.delete(cache.keys().next().value as string);
  return p;
}

// One call at a time per model: the engines use every core already.
const lanes = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = lanes.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  lanes.set(key, next);
  void next.finally(() => { if (lanes.get(key) === next) lanes.delete(key); }).catch(() => undefined);
  return next;
}

const threads = () => Math.max(1, Math.min(4, Number(process.env.SPEECH_THREADS) || 2));

/**
 * 6.12 (F-29): before the engine parses a model, its files must be the ones
 * recorded when it was installed (speech-integrity.ts) — a mismatch is
 * refused as LocalSpeechError("integrity").
 */
export async function verifyModel(id: string): Promise<"verified" | "recorded"> {
  const def = LOCAL_MODEL.get(id);
  if (!def) throw new LocalSpeechError("no-model", `There is no built-in model ${id}.`);
  try {
    return await verifyInstalled(modelsRoot(), id, def.url);
  } catch (err) {
    throw new LocalSpeechError("integrity", (err as Error).message);
  }
}

/**
 * 6.12 review S02: the operator trusts the files installed for `id` as they
 * are now (the console's "Trust installed files", owner role) — a model
 * installed before 6.12, or after its manifest was lost. Loaded engines of
 * the model are dropped so the next use verifies again.
 */
export async function trustModel(id: string, opts: { replaceInvalid?: boolean } = {}): Promise<{ files: number }> {
  const def = LOCAL_MODEL.get(id);
  if (!def) throw new LocalSpeechError("no-model", `There is no built-in model ${id}.`);
  if (!modelFiles(id)) throw new LocalSpeechError("not-installed", `The model ${id} is not installed.`);
  const running = jobs.get(id);
  if (running && (running.state === "downloading" || running.state === "extracting")) throw new LocalSpeechError("busy", "The model is being downloaded.");
  try {
    const rec = await trustInstalled(modelsRoot(), id, def.url, opts);
    for (const k of [...ttsEngines.keys(), ...sttEngines.keys()]) if (k === id || k.startsWith(`${id}|`)) { ttsEngines.delete(k); sttEngines.delete(k); }
    return { files: Object.keys(rec.files).length };
  } catch (err) {
    if (err instanceof LocalSpeechError) throw err;
    throw new LocalSpeechError("integrity", (err as Error).message);
  }
}

function ttsEngine(id: string): Promise<TtsEngine> {
  return remember(ttsEngines, id, async () => {
    const s = await need();
    const f = modelFiles(id);
    if (!f) throw new LocalSpeechError("not-installed", `The voice ${id} is not downloaded yet (AI & speech → Offline speech).`);
    await verifyModel(id);
    return s.OfflineTts.createAsync({ model: { vits: { model: f.model, tokens: f.tokens, dataDir: f.dataDir }, numThreads: threads(), provider: "cpu", debug: false }, maxNumSentences: 2 });
  });
}

function sttEngine(id: string, language: string): Promise<SttEngine> {
  return remember(sttEngines, `${id}|${language}`, async () => {
    const s = await need();
    const f = modelFiles(id);
    if (!f) throw new LocalSpeechError("not-installed", `The model ${id} is not downloaded yet (AI & speech → Offline speech).`);
    await verifyModel(id);
    return s.OfflineRecognizer.createAsync({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: { whisper: { encoder: f.encoder, decoder: f.decoder, language, task: "transcribe" }, tokens: f.tokens, numThreads: threads(), provider: "cpu", debug: 0 } });
  });
}

export const MAX_TTS_CHARS = 5000;

/** Text → WAV. `voice` is a speaker name (or index) of multi-speaker voices; `speed` 0.5–2. */
export async function synthesize(id: string, text: string, voice?: string, speed = 1): Promise<{ audio: Uint8Array; mime: string; sampleRate: number; seconds: number }> {
  const def = LOCAL_MODEL.get(id);
  if (!def || def.kind !== "tts") throw new LocalSpeechError("no-model", `${id} is not a built-in voice.`);
  const clean = text.replace(/\s+/g, " ").trim().slice(0, MAX_TTS_CHARS);
  if (!clean) throw new LocalSpeechError("empty", "There is no text to speak.");
  const tts = await ttsEngine(id);
  const names = voicesOf(id);
  let sid = 0;
  if (voice) { const i = names.indexOf(voice); sid = i >= 0 ? i : Math.max(0, Math.min(tts.numSpeakers - 1, Number.parseInt(voice, 10) || 0)); }
  const out = await serial(`tts:${id}`, () => tts.generateAsync({ text: clean, sid, speed: Math.max(0.5, Math.min(2, speed || 1)) }));
  return { audio: encodeWav(out.samples, out.sampleRate), mime: "audio/wav", sampleRate: out.sampleRate, seconds: out.samples.length / out.sampleRate };
}

/** Audio → text. `language` is a code (cs, en, …) or empty to detect it. */
export async function transcribe(id: string, audio: Uint8Array, mime: string, language?: string): Promise<{ text: string; seconds: number }> {
  const def = LOCAL_MODEL.get(id);
  if (!def || def.kind !== "stt") throw new LocalSpeechError("no-model", `${id} is not a built-in transcription model.`);
  const pcm = await decodeAudio(audio, mime);
  const lang = (language || "").trim().toLowerCase().slice(0, 2).replace(/[^a-z]/g, "");
  const rec = await sttEngine(id, lang);
  // Whisper hears 30-second windows: longer audio is cut into pieces.
  const win = Math.floor(pcm.sampleRate * 28);
  const parts: string[] = [];
  for (let at = 0; at < pcm.samples.length; at += win) {
    const chunk = pcm.samples.subarray(at, Math.min(pcm.samples.length, at + win));
    if (chunk.length < pcm.sampleRate * 0.2) continue;
    const text = await serial(`stt:${id}`, async () => {
      const stream = rec.createStream();
      stream.acceptWaveform({ samples: chunk, sampleRate: pcm.sampleRate });
      await rec.decodeAsync(stream);
      return rec.getResult(stream).text;
    });
    if (text.trim()) parts.push(text.trim());
  }
  return { text: parts.join(" ").replace(/\s+/g, " ").trim(), seconds: pcm.samples.length / pcm.sampleRate };
}

/* ============================================================ audio */

/** 16-bit PCM WAV of mono samples in [-1, 1]. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0, "ascii"); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii"); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii"); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
}

/** Reads a WAV file (PCM 8/16/24/32-bit or float, any rate, mixed down to mono). */
export function decodeWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 44 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") return null;
  let off = 12, fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      let format = b.readUInt16LE(body);
      if (format === 0xfffe && size >= 26) format = b.readUInt16LE(body + 24); // WAVE_FORMAT_EXTENSIBLE: the sub-format
      fmt = { format, channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    } else if (id === "data" && fmt) {
      const end = Math.min(b.length, body + size);
      const step = fmt.bits / 8;
      const frame = step * fmt.channels;
      if (!fmt.channels || !step || (fmt.format !== 1 && fmt.format !== 3)) return null;
      const n = Math.floor((end - body) / frame);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) {
          const p = body + i * frame + c * step;
          sum += fmt.format === 3 ? (fmt.bits === 64 ? b.readDoubleLE(p) : b.readFloatLE(p))
            : fmt.bits === 8 ? (b[p] - 128) / 128 : fmt.bits === 16 ? b.readInt16LE(p) / 32768 : fmt.bits === 24 ? b.readIntLE(p, 3) / 8388608 : b.readInt32LE(p) / 2147483648;
        }
        out[i] = sum / fmt.channels;
      }
      return { samples: out, sampleRate: fmt.rate };
    }
    off = body + size + (size % 2);
  }
  return null;
}

const MAX_AUDIO_SECONDS = 15 * 60;

async function decodeAudio(bytes: Uint8Array, mime: string): Promise<{ samples: Float32Array; sampleRate: number }> {
  const wav = decodeWav(bytes);
  if (wav) {
    if (wav.samples.length / wav.sampleRate > MAX_AUDIO_SECONDS) throw new LocalSpeechError("too-long", "The recording is longer than 15 minutes.");
    return wav;
  }
  if (!(await hasProgram("ffmpeg"))) throw new LocalSpeechError("format", `The built-in engine reads WAV; ${mime || "this audio"} needs ffmpeg on the server (apt install ffmpeg). The chat app sends WAV.`);
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-t", String(MAX_AUDIO_SECONDS), "-f", "f32le", "-ac", "1", "-ar", "16000", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), 120_000);
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    p.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    p.on("error", (e) => { clearTimeout(timer); reject(new LocalSpeechError("format", `ffmpeg: ${e.message}`)); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new LocalSpeechError("format", `ffmpeg could not read the audio: ${err.trim().split("\n").slice(-1)[0] || code}`));
      const all = Buffer.concat(chunks);
      const samples = new Float32Array(all.buffer.slice(all.byteOffset, all.byteOffset + all.length - (all.length % 4)));
      resolve({ samples, sampleRate: 16000 });
    });
    p.stdin.on("error", () => undefined);
    p.stdin.end(Buffer.from(bytes));
  });
}
