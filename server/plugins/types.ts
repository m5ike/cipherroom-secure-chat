// Small helpers the AI & speech endpoints share (4.14: the connectors that
// lived next to this file became the provider adapters in server/ai/).

export function bytesToBase64(bytes: Uint8Array): string {
  // Node has Buffer; this module only runs server-side.
  return Buffer.from(bytes).toString("base64");
}
export function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
