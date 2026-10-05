// One connected room's chat protocol (android chat/RoomSession.java) without UI
// and without transport specifics: the hub frames (join with the room-key
// proof, members, signals, relay, key directory, KT lookups, notices), the
// data-channel texts (hello v3/v4, the KEM, the ratchet, resets, sender keys,
// envelopes of both protocols), what goes to whom (`envelopeFor`, deliver,
// private payloads, the outbox, receipts, the relay for away members), the
// replay window (§ 11), pins and the identity states (§ 12), held messages,
// expiry. The WebSocket and the WebRTC peers are the app's / M5Net's:
// `RoomTransport` sends, `RoomEvents` tells. Single-threaded — `RoomSession`
// (an actor) owns one core and adds the timers and the async KT work.

import Foundation
import M5Core
import M5Crypto

/// How the room reaches the hub and its peers (M5Net's socket, the app's data channels). Thread-safe.
public protocol RoomTransport: Sendable {
    /// A frame on the signaling socket (dropped when it is not open).
    func sendHub(_ frame: JSONObject)
    /// Text on a peer's data channel; false when it is not open.
    func sendText(_ peerId: String, _ text: String) -> Bool
    /// Is the peer's data channel open?
    func isOpen(_ peerId: String) -> Bool
}

/// What the room tells the app. Thread-safe (the app hops to its main actor).
public protocol RoomEvents: Sendable {
    func added(_ message: ChatMessage, fresh: Bool)
    func changed(_ message: ChatMessage)
    func roomChanged()
    /// Make (or forget) the WebRTC peer for a member (`initiator`: we offer).
    func createPeer(_ peerId: String, name: String, initiator: Bool)
    func dropPeer(_ peerId: String)
    /// An opened WebRTC signal (offer, answer, candidate) for a peer.
    func signal(from peerId: String, _ description: JSONObject)
    /// A peer's audio-status (calls).
    func peerAudio(_ peerId: String, _ state: String)
    /// A file frame (JSON) for the app's file transfers; `peerId` nil for the server's.
    func fileFrame(_ peerId: String?, _ frame: JSONObject, proxy: Bool)
    /// A proxied file's key, opened from its sealed signal (§ 8).
    func proxyFileKey(from: String, transferId: String, fk: Bytes, spk: String)
    /// A checked profile frame from a peer, and when a peer can be told our profile's version (ProfileRoom).
    func profileFrame(_ peerId: String, _ frame: JSONObject)
    func profileHello(_ peerId: String, caps: [JSON]?)
    /// Locked: a state for a message of mine that is not in memory (the lock inbox takes it).
    func lockedState(messageId: String, who: String, name: String, state: String)
    /// The room's peer id and resume secret (the vault, or the lock inbox while locked).
    func joined(peerId: String, resume: String)
}

public extension RoomEvents {
    func profileFrame(_ peerId: String, _ frame: JSONObject) {}
    func profileHello(_ peerId: String, caps: [JSON]?) {}
    func fileFrame(_ peerId: String?, _ frame: JSONObject, proxy: Bool) {}
    func proxyFileKey(from: String, transferId: String, fk: Bytes, spk: String) {}
    func lockedState(messageId: String, who: String, name: String, state: String) {}
    func joined(peerId: String, resume: String) {}
    func peerAudio(_ peerId: String, _ state: String) {}
}

/// The settings a room reads.
public struct RoomSettings: Sendable {
    public var receipts = true
    public var readReceipts = true
    /// The account name a hello claims ("" when signed out).
    public var accountName = ""
    /// The app is in the foreground (presence).
    public var foreground = true
    /// With notifications on, the server covers for this device while the app is closed.
    public var awayWanted = false
    public init() {}
}

/// One member of the room as the session knows it.
public final class RoomPeer {
    public let id: String
    public internal(set) var name: String
    public internal(set) var publicKey = ""
    /// "" (no hello yet), "v4", "legacy".
    public internal(set) var proto = ""
    public internal(set) var downgrade = false
    public internal(set) var verified = false
    public internal(set) var changed = false
    public internal(set) var trust = Trust.new
    /// Key transparency: "", checking, unchecked, ok, missing, revoked, unverifiable, accepted.
    public internal(set) var kt = ""
    var ktKey = ""
    public internal(set) var attested = false
    var accountPin: String?
    var namePin = "new"
    /// Review P08: verified under another name than the one shown now.
    public internal(set) var verifiedAs = ""
    public internal(set) var caps: [JSON]?
    /// Reads binary file chunks.
    public internal(set) var bin = false
    public internal(set) var audio = "off"
    var beforeHello: [(payload: JSONObject, priv: Bool)] = []
    init(id: String, name: String) { self.id = id; self.name = name }
}

public final class RoomCore {
    public let key: String
    public let room: String
    public let label: String
    public let userName: String
    public let keys: RoomKeys
    public let identity: ChatIdentity
    let transport: any RoomTransport
    let events: any RoomEvents
    let device: P4Device
    let pins: NamePins
    let verifiedDevice: @Sendable (String) -> Bool
    let clock: any Clock
    public var settings: RoomSettings

    public let senderKeys: SenderKeys
    public private(set) var p4: P4Room!
    private let p4Link = P4LinkBridge()
    public internal(set) var relay = P4Relay()
    let replayWindow: P4ReplayWindow
    let replay: ReplayGuard
    /// Key transparency runs on this server (the actor sets it from P4Device.ktOn()).
    public var ktOn = false
    /// The newest verified tree head for the hello's `sth` (the actor keeps it current).
    public var sth: JSONObject?

    public private(set) var myId = ""
    public private(set) var resumeSecret = ""
    public private(set) var status = "offline"
    public private(set) var notice = ""
    public private(set) var proven = false
    public private(set) var unproven = false
    private var hubNonce = ""
    private var joinSent = false
    private var proofSkipUntil: Int64 = 0
    private var legacyRetried = false
    static let proofRetryMs: Int64 = 3600_000

    /// The members, in the order they came.
    private var peerOrder = [String]()
    private var peerById = [String: RoomPeer]()
    public var peerList: [RoomPeer] { peerOrder.compactMap { peerById[$0] } }
    public func peer(_ id: String) -> RoomPeer? { peerById[id] }
    public private(set) var people = PeerFacts()
    public private(set) var presence = RoomPresence()
    public private(set) var messages = [ChatMessage]()
    private var held = [String: [ChatMessage]]()
    private var relayHeld = OrderedMap<String, [ChatMessage]>()
    public private(set) var heldIds = Set<String>()
    private var seen = OrderedMap<String, Bool>()
    private var clockNoted = Set<String>()

    struct Queued { var message: ChatMessage; let payload: JSONObject; let targets: Set<String>?; let createdAt: Int64; var attempts = 0 }
    private var outbox = [Queued]()
    private var receiptQueue = [String: [String: [String]]]()
    struct RelayWaiting { let payload: JSONObject; let refs: [String]; let mention: [String]; let messageId: String?; let deadline: Int64 }
    private var relayWaiting = OrderedMap<String, RelayWaiting>()
    /// KT lookups the hub answered, for the actor to check (async) and hand back with `applyKtLookup`.
    public private(set) var pendingKtLookups = [(ref: String, lookup: JSONObject?)]()
    /// Peers' tree heads to gossip (async, the actor).
    public private(set) var pendingGossip = [JSONObject]()
    /// The replay window changed (the actor saves it soon).
    public internal(set) var replayDirty = false

    public init(key: String, room: String, label: String, userName: String, keys: RoomKeys, identity: ChatIdentity, transport: any RoomTransport,
                events: any RoomEvents, device: P4Device, pins: NamePins, verifiedDevice: @escaping @Sendable (String) -> Bool,
                settings: RoomSettings = RoomSettings(), clock: any Clock = SystemClock(), rng: (any Rng)? = nil) {
        self.key = key; self.room = room; self.label = label; self.userName = userName
        self.keys = keys; self.identity = identity; self.transport = transport; self.events = events
        self.device = device; self.pins = pins; self.verifiedDevice = verifiedDevice; self.settings = settings; self.clock = clock
        self.senderKeys = SenderKeys(clock: clock)
        replayWindow = device.store.replay(keys.roomId)
        replay = ReplayGuard(store: replayWindow, pruneEvery: 64)
        p4 = P4Room(roomId: keys.roomId, check: keys.check, identity: identity, store: device.store, extras: nil, link: nil, rng: rng, clock: clock)
        p4Link.core = self
        p4.connect(link: p4Link, extras: p4Link)
        if !replayWindow.persistent { M5Log.shared.warn("room", "the replay window cannot be read — only live chains are accepted until it can") }
    }

