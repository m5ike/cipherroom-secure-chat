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

import { deriveRoomKeys, isSealedSignal, openMessage, openSignal, sealSignal, type Envelope, type RoomKeys } from "./envelope";
import { SenderKeyStore, envelopeKind, type Hello } from "./sender-keys";
import { loadIdentity, type Identity } from "./identity";
import { validatePayload } from "./validate";
import type { ChatMessage } from "./chat-types";
import { newId } from "./id";

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
};

export type HubDeps = {
  wsUrl: (server?: string) => string;
  rtcConfig: () => Promise<RTCConfiguration>;
  makeSocket: (url: string) => WebSocket;
  makePeer: (config: RTCConfiguration) => RTCPeerConnection;
  derive: (room: string, passphrase: string) => Promise<RoomKeys>;
  identity: () => Promise<Identity | null>;
};

export type HubEvent = { type: "change" } | { type: "message"; key: string; label: string; message: ChatMessage };

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
  private readonly seen = new Set<string>();
  private stopped = false;
  private attempts = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;

  constructor(readonly target: HubTarget, private readonly deps: HubDeps, private readonly emit: (event: HubEvent) => void) {}

  view(): HubRoomView {
    let users = this.status === "joined" ? 1 : 0;
    for (const p of this.peers.values()) if (p.channel?.readyState === "open" || p.send) users++;
    return { key: this.target.key, label: this.target.label, room: this.target.room, status: this.status, users, unread: this.unread, lastActivity: this.lastActivity, last: this.last, profileId: this.target.profileId };
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

  private connect(): void {
    if (this.stopped || !this.keys) return;
    this.status = "connecting";
    this.changed();
    let socket: WebSocket;
    try { socket = this.deps.makeSocket(this.deps.wsUrl(this.target.server)); } catch { this.scheduleRetry(); return; }
    this.socket = socket;
    socket.onopen = () => {
      this.attempts = 0;
      socket.send(JSON.stringify({
        type: "join", protocol: 2, room: this.keys!.roomId, name: this.target.name,
        peerId: this.myId || newId("peer"), ...(this.resume ? { resume: this.resume } : {}), away: false,
      }));
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

  private scheduleRetry(): void {
    if (this.stopped) return;
    const cap = Math.min(120_000, 1000 * 2 ** Math.min(this.attempts, 12));
    this.attempts++;
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => this.connect(), Math.random() * cap + 250);
  }

  private async frame(f: Record<string, unknown>): Promise<void> {
    switch (f.type) {
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
    channel.onopen = () => this.handleChannelOpen(link.id, send);
    channel.onclose = () => { link.send = null; this.changed(); };
    channel.onmessage = (e) => { if (typeof e.data === "string") void this.handleChannelText(link.id, e.data); };
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
    this.store.forgetPeer(peerId);
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
    if (this.identity) send(JSON.stringify({ ...(await this.store.hello(this.keys, this.identity, this.myId, peerId)), caps: [] }));
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
      const refused = await this.store.acceptHello(keys, this.identity, raw as unknown as Hello, peerId, this.myId);
      if (refused === "key-mismatch") { this.status = "mismatch"; this.changed(); return; }
      if (refused) return;
      if (typeof raw.user === "string") link.name = link.name || raw.user;
      const sk = await this.store.senderKeyFor(keys, this.myId, peerId);
      if (sk && link.send) link.send(JSON.stringify(sk));
      return;
    }
    if (raw.kind === "sender-key") { await this.store.acceptSenderKey(keys, raw as { iv: string; ct: string }, peerId, this.myId); return; }
    if (typeof raw.kind === "string") {
      if (raw.kind === "file-meta") this.note(link.name);
      return; // file frames, key-check: not for a background room
    }
    const envelope = raw as unknown as Envelope;
    const sealedWith = envelopeKind(envelope);
    let opened: { payload: unknown; signer: { valid: boolean } | null; version?: number };
    try {
      opened = sealedWith === "sender-key" ? await this.store.openLive<unknown>(keys, envelope, peerId)
        : sealedWith === "pair" ? await this.store.openPrivate<unknown>(keys, envelope, peerId, this.myId)
        : await openMessage<unknown>(keys, envelope);
    } catch { return; }
    const p = validatePayload(opened.payload, { transportSender: peerId, myId: this.myId });
    if (!p || this.seen.has(p.id)) return;
    this.seen.add(p.id);
    if (this.seen.size > 20_000) this.seen.delete(this.seen.values().next().value!);
    if (p.kind === "audio-status") return;
    if (p.senderName) link.name = p.senderName;
    const message: ChatMessage = {
      id: p.id, senderId: p.senderId, senderName: p.senderName, text: p.text, createdAt: p.createdAt, mine: false, secure: true,
      attachment: p.attachment, flags: p.flags, to: p.to, replyTo: p.replyTo, forwardedFrom: p.forwardedFrom,
      cryptoVersion: 3, sealedWith,
      identity: opened.signer ? { state: opened.signer.valid ? "verified" : "invalid" } : { state: "unsigned" },
    };
    this.messages.push(message);
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    this.unread++;
    this.lastActivity = Date.now();
    this.last = { sender: p.senderName, text: p.flags?.sealed ? "🔒" : p.text || (p.attachment ? `📎 ${p.attachment.name}` : ""), at: p.createdAt };
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
  private snapshot: HubRoomView[] = [];
  private scheduled = false;

  constructor(private readonly deps: HubDeps, readonly limit = 8) {}

  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  list = (): HubRoomView[] => this.snapshot;

  onMessage(fn: (e: Extract<HubEvent, { type: "message" }>) => void): () => void {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
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
      this.publish();
    });
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
  }, limit);
}
