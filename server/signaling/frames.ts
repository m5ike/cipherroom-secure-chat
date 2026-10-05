// Every frame a client may send, validated before anything acts on it.
//
// The previous handler cast JSON straight to a type and trusted the
// fields; forwarded frames were `{...payload}` of whatever the client sent.
// Here each frame is parsed into an exact shape with bounded sizes, and
// anything else is refused with a reason. Forwarded frames are then built
// by the server from these validated fields only.

export const PROTOCOL_VERSION = 2;
/** Largest frame we accept, in bytes (the ws maxPayload is set to this). */
export const MAX_FRAME_BYTES = 256 * 1024;

/** What a client may announce in join.features, and the server in hello:
 *  "bin" — file chunks as binary messages (binary.ts). */
export const KNOWN_FEATURES = new Set(["bin"]);

export type IceCandidate = { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null };
export type SessionDescription = { type: "offer" | "answer" | "pranswer" | "rollback"; sdp: string };
/** SDP / ICE sealed with the room's signal key (crypto v2): opaque here. */
export type SealedSignal = { sealed: { v: 2; iv: string; ciphertext: string } };
export type Envelope = Record<string, string | number>;
/** 6.12 (protocol 4, § 7): a message sealed for one device's mailbox (`mb`), or for
 *  every known device of one account (`mb-set`). JSON the server stores and hands
 *  over as it is — rebuilt here from validated fields only. */
export type P4Envelope = { v: 4; kind: "mb" | "mb-set"; [field: string]: unknown };
/** What a relay frame carries for a recipient: a protocol-3 room envelope or a protocol-4 one. */
export type RelayEnvelope = Envelope | P4Envelope;
/** 6.12 (§ 13): proof that the joiner holds the room key. */
export type JoinProof = { pub: string; sig: string };

export type ClientFrame =
  | { type: "join"; protocol: number; room: string; name: string; peerId?: string; resume?: string; auth?: string; away: boolean; features?: string[]; foreground?: boolean; proof?: JoinProof }
  | { type: "auth"; token: string | null; away: boolean }
  | { type: "leave"; away: boolean }
  | { type: "signal"; target: string; payload: SessionDescription | IceCandidate | SealedSignal }
  | { type: "ping"; t: number }
  // `away`: the page is put aside, cover for me (relay.ts); 6.7 `foreground`:
  // the app is open in the foreground or not (presence, last seen).
  | { type: "presence"; away: boolean; foreground?: boolean }
  // 6.7: mention — the recipients (of `to`) the message mentions; call — it rings them. Hints for the notification's kind only.
  // 6.12: `per` — an envelope of its own for some recipients (by reference); the others get `envelope`.
  | { type: "relay"; messageId: string; to: string[]; envelope?: RelayEnvelope; per?: Record<string, RelayEnvelope>; expiresAt?: number; mention?: string[]; call?: boolean }
  | { type: "relay-ack"; ids: string[] }
  | { type: "receipt"; messageIds: string[]; state: "read" | "delivered"; to?: { peerId?: string; accountId?: string } }
  | { type: "command-poll"; deviceId: string }
  | { type: "command-ack"; commandId: string; result?: string }
  | { type: "storage"; id: string; op: string; payload: Record<string, unknown>; auth?: string; session?: string }
  | { type: "proxy-meta"; transferId: string; iv: string; ciphertext: string; v?: number }
  | { type: "proxy-chunk"; transferId: string; seq: number; iv: string; ciphertext: string; v?: number }
  | { type: "proxy-end"; transferId: string; v?: number; iv?: string; ciphertext?: string }
  | { type: "proxy-cancel"; transferId: string }
  | { type: "proxy-need"; transferId: string; seqs: number[] }
  // 6.12 (§ 7.5, § 14.3): the key directory and key transparency of a member, by its room-scoped reference.
  | { type: "key-bundles"; ref: string }
  | { type: "kt-lookup"; ref: string };

export type FrameError = { code: "invalid-frame" | "unknown-type" | "too-large"; message: string };

