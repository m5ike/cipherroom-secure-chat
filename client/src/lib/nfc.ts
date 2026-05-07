// Web NFC module — Android Chrome only.
//
// Reads/writes encrypted client/room settings on NFC tags. The user
// supplies a 4–16 digit PIN. We derive an AES-GCM key with PBKDF2
// (200k iterations, SHA-256) and encrypt the JSON payload. The tag
// holds: salt (16 B) | iv (12 B) | ciphertext as a base64 NDEF text
// record.
//
// Reader plug-in interface: third parties can register a hardware
// reader (RFID, EMV via PC/SC, etc.) by implementing CardReaderModule
// and calling registerCardReader(). EMV card-data reading is NOT
// implemented here for safety reasons; metadata-only profiles can be
// surfaced via these modules.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type NfcCaps = { available: boolean; reason?: string };

export function detectNfc(): NfcCaps {
  if (typeof window === "undefined") return { available: false, reason: "no-window" };
  if (!("NDEFReader" in window)) {
    return { available: false, reason: "Web NFC není podporováno tímto prohlížečem (typicky vyžaduje Android Chrome)." };
  }
  return { available: true };
}

export function isValidPin(pin: string): boolean {
  return /^[0-9]{4,16}$/.test(pin);
}

async function deriveKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 200_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function toB64(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}
function fromB64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

export type NfcPayload = Record<string, unknown>;

export async function encryptForTag(pin: string, payload: NfcPayload): Promise<string> {
  if (!isValidPin(pin)) throw new Error("PIN musí být 4–16 číslic.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(payload))));
  const combined = new Uint8Array(salt.length + iv.length + ct.length);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(ct, salt.length + iv.length);
  return `m5cet:nfc:v1:${toB64(combined)}`;
}

export async function decryptFromTag(pin: string, blob: string): Promise<NfcPayload> {
  if (!blob.startsWith("m5cet:nfc:v1:")) throw new Error("Tag neobsahuje M5cet payload.");
  if (!isValidPin(pin)) throw new Error("PIN musí být 4–16 číslic.");
  const combined = fromB64(blob.slice("m5cet:nfc:v1:".length));
  if (combined.length < 16 + 12 + 1) throw new Error("Tag payload příliš krátký.");
  const salt = combined.slice(0, 16);
  const iv = combined.slice(16, 28);
  const ct = combined.slice(28);
  const key = await deriveKey(pin, salt);
  const out = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(decoder.decode(out)) as NfcPayload;
}

type NDEFReaderLike = {
  scan: (opts?: { signal?: AbortSignal }) => Promise<void>;
  write: (msg: { records: Array<{ recordType: string; data?: string }> }) => Promise<void>;
  addEventListener: (type: string, cb: (ev: unknown) => void) => void;
};

export type ReadResult = { ok: true; blob: string } | { ok: false; reason: string };

export async function scanOnce(timeoutMs = 30_000): Promise<ReadResult> {
  const caps = detectNfc();
  if (!caps.available) return { ok: false, reason: caps.reason || "unsupported" };
  const W = window as unknown as { NDEFReader: new () => NDEFReaderLike };
  const reader = new W.NDEFReader();
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), timeoutMs);
  try {
    await reader.scan({ signal: ac.signal });
  } catch (err) {
    clearTimeout(timeout);
    return { ok: false, reason: (err as Error).message || "scan-error" };
  }
  return await new Promise<ReadResult>((resolve) => {
    reader.addEventListener("reading", (ev: unknown) => {
      clearTimeout(timeout);
      const message = (ev as { message?: { records?: Array<{ recordType: string; data?: ArrayBuffer }> } }).message;
      const records = message?.records || [];
      for (const r of records) {
        if (r.recordType === "text" && r.data) {
          // Strip 3-byte status + lang prefix for text records.
          const view = new Uint8Array(r.data as ArrayBuffer);
          const langLen = view[0] & 0x3f;
          const text = new TextDecoder().decode(view.slice(1 + langLen));
          if (text.startsWith("m5cet:nfc:v1:")) return resolve({ ok: true, blob: text });
        }
      }
      resolve({ ok: false, reason: "Tag nemá M5cet payload." });
    });
    reader.addEventListener("readingerror", () => resolve({ ok: false, reason: "reading-error" }));
  });
}

export async function writeBlob(blob: string): Promise<{ ok: boolean; reason?: string }> {
  const caps = detectNfc();
  if (!caps.available) return { ok: false, reason: caps.reason || "unsupported" };
  const W = window as unknown as { NDEFReader: new () => NDEFReaderLike };
  const reader = new W.NDEFReader();
  try {
    await reader.write({ records: [{ recordType: "text", data: blob }] });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message || "write-error" };
  }
}

// ---------- Plug-and-play hardware reader registry ----------
//
// Third-party modules can register a CardReader implementation that is
// discovered by the admin/diagnostic UI. We do NOT include EMV card-data
// reading by default because handling primary account numbers requires
// PCI-DSS scope. Modules should only surface non-sensitive metadata
// (tag UID, ATR, application IDs) unless the operator has explicit
// authorisation and dedicated hardware.

export type CardReaderModule = {
  id: string;
  label: string;
  capabilities: string[]; // e.g. ["nfc-uid", "rfid-uid", "atr-only"]
  isAvailable(): Promise<boolean> | boolean;
  read(): Promise<{ ok: boolean; uid?: string; meta?: Record<string, unknown>; reason?: string }>;
};

const readers: CardReaderModule[] = [];

export function registerCardReader(mod: CardReaderModule) {
  if (!readers.some((r) => r.id === mod.id)) readers.push(mod);
}
export function listCardReaders(): CardReaderModule[] { return [...readers]; }

// Built-in: Web NFC tag UID reader (no payload decryption).
registerCardReader({
  id: "web-nfc-uid",
  label: "Web NFC tag UID",
  capabilities: ["nfc-uid"],
  isAvailable: () => detectNfc().available,
  async read() {
    const caps = detectNfc();
    if (!caps.available) return { ok: false, reason: caps.reason };
    const W = window as unknown as { NDEFReader: new () => NDEFReaderLike };
    const reader = new W.NDEFReader();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20_000);
    try { await reader.scan({ signal: ac.signal }); } catch (err) { return { ok: false, reason: (err as Error).message }; }
    return await new Promise<{ ok: boolean; uid?: string; reason?: string }>((resolve) => {
      reader.addEventListener("reading", (ev: unknown) => {
        const sn = (ev as { serialNumber?: string }).serialNumber;
        resolve({ ok: true, uid: sn });
      });
      reader.addEventListener("readingerror", () => resolve({ ok: false, reason: "reading-error" }));
    });
  },
});