    var now: Int64 { clock.now() }
    public var connected: Bool { status == "joined" }
    public func tr(_ key: String) -> String { P4Texts.t(key) }

    /* ------------------------------------------------------------ socket */

    /// The socket opened: the join waits for the server's hello (its nonce is what the proof signs); the actor
    /// calls `joinFallback` after 4 s.
    public func onSocketOpen() {
        hubNonce = ""
        joinSent = false
        legacyRetried = false
        status = "connecting"
        events.roomChanged()
    }

    /// No hello from the server in time: the join without a proof.
    public func joinFallback() { if !joinSent { sendJoin() } }

    public func onSocketClosed(code: Int) {
        status = "offline"
        if code == 4001 { notice = Texts.t("room.replaced", "replaced") }
        if code == 4003 { notice = Texts.t("room.closedByServer", "closed by the server") }
        events.roomChanged()
    }

    /// Restores a member identity from the vault (6.7, before the socket opens).
    public func resume(peerId: String, secret: String) { myId = peerId; resumeSecret = secret }

    /// § 13: {pub, sig} from the room's hub seed over join(…, roomId, nonce); nil without a nonce or for a plain-name room.
    public static func hubProof(_ keys: RoomKeys, nonce: String?) -> JSONObject? {
        guard let nonce, !nonce.isEmpty, keys.roomId.hasPrefix("r3.") else { return nil }
        return try? HubProof.build(seed: keys.hubSeed(), roomId: keys.roomId, nonce: nonce)
    }

    /// Review S14: "legacy" (join again without the proof — only when the refusal allows it; once per socket),
    /// "refuse" (disconnect) or "" (not about the proof).
    public static func proofRefusal(code: String, legacyAllowed: JSON?, retried: Bool) -> String {
        if code != "room-proof" && code != "room-proof-required" { return "" }
        return !retried && legacyAllowed == .bool(true) ? "legacy" : "refuse"
    }

    /// The join frame — with the proof that we hold the room key when the server gave a nonce (§ 13).
    public func joinFrame() -> JSONObject {
        var join = JSONObject([("type", "join"), ("protocol", 2), ("room", .string(keys.roomId)), ("name", .string(userName)),
                               ("peerId", .string(myId.isEmpty ? "peer-" + Crypto.hex(Crypto.random(12)) : myId)), ("away", false),
                               ("features", .array(["bin"])), ("foreground", .bool(settings.foreground))])
        if !resumeSecret.isEmpty { join["resume"] = .string(resumeSecret) }
        if now >= proofSkipUntil, let proof = RoomCore.hubProof(keys, nonce: hubNonce) { join["proof"] = .object(proof) }
        return join
    }

    private func sendJoin() {
        if joinSent { return }
        joinSent = true
        transport.sendHub(joinFrame())
    }

    /// The account on this socket ({type:"auth"}): the relay then holds messages for us.
    public func sendAuth(token: String) {
        guard connected, !token.isEmpty else { return }
        transport.sendHub(JSONObject([("type", "auth"), ("token", .string(token)), ("away", .bool(settings.awayWanted))]))
    }

    /// 6.7: the app went to the background or came back.
    public func presenceFrame() -> JSONObject { JSONObject([("type", "presence"), ("foreground", .bool(settings.foreground))]) }

    public func leaveFrame() -> JSONObject { JSONObject([("type", "leave"), ("away", false)]) }

    /// Everything of the connection forgotten (the room left or closed).
    public func disconnected() {
        for p in peerList { events.dropPeer(p.id) }
        peerOrder.removeAll()
        peerById.removeAll()
        senderKeys.clear()
        p4.clear()
        relay.clear()
        status = "offline"
        events.roomChanged()
    }

    /* ---------------------------------------------------------- frames */

    /// A frame from the server (JSON text).
    public func onHubText(_ text: String) {
        guard let f = JSON.parseObject(text) else { return }
        onHubFrame(f)
    }

    public func onHubFrame(_ f: JSONObject) {
        people.onFrame(f, now: now)
        presence.onFrame(f, now: now)
        switch f.optString("type") {
        case "hello":
            hubNonce = f.string("nonce") ?? ""
            if !joinSent { sendJoin() }
        case "key-bundles":
            if !relay.onKeyBundles(f, now: now).isEmpty { sendWaitingRelays() }
        case "kt-lookup":
            let ref = f.optString("ref")
            if !ref.isEmpty { pendingKtLookups.append((ref, f.object("lookup"))) }
        case "joined":
            myId = f.string("peerId") ?? myId
            resumeSecret = f.optString("resume")
            events.joined(peerId: myId, resume: resumeSecret)
            status = "joined"
            notice = ""
            proven = f.bool("proven") ?? false
            unproven = f["proven"]?.boolValue != nil && !proven
            system(Texts.t("rooms.connected", "connected") + " · " + label)
            for p in f.array("peers") ?? [] { if let p = p.objectValue { createPeer(p.optString("peerId"), p.optString("name"), initiator: true) } }
            events.roomChanged()
        case "peer-joined":
            let id = f.optString("peerId")
            if let p = peerById[id], let n = f.string("name") { p.name = n }
            pendingNames[id] = f.optString("name")
            system(f.optString("name") + " ↗")
            events.roomChanged()
        case "peer-updated":
            if let p = peerById[f.optString("peerId")] { if let n = f.string("name") { p.name = n }; events.roomChanged() }
        case "peer-left": dropPeer(f.optString("peerId"), announce: true, held: f.bool("held") ?? false)
        case "signal": onSignal(source: f.optString("source"), payload: f.object("payload"))
        case "rate-limited":
            notice = Texts.f("room.rateLimited", "rate limited: {0}", f.optString("frame"))
            events.roomChanged()
        case "proxy-meta", "proxy-chunk", "proxy-end", "proxy-cancel": events.fileFrame(f.optString("from"), f, proxy: true)
        case "proxy-need": events.fileFrame(nil, f, proxy: true)
        case "relay-deliver": onRelayDeliver(f.array("items"))
        case "relay-status": onRelayStatus(f)
        case "proxy-ack": if f.bool("accepted") == false { systemNotice("⚠ " + f.optString("reason")) }
        case "closed-by-server": notice = f.optString("reason"); events.roomChanged()
        case "server-notice": onServerNotice(f)
        case "error": onError(f)
        default: break
        }
    }

    private var pendingNames = [String: String]()

    private func onError(_ f: JSONObject) {
        notice = f.optString("message")
        let code = f.optString("code")
        if code == "room-blocked" || code == "room-full" {
            system((code == "room-blocked" ? "⛔ " : "👥 ") + notice)
            status = "blocked"
        }
        switch RoomCore.proofRefusal(code: code, legacyAllowed: f["legacyAllowed"], retried: legacyRetried) {
        case "legacy":
            legacyRetried = true
            proofSkipUntil = now + RoomCore.proofRetryMs
            notice = tr("p4.roomProofLegacy")
            system("⚠ " + notice)
            joinSent = false
            sendJoin()
        case "refuse":
            notice = tr(code == "room-proof" ? "p4.roomProof" : "p4.roomProofRequired")
            system("⛔ " + notice)
            status = "refused"
        default: break
        }
        events.roomChanged()
    }

    private func createPeer(_ peerId: String, _ name: String?, initiator: Bool) {
        if peerId.isEmpty || peerId == myId || peerById[peerId] != nil { return }
        let shown = (name ?? "").isEmpty ? "peer-" + String(decoding: peerId.utf16.suffix(4), as: UTF16.self) : name!
        peerById[peerId] = RoomPeer(id: peerId, name: shown)
        peerOrder.append(peerId)
        events.createPeer(peerId, name: shown, initiator: initiator)
        events.roomChanged()
    }

    private func dropPeer(_ peerId: String, announce: Bool, held isHeld: Bool = false) {
        let p = peerById.removeValue(forKey: peerId)
        peerOrder.removeAll { $0 == peerId }
        senderKeys.forgetPeer(peerId)
        p4.peerGone(peerId)
        // Messages held behind a changed identity wait while the member is only away, and go when it left.
        if !isHeld, let was = held.removeValue(forKey: peerId) {
            for m in was { heldIds.remove(m.id) }
            if let p { system("⚠ " + p.name + ": " + P4Texts.tn("p4.heldDropped", Int64(was.count))) }
        }
        if let p {
            events.dropPeer(peerId)
            if announce { system(p.name + (isHeld ? " ☾ " + Texts.t("presence.wentAway", "went away") : " ↘")) }
        }
        events.roomChanged()
    }

    /* --------------------------------------------------------- signals */