type Raw = Record<string, unknown>;

const ID = /^[A-Za-z0-9_:.\-]{1,96}$/;
const B64 = /^[A-Za-z0-9+/=_-]*$/;

const isObj = (v: unknown): v is Raw => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);
const id = (v: unknown): string | null => (typeof v === "string" && ID.test(v) ? v : null);
const b64 = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max && B64.test(v) ? v : null);
const bool = (v: unknown): boolean => v === true;

function fail(message: string): FrameError {
  return { code: "invalid-frame", message };
}

/** A display name: printable, trimmed, at most 48 characters. */
export function cleanName(v: unknown, fallback = "Anonymous"): string {
  if (typeof v !== "string") return fallback;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "").trim().slice(0, 48);
  return s || fallback;
}

/** A room id: 1–64 visible characters. */
export function cleanRoom(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
  return s || null;
}

function parseSignal(payload: unknown): SessionDescription | IceCandidate | SealedSignal | null {
  if (!isObj(payload)) return null;
  if (isObj(payload.sealed)) {
    const sealed = payload.sealed;
    const iv = b64(sealed.iv, 64);
    const ciphertext = b64(sealed.ciphertext, 96 * 1024);
    if (sealed.v !== 2 || !iv || !ciphertext) return null;
    return { sealed: { v: 2, iv, ciphertext } };
  }
  if (typeof payload.type === "string") {
    const type = payload.type;
    if (type !== "offer" && type !== "answer" && type !== "pranswer" && type !== "rollback") return null;
    const sdp = type === "rollback" ? "" : text(payload.sdp, 64 * 1024);
    if (sdp === null) return null;
    return { type, sdp };
  }
  const candidate = text(payload.candidate, 2_048);
  if (candidate === null) return null;
  const out: IceCandidate = { candidate };
  if (payload.sdpMid === null || typeof payload.sdpMid === "string") out.sdpMid = payload.sdpMid === null ? null : String(payload.sdpMid).slice(0, 64);
  if (payload.sdpMLineIndex === null || (typeof payload.sdpMLineIndex === "number" && Number.isInteger(payload.sdpMLineIndex) && payload.sdpMLineIndex >= 0 && payload.sdpMLineIndex < 64)) {
    out.sdpMLineIndex = payload.sdpMLineIndex as number | null;
  }
  if (payload.usernameFragment === null || typeof payload.usernameFragment === "string") {
    out.usernameFragment = payload.usernameFragment === null ? null : String(payload.usernameFragment).slice(0, 256);
  }
  return out;
}

/** The ciphertext envelope a client relays: flat, small string/number fields. */
function parseEnvelope(v: unknown): Envelope | null {
  if (!isObj(v)) return null;
  const out: Envelope = {};
  let size = 0;
  for (const [key, value] of Object.entries(v)) {
    if (!/^[a-z][a-zA-Z0-9]{0,15}$/.test(key)) return null;
    if (typeof value === "string") {
      if (value.length > 180_000) return null;
      size += value.length;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) return null;
    } else {
      return null;
    }
    out[key] = value;
    if (Object.keys(out).length > 12) return null;
  }
  if (typeof out.iv !== "string" || typeof out.ciphertext !== "string") return null;
  if (size > 190_000) return null;
  return out;
}

/* ------------------------------------------------- protocol 4 (6.12) */

/** Largest protocol-4 envelope (its JSON); the queue's own cap per item is 130 000 bytes. */
export const P4_ENVELOPE_MAX_CHARS = 128_000;
/** Devices one `mb-set` may address. */
export const MB_SET_MAX_ITEMS = 16;

