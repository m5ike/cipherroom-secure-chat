// Several rooms at once (6.0).
//
// The room on screen keeps the app's full engine (App.tsx): calls, files,
// the relay, the composer. Every OTHER room the person keeps connected runs
// here, headless: its own signaling socket (the server holds one room per
// connection), its keys, its WebRTC mesh with the "m5cet" data channel, the
// signed hello, pair and sender keys — exactly the protocol of App.tsx — so
// its members see a normal participant and its messages are not lost while
// another room is on screen. It counts the people and the unread messages,
// keeps the messages, and hands them over when the person switches to that
// room (the app then connects it in the foreground and the room it leaves
// comes here).
//
// Only receiving happens here; writing is for the room on screen. Files and
// calls of a background room are not taken (the channel does not announce
// "bin" or "media"), a notice says so when someone sends a file.
//
// 6.12: protocol 4 here too (p4-session.ts, the same session layer as the
// room on screen): hello v4, pair ratchets, sender keys v4, private messages
// in the ratchet, the downgrade rule, protocol 3 for older peers; the join
// carries the proof of the room key (§ 13); accepted ids go to the device's
// persistent replay window (§ 11); a first-seen key is "new", never "verified".

import { deriveRoomKeys, isSealedSignal, openMessage, openSignal, sealSignal, type Envelope, type RoomKeys } from "./envelope";
import { SenderKeyStore, envelopeKind } from "./sender-keys";
import { loadIdentity, type Identity } from "./identity";
import { buildHubProof, hubSeed, REPLAY, type RatchetInner, type ReplayGuard } from "./p4";
import { isP4RoomEnvelope, P4Room, type HelloLocal } from "./p4-session";
import { TrustBook } from "./p4-trust";
import { deviceReplay } from "./p4-store";
import { deviceMailbox, helloAccountOf } from "./p4-away";
import { validatePayload } from "./validate";
import type { ChatMessage } from "./chat-types";
import { newId } from "./id";
import { PresenceSignal } from "./presence-book";

export type HubTarget = {
  /** Identifies the room across servers: "<server or local>|<room>". */
  key: string;
  room: string;
  label: string;
  /** The name shown to the others. */
  name: string;
  passphrase: string;
  /** Another M5cet server (a saved connection's), "" for this one. */
  server?: string;
  /** The saved connection it came from, if any. */
  profileId?: string;
};

export type HubStatus = "deriving" | "connecting" | "joined" | "offline" | "mismatch";

export type HubRoomView = {
  key: string; label: string; room: string; status: HubStatus;
  /** People in the room, us included (0 before we joined). */
  users: number;
  unread: number;
  lastActivity: number;
  last: { sender: string; text: string; at: number } | null;
  profileId?: string;
  /** 6.10: the people connected there now (peer id + name) — whom an NFC output can be forwarded to. */
  members?: Array<{ id: string; name: string }>;
};

export type HubDeps = {
  wsUrl: (server?: string) => string;
  rtcConfig: () => Promise<RTCConfiguration>;
  makeSocket: (url: string) => WebSocket;
  makePeer: (config: RTCConfiguration) => RTCPeerConnection;
  derive: (room: string, passphrase: string) => Promise<RoomKeys>;
  identity: () => Promise<Identity | null>;
  /** 6.12: our hello's mailbox bundle / account / tree head, the downgrade markers, the replay window (defaults: none, in memory). */
  p4Local?: (identity: Identity) => Promise<HelloLocal>;
  book?: { p4Seen(pk: string): boolean; markP4(pk: string): void };
  replay?: ReplayGuard | null;
};

export type HubEvent = { type: "change" } | { type: "message"; key: string; label: string; message: ChatMessage }
  /** 6.9: a phone call offered to the members of a background room (a call routed into it), or its update / end. */
  | { type: "phone"; key: string; label: string; frame: Record<string, unknown>; socketUrl: string };

