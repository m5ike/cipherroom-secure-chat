// Seals outgoing and opens incoming call frames (media-frames.ts) for
// RTCRtpScriptTransform. Keys arrive from the page per peer; without one a
// frame passes through as it is (the call still has DTLS-SRTP).
//
// 6.12 (protocol 4, docs/protocol-v4.md § 9, F-19): a protocol-4 peer's keys
// are fresh per call and renegotiation — ours (`send4`: a key and its epoch,
// IV = epoch || frame counter) and theirs (`recv4`: the `media` message they
// sent, several epochs kept for the overlap). Once a peer's key is known,
// frames from it that come unsealed are dropped. Protocol-3 peers keep the
// pair's static per-direction keys (`keys`).

import { clearBytes, emptyStats, FrameIvs, isSealed, openFrame, sealFrame, type MediaKind, type MediaStats } from "./media-frames";
import { importMediaKey, MediaReceiver, MediaSender } from "./p4/media4";

type Keys = { send: CryptoKey; recv: CryptoKey };
type Options = { operation: "encrypt" | "decrypt"; peerId: string; kind: MediaKind };
type EncodedFrame = { data: ArrayBuffer; type?: string };
type Transformer = { readable: ReadableStream<EncodedFrame>; writable: WritableStream<EncodedFrame>; options: Options };

const keys = new Map<string, Keys>();
const ivs = new Map<string, FrameIvs>();
// Protocol 4, per peer: our sender (one key per direction, shared by audio and
// video — its one frame counter keeps every IV unique) and their receiver.
const senders4 = new Map<string, MediaSender>();
const receivers4 = new Map<string, MediaReceiver>();
// Counts since the start, and over the last second (what the page shows).
const total = new Map<string, MediaStats>();
const recent = new Map<string, MediaStats>();

function count(peerId: string, field: keyof MediaStats): void {
  for (const map of [total, recent]) {
    let s = map.get(peerId);
    if (!s) { s = emptyStats(); map.set(peerId, s); }
    s[field] += 1;
  }
}

function transformFor(options: Options): TransformStream<EncodedFrame, EncodedFrame> {
  const { operation, peerId, kind } = options;
  return new TransformStream({
    async transform(frame, controller) {
      const clear = () => clearBytes(kind, frame.type === "key", frame.data.byteLength);
      if (operation === "encrypt") {
        const s4 = senders4.get(peerId);
        if (s4) {
          try { frame.data = await s4.seal(frame.data, clear()); } catch { count(peerId, "failed"); return; }
          count(peerId, "sealed");
          controller.enqueue(frame);
          return;
        }
        const k = keys.get(peerId);
        if (!k) { count(peerId, "clearOut"); controller.enqueue(frame); return; }
        let iv = ivs.get(`${peerId}:${kind}`);
        if (!iv) { iv = new FrameIvs(); ivs.set(`${peerId}:${kind}`, iv); }
        frame.data = await sealFrame(k.send, frame.data, clear(), iv.next());
        count(peerId, "sealed");
        controller.enqueue(frame);
        return;
      }
      const r4 = receivers4.get(peerId);
      if (r4?.hasKey) {
        // § 9: once their key is known, an unsealed frame is dropped (counted as arriving in the clear).
        if (!isSealed(frame.data)) { count(peerId, "clearIn"); return; }
        const plain = await r4.open(frame.data);
        if (!plain) { count(peerId, "failed"); return; }
        frame.data = plain;
        count(peerId, "opened");
        controller.enqueue(frame);
        return;
      }
      const k = keys.get(peerId);
      if (!isSealed(frame.data)) { count(peerId, "clearIn"); controller.enqueue(frame); return; }
      const plain = k ? await openFrame(k.recv, frame.data) : null;
      if (!plain) { count(peerId, "failed"); return; } // drop: the decoder would only choke on it
      frame.data = plain;
      count(peerId, "opened");
      controller.enqueue(frame);
    },
  });
}

const scope = self as unknown as {
  onrtctransform: ((event: { transformer: Transformer }) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (msg: unknown) => void;
};

scope.onrtctransform = (event) => {
  const t = event.transformer;
  void t.readable.pipeThrough(transformFor(t.options)).pipeTo(t.writable).catch(() => undefined);
};

type Msg = { type: string; peerId?: string; send?: CryptoKey; recv?: CryptoKey; raw?: Uint8Array; epoch?: number; inner?: unknown };

scope.onmessage = (event: MessageEvent<Msg>) => {
  const msg = event.data;
  if (msg.type === "keys" && msg.peerId && msg.send && msg.recv) {
    keys.set(msg.peerId, { send: msg.send, recv: msg.recv });
    // A new key means a new sender session: fresh salts.
    for (const id of [...ivs.keys()]) if (id.startsWith(`${msg.peerId}:`)) ivs.delete(id);
  } else if (msg.type === "send4" && msg.peerId && msg.raw && typeof msg.epoch === "number") {
    const peerId = msg.peerId;
    const epoch = msg.epoch;
    void importMediaKey(msg.raw).then((key) => { senders4.set(peerId, new MediaSender(key, epoch)); }).catch(() => undefined);
    msg.raw.fill(0);
  } else if (msg.type === "recv4" && msg.peerId) {
    let r = receivers4.get(msg.peerId);
    if (!r) { r = new MediaReceiver(); receivers4.set(msg.peerId, r); }
    void r.accept(msg.inner);
  } else if (msg.type === "forget" && msg.peerId) {
    keys.delete(msg.peerId);
    senders4.delete(msg.peerId);
    receivers4.delete(msg.peerId);
    total.delete(msg.peerId);
    recent.delete(msg.peerId);
    for (const id of [...ivs.keys()]) if (id.startsWith(`${msg.peerId}:`)) ivs.delete(id);
  }
};

setInterval(() => {
  if (recent.size === 0) return;
  scope.postMessage({ type: "stats", total: Object.fromEntries(total), recent: Object.fromEntries(recent) });
  recent.clear();
}, 1000);
