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
// The manifest carries an HMAC under a subkey of the storage master key
// (keys.ts derivedKey("speech-manifest")) so that whoever can swap a model
// file cannot simply rewrite the manifest too; without the master key it is
// kept without one (and says so).
//
// 6.12 review S02 — that attacker could DELETE the manifest instead: a model
// without an entry used to be recorded at its next load ("first-load"), and
// the first-download rule lived only in that file. Now installed model files
// that the manifest does not vouch for are an integrity failure — never
// recorded by themselves — and so is a download while the manifest is
// missing but models are installed (unless an operator pin covers it). Only
// an explicit operator action records installed files:
//
//   - the console (AI & speech → Offline speech → "Trust installed files",
//     owner role, audited: trustInstalled), or
//   - an operator pin of the files: SPEECH_MODEL_PINS="<id>=files:<sha256>",
//     the digest of every installed file (treeDigest — the refusal names it);
//     a model with such a pin must match it at every load.
//
// That includes models installed before 6.12 (they had no entry).

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { derivedKey } from "../storage/keys";

export type ModelRecord = {
  url: string;
  /** SHA-256 of the downloaded archive ("" for a model recorded from its installed files). */
  archive: string;
  archiveBytes: number;
  /** Every file of the unpacked model: relative path → SHA-256. */
  files: Record<string, string>;
  at: number;
  /** "first-load": recorded at a load before the 6.12 review (no longer written). "operator": the operator
   *  trusted the installed files (console). "pinned-files": they matched SPEECH_MODEL_PINS "<id>=files:<digest>". */
  source: "pinned" | "first-download" | "first-load" | "operator" | "pinned-files";
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

/** 6.12 review S02: an operator pin of a model's installed files, SPEECH_MODEL_PINS "<id>=files:<sha256>" (treeDigest). */
export function pinnedFilesDigest(id: string): string | null {
  for (const part of (process.env.SPEECH_MODEL_PINS ?? "").split(",")) {
    const [k, v] = part.split("=").map((s) => s.trim());
    const m = /^files:([0-9a-fA-F]{64})$/.exec(v ?? "");
    if (k === id && m) return m[1].toLowerCase();
  }
  return null;
}

/** The digest of a model's files (what a "files:" pin names): SHA-256 over the sorted [path, sha256] pairs. */
export function treeDigest(files: Record<string, string>): string {
  return createHash("sha256").update(JSON.stringify(Object.keys(files).sort().map((f) => [f, files[f]]))).digest("hex");
}

/** Model folders under `root` (an unpacked model is a folder named by its id; downloads in progress start with "."). */
function installedModels(root: string): string[] {
  try { return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name); } catch { return []; }
}

/** Refuses an archive that does not match a pin or the hash recorded at the first download. 6.12 review S02:
 *  with models installed and the manifest gone, no download is trusted on first use either (only a pin). */
export function checkArchive(root: string, id: string, sha256: string, catalogue?: string): "pinned" | "first-download" | "known" {
  const pin = pinnedArchiveHash(id, catalogue);
  if (pin) {
    if (pin !== sha256) throw new SpeechIntegrityError(`the download of ${id} does not match its pinned SHA-256 (expected ${pin}, got ${sha256}) — refused`);
    return "pinned";
  }
  if (!existsSync(manifestPath(root)) && installedModels(root).length) {
    throw new SpeechIntegrityError(`${manifestPath(root)} is missing although models are installed (${installedModels(root).slice(0, 3).join(", ")}): what was recorded at their first downloads is gone, so the download of ${id} is not trusted — restore the manifest, trust the installed models in the console (AI & speech → Offline speech), or pin the archive (SPEECH_MODEL_PINS=${id}=<sha256>)`);
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
 * Before a model is loaded: its files must be exactly the ones recorded (or
 * the operator's "files:" pin). 6.12 review S02: files nothing vouches for —
 * no entry in the manifest (a model installed before 6.12, or a manifest
 * someone deleted) — are refused, never recorded by themselves; the operator
 * trusts them in the console (trustInstalled) or pins them.
 */
export async function verifyInstalled(root: string, id: string, url: string): Promise<"verified" | "recorded"> {
  const dir = join(root, id);
  const filesPin = pinnedFilesDigest(id);
  if (filesPin) {
    const now = await hashTree(dir);
    const digest = treeDigest(now);
    if (digest !== filesPin) {
      console.warn(`[speech] ${id} does not match its operator pin (SPEECH_MODEL_PINS files:${filesPin.slice(0, 12)}…, the files are ${digest.slice(0, 12)}…): not loaded`);
      throw new SpeechIntegrityError(`The model ${id} does not match its operator pin (SPEECH_MODEL_PINS ${id}=files:…). It was not loaded.`);
    }
    // The pin vouches for the files; the manifest only keeps a record of it (one that does not verify stays as it is).
    let models: Record<string, ModelRecord>;
    try { models = readManifest(root); } catch { return "verified"; }
    if (models[id] && treeDigest(models[id].files) === digest) return "verified";
    models[id] = { url, archive: models[id]?.archive ?? "", archiveBytes: models[id]?.archiveBytes ?? 0, files: now, at: Date.now(), source: "pinned-files" };
    writeManifest(root, models);
    console.warn(`[speech] ${id}: recorded its files as the operator pinned them (SPEECH_MODEL_PINS files:…)`);
    return "recorded";
  }
  const models = readManifest(root);
  const rec = models[id];
  if (!rec) {
    const digest = treeDigest(await hashTree(dir));
    const why = existsSync(manifestPath(root)) ? "it has no entry in the manifest (installed before 6.12?)" : `${manifestPath(root)} is missing`;
    console.warn(`[speech] ${id}: no recorded hashes — ${why}; not loaded until the operator trusts its files (console: AI & speech → Offline speech → Trust installed files, or SPEECH_MODEL_PINS=${id}=files:${digest})`);
    throw new SpeechIntegrityError(`The model ${id} has no recorded hashes (${why}). It was not loaded: if these are the files you installed, trust them in AI & speech → Offline speech (owner), or reinstall the model.`);
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

/**
 * 6.12 review S02: the operator's explicit action (console, owner role) —
 * records the files installed for `id` as they are now (source "operator"),
 * after a lost manifest or for a model installed before 6.12. A manifest that
 * does not verify is replaced only when `replaceInvalid` (the console asks);
 * the other models' entries are kept when it verifies.
 */
export async function trustInstalled(root: string, id: string, url: string, opts: { replaceInvalid?: boolean } = {}): Promise<ModelRecord> {
  const dir = join(root, id);
  if (!existsSync(dir)) throw new SpeechIntegrityError(`The model ${id} is not installed.`);
  let models: Record<string, ModelRecord>;
  try { models = readManifest(root); } catch (err) {
    if (!opts.replaceInvalid) throw err;
    models = {};
  }
  const files = await hashTree(dir);
  models[id] = { url, archive: models[id]?.archive ?? "", archiveBytes: models[id]?.archiveBytes ?? 0, files, at: Date.now(), source: "operator" };
  writeManifest(root, models);
  return models[id];
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
