// Room-level crypto helpers. Kept in a dedicated module so App.tsx and other
// consumers can share the same implementation without duplicating it.
//
// Contract:
//   - deriveRoomKey(room, passphrase) -> non-extractable AES-GCM-256 key.
//   - encryptEnvelope(key, payload) -> { iv, ciphertext } with a fresh 12-byte IV.
//   - decryptEnvelope(key, envelope) -> parsed payload.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

export function fromBase64(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
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
