// Keys for the server-side storage.
//
// Two kinds of database key exist, and the difference is the whole security
// story of this subsystem:
//
//   prf      A signed-in user's database is opened with a key their passkey
//            produced (WebAuthn PRF → HKDF, client side). The server holds
//            it in memory for the length of the session and never writes it
//            down: once the session ends, nothing on this machine can open
//            that database again until the user signs in.
//
//   wrapped  A session database of someone who has not registered a passkey.
//            The key is random, generated here, and kept wrapped with the
//            server's master key so the sweep can still delete it and the
//            same browser can come back to its data for a day. The server
//            can open these — that is why they expire, and why registering
//            a passkey moves the data into a `prf` database (promote.ts).
//
// The master key comes from STORAGE_MASTER_KEY (32 bytes, base64 or hex).
// Without it we generate one into $DATA_DIR/storage.key with mode 0600 and
// say so; losing that file makes every `wrapped` database unreadable, which
// is exactly what it means for data to be encrypted at rest.

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function parseKeyMaterial(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  try {
    const buf = Buffer.from(trimmed, "base64");
    return buf.length === KEY_BYTES ? buf : null;
  } catch {
    return null;
  }
}

let masterKey: Buffer | null = null;
let masterKeySource: "env" | "file" | "memory" = "memory";

/** The key that wraps session-database keys. Stable across restarts unless
 *  the file is lost. */
export function getMasterKey(): { key: Buffer; source: typeof masterKeySource } {
  if (masterKey) return { key: masterKey, source: masterKeySource };

  const fromEnv = env("STORAGE_MASTER_KEY");
  if (fromEnv) {
    const parsed = parseKeyMaterial(fromEnv);
    if (parsed) {
      masterKey = parsed;
      masterKeySource = "env";
      return { key: masterKey, source: masterKeySource };
    }
    console.warn("[storage] STORAGE_MASTER_KEY is not 32 bytes (hex or base64); falling back to the key file.");
  }

  const path = join(storageDir(), "storage.key");
  try {
    if (existsSync(path)) {
      const parsed = parseKeyMaterial(readFileSync(path, "utf8"));
      if (parsed) {
        masterKey = parsed;
        masterKeySource = "file";
        return { key: masterKey, source: masterKeySource };
      }
      console.warn(`[storage] ${path} does not hold a 32-byte key; generating a new one — existing session databases become unreadable.`);
    }
    const fresh = randomBytes(KEY_BYTES);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, fresh.toString("hex"), { mode: 0o600 });
    chmodSync(path, 0o600);
    masterKey = fresh;
    masterKeySource = "file";
    console.warn(`[storage] generated a storage master key in ${path}. Back it up, or set STORAGE_MASTER_KEY.`);
  } catch (err) {
    // Read-only install: still usable, but session databases do not survive
    // a restart (their keys were never written down).
    masterKey = randomBytes(KEY_BYTES);
    masterKeySource = "memory";
    console.warn(`[storage] could not persist a master key (${(err as Error).message}); session databases will not survive a restart.`);
  }
  return { key: masterKey, source: masterKeySource };
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

/* ------------------------------------------------------------- wrapping */

/** AES-256-GCM: iv ‖ tag ‖ ciphertext, with `aad` binding it to its row. */
export function wrapKey(key: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getMasterKey().key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(key), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function unwrapKey(wrapped: Buffer, aad: string): Buffer | null {
  try {
    if (wrapped.length < 12 + 16 + 1) return null;
    const decipher = createDecipheriv("aes-256-gcm", getMasterKey().key, wrapped.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(wrapped.subarray(12, 28));
    return Buffer.concat([decipher.update(wrapped.subarray(28)), decipher.final()]);
  } catch {
    return null;
  }
}

/** Encrypts a value that goes into the global database (logs, transfers). */
export function sealValue(plaintext: string, aad: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getMasterKey().key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function openValue(sealed: Buffer | Uint8Array | null, aad: string): string | null {
  if (!sealed) return null;
  const buf = Buffer.from(sealed);
  const key = unwrapKey(buf, aad);
  return key ? key.toString("utf8") : null;
}

/** Constant-time comparison for opaque session ids. */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Test seam: forget the cached master key. */
export function _resetMasterKeyForTests(): void {
  masterKey = null;
  masterKeySource = "memory";
}
