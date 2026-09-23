// Keys for the server-side storage.
//
// Two kinds of database key exist, and the difference is the whole security
// story of this subsystem:
//
//   prf      A signed-in user's database is opened with a key their passkey
//            produced (WebAuthn PRF → HKDF, client side). The server holds
//            it in memory while at least one of the user's sessions uses it
//            (and never longer than 12 hours without use), zeroes it when it
//            lets go, and never writes it down: once it is released, nothing
//            on this machine can open that database again until the user
//            signs in.
//
//   wrapped  A session database of someone who has not registered a passkey.
//            The key is random, generated here, and kept wrapped with a key
//            derived from the server's master key so the sweep can still
//            delete it and the same browser can come back to its data. The
//            server can open these — that is why they expire, and why
//            registering a passkey moves the data into a `prf` database.
//
// The master key comes from STORAGE_MASTER_KEY (32 bytes, hex or base64), or
// else from a key file: STORAGE_KEY_FILE when it is set, and by default
// $STORAGE_DIR/storage.key — i.e. $DATA_DIR/storage/storage.key, or
// ./.m5cet/storage/storage.key — right next to m5cet.db. Point
// STORAGE_KEY_FILE at another volume (or use the env variable) so that a copy
// of the storage directory alone does not carry the key to its sessions.
//
// The key file is created once — written to a private temp file (0600),
// flushed, then linked into place so creation is atomic and exclusive — and
// is never overwritten: a key file that exists but cannot be read or parsed
// stops the storage with a clear reason instead of being replaced, because a
// new key would make every session database unreadable.
//
// Nothing uses the master key directly. HKDF derives one subkey per purpose:
// wrapping database keys, sealing values in the global database, and the
// HMAC that turns session ids into the references stored on disk.

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const KEY_BYTES = 32;

export type KeyMode = "prf" | "wrapped";

const env = (name: string) => process.env[name]?.trim() || "";

/** Where all server-side storage lives. */
export function storageDir(): string {
  const explicit = env("STORAGE_DIR");
  if (explicit) return resolve(explicit);
  const data = env("DATA_DIR");
  return data ? resolve(data, "storage") : resolve(process.cwd(), ".m5cet", "storage");
}

/** Where the master key file is (or will be created). Default: next to
 *  m5cet.db in the storage directory; STORAGE_KEY_FILE moves it. */
export function masterKeyFile(): string {
  const explicit = env("STORAGE_KEY_FILE");
  return explicit ? resolve(explicit) : join(storageDir(), "storage.key");
}

function parseKeyMaterial(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  if (!/^[A-Za-z0-9+/_-]{42,44}={0,2}$/.test(trimmed)) return null;
  const buf = Buffer.from(trimmed, trimmed.includes("-") || trimmed.includes("_") ? "base64url" : "base64");
  return buf.length === KEY_BYTES ? buf : null;
}

/** The master key could not be loaded: storage must stay off. */
export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MasterKeyError";
  }
}

type MasterKeys = {
  master: Buffer;
  wrap: Buffer;
  seal: Buffer;
  session: Buffer;
  source: "env" | "file";
};

let cached: MasterKeys | null = null;

function derive(master: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.from("m5cet-storage-v2", "utf8"), Buffer.from(`m5cet:${purpose}`, "utf8"), KEY_BYTES));
}

function createKeyFile(path: string): Buffer {
  const fresh = randomBytes(KEY_BYTES);
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, fresh.toString("hex"));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      // link() is atomic and fails if the name exists: whoever gets there
      // first wins, and nobody ever replaces a key file.
      linkSync(tmp, path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        fresh.fill(0);
        return readExistingKey(path);
      }
      // A filesystem without hard links: rename, but only onto nothing.
      if (existsSync(path)) {
        fresh.fill(0);
        return readExistingKey(path);
      }
      renameSync(tmp, path);
    }
  } catch (err) {
    if (err instanceof MasterKeyError) throw err;
    throw new MasterKeyError(`could not create the storage key file ${path} (${(err as Error).message}); set STORAGE_MASTER_KEY, or STORAGE_KEY_FILE to a writable place`);
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
  }
  console.warn(`[storage] generated a storage master key in ${path}. Back it up, or set STORAGE_MASTER_KEY.`);
  return fresh;
}

function readExistingKey(path: string): Buffer {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
    throw new MasterKeyError(`could not read the storage key file ${path} (${code}); storage stays off rather than replace the key`);
  }
  const parsed = parseKeyMaterial(raw);
  if (!parsed) {
    throw new MasterKeyError(`${path} exists but does not hold a 32-byte key; it was left untouched and storage stays off — restore it, or move it away to generate a new one (existing session databases then become unreadable)`);
  }
  return parsed;
}

function loadMasterKey(): { key: Buffer; source: "env" | "file" } {
  const fromEnv = env("STORAGE_MASTER_KEY");
  if (fromEnv) {
    const parsed = parseKeyMaterial(fromEnv);
    if (!parsed) throw new MasterKeyError("STORAGE_MASTER_KEY is set but is not a 32-byte key (64 hex characters or base64); fix or unset it");
    return { key: parsed, source: "env" };
  }
  const path = masterKeyFile();
  if (existsSync(path)) return { key: readExistingKey(path), source: "file" };
  return { key: createKeyFile(path), source: "file" };
}

