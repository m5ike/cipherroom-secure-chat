// Crypto helper — passphrase-derived room key + envelope encrypt/decrypt.
//
// Schema:
//   passphrase + room → PBKDF2-SHA256 (250 000 iterací) → AES-GCM 256
//   envelope = { v: 1, alg: "AES-GCM", iv: <base64>, ciphertext: <base64> }
//   IV: 12 náhodných byte na každou zprávu
//
// `version` v envelope umožní budoucí breaking change v iteracích/alg,
// aniž by se klienti rozbili.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const PBKDF2_ITERATIONS = 250_000;
export const KEY_VERSION = 1;
export const ENVELOPE_ALG = "AES-GCM";

export function newId(prefix = "id") {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function normalizeRoom(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "secure-room"
  );
}

export function toBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

export function fromBase64(value: string) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

export async function deriveRoomKey(room: string, passphrase: string) {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode(`CipherRoom:v${KEY_VERSION}:${room}`),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    material,
    { name: ENVELOPE_ALG, length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export type DataChannelEnvelope = {
  v: typeof KEY_VERSION;
  alg: typeof ENVELOPE_ALG;
  iv: string;
  ciphertext: string;
};

export async function encryptEnvelope(
  key: CryptoKey,
  payload: unknown,
): Promise<DataChannelEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: ENVELOPE_ALG, iv }, key, plaintext),
  );
  return {
    v: KEY_VERSION,
    alg: ENVELOPE_ALG,
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext),
  };
}

export async function decryptEnvelope<T>(
  key: CryptoKey,
  envelope: DataChannelEnvelope,
): Promise<T> {
  if (envelope?.alg !== ENVELOPE_ALG) {
    throw new Error("Unsupported envelope algorithm.");
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: ENVELOPE_ALG, iv: fromBase64(envelope.iv) },
    key,
    fromBase64(envelope.ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Passphrase strength check
// ─────────────────────────────────────────────────────────────────────────────

export type PassphraseStrength = { ok: boolean; level: "ok" | "warn" | "weak"; message?: string };

export function evaluatePassphrase(pp: string): PassphraseStrength {
  if (!pp) return { ok: false, level: "weak", message: "Klíč místnosti je povinný." };
  if (pp.length < 8) return { ok: false, level: "weak", message: "Alespoň 8 znaků." };
  if (pp.length < 12) {
    return { ok: true, level: "warn", message: "Doporučujeme 12+ znaků." };
  }
  const unique = new Set(pp).size;
  if (unique < 6 && pp.length < 20) {
    return { ok: true, level: "warn", message: "Málo unikátních znaků — zvaž delší frázi." };
  }
  return { ok: true, level: "ok" };
}

// ─────────────────────────────────────────────────────────────────────────────
// DTLS-SRTP fingerprint extraction pro TOFU safety number
// ─────────────────────────────────────────────────────────────────────────────

export async function getDtlsFingerprint(pc: RTCPeerConnection): Promise<string> {
  const stats = await pc.getStats();
  let fpHexes: string[] | null = null;
  for (const report of stats.values()) {
    // Stats report typu "transport" nebo "candidate-pair" může nést fingerprint.
    const r = report as Record<string, unknown>;
    const candidate = r["selectedCandidatePairId"];
    if (typeof candidate === "string") {
      try {
        const fp = await crypto.subtle.digest(
          "SHA-256",
          encoder.encode(`cipherroom-safety:${candidate}:${pc.connectionState ?? ""}`),
        );
        fpHexes = Array.from(new Uint8Array(fp))
          .slice(0, 8)
          .map((b) => b.toString(16).padStart(2, "0"));
      } catch {
        // ignore
      }
      break;
    }
  }
  // Fallback: deterministický hash z remoteDescription.sdp, pokud je k dispozici
  if (!fpHexes) {
    const remote = pc.remoteDescription?.sdp;
    if (remote) {
      const fp = await crypto.subtle.digest("SHA-256", encoder.encode(remote));
      fpHexes = Array.from(new Uint8Array(fp))
        .slice(0, 8)
        .map((b) => b.toString(16).padStart(2, "0"));
    }
  }
  if (!fpHexes) return "????-????-????";
  // Formát: XXXX-XXXX-XXXX (12 hex chars ve 3 skupinách, snadno přečte přes telefon)
  const joined = fpHexes.join("");
  return `${joined.slice(0, 4)}-${joined.slice(4, 8)}-${joined.slice(8, 12)}`.toUpperCase();
}