    private func onSignal(source: String, payload: JSONObject?) {
        guard let sealed = payload?.object("sealed") else { M5Log.shared.warn("room", "unsealed signal ignored"); return }
        guard let desc = try? Envelopes.openSignal(keys, from: source, to: myId, sealed: sealed) else {
            notice = Texts.t("room.keyMismatch", "the room key does not match")
            status = "mismatch"
            events.roomChanged()
            return
        }
        // § 8 (review P07): a proxied file's key.
        if desc.optString("p4") == "fk" { acceptProxyFileKey(source, desc); return }
        if peerById[source] == nil { createPeer(source, pendingNames[source], initiator: false) }
        if peerById[source] != nil { events.signal(from: source, desc) }
    }

    /// A sealed WebRTC signal to a peer.
    public func sendSignal(_ target: String, _ payload: JSONObject) {
        guard let sealed = try? Envelopes.sealSignal(keys, from: myId, to: target, payload: payload) else { return }
        transport.sendHub(JSONObject([("type", "signal"), ("target", .string(target)), ("payload", .object(sealed))]))
    }

    /// § 8 (review P07): the FK of a file the server relays from `source` — a mailbox item sealed to this device.
    private func acceptProxyFileKey(_ source: String, _ sig: JSONObject) {
        let tx = sig.optString("transferId")
        guard !tx.isEmpty, tx.utf16.count <= 96, let item = sig.object("item"), P4Relay.isP4(item) else { return }
        let o: Mailbox.Opened?
        do { o = try device.mailbox(identity).open(item, roomId: keys.roomId, now: now) } catch {
            M5Log.shared.warn("room", "a proxied file's key did not open: \(error)")
            return
        }
        guard let fk = ProxyKeys.fkOf(o, transferId: tx, expectedPk: peerById[source]?.publicKey) else {
            M5Log.shared.warn("room", "a proxied file's key refused (another transfer, or another device than the member's)")
            return
        }
        events.proxyFileKey(from: source, transferId: tx, fk: fk, spk: o!.spk)
    }

    /// § 8 (review P07): the signals carrying a proxied file's FK sealed to every present member's trusted devices;
    /// nil when some member has no such device (then the room-derived key has to do). Ask the key directory first
    /// (`proxyFileKeyAsks`) and wait for its answers (`relayReady`).
    public func proxyFileKeySignals(transferId: String, fk: Bytes) -> [(peer: String, signal: JSONObject)]? {
        guard keys.roomId.hasPrefix("r3.") else { return nil }
        let recipients = peerOrder.filter { $0 != myId }
        if recipients.isEmpty { return nil }
        let box = device.mailbox(identity)
        let sacc = device.account(identity)
        let payload = JSONObject([("id", .string(transferId)), ("t", "fk"), ("fk", .string(Prim.b64(fk)))]).stringify()
        var out = [(String, JSONObject)]()
        for peerId in recipients {
            let ref = people.account(peerId)
            var devices = ref.isEmpty ? [] : relay.devices(ref, pinnedApk: device.store.refAccount(ref), remembered: device.store.devicesOfRef(ref), ktOn: ktOn, now: now)
            if let live = p4.helloDevice(peerId, now: now), !devices.contains(where: { $0.pk == live.pk }) { devices.append(live) }
            var items = [JSONObject]()
            for d in devices {
                if let item = try? box.seal(roomId: keys.roomId, id: transferId, payloadJson: payload, recipientPk: d.pk, recipient: d.bundle, sacc: sacc, now: now) { items.append(item) }
            }
            if items.isEmpty { return nil }
            guard let one = items.count == 1 ? items[0] : try? Mailbox.set(transferId, items) else { return nil }
            out.append((peerId, JSONObject([("p4", "fk"), ("transferId", .string(transferId)), ("item", .object(one))])))
        }
        return out
    }

    /// The key-bundles / kt-lookup frames a proxied file's FK (or a relayed message) needs before it can be sealed.
    public func proxyFileKeyAsks() -> [String] {
        var refs = [String]()
        for id in peerOrder where id != myId {
            let ref = people.account(id)
            if ref.isEmpty || refs.contains(ref) { continue }
            refs.append(ref)
            if relay.shouldAsk(ref, now: now) { transport.sendHub(P4Relay.askFrame(ref)) }
            if ktOn && !unproven && !device.store.refAccount(ref).isEmpty && relay.shouldAskKt(ref, now: now) { transport.sendHub(P4Relay.ktFrame(ref)) }
        }
        return refs
    }

    /* ---------------------------------------------------- data channel */

    /// A peer's data channel opened: our hello, and the outbox.
    public func onChannelOpen(_ peerId: String) {
        guard let p = peerById[peerId] else { return }
        sendHello(p)
        flushOutbox("channel")
        events.roomChanged()
    }

    /// The peer's channel closed for good (WebRTC gave up): the peer is forgotten.
    public func onChannelGone(_ peerId: String) { dropPeer(peerId, announce: false) }

    /// Our hello on this channel: the protocol-3 hello (caps, user), made a hello v4 (§ 2).
    func sendHello(_ p: RoomPeer) {
        guard var hello = try? senderKeys.hello(keys, identity, from: myId, to: p.id) else { return }
        // caps: "bin" = we read binary file chunks; "profile" = we speak the room's profile frames; no "media".
        hello["caps"] = .array(["bin", "profile"])
        if !settings.accountName.isEmpty { hello["user"] = .string(settings.accountName) }
        let v4 = p4.hello(myId: myId, peerId: p.id, v3: hello)
        _ = transport.sendText(p.id, (v4 ?? hello).stringify())
    }

    /// Text from a peer's data channel.
    public func onPeerText(_ peerId: String, _ text: String) {
        guard let p = peerById[peerId], let raw = JSON.parseObject(text) else { return }
        let kind = raw.optString("kind")
        // 6.12 (§ 1): a device that spoke protocol 4 before and now does not is refused — nothing of it is read.
        if p.downgrade && kind != "hello" { return }
        switch kind {
        case "key-check":
            if raw.optString("check") != keys.check { notice = Texts.t("room.keyMismatch", "the room key does not match"); events.roomChanged() }
            return
        case "hello": onHello(p, raw); return
        case "p4-kem": p4.onKem(p.id, raw); return
        case "p4": p4.onFrame(p.id, raw); return
        case "p4-reset": p4.onReset(p.id, raw); return
        case "sender-key": if !isV4(p.id) { _ = senderKeys.acceptSenderKey(keys, raw, from: p.id, to: myId) }; return
        case "file-meta", "file-chunk", "file-end", "file-cancel", "file-need":
            if raw.string("transferId") != nil { events.fileFrame(p.id, raw, proxy: false); return }
        default: break
        }
        // 6.12 (§ 6): a room message sealed with the peer's sender key v4.
        if P4Room.isRoomEnvelope(raw) {
            guard p4.v4(p.id) else { return }
            do {
                handleOpened(p, Envelopes.Opened(payload: try p4.openRoom(p.id, raw), version: P4.version, signer: p4.signer(p.id)), pairSealed: false, liveChain: true)
            } catch {
                if (error as? P4Error)?.code != "replay" { system("⚠ " + p.name + ": undecryptable message") }
            }
            return
        }
        // A protocol-4 peer speaks protocol 4 only.
        if isV4(p.id) { M5Log.shared.warn("room", "a protocol-3 envelope from a protocol-4 peer ignored"); return }
        let sealedWith = SenderKeys.kind(raw)
        let opened: Envelopes.Opened
        do {
            opened = sealedWith == "sender-key" ? try senderKeys.openLive(keys, raw, from: p.id)
                : sealedWith == "pair" ? try senderKeys.openPrivate(keys, raw, from: p.id, to: myId)
                : try Envelopes.openMessage(keys, raw)
        } catch {
            system("⚠ " + p.name + ": undecryptable message")
            return
        }
        handleOpened(p, opened, pairSealed: sealedWith == "pair", liveChain: sealedWith == "sender-key")
    }

    /// The peer's current hello is protocol 4: it gets (and is heard in) protocol 4 only.
    public func isV4(_ peerId: String) -> Bool { p4.v4(peerId) }