export const roomKeyOf = (room: string, server = "") => `${server || "local"}|${room}`;

type PeerLink = {
  id: string; name: string; initiator: boolean;
  pc: RTCPeerConnection | null; channel: RTCDataChannel | null;
  send: ((text: string) => void) | null;
  makingOffer: boolean; ignoreOffer: boolean;
  signals: Promise<void>;
};

const MAX_MESSAGES = 500;

export class BackgroundRoom {
  status: HubStatus = "deriving";
  unread = 0;
  lastActivity = 0;
  last: HubRoomView["last"] = null;
  readonly messages: ChatMessage[] = [];
  private keys: RoomKeys | null = null;
  private identity: Identity | null = null;
  private socket: WebSocket | null = null;
  private myId = "";
  private resume = "";
  private readonly peers = new Map<string, PeerLink>();
  private readonly names = new Map<string, string>();
  private readonly store = new SenderKeyStore();
  /** 6.12: protocol 4 with this room's peers (made with the keys and our identity). */
  private p4: P4Room | null = null;
  private readonly book: { p4Seen(pk: string): boolean; markP4(pk: string): void };
  private readonly seen = new Set<string>();
  private stopped = false;
  private attempts = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  /** 6.7: the app is in the foreground — this room's members see the same presence as the room on screen's. */
  private foreground = true;
  private readonly presence = new PresenceSignal((frame) => {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1 || this.status !== "joined") return false;
    try { socket.send(JSON.stringify(frame)); return true; } catch { return false; }
  });

  constructor(readonly target: HubTarget, private readonly deps: HubDeps, private readonly emit: (event: HubEvent) => void) {
    this.book = deps.book ?? new TrustBook(null);
  }

  /** The protocol-4 session layer for these keys (text only: no "bin", no "media"). */
  private session(): P4Room | null {
    const keys = this.keys;
    const identity = this.identity;
    if (!keys || !identity) return null;
    if (this.p4 && this.p4.keys === keys) return this.p4;
    this.p4?.clear();
    this.p4 = new P4Room({
      keys, identity, v3: this.store,
      selfId: () => this.myId,
      send: (peerId, text) => { const send = this.peers.get(peerId)?.send; if (!send) return false; send(text); return true; },
      helloExtra: () => ({ caps: [] }),
      local: () => (this.deps.p4Local ? this.deps.p4Local(identity) : { mb: null, acc: null, sth: null }),
      book: this.book,
      events: {
        inner: (peerId, inner) => this.inner(peerId, inner),
        refused: (_peerId, why) => { if (why === "key-mismatch") { this.status = "mismatch"; this.changed(); } },
        close: (peerId) => { try { this.peers.get(peerId)?.channel?.close(); } catch { /* closed */ } },
        downgrade: (peerId) => { try { this.peers.get(peerId)?.channel?.close(); } catch { /* closed */ } },
      },
    });
    return this.p4;
  }

  /** 6.7: the app went to the background or came back (presence, last seen). */
  setForeground(on: boolean): void {
    this.foreground = on;
    this.presence.set({ away: false, foreground: on });
  }

  view(): HubRoomView {
    let users = this.status === "joined" ? 1 : 0;
    const members: Array<{ id: string; name: string }> = [];
    for (const p of this.peers.values()) if (p.channel?.readyState === "open" || p.send) { users++; members.push({ id: p.id, name: p.name }); }
    return { key: this.target.key, label: this.target.label, room: this.target.room, status: this.status, users, unread: this.unread, lastActivity: this.lastActivity, last: this.last, profileId: this.target.profileId, members };
  }

  private changed() { this.emit({ type: "change" }); }

  /** Derives the keys (Argon2id, in the worker) and connects. */
  async start(): Promise<void> {
    this.status = "deriving";
    this.changed();
    this.keys = await this.deps.derive(this.target.room, this.target.passphrase);
    this.identity = await this.deps.identity().catch(() => null);
    if (this.stopped) return;
    this.connect();
  }

  /** For tests (and a room whose keys are already known). */
  useKeys(keys: RoomKeys, identity: Identity | null, myId: string): void {
    this.keys = keys;
    this.identity = identity;
    this.myId = myId;
    this.status = "joined";
  }

  /** 6.12: the protocol each peer speaks (tests, diagnostics). */
  protocolOf(peerId: string) { return this.p4?.protocolOf(peerId) ?? "pending"; }

  private connect(): void {
    if (this.stopped || !this.keys) return;
    this.status = "connecting";
    this.changed();
    let socket: WebSocket;
    try { socket = this.deps.makeSocket(this.deps.wsUrl(this.target.server)); } catch { this.scheduleRetry(); return; }
    this.socket = socket;
    socket.onopen = () => {
      this.attempts = 0;
      // 6.12 (§ 13): the join waits for the server's hello and its nonce (3 s at most).
      setTimeout(() => { void this.join(socket, null); }, 3000);
      if (this.ping) clearInterval(this.ping);
      this.ping = setInterval(() => { try { socket.send(JSON.stringify({ type: "ping", t: Date.now() })); } catch { /* closing */ } }, 25_000);
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(event.data) as Record<string, unknown>; } catch { return; }
      void this.frame(frame);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.ping) { clearInterval(this.ping); this.ping = null; }
      if (this.status !== "mismatch") this.status = "offline";
      this.changed();
      if (event.code === 4001 || event.code === 4003) { this.stopped = true; return; }
      this.scheduleRetry();
    };
  }

  private readonly joined = new WeakSet<WebSocket>();
  private seed: Promise<Uint8Array> | null = null;

  /** The join, once per socket — with the proof that we hold the room key over the socket's nonce (§ 13). */
  private async join(socket: WebSocket, nonce: string | null): Promise<void> {
    if (this.joined.has(socket) || !this.keys) return;
    this.joined.add(socket);
    const keys = this.keys;
    let proof: { pub: string; sig: string } | null = null;
    if (nonce && keys.version === 3 && keys.roomId.startsWith("r3.")) {
      try { proof = await buildHubProof(await (this.seed ??= hubSeed(keys)), keys.roomId, nonce); } catch { proof = null; }
    }
    if (this.socket !== socket || socket.readyState !== 1) return;
    socket.send(JSON.stringify({
      type: "join", protocol: 2, room: keys.roomId, name: this.target.name,
      peerId: this.myId || newId("peer"), ...(this.resume ? { resume: this.resume } : {}), away: false, foreground: this.foreground,
      ...(proof ? { proof } : {}),
    }));
    this.presence.reset({ away: false, foreground: this.foreground });
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const cap = Math.min(120_000, 1000 * 2 ** Math.min(this.attempts, 12));
    this.attempts++;
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => this.connect(), Math.random() * cap + 250);
  }

  private async frame(f: Record<string, unknown>): Promise<void> {
    switch (f.type) {
      case "hello": if (this.socket) await this.join(this.socket, typeof f.nonce === "string" ? f.nonce : null); return;
      case "joined": {
        this.myId = String(f.peerId ?? this.myId);
        this.resume = typeof f.resume === "string" ? f.resume : "";
        this.status = "joined";
        const list = Array.isArray(f.peers) ? f.peers as Array<{ peerId?: unknown; name?: unknown }> : [];
        for (const p of list) if (typeof p.peerId === "string") await this.createPeer(p.peerId, String(p.name ?? ""), true);
        this.changed();
        return;
      }
      case "peer-joined": if (typeof f.peerId === "string") this.names.set(f.peerId, String(f.name ?? "")); return;
      case "peer-updated": { const p = this.peers.get(String(f.peerId)); if (p) p.name = String(f.name ?? p.name); return; }
      case "peer-left": this.dropPeer(String(f.peerId)); return;
      case "phone-bridge": this.emit({ type: "phone", key: this.target.key, label: this.target.label, frame: f, socketUrl: this.socket?.url ?? "" }); return;
      case "signal": {
        const source = String(f.source ?? "");
        const link = this.peers.get(source);
        const run = () => this.applySignal(source, f.payload);
        if (link) link.signals = link.signals.then(run).catch(() => undefined);
        else await run().catch(() => undefined);
        return;
      }
      default: return;
    }
  }

  private async createPeer(peerId: string, name: string, initiator: boolean): Promise<PeerLink | null> {
    if (!peerId || peerId === this.myId || this.peers.has(peerId)) return this.peers.get(peerId) ?? null;
    const link: PeerLink = { id: peerId, name: name || this.names.get(peerId) || `peer-${peerId.slice(-4)}`, initiator, pc: null, channel: null, send: null, makingOffer: false, ignoreOffer: false, signals: Promise.resolve() };
    this.peers.set(peerId, link);
    const pc = this.deps.makePeer(await this.deps.rtcConfig());
    link.pc = pc;
    pc.onicecandidate = (e) => { if (e.candidate) void this.sendSignal(peerId, e.candidate.toJSON()); };
    pc.onnegotiationneeded = async () => {
      try {
        link.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) void this.sendSignal(peerId, pc.localDescription.toJSON());
      } catch { /* the next negotiation */ } finally { link.makingOffer = false; }
    };
    pc.onconnectionstatechange = () => { if (pc.connectionState === "failed" || pc.connectionState === "closed") this.changed(); };
    pc.ondatachannel = (e) => this.wire(link, e.channel);
    if (initiator) this.wire(link, pc.createDataChannel("m5cet", { ordered: true }));
    return link;
  }

  private wire(link: PeerLink, channel: RTCDataChannel): void {
    link.channel = channel;
    const send = (text: string) => { try { channel.send(text); } catch { /* closing */ } };
    // 6.12: frames of one channel are handled in the order they came (a chain
    // must be installed before the message it opens); our hello goes first.
    let inbox: Promise<void> = Promise.resolve();
    const queue = (work: () => Promise<void>) => { inbox = inbox.then(work).catch(() => undefined); };
    channel.onopen = () => queue(() => this.handleChannelOpen(link.id, send));
    channel.onclose = () => { link.send = null; this.p4?.channelClosed(link.id); this.changed(); };
    channel.onmessage = (e) => { if (typeof e.data === "string") { const text = e.data; queue(() => this.handleChannelText(link.id, text)); } };
  }

  private async applySignal(source: string, payload: unknown): Promise<void> {
    if (!this.keys || !isSealedSignal(payload)) return;
    let desc: RTCSessionDescriptionInit | RTCIceCandidateInit;
    try { desc = await openSignal(this.keys, source, this.myId, payload.sealed); }
    catch { this.status = "mismatch"; this.changed(); return; }
    const link = this.peers.get(source) ?? await this.createPeer(source, this.names.get(source) ?? "", false);
    const pc = link?.pc;
    if (!link || !pc) return;
    if ("type" in desc && (desc.type === "offer" || desc.type === "answer")) {
      const collision = desc.type === "offer" && (link.makingOffer || pc.signalingState !== "stable");
      link.ignoreOffer = link.initiator && collision;
      if (link.ignoreOffer) return;
      await pc.setRemoteDescription(desc);
      if (desc.type === "offer") {
        await pc.setLocalDescription();
        if (pc.localDescription) void this.sendSignal(source, pc.localDescription.toJSON());
      }
      return;
    }
    if ("candidate" in desc && desc.candidate) {
      try { await pc.addIceCandidate(desc); } catch (err) { if (!link.ignoreOffer) throw err; }
    }
  }

  private async sendSignal(target: string, payload: RTCSessionDescriptionInit | RTCIceCandidateInit): Promise<void> {
    const socket = this.socket;
    if (!this.keys || !socket || socket.readyState !== 1) return;
    const sealed = await sealSignal(this.keys, this.myId, target, payload);
    try { socket.send(JSON.stringify({ type: "signal", target, payload: sealed })); } catch { /* closing */ }
  }

  private dropPeer(peerId: string): void {
    const link = this.peers.get(peerId);
    if (this.p4) this.p4.peerLeft(peerId); else this.store.forgetPeer(peerId);
    this.peers.delete(peerId);
    if (link) { try { link.channel?.close(); } catch { /* closed */ } try { link.pc?.close(); } catch { /* closed */ } }
    this.changed();
  }

  /** The channel to a peer opened: our signed hello (no "bin", no "media": text only). */
  async handleChannelOpen(peerId: string, send: (text: string) => void): Promise<void> {
    let link = this.peers.get(peerId);
    if (!link) {
      link = { id: peerId, name: this.names.get(peerId) ?? `peer-${peerId.slice(-4)}`, initiator: false, pc: null, channel: null, send: null, makingOffer: false, ignoreOffer: false, signals: Promise.resolve() };
      this.peers.set(peerId, link);
    }
    link.send = send;
    if (!this.keys) return;
    this.identity ??= await this.deps.identity().catch(() => null);
    // 6.12: a hello v4 (with the protocol-3 fields an older peer reads).
    await this.session()?.open(peerId);
    this.changed();
  }

  /** A text frame from a peer: hello, a sender key, or a message. */
  async handleChannelText(peerId: string, text: string): Promise<void> {
    const keys = this.keys;
    const link = this.peers.get(peerId);
    if (!keys || !link) return;
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(text) as Record<string, unknown>; } catch { return; }
    if (!raw || typeof raw !== "object") return;
    if (raw.kind === "hello") {
      if (!this.identity) return;
      if (typeof raw.user === "string") link.name = link.name || raw.user;
      await this.session()?.handle(peerId, raw);
      return;
    }
    const p4 = this.session();
    // p4-kem, p4 frames, p4-reset, a protocol-3 sender key.
    if (p4 && (await p4.handle(peerId, raw))) return;
    if (p4?.protocolOf(peerId) === "refused") return;
    if (typeof raw.kind === "string") {
      if (raw.kind === "file-meta") this.note(link.name);
      return; // file frames, key-check: not for a background room
    }
    if (isP4RoomEnvelope(raw)) {
      if (!p4) return;
      try { await this.accept(peerId, await p4.openRoom<unknown>(peerId, raw), 4, "p4-sk"); } catch { /* not ours to open */ }
      return;
    }
    const envelope = raw as unknown as Envelope;
    const sealedWith = envelopeKind(envelope);
    // A protocol-4 peer never seals with protocol-3 session keys.
    if (sealedWith !== "room" && p4?.protocolOf(peerId) === 4) return;
    let opened: { payload: unknown; signer: { valid: boolean } | null; version?: number };
    try {
      opened = sealedWith === "sender-key" ? await this.store.openLive<unknown>(keys, envelope, peerId)
        : sealedWith === "pair" ? await this.store.openPrivate<unknown>(keys, envelope, peerId, this.myId)
        : await openMessage<unknown>(keys, envelope);
    } catch { return; }
    await this.accept(peerId, opened, 3, sealedWith);
  }

  /** A private message in a peer's ratchet (§ 5.7 `msg`); media and file keys are not for a background room. */
  private async inner(peerId: string, inner: RatchetInner): Promise<void> {
    if (inner.t !== "msg" || !this.p4) return;
    const m = inner as { id?: unknown; p?: unknown };
    if (typeof m.id !== "string" || !m.p || typeof m.p !== "object" || (m.p as { id?: unknown }).id !== m.id) return;
    await this.accept(peerId, { payload: m.p, signer: this.p4.signer(peerId) }, 4, "p4-pair");
  }

  /** An opened payload: checked, fresh, kept and counted. */
  private async accept(peerId: string, opened: { payload: unknown; signer: { valid: boolean; account?: { valid: boolean } } | null }, version: 3 | 4, sealedWith: NonNullable<ChatMessage["sealedWith"]>): Promise<void> {
    const link = this.peers.get(peerId);
    const keys = this.keys;
    if (!link || !keys) return;
    const p = validatePayload(opened.payload, { transportSender: peerId, myId: this.myId });
    if (!p || this.seen.has(p.id)) return;
    // 6.12 (§ 11): the device's persistent replay window. A message dated far
    // ahead (the sender's clock is off) is kept, with the time it arrived.
    const replay = this.deps.replay ?? null;
    const receivedAt = Date.now();
    const rawCreatedAt = (opened.payload as { createdAt?: unknown }).createdAt;
    let verdict: Awaited<ReturnType<ReplayGuard["check"]>> = "ok";
    if (replay) {
      try {
        verdict = await replay.check(keys.roomId, p.id, rawCreatedAt, { now: receivedAt });
      } catch {
        // Review P10: the window cannot be read — fail closed. A live chain (ratchet, sender key) cannot be
        // replayed (the in-memory set still dedupes); a room-key envelope could: dropped.
        if (sealedWith === "room" || sealedWith === "p4-mailbox") return;
        verdict = typeof rawCreatedAt === "number" && rawCreatedAt >= receivedAt - REPLAY.windowMs ? "ok" : "too-old";
      }
    }
    if (verdict !== "ok" && verdict !== "clamped") return;
    if (this.seen.has(p.id)) return;
    this.seen.add(p.id);
    if (this.seen.size > 20_000) this.seen.delete(this.seen.values().next().value!);
    const ahead = verdict === "clamped" || (typeof rawCreatedAt === "number" && rawCreatedAt > receivedAt + REPLAY.futureMs);
    const createdAt = ahead ? receivedAt : p.createdAt;
    if (p.kind === "audio-status" || p.kind === "receipt") return;
    if (p.senderName) link.name = p.senderName;
    // § 12.1: a key seen here is not verified (the room on screen pins and compares).
    const valid = opened.signer ? opened.signer.valid && opened.signer.account?.valid !== false : false;
    const message: ChatMessage = {
      id: p.id, senderId: p.senderId, senderName: p.senderName, text: p.text, createdAt, mine: false, secure: true,
      attachment: p.attachment, flags: p.flags, to: p.to, replyTo: p.replyTo, forwardedFrom: p.forwardedFrom,
      cryptoVersion: version, sealedWith,
      identity: opened.signer ? { state: valid ? "new" : "invalid", protocol: version, ...(opened.signer.account ? { account: true } : {}) } : { state: "unsigned", protocol: version },
    };
    this.messages.push(message);
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    this.unread++;
    this.lastActivity = Date.now();
    this.last = { sender: p.senderName, text: p.flags?.sealed ? "🔒" : p.text || (p.attachment ? `📎 ${p.attachment.name}` : ""), at: createdAt };
    this.emit({ type: "message", key: this.target.key, label: this.target.label, message });
    this.changed();
  }

  private note(name: string): void {
    this.messages.push({ id: newId("system"), senderId: "system", senderName: "M5cet", text: `${name}: 📎 → open the room to receive files`, createdAt: Date.now(), mine: false, secure: false });
  }

  /** Leaves for good; the messages go to whoever takes the room over. */
  stop(): ChatMessage[] {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.ping) clearInterval(this.ping);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try { socket.send(JSON.stringify({ type: "leave", away: false })); } catch { /* closed */ }
      try { socket.close(); } catch { /* closed */ }
    }
    for (const link of this.peers.values()) { try { link.channel?.close(); } catch { /* closed */ } try { link.pc?.close(); } catch { /* closed */ } }
    this.peers.clear();
    this.p4?.clear();
    this.p4 = null;
    this.store.clear();
    this.status = "offline";
    return this.messages.splice(0);
  }
}

