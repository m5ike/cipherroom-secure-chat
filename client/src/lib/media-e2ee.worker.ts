// Seals outgoing and opens incoming call frames (media-frames.ts) for
// RTCRtpScriptTransform. Keys arrive from the page per peer; without one a
// frame passes through as it is (the call still has DTLS-SRTP).

import { clearBytes, emptyStats, FrameIvs, isSealed, openFrame, sealFrame, type MediaKind, type MediaStats } from "./media-frames";

type Keys = { send: CryptoKey; recv: CryptoKey };
type Options = { operation: "encrypt" | "decrypt"; peerId: string; kind: MediaKind };
type EncodedFrame = { data: ArrayBuffer; type?: string };
type Transformer = { readable: ReadableStream<EncodedFrame>; writable: WritableStream<EncodedFrame>; options: Options };

const keys = new Map<string, Keys>();
const ivs = new Map<string, FrameIvs>();
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
      const k = keys.get(peerId);
      if (operation === "encrypt") {
        if (!k) { count(peerId, "clearOut"); controller.enqueue(frame); return; }
        let iv = ivs.get(`${peerId}:${kind}`);
        if (!iv) { iv = new FrameIvs(); ivs.set(`${peerId}:${kind}`, iv); }
        const clear = clearBytes(kind, frame.type === "key", frame.data.byteLength);
        frame.data = await sealFrame(k.send, frame.data, clear, iv.next());
        count(peerId, "sealed");
        controller.enqueue(frame);
        return;
      }
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

scope.onmessage = (event: MessageEvent<{ type: string; peerId?: string; send?: CryptoKey; recv?: CryptoKey }>) => {
  const msg = event.data;
  if (msg.type === "keys" && msg.peerId && msg.send && msg.recv) {
    keys.set(msg.peerId, { send: msg.send, recv: msg.recv });
    // A new key means a new sender session: fresh salts.
    for (const id of [...ivs.keys()]) if (id.startsWith(`${msg.peerId}:`)) ivs.delete(id);
  } else if (msg.type === "forget" && msg.peerId) {
    keys.delete(msg.peerId);
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