    private func onHello(_ p: RoomPeer, _ raw: JSONObject) {
        if p4.repeatHello(p.id, raw) { return } // the same hello again: already answered
        if !p4.helloSent(p.id) { sendHello(p) } // ours first: the KEM message answers the hello we sent
        let refused = senderKeys.acceptHello(keys, identity, raw, from: p.id, to: myId)
        if refused == "key-mismatch" {
            notice = Texts.t("room.keyMismatch", "the room key does not match")
            status = "mismatch"
            events.roomChanged()
            return
        }
        if refused != nil { M5Log.shared.warn("room", "bad hello"); return }
        p.publicKey = raw.optString("pk")
        var proto = p4.onHello(p.id, raw, ref: people.account(p.id), now: now)
        if proto == "pending" {
            // Review P03: our hello v4 could not be made, and this peer speaks protocol 4 — once more.
            sendHello(p)
            proto = p4.onHello(p.id, raw, ref: people.account(p.id), now: now)
            if proto == "pending" { p.proto = ""; events.roomChanged(); return }
        }
        p.downgrade = proto == "downgrade"
        p.proto = proto
        if p.downgrade {
            p.verified = false
            p.beforeHello.removeAll()
            system("⚠ " + p.name + ": " + tr("p4.downgrade"))
            events.roomChanged()
            return
        }
        people.onHello(p.id, raw, now: now)
        p.caps = raw.array("caps")
        p.bin = p.caps?.contains(.string("bin")) ?? false
        p.verified = true
        pinPeer(p)
        if proto == "v4" {
            if let sth = raw.object("sth") { pendingGossip.append(sth) } // § 14.4
            ktLookup(p)
        } else {
            if let sk = try? senderKeys.senderKeyFor(keys, from: myId, to: p.id) { _ = transport.sendText(p.id, sk.stringify()) }
            events.profileHello(p.id, caps: p.caps)
        }
        let waiting = p.beforeHello
        p.beforeHello.removeAll()
        for w in waiting { deliverTo(p, w.payload, priv: w.priv) }
        events.roomChanged()
    }

    /// How a payload goes to one open peer whose hello came (review P03): "p4", "pair", "sender-key", "room" or "none".
    public static func envelopeFor(v4: Bool, priv: Bool, hasPair: Bool, p4Seen: Bool) -> String {
        if v4 { return "p4" }
        if hasPair { return priv ? "pair" : "sender-key" }
        return priv || p4Seen ? "none" : "room"
    }

    private func p4Seen(_ p: RoomPeer) -> Bool { !p.publicKey.isEmpty && device.store.p4Seen(p.publicKey) }

    private func deliverTo(_ p: RoomPeer, _ payload: JSONObject, priv: Bool) {
        guard !p.downgrade, transport.isOpen(p.id) else { return }
        let id = payload.optString("id")
        let envelope: JSONObject?
        switch RoomCore.envelopeFor(v4: isV4(p.id), priv: priv, hasPair: senderKeys.hasPair(p.id), p4Seen: p4Seen(p)) {
        case "p4":
            if priv { p4.sendPrivate(p.id, payload); return }
            _ = try? p4.sendRoom([p.id], id: id, payloadJson: payload.stringify(), now: now)
            return
        case "pair": envelope = try? senderKeys.sealPrivate(keys, id: id, payload: payload, from: myId, to: p.id, identity: identity)
        case "sender-key":
            if !senderKeys.hasOurKey(p.id), let sk = try? senderKeys.senderKeyFor(keys, from: myId, to: p.id) { _ = transport.sendText(p.id, sk.stringify()) }
            envelope = try? senderKeys.sealLive(keys, id: id, payload: payload, identity: identity)
        case "room": envelope = try? Envelopes.sealMessage(keys, id: id, payload: payload, identity: identity)
        default: M5Log.shared.warn("room", "nothing sent to a peer without a key for it (no room-key fallback)"); return
        }
        if let envelope { _ = transport.sendText(p.id, envelope.stringify()) }
    }

    /// The pair session with a protocol-4 peer is up: what waited for it goes now.
    func onP4Established(_ peerId: String) {
        guard let p = peerById[peerId] else { return }
        events.profileHello(p.id, caps: p.caps)
        flushOutbox("p4")
        events.roomChanged()
    }

    /// An opened message from a peer (any protocol): a profile frame, a receipt, a chat message.
    func handleOpened(_ p: RoomPeer, _ opened: Envelopes.Opened, pairSealed: Bool, liveChain: Bool) {
        let payload = opened.payload
        // 6.7: a member's profile — only sealed for us alone (a pair envelope, or the ratchet).
        if payload.string("kind") == "profile" {
            if payload.string("senderId") == p.id && p.id != myId && pairSealed { events.profileFrame(p.id, payload) }
            return
        }
        if let r = Payloads.receipt(payload, transportSender: p.id, myId: myId) { applyReceipt(p, r); return }
        guard var m = Payloads.validate(payload, transportSender: p.id, myId: myId, now: now) else { return }
        if seen[m.id] != nil { return }
        seen[m.id] = true
        while seen.count > 20_000, let first = seen.first { seen.remove(first.key) }
        if m.kind == "audio-status" { p.audio = m.text; events.peerAudio(p.id, m.text); events.roomChanged(); return }
        if !freshMessage(&m, payload["createdAt"], p4Message: opened.version == P4.version, liveChain: liveChain) { return }
        m.roomKey = key
        m.senderKid = p.publicKey.isEmpty ? "" : Ec.kid(p.publicKey)
        // 6.7 S15: the pinned key, under its name — 6.12 § 12.1: "verified" only when the person verified it.
        m.verified = Verified.p2p(opened.signer, helloKey: p.publicKey, changed: p.changed, claimedName: m.senderName, peerName: p.name) && p.trust == Trust.verified
        m.changed = p.changed
        if m.expired(now) { return }
        arrived(&m, via: "p2p")
        if p.changed { hold(p, m); return }
        add(m, fresh: true)
        if settings.receipts { queueReceipt(p.id, "delivered", m.id) }
    }

    /* ------------------------------------------------------------ replay */

    /// Review P10: while the stored window cannot be read, only live chains are accepted.
    func replayReady() -> Bool {
        if replayWindow.persistent { return true }
        return device.store.reloadReplay(keys.roomId, replayWindow)
    }

    /// § 11: is this message fresh and not seen before (remembered when it is)? Protocol 3: replay only.
    func freshMessage(_ m: inout ChatMessage, _ createdAt: JSON?, p4Message: Bool, liveChain: Bool) -> Bool {
        if !liveChain && !replayReady() { M5Log.shared.warn("room", "message refused: the replay window cannot be read"); return false }
        let n = now
        let verdict = p4Message ? replay.check(keys.roomId, m.id, createdAt: createdAt, now: n) : replay.checkId(keys.roomId, m.id, now: n)
        if verdict == "clamped" {
            let ahead = (createdAt?.int64Value ?? n) - n
            m.createdAt = n
            if clockNoted.insert(m.senderId).inserted {
                system("⏱ " + m.senderName + ": " + tr("p4.clockAhead").replacingOccurrences(of: "{min}", with: String(max(5, ahead / 60_000))))
            }
        } else if verdict != "ok" { M5Log.shared.warn("room", "message refused: \(verdict)"); return false }
        replayDirty = true
        return true
    }

    /* ------------------------------------------------- identity (§ 12) */

    private func pinPeer(_ p: RoomPeer) {
        let kid = Ec.kid(p.publicKey)
        let acc = p.proto == "v4" ? p4.account(p.id) : nil
        let attested = acc?.valid ?? false
        let user = people.get(p.id)?.username ?? ""
        let store = device.store
        let namePin = attested ? pins.verdict(room, p.name, kid) : pins.pin(room, p.name, kid)
        let accountPin = attested ? store.pinAccount(acc!.publicKey, devicePk: p.publicKey, username: user) : nil
        if attested && namePin == "new" { pins.pin(room, p.name, kid) }
        let ref = people.account(p.id)
        if attested && !ref.isEmpty && store.pinRef(ref, acc!.publicKey) == "changed" { M5Log.shared.warn("room", "a member reference shows another account than the one pinned for it") }
        let accepted = p.kt == "accepted" && p.publicKey == p.ktKey
        p.attested = attested
        p.accountPin = accountPin
        p.namePin = namePin
        p.kt = !attested || !ktOn ? "" : accepted ? "accepted" : "checking"
        p.ktKey = p.publicKey
        updateTrust(p)
    }

    private func ktConfirmed(_ p: RoomPeer) -> Bool { p.kt == "ok" || (p.kt.isEmpty && !ktOn) }

