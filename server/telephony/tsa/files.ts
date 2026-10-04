// Audio files for the Play tool (6.9): greetings, hold music, announcements
// the operator uploads in the console (Telephony › Files), played to callers
// by id. They live in a directory next to telephony.json —
// telephony-audio/<id>.<mp3|wav> plus index.json (0600 files, 0700 directory)
// — written by the admin service, served to the providers by the main service
// at /wh/tsa/file/<id> (tsa/media.ts). An id is 96 random bits: the URL is
// not guessable, and nothing else is served from there.
//
// Only MP3 and WAV (what every provider plays), recognised by their bytes,
// 10 MB each, 200 files.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataFilePath } from "../store";

export const AUDIO_FILE_LIMITS = { bytes: 10 * 1024 * 1024, files: 200 } as const;
const ID = /^af_[a-f0-9]{24}$/;

export type AudioFile = { id: string; name: string; mime: "audio/mpeg" | "audio/wav"; bytes: number; createdAt: number; by: string };

export function audioDir(): string {
  const explicit = process.env.TSA_AUDIO_DIR?.trim();
  return explicit || join(dirname(dataFilePath()), "telephony-audio");
}
const indexPath = () => join(audioDir(), "index.json");
const ext = (mime: AudioFile["mime"]) => (mime === "audio/wav" ? "wav" : "mp3");

export class AudioFileError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "AudioFileError"; }
}

/** MP3 (an ID3 tag or a frame sync) or WAV (RIFF … WAVE) — by the bytes, not by what the upload says. */
export function sniffAudio(b: Uint8Array): AudioFile["mime"] | null {
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) return "audio/wav";
  if (b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return "audio/mpeg";
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "audio/mpeg";
  return null;
}

function readIndex(): AudioFile[] {
  try {
    const list = JSON.parse(readFileSync(indexPath(), "utf8")) as unknown;
    return Array.isArray(list) ? list.filter((f): f is AudioFile => Boolean(f) && typeof f === "object" && ID.test((f as AudioFile).id)) : [];
  } catch { return []; }
}

function writeIndex(list: AudioFile[]): void {
  const dir = audioDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${indexPath()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 1), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, indexPath());
}

export function listAudioFiles(): AudioFile[] { return readIndex().sort((a, b) => b.createdAt - a.createdAt); }

export function getAudioFile(id: string): AudioFile | null {
  if (!ID.test(id)) return null;
  return readIndex().find((f) => f.id === id) ?? null;
}

/** The file's bytes (null when it is gone). */
export function readAudioFile(id: string): { file: AudioFile; bytes: Buffer } | null {
  const file = getAudioFile(id);
  if (!file) return null;
  const path = join(audioDir(), `${file.id}.${ext(file.mime)}`);
  try {
    if (statSync(path).size > AUDIO_FILE_LIMITS.bytes) return null;
    return { file, bytes: readFileSync(path) };
  } catch { return null; }
}

/** "data:audio/wav;base64,…" or plain base64 → bytes. */
export function bytesOfDataUrl(data: string): Buffer | null {
  const m = /^data:([a-z0-9.+/-]*)(;[a-z0-9=.+-]+)*;base64,/i.exec(data);
  const b64 = m ? data.slice(m[0].length) : data;
  if (!/^[A-Za-z0-9+/_\-\s]*={0,2}\s*$/.test(b64.slice(-64))) return null;
  try { return Buffer.from(b64.replace(/\s+/g, ""), "base64"); } catch { return null; }
}

export function addAudioFile(input: { name?: unknown; data?: unknown }, by: string): AudioFile {
  if (typeof input.data !== "string" || !input.data) throw new AudioFileError(400, "data: the file as a data: URL or base64.");
  if (input.data.length > Math.ceil(AUDIO_FILE_LIMITS.bytes * 4 / 3) + 200) throw new AudioFileError(413, `The file is larger than ${AUDIO_FILE_LIMITS.bytes / 1024 / 1024} MB.`);
  const bytes = bytesOfDataUrl(input.data);
  if (!bytes || !bytes.length) throw new AudioFileError(400, "The data is not base64.");
  if (bytes.length > AUDIO_FILE_LIMITS.bytes) throw new AudioFileError(413, `The file is larger than ${AUDIO_FILE_LIMITS.bytes / 1024 / 1024} MB.`);
  const mime = sniffAudio(bytes);
  if (!mime) throw new AudioFileError(415, "Only MP3 and WAV files (what every provider plays).");
  const list = readIndex();
  if (list.length >= AUDIO_FILE_LIMITS.files) throw new AudioFileError(409, `There are ${AUDIO_FILE_LIMITS.files} files already; remove some first.`);
  const file: AudioFile = {
    id: `af_${randomBytes(12).toString("hex")}`,
    name: (typeof input.name === "string" ? input.name : "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 120) || `audio.${ext(mime)}`,
    mime, bytes: bytes.length, createdAt: Date.now(), by: by.slice(0, 120),
  };
  const dir = audioDir();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${file.id}.${ext(mime)}`), bytes, { mode: 0o600 });
    writeIndex([...list, file]);
  } catch (err) {
    throw new AudioFileError(507, `Cannot store the file in ${dir}: ${(err as Error).message}`);
  }
  return file;
}

export function removeAudioFile(id: string): boolean {
  const list = readIndex();
  const file = list.find((f) => f.id === id);
  if (!file) return false;
  try { rmSync(join(audioDir(), `${file.id}.${ext(file.mime)}`), { force: true }); } catch { /* gone already */ }
  writeIndex(list.filter((f) => f.id !== id));
  return true;
}

export const audioDirExists = (): boolean => existsSync(audioDir());