const B64_STD = /^[A-Za-z0-9+/]*={0,2}$/;
const B64_URL = /^[A-Za-z0-9_-]*$/;
const std = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 && v.length <= max && B64_STD.test(v) ? v : null);
const url = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 && v.length <= max && B64_URL.test(v) ? v : null);
const time = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** A signed mailbox bundle (contract.ts MailboxBundle), fields only. */
function parseBundle(v: unknown): Record<string, unknown> | null {
  if (!isObj(v)) return null;
  const id = url(v.id, 16);
  const dh = std(v.dh, 200);
  const kem = std(v.kem, 1_600);
  const exp = time(v.exp);
  const sig = std(v.sig, 100);
  return id && dh && kem && exp !== null && sig ? { id, dh, kem, exp, sig } : null;
}

/** One message for one device's mailbox (contract.ts MailboxItem), fields only. */
function parseMailboxItem(v: unknown): Record<string, unknown> | null {
  if (!isObj(v) || v.v !== 4 || v.kind !== "mb") return null;
  const mid = id(v.id);
  const to = url(v.to, 16);
  const sb = parseBundle(v.sb);
  const spk = std(v.spk, 200);
  const e = std(v.e, 200);
  const kct = std(v.kct, 1_600);
  const c = std(v.c, P4_ENVELOPE_MAX_CHARS);
  if (!mid || !to || !sb || !spk || !e || !kct || !c) return null;
  const out: Record<string, unknown> = { v: 4, kind: "mb", id: mid, to, sb, spk };
  if (v.sacc !== undefined) {
    if (!isObj(v.sacc)) return null;
    const apk = std(v.sacc.apk, 64);
    const ac = std(v.sacc.ac, 128);
    if (!apk || !ac) return null;
    const sacc: Record<string, unknown> = { apk, ac };
    if (v.sacc.cv !== undefined) { if (v.sacc.cv !== 2) return null; sacc.cv = 2; }
    if (v.sacc.exp !== undefined) { const exp = time(v.sacc.exp); if (exp === null) return null; sacc.exp = exp; }
    out.sacc = sacc;
  }
  out.e = e;
  out.kct = kct;
  out.c = c;
  return out;
}

/** A protocol-4 envelope (`mb` or `mb-set`), rebuilt from its validated fields; null when it is not one. */
export function parseP4Envelope(v: unknown): P4Envelope | null {
  if (!isObj(v) || v.v !== 4) return null;
  let out: Record<string, unknown> | null = null;
  if (v.kind === "mb") {
    out = parseMailboxItem(v);
  } else if (v.kind === "mb-set") {
    const mid = id(v.id);
    if (!mid || !Array.isArray(v.items) || v.items.length === 0 || v.items.length > MB_SET_MAX_ITEMS) return null;
    const items: Array<Record<string, unknown>> = [];
    for (const item of v.items) {
      const parsed = parseMailboxItem(item);
      if (!parsed) return null;
      items.push(parsed);
    }
    out = { v: 4, kind: "mb-set", id: mid, items };
  }
  if (!out || JSON.stringify(out).length > P4_ENVELOPE_MAX_CHARS) return null;
  return out as P4Envelope;
}

/** A relayed envelope: protocol 3 (flat, iv + ciphertext) or protocol 4 (`mb` / `mb-set`). */
function parseRelayEnvelope(v: unknown): RelayEnvelope | null {
  if (isObj(v) && v.v === 4) return parseP4Envelope(v);
  return parseEnvelope(v);
}

/** The crypto version a client put on a frame (absent = 1). */
function version(v: unknown): { v?: number } {
  // 2: room-derived file key (protocol 3); 4: the transfer's own FK (protocol 4, § 8 — 6.12 review P07).
  return v === 2 || v === 4 ? { v } : {};
}

function ids(v: unknown, max: number): string[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: string[] = [];
  for (const item of v) {
    const ok = id(item);
    if (!ok) return null;
    out.push(ok);
  }
  return out;
}