    func updateTrust(_ p: RoomPeer) {
        let acc = p.attested ? p4.account(p.id) : nil
        let store = device.store
        let devVerified = verifiedDevice(Ec.kid(p.publicKey))
        let accVerified = acc.map { store.accountVerified($0.publicKey) } ?? false
        let verifiedName = acc.map { store.accountVerifiedName($0.publicKey) } ?? ""
        let nameOk = Trust.verifiedUnder(verifiedName, p.name)
        let wasChanged = p.changed, wasOther = !p.verifiedAs.isEmpty
        p.verifiedAs = accVerified && !nameOk && !devVerified ? verifiedName : ""
        p.trust = Trust.of(attested: p.attested && acc != nil, accountPin: p.accountPin, namePin: p.namePin, deviceVerified: devVerified,
                           accountVerified: accVerified && nameOk, ktRevoked: p.kt == "revoked", ktConfirmed: ktConfirmed(p))
        p.changed = p.trust == Trust.changed
        if p.changed && !wasChanged { system("⚠ " + p.name + ": " + tr("p4.identityChanged")) }
        if !p.verifiedAs.isEmpty && !wasOther { system("⚠ " + p.name + ": " + tr("p4.trust.otherName").replacingOccurrences(of: "{name}", with: p.verifiedAs)) }
    }

    private func hold(_ p: RoomPeer, _ m: ChatMessage) {
        var list = held[p.id] ?? []
        list.append(m)
        heldIds.insert(m.id)
        while list.count > 200 { heldIds.remove(list.removeFirst().id) }
        held[p.id] = list
        if list.count == 1 { system("⚠ " + p.name + ": " + tr("p4.held")) }
        events.roomChanged()
    }

    /// Review P14: is this message held (its sender's identity changed, not accepted yet)?
    public func isHeld(_ messageId: String?) -> Bool { messageId.map { heldIds.contains($0) } ?? false }

    private func holdRelayed(_ kid: String, _ m: ChatMessage) {
        var list = relayHeld[kid] ?? []
        list.append(m)
        heldIds.insert(m.id)
        while list.count > 200 { heldIds.remove(list.removeFirst().id) }
        relayHeld[kid] = list
        while relayHeld.count > 50, let first = relayHeld.first { for x in first.value { heldIds.remove(x.id) }; relayHeld.remove(first.key) }
        if list.count == 1 { system("⚠ " + m.senderName + ": " + tr("p4.held")) }
        events.roomChanged()
    }

    /// How many messages of this peer are held — on its channel, and relayed ones of its device key.
    public func heldCount(_ peerId: String) -> Int {
        let l = held[peerId]?.count ?? 0
        guard let p = peerById[peerId], !p.publicKey.isEmpty else { return l }
        return l + (relayHeld[Ec.kid(p.publicKey)]?.count ?? 0)
    }

    /// People › verify: the person compared the safety number (on) or took it back (off).
    public func identityVerified(_ peerId: String, _ on: Bool) {
        guard let p = peerById[peerId], !p.publicKey.isEmpty else { return }
        let acc = p.proto == "v4" ? p4.account(p.id) : nil
        let attested = acc?.valid ?? false
        let user = people.get(p.id)?.username ?? ""
        let store = device.store
        if on {
            let kid = Ec.kid(p.publicKey)
            pins.repin(room, p.name, kid)
            if attested, let acc {
                store.acceptAccount(acc.publicKey, devicePk: p.publicKey, username: user)
                store.setAccountVerified(acc.publicKey, true, name: p.name) // review P08: under this name
                let ref = people.account(p.id)
                if !ref.isEmpty { store.repinRef(ref, acc.publicKey) }
            }
            if p.kt == "revoked" { p.kt = "accepted"; p.ktKey = p.publicKey }
            p.accountPin = attested ? "match" : nil
            p.namePin = "match"
            updateTrust(p)
            let list = held.removeValue(forKey: peerId) ?? []
            let relayed = relayHeld.remove(kid) ?? []
            for var m in list + relayed { heldIds.remove(m.id); m.changed = false; add(m, fresh: true) }
        } else {
            if attested, let acc { store.setAccountVerified(acc.publicKey, false) }
            updateTrust(p)
        }
        events.roomChanged()
    }

    /// § 14.4 (review P04): an attested peer against key transparency — by the hub's kt-lookup of its reference.
    private func ktLookup(_ p: RoomPeer) {
        guard p.attested, let acc = p4.account(p.id), acc.valid, ktOn else { return }
        let ref = people.account(p.id)
        if ref.isEmpty || unproven {
            if p.kt != "accepted" { p.kt = "unchecked"; p.ktKey = p.publicKey; updateTrust(p) }
            return
        }
        transport.sendHub(P4Relay.ktFrame(ref))
    }

    /// Key transparency is known now (its key pinned): attested peers that came before it are looked up.
    public func ktCheckPeers() {
        guard ktOn else { return }
        for p in peerList where p.attested && p.kt.isEmpty {
            p.kt = "checking"
            p.ktKey = p.publicKey
            updateTrust(p)
            ktLookup(p)
        }
        events.roomChanged()
    }

    /// The KT work the actor took (it checks them asynchronously).
    public func takeKtWork() -> (lookups: [(ref: String, lookup: JSONObject?)], gossip: [JSONObject]) {
        defer { pendingKtLookups.removeAll(); pendingGossip.removeAll() }
        return (pendingKtLookups, pendingGossip)
    }

    /// A checked lookup of a member reference: it serves the relay and the peers of that reference.
    public func applyKtLookup(ref: String, checked: Kt.Checked?, lookupPresent: Bool) {
        relay.onKt(ref, checked, now: now)
        sendWaitingRelays()
        for p in peerList {
            guard people.account(p.id) == ref, p.attested, let acc = p4.account(p.id), acc.valid else { continue }
            applyKt(p, pk: p.publicKey, apk: acc.publicKey, checked: lookupPresent ? checked : nil, user: people.get(p.id)?.username ?? "")
        }
    }

    private func applyKt(_ p: RoomPeer, pk: String, apk: String, checked c: Kt.Checked?, user: String) {
        if pk != p.publicKey || p.kt == "accepted" { return }
        p.kt = RoomCore.ktState(c, apk: apk, pk: pk, now: now)
        p.ktKey = pk
        if let c, c.ok, !user.isEmpty, !RoomCore.userShown(c.entries, user) {
            M5Log.shared.warn("room", "key transparency does not show the username a hello claims — not shown")
            people.dropUsername(p.id)
        }
        updateTrust(p)
        events.roomChanged()
    }

    /// Pure: a peer device's key-transparency word from a checked lookup.
    public static func ktState(_ c: Kt.Checked?, apk: String, pk: String, now: Int64) -> String {
        guard let c, c.ok else { return "unverifiable" }
        let st = Kt.deviceStatus(c.entries, apk: apk, dpk: pk, now: now)
        let logged = c.entries.contains { $0.entry.optString("t") == "acct" }
        return st.ok ? "ok" : st.revoked || (logged && !st.account) ? "revoked" : "missing"
    }

    /// Do the entries name this username's user (u)? True when there are none to tell.
    public static func userShown(_ entries: [Kt.Entry], _ username: String) -> Bool {
        let u = Kt.user(username)
        return entries.allSatisfy { $0.entry.optString("u") == u }
    }

    /// "@name" mentions in a text.
    public static func mentionNames(_ text: String?) -> [String] {
        guard let text else { return [] }
        var out = [String]()
        let scalars = Array(text.unicodeScalars)
        var i = 0
        func ok(_ u: Unicode.Scalar) -> Bool {
            switch u.properties.generalCategory {
            case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter, .decimalNumber, .letterNumber, .otherNumber: return true
            default: return u == "." || u == "_" || u == "-"
            }
        }
        while i < scalars.count && out.count < 20 {
            if scalars[i] == "@" {
                var j = i + 1
                var name = String.UnicodeScalarView()
                while j < scalars.count && ok(scalars[j]) && name.count < 40 { name.append(scalars[j]); j += 1 }
                if !name.isEmpty { out.append(String(name)); i = j; continue }
            }
            i += 1
        }
        return out
    }

    /* --------------------------------------------------------- messages */

    func system(_ text: String) { add(ChatMessage.system(roomKey: key, text: text, now: now), fresh: false) }

    /// A notice that is not a protocol message (a file failed, …).
    public func systemNotice(_ text: String) { system(text) }

    private func onServerNotice(_ f: JSONObject) {
        var text = f.optString("text")
        if text.isEmpty { return }
        text = Payloads.prefixUTF16(text, 2000)
        let kind = f.string("kind") ?? "wall"
        if kind == "flash" || kind == "wake" { notice = text; events.roomChanged(); return }
        var m = ChatMessage.system(roomKey: key, text: text, now: now)
        m.id = Names.noticeId + (f.string("id") ?? String(now, radix: 36))
        // 6.12 (F-22): always the operator — the frame's "from" could name anyone.
        m.senderName = (kind == "message" ? "✉ " : f.bool("pinned") == true ? "📌 " : "📣 ") + Texts.t("notice.operator", "Operator")
        m.createdAt = f.int64("at") ?? now
        if messages.contains(where: { $0.id == m.id }) { return }
        add(m, fresh: false)
        notice = text
        events.roomChanged()
    }

