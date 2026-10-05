// Integrity of the offline speech models (6.12, F-29).
//
// The models (local-speech.ts) are native ONNX graphs and data files that
// sherpa-onnx parses in this process — a replaced file is code execution in
// the server. They come from GitHub release URLs without published checksums,
// so trust is pinned where it can be:
//
//   1. an operator pin: SPEECH_MODEL_PINS="whisper-small=<sha256>,piper-…=<sha256>"
//      (the SHA-256 of the release archive), or a `sha256` in the catalogue —
//      a download that does not match is refused;
//   2. otherwise trust on first download: the archive's SHA-256 and every
//      unpacked file's SHA-256 are recorded in speech-models/manifest.json —
//      a later download of the same model must match (an upstream re-release
//      or a swapped file is refused until the operator removes its entry);
//   3. every time a model is loaded, its files are hashed again and compared
//      with the manifest — a changed, missing or added file is refused.
//
// Models installed before 6.12 have no entry: they are recorded at their
// first load (logged as "first-load"). The manifest carries an HMAC under a
// subkey of the storage master key (keys.ts derivedKey("speech-manifest")) so
// that whoever can swap a model file cannot simply rewrite the manifest too;
// without the master key it is kept without one (and says so).

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { derivedKey } from "../storage/keys";

export type ModelRecord = {
  url: string;
  /** SHA-256 of the downloaded archive ("" for a model recorded at its first load). */
  archive: string;
  archiveBytes: number;
  /** Every file of the unpacked model: relative path → SHA-256. */
  files: Record<string, string>;
  at: number;
  source: "pinned" | "first-download" | "first-load";
};

type Manifest = { v: 1; models: Record<string, ModelRecord>; mac?: string };

export class SpeechIntegrityError extends Error {
  readonly code = "integrity";
  constructor(message: string) { super(message); this.name = "SpeechIntegrityError"; }
}

export const manifestPath = (root: string) => join(root, "manifest.json");

function macKey(): Buffer | null {
  try { return derivedKey("speech-manifest"); } catch { return null; }
}

function macOf(models: Record<string, ModelRecord>, key: Buffer): string {
  const canonical = JSON.stringify(Object.keys(models).sort().map((id) => {
    const m = models[id];
    return [id, m.url, m.archive, m.archiveBytes, Object.keys(m.files).sort().map((f) => [f, m.files[f]]), m.at, m.source];
  }));
  return createHmac("sha256", key).update(canonical).digest("hex");
}

/** The manifest — throws SpeechIntegrityError when it was changed behind the server's back. */
export function readManifest(root: string): Record<string, ModelRecord> {
  const file = manifestPath(root);
  if (!existsSync(file)) return {};
  let parsed: Manifest;
  try { parsed = JSON.parse(readFileSync(file, "utf8")) as Manifest; } catch { throw new SpeechIntegrityError(`${file} is not readable JSON — restore it, or delete it to record the models again`); }
  const models = parsed && typeof parsed.models === "object" && parsed.models ? parsed.models : {};
  const key = macKey();
  if (key) {
    const ok = typeof parsed.mac === "string" && /^[0-9a-f]{64}$/.test(parsed.mac) && timingSafeEqual(Buffer.from(parsed.mac, "hex"), Buffer.from(macOf(models, key), "hex"));
    if (!ok) throw new SpeechIntegrityError(`${file} does not verify against the storage master key — it was edited outside the server; restore it, or delete it to record the models again`);
  }
  return models;
}

export function writeManifest(root: string, models: Record<string, ModelRecord>): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const key = macKey();
  const body: Manifest = { v: 1, models, ...(key ? { mac: macOf(models, key) } : {}) };
  const tmp = `${manifestPath(root)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 1), { mode: 0o600 });
  renameSync(tmp, manifestPath(root));
}

/** An operator pin (SPEECH_MODEL_PINS) or the catalogue's, for a model's archive. */
export function pinnedArchiveHash(id: string, catalogue?: string): string | null {
  for (const part of (process.env.SPEECH_MODEL_PINS ?? "").split(",")) {
    const [k, v] = part.split("=").map((s) => s.trim());
    if (k === id && /^[0-9a-fA-F]{64}$/.test(v ?? "")) return v.toLowerCase();
  }
  return catalogue && /^[0-9a-f]{64}$/.test(catalogue) ? catalogue : null;
}

/** Refuses an archive that does not match a pin or the hash recorded at the first download. */
export function checkArchive(root: string, id: string, sha256: string, catalogue?: string): "pinned" | "first-download" | "known" {
  const pin = pinnedArchiveHash(id, catalogue);
  if (pin) {
    if (pin !== sha256) throw new SpeechIntegrityError(`the download of ${id} does not match its pinned SHA-256 (expected ${pin}, got ${sha256}) — refused`);
    return "pinned";
  }
  const known = readManifest(root)[id]?.archive;
  if (known && known !== sha256) throw new SpeechIntegrityError(`the download of ${id} differs from the one recorded at its first download (expected ${known}, got ${sha256}) — refused; remove its entry from ${manifestPath(root)} to accept a new release`);
  return known ? "known" : "first-download";
}

export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

/** Every file under `dir` (relative paths with /), hashed. */
export async function hashTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() || (e.isSymbolicLink() && statSync(p).isFile())) out[relative(dir, p).split(sep).join("/")] = await hashFile(p);
    }
  };
  await walk(dir);
  return out;
}

/** Records a model that was just unpacked (its archive's hash and every file's). */
export async function recordInstall(root: string, id: string, url: string, archive: string, archiveBytes: number, source: ModelRecord["source"]): Promise<ModelRecord> {
  const files = await hashTree(join(root, id));
  const models = readManifest(root);
  models[id] = { url, archive, archiveBytes, files, at: Date.now(), source };
  writeManifest(root, models);
  return models[id];
}

/**
 * Before a model is loaded: its files must be exactly the ones recorded.
 * A model installed before 6.12 is recorded now (trust on first load).
 */
export async function verifyInstalled(root: string, id: string, url: string): Promise<"verified" | "recorded"> {
  const models = readManifest(root);
  const rec = models[id];
  const dir = join(root, id);
  if (!rec) {
    await recordInstall(root, id, url, "", 0, "first-load");
    console.warn(`[speech] ${id} had no recorded hashes (installed before 6.12): recorded them now — later loads must match`);
    return "recorded";
  }
  const now = await hashTree(dir);
  const changed = Object.keys(rec.files).filter((f) => now[f] !== rec.files[f]);
  const added = Object.keys(now).filter((f) => !(f in rec.files));
  if (changed.length || added.length) {
    const what = [...changed.map((f) => `${f} ${now[f] ? "changed" : "missing"}`), ...added.map((f) => `${f} added`)].slice(0, 5).join(", ");
    console.warn(`[speech] ${id} does not match its recorded hashes (${what}): not loaded`);
    throw new SpeechIntegrityError(`The model ${id} does not match the hashes recorded when it was installed (${what}). It was not loaded — reinstall it (AI & speech → Offline speech).`);
  }
  return "verified";
}

/** Drops a model's files from the manifest but keeps its archive hash (a re-download must match it). */
export function forgetFiles(root: string, id: string): void {
  try {
    const models = readManifest(root);
    if (!models[id]) return;
    models[id] = { ...models[id], files: {} };
    writeManifest(root, models);
  } catch { /* an unreadable manifest stays as it is */ }
}
