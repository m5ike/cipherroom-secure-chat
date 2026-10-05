// Release manifests (docs/protocol-v4.md § 15, F-02).
//
// `release.json` lists every file of a release with its size and SHA-256;
// `release.json.sig` is the developer's Ed25519 signature over its exact
// bytes (made off the server), `release-signing.pub` the raw public key.
// An unsigned manifest still detects corruption and local modification; a
// signed one also detects a package that did not come from the developer.
// Used by the web integrity check (dist/public/release-web.json) and by Node
// scripts (installer, server self-check) — WebCrypto only.

import type { ReleaseManifest } from "./contract";
import { ed25519Verify, hex, P4Error, unb64, utf8 } from "./primitives";

export const RELEASE_FORMAT = "m5cet-release/1";

const HEX64 = /^[0-9a-f]{64}$/;

/** A path relative to the release root with "/": no leading "/", no "\\", no empty, "." or ".." segment. */
export function isReleasePath(path: unknown): path is string {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** Parses and validates `release.json`; `files` must be sorted by path (ordinal order) without duplicates. */
export function parseReleaseManifest(input: string | Uint8Array): ReleaseManifest {
  let value: unknown;
  try {
    value = JSON.parse(typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input));
  } catch {
    throw new P4Error("malformed", "release manifest is not JSON");
  }
  const m = value as Partial<ReleaseManifest> | null;
  if (!m || typeof m !== "object" || m.format !== RELEASE_FORMAT) throw new P4Error("malformed", "not an m5cet-release/1 manifest");
  for (const field of ["name", "version", "commit", "created"] as const) {
    if (typeof m[field] !== "string") throw new P4Error("malformed", `manifest ${field} missing`);
  }
  if (!Array.isArray(m.files)) throw new P4Error("malformed", "manifest files missing");
  let previous: string | null = null;
  for (const f of m.files) {
    if (!f || typeof f !== "object" || !isReleasePath(f.path) || !Number.isSafeInteger(f.size) || f.size < 0 || typeof f.sha256 !== "string" || !HEX64.test(f.sha256)) {
      throw new P4Error("malformed", "bad manifest file entry");
    }
    if (previous !== null && !(previous < f.path)) throw new P4Error("malformed", "manifest files not sorted by path");
    previous = f.path;
  }
  return m as ReleaseManifest;
}

/** Ed25519 over the exact manifest bytes; `signature` and `publicKey` are b64 (surrounding whitespace ignored). Never throws. */
export async function verifyReleaseSignature(manifestBytes: Uint8Array | string, signature: string, publicKey: string): Promise<boolean> {
  try {
    const sig = unb64(signature.trim(), 64);
    const pub = unb64(publicKey.trim(), 32);
    return await ed25519Verify(pub, typeof manifestBytes === "string" ? utf8(manifestBytes) : manifestBytes, sig);
  } catch {
    return false;
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))));
}

/** Hash-checks files against the manifest; `read` returns a file's bytes or null when it is missing. */
export async function checkReleaseFiles(manifest: ReleaseManifest, read: (path: string) => Promise<Uint8Array | null>): Promise<{ ok: boolean; missing: string[]; changed: string[] }> {
  const missing: string[] = [];
  const changed: string[] = [];
  for (const f of manifest.files) {
    const bytes = await read(f.path);
    if (!bytes) { missing.push(f.path); continue; }
    if (bytes.length !== f.size || (await sha256Hex(bytes)) !== f.sha256) changed.push(f.path);
  }
  return { ok: missing.length === 0 && changed.length === 0, missing, changed };
}