function masterKeys(): MasterKeys {
  if (cached) return cached;
  const { key, source } = loadMasterKey();
  cached = { master: key, wrap: derive(key, "wrap-database-keys"), seal: derive(key, "seal-values"), session: derive(key, "session-id-hmac"), source };
  return cached;
}

/** The storage master key. Throws MasterKeyError when it cannot be loaded —
 *  it never silently falls back to a key that would not survive a restart. */
export function getMasterKey(): { key: Buffer; source: "env" | "file" } {
  const keys = masterKeys();
  return { key: keys.master, source: keys.source };
}

/** Loads the master key once, for start-up: ok, or the reason storage is off. */
export function checkMasterKey(): { ok: true; source: "env" | "file" } | { ok: false; reason: string } {
  try {
    return { ok: true, source: masterKeys().source };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/** A fresh database key. */
export function newDatabaseKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** SQLCipher wants the raw key as x'<hex>'. */
export function keyToSqlcipher(key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new Error(`database key must be ${KEY_BYTES} bytes`);
  return `x'${key.toString("hex")}'`;
}

/** Accepts the hex or base64 key a client derived from its passkey. */
export function parseClientKey(raw: unknown): Buffer | null {
  if (typeof raw !== "string" || raw.length < 32 || raw.length > 128) return null;
  const parsed = parseKeyMaterial(raw);
  return parsed && parsed.length === KEY_BYTES ? parsed : null;
}

/* ---------------------------------------------------------------- AES-GCM */

function gcmSeal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function gcmOpen(key: Buffer, sealed: Buffer, aad: string): Buffer | null {
  try {
    if (sealed.length < 12 + 16 + 1) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(sealed.subarray(12, 28));
    return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- wrapping */

/** AES-256-GCM under the wrapping subkey: iv ‖ tag ‖ ciphertext, with `aad`
 *  binding it to its row. */
export function wrapKey(key: Buffer, aad: string): Buffer {
  return gcmSeal(masterKeys().wrap, key, aad);
}

/** The other half of wrapKey. Keys wrapped before the subkeys existed (with
 *  the master key itself) still open, so old session databases survive the
 *  upgrade; the global store re-wraps them. */
export function unwrapKey(wrapped: Buffer, aad: string): Buffer | null {
  try {
    const keys = masterKeys();
    const buf = Buffer.from(wrapped);
    return gcmOpen(keys.wrap, buf, aad) ?? gcmOpen(keys.master, buf, aad);
  } catch {
    return null;
  }
}

/** Encrypts a value that goes into the global database (logs, transfers,
 *  audit). `aad` must name the row it belongs to. */
export function sealValue(plaintext: string, aad: string): Buffer {
  return gcmSeal(masterKeys().seal, Buffer.from(plaintext, "utf8"), aad);
}

/** Opens a sealed value; null when it was sealed for another row, or under
 *  the scheme before the subkeys (those old details simply read as null). */
export function openValue(sealed: Buffer | Uint8Array | null, aad: string): string | null {
  if (!sealed) return null;
  try {
    const opened = gcmOpen(masterKeys().seal, Buffer.from(sealed), aad);
    return opened ? opened.toString("utf8") : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ session ids */

/** What the server stores instead of a session id: an HMAC under a subkey
 *  of the master key. The id itself is a bearer secret held by the browser. */
export function sessionRef(sessionId: string): string {
  return `sr-${createHmac("sha256", masterKeys().session).update(sessionId, "utf8").digest("base64url")}`;
}

/** A plain session id becomes its reference; a reference stays as it is. */
export function toSessionRef(value: string): string {
  return value.startsWith("sess-") ? sessionRef(value) : value;
}

/* ------------------------------------------------------- key fingerprints */

// Per-process pepper: the pool keeps a fingerprint of each key it opened a
// database with, and a fingerprint is useless outside this process.
const pepper = randomBytes(32);

/** A fingerprint of a database key, for comparing without keeping it twice. */
export function digestKey(key: Buffer): Buffer {
  return createHmac("sha256", pepper).update(key).digest();
}

/** Constant-time comparison of two digests (or any equal-length buffers). */
export function sameDigest(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A value that proves a key belongs to a database without revealing it:
 *  lets a wrong key be told apart from a damaged file. */
export function keyCheckValue(key: Buffer, databaseId: string): Buffer {
  return createHmac("sha256", key).update(`m5cet:key-check:v1:${databaseId}`, "utf8").digest();
}

/** Who holds an account key open: the hash of the bearer token, so one
 *  device signing out does not lock the others. Deliberately the same value
 *  as tokenHash() in accounts/store.ts (SHA-256, hex), so a revoke listener
 *  can hand its token hash straight to StorageService.releaseAccount. */
export function holderForToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison for opaque session ids. */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Test seam: forget the cached master key (and its subkeys). */
export function _resetMasterKeyForTests(): void {
  if (cached) {
    for (const buf of [cached.master, cached.wrap, cached.seal, cached.session]) buf.fill(0);
  }
  cached = null;
}
