// Room-level crypto helpers. Kept in a dedicated module so App.tsx and other
// consumers can share the same implementation without duplicating it.
//
// Contract:
//   - deriveRoomKey(room, passphrase) -> non-extractable AES-GCM-256 key.
//   - encryptEnvelope(key, payload) -> { iv, ciphertext } with a fresh 12-byte IV.
//   - decryptEnvelope(key, envelope) -> parsed payload.
//   - toBase64 / fromBase64 -> the single base64 codec for every encrypted
//     frame (chat envelopes, file chunks, NFC payloads).

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Bytes backed by a plain ArrayBuffer. WebCrypto and Blob reject
 * SharedArrayBuffer-backed views at runtime, and TypeScript >= 5.7 models
 * that, so anything handed to `crypto.subtle` is typed as this.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

// ES2026 Uint8Array base64 (Chrome 140+, Firefox 133+, Safari 18.2+).
// Feature-detected once; the fallback below is the portable path.
type NativeBase64 = {
  encode: (bytes: Uint8Array) => string;
  decode: (value: string) => Bytes;
};
const native: NativeBase64 | null = (() => {
  const proto = Uint8Array.prototype as unknown as { toBase64?: () => string };
  const ctor = Uint8Array as unknown as { fromBase64?: (value: string) => Bytes };
  if (typeof proto.toBase64 !== "function" || typeof ctor.fromBase64 !== "function") return null;
  const fromBase64 = ctor.fromBase64;
  return {
    encode: (bytes) => (bytes as unknown as { toBase64: () => string }).toBase64(),
    decode: (value) => fromBase64(value),
  };
})();

// String.fromCharCode.apply spreads its argument onto the stack; 32 KiB per
// call stays far below every engine's argument limit.
const APPLY_CHUNK = 0x8000;

/**
 * Standard padded base64. Sits on the hot path — every 32 KiB file chunk is
 * encoded once and decoded once — so it avoids per-byte callbacks: measured
 * 2-3x (encode) and 20-30x (decode) faster than the forEach / Uint8Array.from
 * (string, mapFn) versions it replaces, with byte-identical output.
 */
export function toBase64(bytes: Uint8Array): string {
  if (native) return native.encode(bytes);
  let binary = "";
  for (let i = 0; i < bytes.length; i += APPLY_CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + APPLY_CHUNK) as unknown as number[]);
  }
  return btoa(binary);
}

/** Inverse of {@link toBase64}. Throws on malformed input, like `atob`. */
export function fromBase64(value: string): Bytes {
  if (native) return native.decode(value);
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Derive the per-room AES-GCM 256 key from the room id + user-supplied
 * passphrase. PBKDF2-SHA256, 250 000 iterations, salt `CipherRoom:v1:<room>`.
 *
 * The room id participates in the salt so reusing the same passphrase across
 * rooms still yields independent keys. The key is non-extractable; the
 * server never sees it. Salt v1 is intentionally fixed — changing it is a
 * breaking key-format migration and must bump the prefix.
 */
export async function deriveRoomKey(room: string, passphrase: string) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode(`CipherRoom:v1:${room}`),
      iterations: 250_000,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export type DataChannelEnvelope = { iv: string; ciphertext: string };

/**
 * Wrap a plaintext payload in an AES-GCM envelope with a fresh random 12-byte
 * IV. The IV/ciphertext pair is base64-encoded and shipped over the WebRTC
 * DataChannel. Reusing an IV with the same key would catastrophically break
 * GCM, so callers MUST NOT cache `iv` — `crypto.getRandomValues` is the only
 * source.
 */
export async function encryptEnvelope<T>(key: CryptoKey, payload: T): Promise<DataChannelEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return { iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
}

/**
 * Inverse of {@link encryptEnvelope}. Throws if the ciphertext was tampered
 * with or if the receiver derived a different key (different passphrase).
 * The caller surfaces the failure to the user as "different room key" rather
 * than as a crash.
 */
export async function decryptEnvelope<T>(key: CryptoKey, envelope: DataChannelEnvelope): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(envelope.iv) },
    key,
    fromBase64(envelope.ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}
