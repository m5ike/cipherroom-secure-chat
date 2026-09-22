// Minimal CBOR (RFC 8949) decoder for WebAuthn: attestation objects and
// COSE public keys. Supports everything those use — unsigned / negative
// integers, byte and text strings, arrays, maps (as Map, keys may be ints),
// tags (unwrapped), simple values and floats. Indefinite lengths are
// rejected (WebAuthn never uses them); nesting and sizes are bounded.

export type CborValue = number | bigint | string | Uint8Array | boolean | null | undefined | CborValue[] | Map<CborValue, CborValue>;

const MAX_DEPTH = 16;
const MAX_ITEMS = 4096;

export class CborError extends Error {}

export function decodeCbor(input: Uint8Array): { value: CborValue; length: number } {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let pos = 0;
  let items = 0;

  const need = (n: number) => {
    if (pos + n > input.length) throw new CborError("truncated CBOR");
  };
  const readArg = (info: number): number | bigint => {
    if (info < 24) return info;
    if (info === 24) { need(1); return input[pos++]; }
    if (info === 25) { need(2); const v = view.getUint16(pos); pos += 2; return v; }
    if (info === 26) { need(4); const v = view.getUint32(pos); pos += 4; return v; }
    if (info === 27) {
      need(8);
      const v = view.getBigUint64(pos);
      pos += 8;
      return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }
    throw new CborError("indefinite / reserved length not supported");
  };
  const len = (info: number): number => {
    const n = readArg(info);
    if (typeof n === "bigint" || n > input.length) throw new CborError("length out of range");
    return n;
  };

  const item = (depth: number): CborValue => {
    if (depth > MAX_DEPTH) throw new CborError("CBOR nested too deep");
    if (++items > MAX_ITEMS) throw new CborError("too many CBOR items");
    need(1);
    const initial = input[pos++];
    const major = initial >> 5;
    const info = initial & 0x1f;
    switch (major) {
      case 0: return readArg(info);
      case 1: {
        const n = readArg(info);
        return typeof n === "bigint" ? -1n - n : -1 - n;
      }
      case 2: {
        const n = len(info);
        need(n);
        const out = input.slice(pos, pos + n);
        pos += n;
        return out;
      }
      case 3: {
        const n = len(info);
        need(n);
        const out = new TextDecoder("utf-8", { fatal: true }).decode(input.subarray(pos, pos + n));
        pos += n;
        return out;
      }
      case 4: {
        const n = len(info);
        const out: CborValue[] = [];
        for (let i = 0; i < n; i++) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        const n = len(info);
        const out = new Map<CborValue, CborValue>();
        for (let i = 0; i < n; i++) {
          const k = item(depth + 1);
          out.set(k, item(depth + 1));
        }
        return out;
      }
      case 6: readArg(info); return item(depth + 1); // tag: keep the tagged value
      case 7: {
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        if (info === 25) { need(2); const v = halfToFloat(view.getUint16(pos)); pos += 2; return v; }
        if (info === 26) { need(4); const v = view.getFloat32(pos); pos += 4; return v; }
        if (info === 27) { need(8); const v = view.getFloat64(pos); pos += 8; return v; }
        if (info < 24) return info;
        if (info === 24) { need(1); return input[pos++]; }
        throw new CborError("unsupported simple value");
      }
      default: throw new CborError("bad major type");
    }
  };

  const value = item(0);
  return { value, length: pos };
}

function halfToFloat(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  const sign = s ? -1 : 1;
  if (e === 0) return sign * 2 ** -14 * (f / 1024);
  if (e === 0x1f) return f ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * 2 ** (e - 15) * (1 + f / 1024);
}