    func add(_ m: ChatMessage, fresh: Bool) {
        messages.append(m)
        if messages.count > 600 { messages.removeFirst(messages.count - 600) }
        events.added(m, fresh: fresh && !m.mine && m.kind != "sys")
    }

    private func update(_ id: String, _ body: (inout ChatMessage) -> Void) -> ChatMessage? {
        guard let i = messages.lastIndex(where: { $0.id == id }) else { return nil }
        body(&messages[i])
        events.changed(messages[i])
        return messages[i]
    }

    /// A message of this room by id.
    public func message(_ id: String) -> ChatMessage? { messages.last { $0.id == id } }

    /// The history restored into the list (the app read it from the vault).
    public func restore(_ history: [ChatMessage]) {
        let have = Set(messages.map(\.id))
        messages = history.filter { !have.contains($0.id) } + messages
        if messages.count > 600 { messages.removeFirst(messages.count - 600) }
        for m in history { seen[m.id] = true }
        events.roomChanged()
    }

    /* -------------------------------------------------------------- send */

    /// A message of mine from what the composer made (the bubble, "sending"). Sealing (`Sealed.seal`, slow) happens
    /// before `finishSend`; `sealedText`/`sealedMeta` carry its result.
    public func compose(_ o: Outgoing) -> ChatMessage {
        var m = ChatMessage()
        m.id = "msg-" + Crypto.hex(Crypto.random(12))
        m.roomKey = key
        m.text = o.text
        m.createdAt = now
        m.senderName = userName
        m.senderId = myId
        m.mine = true
        m.verified = true
        m.status = "sending"
        m.mark("created", "", at: m.createdAt)
        m.tap = o.tap
        m.vanishSeconds = o.vanishSeconds > 0 ? max(Payloads.vanishMin, min(Payloads.vanishMax, o.vanishSeconds)) : 0
        m.to = o.recipientNames
        m.forwardedFrom = o.forwardedFrom
        m.loc = o.loc
        m.fn = o.fn
        m.fnLocal = o.fnLocal
        m.sourceAudio = o.sourceAudio
        if o.ttlMinutes > 0 { m.ttlMinutes = min(Payloads.maxTtlMinutes, o.ttlMinutes); m.expiresAt = m.createdAt + Int64(m.ttlMinutes) * 60_000 }
        if let r = o.replyTo {
            m.replyToId = r.id
            m.replyToSender = r.senderName
            let q = r.sealed != nil ? "🔒" : !r.visibleText.isEmpty ? r.visibleText : (r.fileName.map { "📎 " + $0 } ?? "")
            m.replyToText = Payloads.prefixUTF16(q, 200)
        }
        if let d = o.dataUrl { m.fileName = o.fileName; m.fileMime = o.fileMime; m.fileSize = o.fileSize; m.fileDataUrl = d; m.fileImage = o.fileImage }
        if let code = o.sealCode, !m.text.isEmpty { m.sealCode = code.isEmpty ? Sealed.newCode() : code; m.sealPlain = m.text }
        add(m, fresh: false)
        return m
    }

    /// Sends a composed message: sealed (when it was to be) by the caller, then to the recipients' channels —
    /// "sent" — or into the outbox — "queued"; a room message also goes to the members who are away.
    public func finishSend(_ id: String, recipients: [String], sealed: (ciphertext: String, meta: JSONObject)? = nil) {
        guard var m = message(id) else { return }
        if let s = sealed { m.text = s.ciphertext; m.sealed = s.meta; m.mark("encrypted", "code", at: now) }
        m.senderId = myId
        let payload = payloadOf(m)
        let targets = recipients.isEmpty ? nil : Set(recipients)
        m.mark("encrypted", "", at: now)
        let to = openNames(targets)
        let sent = deliver(payload, targets: targets)
        if sent > 0 { m.raise("sent", who: to, at: now) }
        else {
            m.status = "queued"
            m.mark("queued", "", at: now)
            outbox.append(Queued(message: m, payload: payload, targets: targets, createdAt: now))
            if outbox.count > 200 { outbox.removeFirst(outbox.count - 200) }
        }
        _ = update(id) { $0 = m }
        if targets == nil { relayToAway(payload, mentionNames: RoomCore.mentionNames(m.sealed == nil ? m.text : nil), messageId: m.id) }
    }

    /// The payload of a message of mine, as the web builds it.
    public func payloadOf(_ m: ChatMessage) -> JSONObject {
        var p = JSONObject([("id", .string(m.id)), ("text", .string(m.text)), ("createdAt", .int(m.createdAt)), ("senderId", .string(myId)), ("senderName", .string(userName))])
        if let r = m.replyToId, !r.hasPrefix("fncall-") {
            p["replyTo"] = .object(JSONObject([("id", .string(r)), ("senderName", .string(m.replyToSender ?? "")), ("text", .string(m.replyToText ?? ""))]))
        }
        if let d = m.fileDataUrl {
            p["attachment"] = .object(JSONObject([("kind", .string(m.fileImage ? "image" : "file")), ("name", .string(m.fileName ?? "")), ("mime", .string(m.fileMime ?? "")),
                                                  ("size", .int(m.fileSize)), ("dataUrl", .string(d))]))
        }
        if m.ttlMinutes > 0 { p["ttlMinutes"] = .int(m.ttlMinutes) }
        var flags = JSONObject()
        if m.tap { flags["tap"] = true }
        if m.vanishSeconds > 0 { flags["vanishSeconds"] = .int(m.vanishSeconds) }
        if let s = m.sealed { flags["sealed"] = .object(s) }
        if let f = m.fn { flags["fn"] = .object(f) }
        if !flags.isEmpty { p["flags"] = .object(flags) }
        if !m.to.isEmpty { p["to"] = .array(m.to.map { .string($0) }) }
        if let f = m.forwardedFrom { p["forwardedFrom"] = .string(f) }
        if let l = m.loc { p["loc"] = .object(l) }
        return p
    }

    private func openNames(_ targets: Set<String>?) -> String {
        peerList.filter { transport.isOpen($0.id) && (targets == nil || targets!.contains($0.id)) }.map(\.name).joined(separator: ", ")
    }

    /// To the open peers with the best key each can open; returns how many took it (or wait for their hello).
    @discardableResult
    public func deliver(_ payload: JSONObject, targets: Set<String>?) -> Int {
        let id = payload.optString("id")
        var roomEnvelope: JSONObject?, live: JSONObject?
        var v4Room = [String]()
        var sent = 0
        for p in peerList {
            if !transport.isOpen(p.id) || p.downgrade || (targets != nil && !targets!.contains(p.id)) { continue }
            // Its hello has not said yet which protocol it speaks — the payload waits for it.
            if p.proto.isEmpty {
                if p.beforeHello.count < 200 { p.beforeHello.append((payload, targets != nil)); sent += 1 }
                continue
            }
            let envelope: JSONObject?
            switch RoomCore.envelopeFor(v4: isV4(p.id), priv: targets != nil, hasPair: senderKeys.hasPair(p.id), p4Seen: p4Seen(p)) {
            case "p4":
                if targets != nil { if p4.sendPrivate(p.id, payload) { sent += 1 } } else { v4Room.append(p.id) }
                continue
            case "pair": envelope = try? senderKeys.sealPrivate(keys, id: id, payload: payload, from: myId, to: p.id, identity: identity)
            case "sender-key":
                if !senderKeys.hasOurKey(p.id), let sk = try? senderKeys.senderKeyFor(keys, from: myId, to: p.id) { _ = transport.sendText(p.id, sk.stringify()) }
                if live == nil { live = try? senderKeys.sealLive(keys, id: id, payload: payload, identity: identity) }
                envelope = live
            case "room":
                if roomEnvelope == nil { roomEnvelope = try? Envelopes.sealMessage(keys, id: id, payload: payload, identity: identity) }
                envelope = roomEnvelope
            default: continue // review P03: no room-key fallback
            }
            if let e = envelope, transport.sendText(p.id, e.stringify()) { sent += 1 }
        }
        if !v4Room.isEmpty { sent += (try? p4.sendRoom(v4Room, id: id, payloadJson: payload.stringify(), now: now)) ?? 0 }
        return sent
    }

    /// Can this peer get a private payload (a protocol-4 session — possibly still being made — or a pair key)?
    public func canPrivate(_ peerId: String) -> Bool {
        guard let p = peerById[peerId], !p.downgrade else { return false }
        return p4.v4(peerId) || senderKeys.hasPair(peerId)
    }