export function parseFrame(raw: string | Buffer): ClientFrame | FrameError {
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.length;
  if (bytes > MAX_FRAME_BYTES) return { code: "too-large", message: `frame of ${bytes} bytes` };
  let data: unknown;
  try {
    data = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    return fail("not JSON");
  }
  if (!isObj(data) || typeof data.type !== "string") return fail("no frame type");
  const f = data;

  switch (f.type) {
    case "join": {
      const room = cleanRoom(f.room);
      if (!room) return fail("join needs a room");
      const protocol = typeof f.protocol === "number" && Number.isInteger(f.protocol) ? f.protocol : 1;
      const frame: ClientFrame = { type: "join", protocol, room, name: cleanName(f.name), away: bool(f.away) };
      const peerId = id(f.peerId);
      if (peerId) frame.peerId = peerId;
      const resume = b64(f.resume, 64);
      if (resume) frame.resume = resume;
      const auth = text(f.auth, 200);
      if (auth) frame.auth = auth;
      // Optional abilities of the client; only the ones this server knows.
      if (Array.isArray(f.features)) {
        const features = f.features.filter((x): x is string => typeof x === "string" && KNOWN_FEATURES.has(x)).slice(0, 8);
        if (features.length) frame.features = [...new Set(features)];
      }
      // 6.7: joined with the app in the background (absent: the foreground).
      if (typeof f.foreground === "boolean") frame.foreground = f.foreground;
      // 6.12: the hub join proof (proof.ts) — the shapes here, the signature there.
      if (f.proof !== undefined && f.proof !== null) {
        const p = f.proof;
        const pub = isObj(p) ? std(p.pub, 64) : null;
        const sig = isObj(p) ? std(p.sig, 128) : null;
        if (!pub || !sig) return fail("join.proof is { pub, sig } in base64");
        frame.proof = { pub, sig };
      }
      return frame;
    }
    case "auth": {
      if (f.token !== null && f.token !== undefined && text(f.token, 200) === null) return fail("bad token");
      return { type: "auth", token: typeof f.token === "string" ? f.token : null, away: bool(f.away) };
    }
    case "leave":
      return { type: "leave", away: bool(f.away) };
    case "signal": {
      const target = id(f.target);
      const payload = parseSignal(f.payload);
      if (!target || !payload) return fail("signal needs a target and an SDP or ICE payload");
      return { type: "signal", target, payload };
    }
    case "ping":
      return { type: "ping", t: typeof f.t === "number" && Number.isFinite(f.t) ? f.t : Date.now() };
    case "presence":
      return typeof f.foreground === "boolean" ? { type: "presence", away: bool(f.away), foreground: f.foreground } : { type: "presence", away: bool(f.away) };
    case "relay": {
      const messageId = id(f.messageId);
      const to = ids(f.to, 50);
      const envelope = f.envelope === undefined ? undefined : parseRelayEnvelope(f.envelope);
      if (!messageId || !to || to.length === 0 || envelope === null) return fail("relay needs messageId, to[] and an envelope");
      const recipients = [...new Set(to)];
      // 6.12: an envelope per recipient reference (keys outside `to` are dropped).
      let per: Record<string, RelayEnvelope> | undefined;
      if (f.per !== undefined) {
        if (!isObj(f.per) || Object.keys(f.per).length > 50) return fail("relay.per maps recipient references to envelopes");
        // No prototype: a reference is only ever an own key ("__proto__" included).
        per = Object.create(null) as Record<string, RelayEnvelope>;
        for (const [ref, value] of Object.entries(f.per)) {
          if (!id(ref)) return fail("relay.per maps recipient references to envelopes");
          const parsed = parseRelayEnvelope(value);
          if (!parsed) return fail(`relay.per has a bad envelope`);
          if (recipients.includes(ref)) per[ref] = parsed;
        }
      }
      if (!envelope && !recipients.every((ref) => per?.[ref])) return fail("relay needs an envelope for every recipient (envelope, or per[ref])");
      const frame: ClientFrame = { type: "relay", messageId, to: recipients, ...(envelope ? { envelope } : {}), ...(per && Object.keys(per).length ? { per } : {}) };
      if (typeof f.expiresAt === "number" && Number.isFinite(f.expiresAt)) frame.expiresAt = f.expiresAt;
      const mention = f.mention === undefined ? null : ids(f.mention, 50);
      if (mention && mention.length) frame.mention = mention.filter((m) => frame.to.includes(m));
      if (f.call === true) frame.call = true;
      return frame;
    }
    case "relay-ack": {
      const list = ids(f.ids, 500);
      if (!list) return fail("relay-ack needs ids[]");
      return { type: "relay-ack", ids: list };
    }
    case "receipt": {
      const list = ids(f.messageIds, 200);
      const state = f.state === "read" || f.state === "delivered" ? f.state : null;
      if (!list || list.length === 0 || !state) return fail("receipt needs messageIds[] and a state");
      return { type: "receipt", messageIds: list, state };
    }
    case "command-poll": {
      const deviceId = id(f.deviceId);
      if (!deviceId) return fail("command-poll needs a deviceId");
      return { type: "command-poll", deviceId };
    }
    case "command-ack": {
      const commandId = id(f.commandId);
      if (!commandId) return fail("command-ack needs a commandId");
      const result = text(f.result, 256);
      return result ? { type: "command-ack", commandId, result } : { type: "command-ack", commandId };
    }
    case "storage": {
      const requestId = text(f.id, 64) ?? "";
      const op = text(f.op, 40);
      if (!op) return fail("storage needs an op");
      const frame: ClientFrame = { type: "storage", id: requestId, op, payload: isObj(f.payload) ? f.payload : {} };
      const auth = text(f.auth, 200);
      if (auth) frame.auth = auth;
      const session = text(f.session, 96);
      if (session) frame.session = session;
      return frame;
    }
    case "proxy-meta": {
      const transferId = id(f.transferId);
      const iv = b64(f.iv, 64);
      const ciphertext = b64(f.ciphertext, 16_384);
      if (!transferId || !iv || ciphertext === null) return fail("proxy-meta needs transferId, iv, ciphertext");
      return { type: "proxy-meta", transferId, iv, ciphertext, ...version(f.v) };
    }
    case "proxy-chunk": {
      const transferId = id(f.transferId);
      const iv = b64(f.iv, 64);
      const ciphertext = b64(f.ciphertext, 200_000);
      const seq = typeof f.seq === "number" && Number.isInteger(f.seq) && f.seq >= 0 && f.seq <= 10_000_000 ? f.seq : null;
      if (!transferId || !iv || ciphertext === null || seq === null) return fail("proxy-chunk needs transferId, seq, iv, ciphertext");
      return { type: "proxy-chunk", transferId, seq, iv, ciphertext, ...version(f.v) };
    }
    case "proxy-end": {
      const transferId = id(f.transferId);
      if (!transferId) return fail("proxy-end needs a transferId");
      // v2: the sealed, signed digest of the whole file rides on the end frame.
      const iv = b64(f.iv, 64);
      const ciphertext = b64(f.ciphertext, 4_096);
      return { type: "proxy-end", transferId, ...version(f.v), ...(iv && ciphertext ? { iv, ciphertext } : {}) };
    }
    case "proxy-cancel": {
      const transferId = id(f.transferId);
      if (!transferId) return fail("proxy-cancel needs a transferId");
      return { type: "proxy-cancel", transferId };
    }
    case "proxy-need": {
      const transferId = id(f.transferId);
      const seqs = Array.isArray(f.seqs)
        ? f.seqs.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 10_000_000).slice(0, 5_000)
        : [];
      if (!transferId || seqs.length === 0) return fail("proxy-need needs a transferId and seqs[]");
      return { type: "proxy-need", transferId, seqs };
    }
    case "key-bundles":
    case "kt-lookup": {
      const ref = id(f.ref);
      if (!ref) return fail(`${f.type} needs a member reference (ref)`);
      return { type: f.type, ref };
    }
    default:
      return { code: "unknown-type", message: `unknown frame type ${String(f.type).slice(0, 40)}` };
  }
}

export function isFrameError(v: ClientFrame | FrameError): v is FrameError {
  return "code" in v;
}
