// @vitest-environment node
//
// Property tests with a seeded generator: whatever arrives from the
// network — a signaling frame, a binary chunk, a Redis reply, a decrypted
// payload, a file's meta — the parsers never throw, and what they accept
// keeps its invariants. A failure prints the seed; FUZZ_SEED=<n> replays it.

import { describe, it, expect } from "vitest";
import { isFrameError, MAX_FRAME_BYTES, parseFrame } from "../server/signaling/frames";
import { isBinaryError, parseBinaryChunk } from "../server/signaling/binary";
import { parseReply } from "../server/cluster/resp";
import { decodeChunk, encodeChunk, FRAME_PROXY_CHUNK } from "../client/src/lib/binary-frames";
import { validatePayload } from "../client/src/lib/validate";
import { checkMeta, MAX_TOTAL_CHUNKS } from "../client/src/lib/file-transfer";
import { isSealed } from "../client/src/lib/media-frames";

const RUNS = Number(process.env.FUZZ_RUNS) || 3000;
const SEED = Number(process.env.FUZZ_SEED) || 0x5eed;

/** mulberry32: small, fast, reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T,>(xs: readonly T[]): T => xs[int(xs.length)];
  const nasty = ["", " ", "\u0000", "‮", "💥", "<script>", "../../etc/passwd", "__proto__", "constructor", "a".repeat(300), "NaN", "-1", "1e309", "\ud800"];
  const str = (): string => (next() < 0.3 ? pick(nasty) : Array.from({ length: int(24) }, () => String.fromCharCode(int(next() < 0.9 ? 128 : 0xffff))).join(""));
  const num = (): number => pick([0, -1, 1, 2 ** 31, 2 ** 53, -(2 ** 53), NaN, Infinity, -Infinity, 0.5, int(1_000_000)]);
  const value = (depth = 0): unknown => {
    const k = int(depth > 3 ? 5 : 8);
    if (k === 0) return null;
    if (k === 1) return next() < 0.5;
    if (k === 2) return num();
    if (k === 3 || k === 4) return str();
    if (k === 5) return Array.from({ length: int(5) }, () => value(depth + 1));
    const o: Record<string, unknown> = {};
    for (let i = int(6); i > 0; i--) o[next() < 0.5 ? str() : pick(KEYS)] = value(depth + 1);
    return o;
  };
  const bytes = (n: number) => Uint8Array.from({ length: n }, () => int(256));
  return { next, int, pick, str, num, value, bytes };
}

const KEYS = ["type", "room", "name", "peerId", "target", "payload", "sdp", "candidate", "messageId", "ids", "transferId", "seq", "iv", "ciphertext", "seqs", "v", "auth", "resume", "features", "away", "state", "messageIds", "kind", "text", "id", "senderId", "createdAt", "attachment", "size", "chunkSize", "totalChunks", "mime"] as const;
const TYPES = ["join", "auth", "leave", "signal", "ping", "presence", "relay", "relay-ack", "receipt", "command-poll", "command-ack", "storage", "proxy-meta", "proxy-chunk", "proxy-end", "proxy-cancel", "proxy-need", "hello", "x"] as const;

function forAll(name: string, body: (r: ReturnType<typeof rng>, i: number) => void) {
  it(name, () => {
    const r = rng(SEED ^ [...name].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261));
    for (let i = 0; i < RUNS; i++) {
      try { body(r, i); } catch (err) { throw new Error(`${name}, run ${i} (FUZZ_SEED=${SEED}): ${(err as Error).message}`); }
    }
  });
}

describe("signaling frames", () => {
  forAll("parseFrame never throws, and what it accepts is well-formed", (r) => {
    const frame: Record<string, unknown> = { ...(r.value() as object), type: r.pick(TYPES) };
    for (const k of KEYS) if (r.next() < 0.25) frame[k] = r.value(1);
    let raw = JSON.stringify(frame) ?? "null";
    if (r.next() < 0.1) raw = raw.slice(0, r.int(raw.length)); // truncated JSON
    const out = parseFrame(raw);
    if (isFrameError(out)) { expect(typeof out.code).toBe("string"); return; }
    expect(TYPES).toContain(out.type);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    const text = JSON.stringify(out);
    expect(text.length).toBeLessThanOrEqual(MAX_FRAME_BYTES * 2);
    if (out.type === "join") {
      expect(out.room.length).toBeGreaterThan(0);
      expect(out.name.length).toBeLessThanOrEqual(64);
    }
    if (out.type === "proxy-need") expect(out.seqs.every((n) => Number.isInteger(n) && n >= 0)).toBe(true);
  });

  forAll("refuses anything over the frame limit without parsing it", (r) => {
    if (r.next() > 0.02) return;
    expect(parseFrame(`{"type":"ping","x":"${"a".repeat(MAX_FRAME_BYTES)}"}`)).toMatchObject({ code: "too-large" });
  });
});

describe("binary chunks", () => {
  forAll("random and mutated bytes decode to a valid chunk or nothing", (r) => {
    let buf: Uint8Array;
    if (r.next() < 0.5) {
      buf = r.bytes(r.int(200));
    } else {
      buf = new Uint8Array(encodeChunk({ type: FRAME_PROXY_CHUNK, version: 3, transferId: "xfer-" + r.int(1e6), seq: r.int(2 ** 31), iv: r.bytes(12), data: r.bytes(16 + r.int(64)) }));
      for (let m = r.int(4); m > 0; m--) buf[r.int(buf.length)] = r.int(256);
      if (r.next() < 0.3) buf = buf.slice(0, r.int(buf.length));
    }
    const client = decodeChunk(buf);
    if (client) {
      expect(client.iv.length).toBe(12);
      expect(client.data.length).toBeGreaterThanOrEqual(16);
      expect(client.transferId).toMatch(/^[A-Za-z0-9_:.-]{1,96}$/);
    }
    const server = parseBinaryChunk(Buffer.from(buf), 256 * 1024);
    if (!isBinaryError(server)) {
      expect(server.iv.length).toBe(12);
      expect(server.seq).toBeLessThanOrEqual(2_000_000);
    }
    expect(typeof isSealed(buf.buffer as ArrayBuffer)).toBe("boolean");
  });
});

describe("Redis replies", () => {
  forAll("parseReply returns a whole value, null (need more), or refuses the stream", (r) => {
    const prefix = r.pick(["+", "-", ":", "$", "*", "?"]);
    const body = r.pick(["OK", "-1", "3", "0", String(r.int(50)), "abc", ""]) + "\r\n" + r.str() + (r.next() < 0.5 ? "\r\n" : "");
    const buf = Buffer.from(prefix + body);
    let out: ReturnType<typeof parseReply> = null;
    try { out = parseReply(buf); } catch (err) { expect((err as Error).message).toMatch(/RESP/); return; }
    // Never an offset the reader cannot continue from (NaN would spin it forever).
    if (out) expect(Number.isInteger(out.next) && out.next > 0 && out.next <= buf.length).toBe(true);
  });
});

describe("decrypted payloads", () => {
  forAll("validatePayload never throws and never lets a reserved or foreign sender through", (r) => {
    const p: Record<string, unknown> = r.value() && typeof r.value() === "object" ? { ...(r.value() as object) } : {};
    for (const k of ["id", "senderId", "senderName", "kind", "text", "createdAt", "attachment", "status"]) if (r.next() < 0.5) p[k] = r.value(1);
    if (r.next() < 0.5) { p.id = "m-" + r.int(1e9); p.senderId = r.pick(["peer-a", "system", "peer-b", r.str()]); p.kind = r.pick(["chat", "audio-status", r.str()]); p.text = r.str(); }
    const out = validatePayload(p, { transportSender: "peer-a", myId: "me" });
    if (!out) return;
    expect(out.senderId).toBe("peer-a");
    expect(out.createdAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
  });
});

describe("file meta", () => {
  forAll("checkMeta never allocates for an impossible file", (r) => {
    const m: Record<string, unknown> = { transferId: "t", ...(r.value() as object) };
    if (r.next() < 0.6) Object.assign(m, { size: r.num(), chunkSize: r.num(), totalChunks: r.num(), name: r.str(), mime: r.str() });
    const out = checkMeta(m, "t", 10 * 1024 ** 3);
    if (typeof out === "string") return;
    expect(out.totalChunks).toBe(Math.max(1, Math.ceil(out.size / out.chunkSize)));
    expect(out.totalChunks).toBeLessThanOrEqual(MAX_TOTAL_CHUNKS);
    expect(out.name).not.toMatch(/[\\/\u0000]/);
  });
});