    /// A private payload (receipt, profile frame) to one peer.
    @discardableResult
    public func privateTo(_ peerId: String, _ payload: JSONObject) -> Bool {
        guard let p = peerById[peerId], !p.downgrade else { return false }
        if isV4(peerId) { return p4.sendPrivate(peerId, payload) }
        guard let id = payload.string("id"), let sealed = try? senderKeys.sealPrivate(keys, id: id, payload: payload, from: myId, to: peerId, identity: identity) else { return false }
        return transport.sendText(peerId, sealed.stringify())
    }

    /// audio-status to everyone (sealed like a message).
    public func broadcastAudio(_ state: String) {
        let payload = JSONObject([("id", .string("aud-" + Crypto.hex(Crypto.random(8)))), ("kind", "audio-status"), ("status", .string(state)),
                                  ("createdAt", .int(now)), ("senderId", .string(myId)), ("senderName", .string(userName))])
        deliver(payload, targets: nil)
    }

    /* ------------------------------------------------------------- relay */

    /// 6.12 (§ 7.4): a room message for the signed-in members who are away — sealed per trusted device, the room
    /// envelope for the others. Waits (≤ 3 s, `sendParkedRelays`) for the directory and the lookups.
    func relayToAway(_ payload: JSONObject, mentionNames: [String], messageId: String?) {
        guard connected else { return }
        var here = Set<String>()
        for p in peerList where transport.isOpen(p.id) { let a = people.account(p.id); if !a.isEmpty { here.insert(a) } }
        var refs = [String](), mention = [String]()
        for a in people.away {
            if here.contains(a.account) || refs.contains(a.account) { continue }
            refs.append(a.account)
            for n in mentionNames where Verified.sameName(n, a.name) { mention.append(a.account) }
            if refs.count >= 50 { break }
        }
        if refs.isEmpty { return }
        let id = payload.optString("id")
        var waiting = false
        for ref in refs {
            if relay.shouldAsk(ref, now: now) { transport.sendHub(P4Relay.askFrame(ref)); waiting = true }
            else if !relay.known(ref, now: now) { waiting = true }
            if ktOn && !unproven && !device.store.refAccount(ref).isEmpty {
                if relay.shouldAskKt(ref, now: now) { transport.sendHub(P4Relay.ktFrame(ref)); waiting = true }
                else if !relay.ktKnown(ref, now: now) { waiting = true }
            }
        }
        if !waiting { sendRelay(id, payload, refs, mention, messageId); return }
        relayWaiting[id] = RelayWaiting(payload: payload, refs: refs, mention: mention, messageId: messageId, deadline: now + 3_000)
        while relayWaiting.count > 100, let first = relayWaiting.first { relayWaiting.remove(first.key) }
    }

    /// Every reference has its directory answer (and its lookup, where one is needed)?
    public func relayReady(_ refs: [String]) -> Bool {
        for r in refs {
            if !relay.known(r, now: now) { return false }
            if ktOn && !unproven && !device.store.refAccount(r).isEmpty && !relay.ktKnown(r, now: now) { return false }
        }
        return true
    }

    private func sendWaitingRelays() {
        for (id, w) in relayWaiting.entries where relayReady(w.refs) {
            relayWaiting.remove(id)
            sendRelay(id, w.payload, w.refs, w.mention, w.messageId)
        }
    }

    /// The waiting relays whose 3 s are up go now (the actor calls this on its timer).
    public func sendParkedRelays() {
        for (id, w) in relayWaiting.entries where w.deadline <= now {
            relayWaiting.remove(id)
            sendRelay(id, w.payload, w.refs, w.mention, w.messageId)
        }
    }

    /// When the next parked relay is due (nil: none).
    public var nextRelayDeadline: Int64? { relayWaiting.orderedValues.map(\.deadline).min() }

    private func sendRelay(_ id: String, _ payload: JSONObject, _ refs: [String], _ mention: [String], _ messageId: String?) {
        var devices = [String: [P4Relay.Device]]()
        for ref in refs { devices[ref] = relay.devices(ref, pinnedApk: device.store.refAccount(ref), remembered: device.store.devicesOfRef(ref), ktOn: ktOn, now: now) }
        let box = device.mailbox(identity)
        let sacc = device.account(identity)
        let json = payload.stringify()
        let n = now
        guard let built = try? P4Relay.frame(messageId: id, refs: refs, devices: devices,
                                             seal: { d in try box.seal(roomId: keys.roomId, id: id, payloadJson: json, recipientPk: d.pk, recipient: d.bundle, sacc: sacc, now: n) },
                                             roomEnvelope: { try Envelopes.sealMessage(keys, id: id, payload: payload, identity: identity) }, mention: mention) else { return }
        transport.sendHub(built.frame)
        if let messageId { markRelayed(messageId, to: built.frame.array("to") ?? [], sealed: built.sealed) }
    }

    /// § 7.4: the message's info names who got which form.
    private func markRelayed(_ id: String, to: [JSON], sealed: [String]) {
        var names = [String: String]()
        for a in people.away { names[a.account] = a.name }
        var p4Names = [String](), roomNames = [String]()
        for r in to {
            let ref = r.stringValue ?? ""
            let name = names[ref] ?? "?"
            if sealed.contains(ref) { p4Names.append(name) } else { roomNames.append(name) }
        }
        _ = update(id) { m in
            if !p4Names.isEmpty { m.mark("relay-p4", p4Names.joined(separator: ", "), at: now) }
            if !roomNames.isEmpty { m.mark("relay-room", roomNames.joined(separator: ", "), at: now) }
        }
    }

    /// relay-deliver: messages and states kept for us; each handled item is acknowledged.
    private func onRelayDeliver(_ items: [JSON]?) {
        guard let items else { return }
        var ack = [JSON]()
        var waitForReplay = false
        for raw in items.prefix(500) {
            guard let it = raw.objectValue else { continue }
            let itemId = it["id"] ?? .null
            if it.optString("kind") == "status" {
                if let st = it.object("status") { raiseMine(it.optString("messageId"), st.optString("state"), st.string("recipientName") ?? "relay") }
                ack.append(itemId)
                continue
            }
            // Review P10: not while the replay window cannot be read (not acknowledged: delivered again).
            if waitForReplay || !replayReady() { waitForReplay = true; continue }
            guard let env = it.object("envelope"), let from = it.object("from") else { ack.append(itemId); continue }
            let opened: Envelopes.Opened
            if P4Relay.isP4(env) {
                let o: Mailbox.Opened?
                do { o = try device.mailbox(identity).open(env, roomId: keys.roomId, now: now) } catch { ack.append(itemId); continue }
                guard let o else { continue } // not for this device: another device of the account may open it
                let acc = Handshake.verifyAccount(o.sacc.map { .object($0) }, pk: o.spk, now: now)
                device.store.updateBundle(o.spk, o.senderBundle) // a pinned device's newer bundle; never a new pin
                opened = Envelopes.Opened(payload: o.payload, version: P4.version,
                                          signer: Envelopes.Signer(publicKey: o.spk, valid: true, accountKey: acc?.publicKey, accountValid: acc?.valid ?? false))
            } else {
                guard let o = try? Envelopes.openMessage(keys, env) else { continue } // another key may open it later
                opened = o
            }
            ack.append(itemId)
            guard var m = Payloads.validate(opened.payload, transportSender: from.optString("peerId"), myId: myId, now: now), seen[m.id] == nil, m.kind != "audio-status" else { continue }
            seen[m.id] = true
            if !freshMessage(&m, opened.payload["createdAt"], p4Message: opened.version == P4.version, liveChain: false) { continue }
            m.roomKey = key
            m.relayed = true
            let s = opened.signer
            let signed = s?.valid == true && !(s?.publicKey ?? "").isEmpty
            let state = signed ? relayedTrust(s!.publicKey, apk: s!.accountValid ? s!.accountKey : nil, name: m.senderName) : Trust.new
            m.senderKid = signed ? Ec.kid(s!.publicKey) : ""
            m.changed = state == Trust.changed
            m.verified = state == Trust.verified && (opened.version == P4.version || Verified.relay(s, pinnedKid: pins.pinned(room, m.senderName)))
            if m.expired(now) { continue }
            arrived(&m, via: "relay")
            if m.changed { holdRelayed(m.senderKid, m); continue }
            add(m, fresh: true)
        }
        if !ack.isEmpty { transport.sendHub(JSONObject([("type", "relay-ack"), ("ids", .array(ack))])) }
    }

