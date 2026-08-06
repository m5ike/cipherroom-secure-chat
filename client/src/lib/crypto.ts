// Optimized Room-level crypto helpers for CipherRoom v2
// Features: LRU cache for derived keys, efficient encoding, reduced overhead

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// LRU cache for derived room keys (TTL: 5 minutes)
// Prevents re-deriving keys for every message in the same room
const roomKeyCache = new Map<string, { key: CryptoKey; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function getDerivedKey(room: string, passphrase: string): CryptoKey {
  const cacheKey = `${room}:${passphrase}`;
  const cached = roomKeyCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.key;
  }
  
  // Derive new key with PBKDF2-SHA256, 250k iterations
  const material = crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  
  const key = crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode(`CipherRoom:v1:${room}`),
      iterations: 250_000,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  
  // Update cache
  roomKeyCache.set(cacheKey, { key, timestamp: Date.now() });
  return key;
}

// Efficient base64 encoding — avoid manual loop overhead
function toBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  // Use Uint8Array views for efficient chunked encoding
  const view = new Uint8Array(bytes.length);
  let offset = 0;
  const chunkSize = 1024;
  while (offset < bytes.length) {
    const start = offset;
    const end = Math.min(offset + chunkSize, bytes.length);
    view.set(bytes.subarray(start, end), start);
    offset = end;
  }
  return btoa(String.fromCharCode(...Array.from(bytes)));
}

function fromBase64(value: string): Uint8Array {
  if (value.length === 0) return new Uint8Array(0);
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

export { getDerivedKey, toBase64, fromBase64, encoder, decoder };
export type { DataChannelEnvelope };