/** The background rooms, observable (useSyncExternalStore). */
export class RoomHub {
  private readonly rooms = new Map<string, BackgroundRoom>();
  private readonly listeners = new Set<() => void>();
  private readonly messageListeners = new Set<(e: Extract<HubEvent, { type: "message" }>) => void>();
  private readonly phoneListeners = new Set<(e: Extract<HubEvent, { type: "phone" }>) => void>();
  private snapshot: HubRoomView[] = [];
  private scheduled = false;
  private foreground = true;

  constructor(private readonly deps: HubDeps, readonly limit = 8) {}

  /** 6.7: the app went to the background or came back — every background room tells its members. */
  setForeground(on: boolean): void {
    this.foreground = on;
    for (const room of this.rooms.values()) room.setForeground(on);
  }

  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  list = (): HubRoomView[] => this.snapshot;

  onMessage(fn: (e: Extract<HubEvent, { type: "message" }>) => void): () => void {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }

  /** 6.9: phone calls offered in a background room. */
  onPhone(fn: (e: Extract<HubEvent, { type: "phone" }>) => void): () => void {
    this.phoneListeners.add(fn);
    return () => this.phoneListeners.delete(fn);
  }

  private publish(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.snapshot = [...this.rooms.values()].map((r) => r.view()).sort((a, b) => b.lastActivity - a.lastActivity || a.label.localeCompare(b.label));
      for (const fn of this.listeners) fn();
    });
  }

  has(key: string): boolean { return this.rooms.has(key); }
  get size(): number { return this.rooms.size; }

  /** Keeps a room connected in the background (no-op when it already is). */
  add(target: HubTarget): boolean {
    if (this.rooms.has(target.key)) return true;
    if (this.rooms.size >= this.limit) return false;
    const room = new BackgroundRoom(target, this.deps, (event) => {
      if (event.type === "message") for (const fn of this.messageListeners) fn(event);
      if (event.type === "phone") { for (const fn of this.phoneListeners) fn(event); return; }
      this.publish();
    });
    if (!this.foreground) room.setForeground(false);
    this.rooms.set(target.key, room);
    void room.start().catch(() => { room.status = "offline"; this.publish(); });
    this.publish();
    return true;
  }

  /** Stops a background room and hands over what it knows (switching to it). */
  take(key: string): { target: HubTarget; messages: ChatMessage[] } | null {
    const room = this.rooms.get(key);
    if (!room) return null;
    this.rooms.delete(key);
    const messages = room.stop();
    this.publish();
    return { target: room.target, messages };
  }

  remove(key: string): void { this.take(key); }

  markRead(key: string): void {
    const room = this.rooms.get(key);
    if (room && room.unread) { room.unread = 0; this.publish(); }
  }

  clear(): void { for (const key of [...this.rooms.keys()]) this.take(key); }

  /** For tests. */
  room(key: string): BackgroundRoom | undefined { return this.rooms.get(key); }
}

/** The app's hub (browser): the same socket URL, ICE servers, KDF worker and identity as the room on screen. */
export function createRoomHub(wsUrl: (server?: string) => string, rtcConfig: () => Promise<RTCConfiguration>, limit = 8): RoomHub {
  return new RoomHub({
    wsUrl,
    rtcConfig,
    makeSocket: (url) => new WebSocket(url),
    makePeer: (config) => new RTCPeerConnection(config),
    derive: (room, passphrase) => deriveRoomKeys(room, passphrase),
    identity: () => loadIdentity(),
    // 6.12: the device's mailbox bundle and account in our hellos, its downgrade markers and replay window.
    p4Local: async (identity) => {
      const current = await deviceMailbox(identity).current().catch(() => null);
      return { mb: current?.bundle ?? null, acc: helloAccountOf(identity.attestation), sth: null };
    },
    book: new TrustBook(),
    replay: deviceReplay().guard,
  }, limit);
}