    /// A relayed sender's identity state (§ 12.1) from the pins as they are (none is made).
    private func relayedTrust(_ spk: String, apk: String?, name: String) -> String {
        let kid = Ec.kid(spk)
        let store = device.store
        let attested = !(apk ?? "").isEmpty
        let verifiedName = attested ? store.accountVerifiedName(apk) : ""
        let accVerified = attested && store.accountVerified(apk) && Trust.verifiedUnder(verifiedName, name)
        return Trust.of(attested: attested, accountPin: attested ? store.accountKnown(apk) : nil, namePin: pins.verdict(room, name, kid),
                        deviceVerified: verifiedDevice(kid), accountVerified: accVerified, ktRevoked: false)
    }

    private func onRelayStatus(_ f: JSONObject) {
        let state = f.optString("state")
        let name = f.object("recipient")?.optString("name") ?? ""
        if state == "rejected" { system("⚠ " + name + ": " + f.optString("reason")); return }
        if state == "duplicate" { return }
        raiseMine(f.optString("messageId"), state, name)
    }

    private func raiseMine(_ messageId: String, _ state: String, _ who: String) {
        let key = who.isEmpty ? "relay" : who
        guard let m = message(messageId) else { events.lockedState(messageId: messageId, who: key, name: key, state: state); return }
        if !m.mine { return }
        _ = update(messageId) { m in
            if ChatMessage.rank(state) > ChatMessage.rank(m.receipts.optString(key)) { m.receipts[key] = .string(state) }
            m.raise(state, who: key, at: now)
        }
    }

    /* ------------------------------------------------------------ outbox */

    /// outbox.ts flush: to the peers that are open now; gone as soon as one took it, after 60 tries or 24 h.
    public func flushOutbox(_ reason: String) {
        let n = now
        outbox.removeAll { n - $0.createdAt > 24 * 3600_000 || $0.attempts >= 60 || $0.message.expired(n) }
        var done = Set<String>()
        for i in outbox.indices {
            outbox[i].attempts += 1
            if deliver(outbox[i].payload, targets: outbox[i].targets) > 0 { done.insert(outbox[i].message.id) }
        }
        outbox.removeAll { done.contains($0.message.id) }
        for id in done { _ = update(id) { $0.raise("sent", at: n) } }
    }

    public var outboxCount: Int { outbox.count }

    /* ---------------------------------------------------------- receipts */

    /// 6.1 receipts: queued, sent in batches (the actor calls `sendReceipts` after 400 ms).
    public func queueReceipt(_ peerId: String, _ state: String, _ messageId: String) {
        if !canPrivate(peerId) { return }
        receiptQueue[peerId, default: [:]][state, default: []].append(messageId)
    }

    public var receiptsWaiting: Bool { !receiptQueue.isEmpty }

    public func sendReceipts() {
        for (peerId, byState) in receiptQueue {
            guard peerById[peerId] != nil, transport.isOpen(peerId), canPrivate(peerId) else { continue }
            for (state, ids) in byState {
                var from = 0
                while from < ids.count {
                    let slice = Array(ids[from..<min(ids.count, from + 50)])
                    let payload = JSONObject([("kind", "receipt"), ("id", .string("rcpt-" + Crypto.hex(Crypto.random(12)))), ("createdAt", .int(now)),
                                              ("senderId", .string(myId)), ("senderName", .string(userName)), ("state", .string(state)),
                                              ("ids", .array(slice.map { .string($0) }))])
                    privateTo(peerId, payload)
                    from += 50
                }
            }
        }
        receiptQueue.removeAll()
    }

    /// A peer's receipt for messages of mine: the state goes up (per peer).
    private func applyReceipt(_ p: RoomPeer, _ r: Payloads.Receipt) {
        var ids = Set(r.ids)
        var n = 0
        for i in messages.indices.reversed() {
            if n >= 2000 { break }
            n += 1
            guard messages[i].mine, ids.contains(messages[i].id) else { continue }
            ids.remove(messages[i].id)
            if ChatMessage.rank(r.state) > ChatMessage.rank(messages[i].receipts.optString(p.id)) { messages[i].receipts[p.id] = .string(r.state) }
            messages[i].raise(r.state, who: p.name, at: now)
            events.changed(messages[i])
        }
        // Locked: receipts for older messages go to the lock inbox.
        for id in ids { events.lockedState(messageId: id, who: p.id, name: p.name, state: r.state) }
    }

    /// The UI showed these messages: "read" to their senders.
    public func markRead(_ shownIds: [String]) {
        guard settings.readReceipts else { return }
        for id in shownIds {
            guard let i = messages.lastIndex(where: { $0.id == id }) else { continue }
            let m = messages[i]
            if m.mine || m.relayed || m.kind == "sys" || m.readSent || m.senderId.isEmpty || ModelIdentity.reservedSender(m.senderId) { continue }
            messages[i].readSent = true
            queueReceipt(m.senderId, "read", m.id)
        }
    }

    /* ------------------------------------------------------------ expiry */

    /// When the next message expires (nil: none).
    public var nextExpiry: Int64? { messages.filter { $0.expiresAt > 0 }.map(\.expiresAt).min() }

    /// ttlMinutes: gone at expiresAt, for both sides. Returns the messages that went.
    @discardableResult
    public func expire() -> [ChatMessage] {
        let n = now
        var gone = [ChatMessage]()
        messages.removeAll { m in
            if m.expired(n) { gone.append(m); return true }
            return false
        }
        for var m in gone { m.vanished = true; m.mark("expired", "ttl", at: n); events.changed(m) }
        return gone
    }

    /// A vanishing message ran out on this device.
    public func vanished(_ id: String) { _ = update(id) { $0.vanished = true; $0.mark("expired", "vanish", at: now) } }

    /// Hides a message in this view until then (ChatMessage.untilSignIn with the unlock it belongs to), or shows it again (0).
    public func hide(_ id: String, until: Int64, unlock: String?, why: String?) {
        _ = update(id) { m in
            m.hiddenUntil = until
            m.hiddenFor = until == ChatMessage.untilSignIn ? unlock : nil
            m.mark(until == 0 ? "unhidden" : "hidden", why, at: now)
        }
    }

    /// Deleted on this device: out of the view and the outbox.
    public func deleteLocal(_ id: String) {
        guard let i = messages.lastIndex(where: { $0.id == id }) else { return }
        var m = messages.remove(at: i)
        outbox.removeAll { $0.message.id == id }
        m.deleted = true
        events.changed(m)
    }

    /// A message that came in: created (the sender's clock), received and decrypted now — via "p2p" or "relay".
    func arrived(_ m: inout ChatMessage, via: String) {
        let n = now
        m.mark("created", "", at: m.createdAt)
        m.mark("received", via, at: n)
        m.mark("decrypted", "", at: n)
    }

    /* -------------------------------------------------------------- view */

    /// The other people in the room with an open channel: [{id, name}].
    public var peersScope: [JSON] {
        peerList.filter { transport.isOpen($0.id) }.map { .object(JSONObject([("id", .string($0.id)), ("name", .string($0.name))])) }
    }

    /// This device's key in the room (the other half of a safety number).
    public var myKey: String { identity.publicKey }

    /// The safety number with a peer ("" before its hello).
    public func safetyNumber(_ peerId: String) -> String {
        guard let p = peerById[peerId], !p.publicKey.isEmpty else { return "" }
        return ChatIdentity.safetyNumber(identity.publicKey, p.publicKey)
    }
}

/// P4Room's link and hello extras, bridging to its core (P4Room keeps weak references).
final class P4LinkBridge: P4RoomLink, P4HelloExtras {
    weak var core: RoomCore?
    func send(_ peerId: String, _ text: String) -> Bool { core?.transport.sendText(peerId, text) ?? false }
    func delivered(_ peerId: String, _ payload: JSONObject, _ signer: Envelopes.Signer, pairSealed: Bool) {
        guard let core, let p = core.peer(peerId) else { return }
        core.handleOpened(p, Envelopes.Opened(payload: payload, version: P4.version, signer: signer), pairSealed: pairSealed, liveChain: true)
    }
    func established(_ peerId: String) { core?.onP4Established(peerId) }
    func rehello(_ peerId: String) {
        guard let core, let p = core.peer(peerId), core.transport.isOpen(peerId) else { return }
        core.sendHello(p)
    }
    func flood(_ peerId: String) {
        M5Log.shared.warn("room", "protocol-4 resets from a peer too often — channel closed")
        core?.onChannelGone(peerId)
    }
    func mailbox() -> JSONObject? { guard let core else { return nil }; return core.device.bundle(core.identity, unlocked: core.pins.vaultUnlocked) }
    func account() -> JSONObject? { guard let core else { return nil }; return core.device.account(core.identity) }
    func sth() -> JSONObject? { core?.sth }
}
