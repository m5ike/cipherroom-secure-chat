// Protocol 4 for one room (docs/protocol-v4.md §§ 1–8; android chat/P4Room.java):
// per peer the hello v4 handshake, the pair ratchet and its resets, the room's
// sender keys v4, private messages and file keys over the ratchet, the
// downgrade rule. It knows peers by id and talks to them through a `Link`
// (the data channels), so tests run two rooms against each other.
//
// Single-threaded: owned by one room session (an actor) and called in channel
// order — the KEM, ratchet and reset messages travel only on the ordered data
// channel. Not Sendable on purpose.
//
// Wire shapes (on the data channel as JSON text):
//   hello v4 { kind:"hello", v:4, …v3, e, k, n, mb, acc, sth, sig4 }
//   { kind:"p4-kem", v:4, ct, r }    { kind:"p4", v:4, h, c }    { kind:"p4-reset", v:4, why }
//   room message { v:4, id, sk, n, c, s }  (no kind)
//   inner (in "p4"): sk (a chain), msg {id, p} (private messages, receipts, profiles), file {transferId, key}, media (ignored)

import Foundation
import M5Core
import M5Crypto

/// How a P4Room reaches its peers and tells its room what happened.
public protocol P4RoomLink: AnyObject {
    /// Text on the peer's data channel; false when it is not open.
    func send(_ peerId: String, _ text: String) -> Bool
    /// An opened chat payload from the peer: private (ratchet `msg`) or a room message (sender key v4).
    func delivered(_ peerId: String, _ payload: JSONObject, _ signer: Envelopes.Signer, pairSealed: Bool)
    /// The pair session with the peer is up.
    func established(_ peerId: String)
    /// The session broke (§ 5.5): send a new hello on this channel.
    func rehello(_ peerId: String)
    /// Reset flood (more than one per 10 s): close the channel.
    func flood(_ peerId: String)
}

/// What the hello carries besides the protocol-3 fields: own bundle, account attestation, newest STH (each may be nil).
public protocol P4HelloExtras: AnyObject {
    func mailbox() -> JSONObject?
    func account() -> JSONObject?
    func sth() -> JSONObject?
}

/// A ChatIdentity as the hello's device signer.
public struct IdentitySigner: DeviceSigner {
    public let identity: ChatIdentity
    public init(_ identity: ChatIdentity) { self.identity = identity }
    public var publicKey: String { identity.publicKey }
    public func sign(_ data: Bytes) throws -> String {
        do { return try identity.sign(data) } catch { throw P4Error("state", "cannot sign") }
    }
}

public final class P4Room {
    public final class PeerState {
        var hs: PairHandshake?
        var session: Handshake.Session?
        /// The peer's last accepted hello (v4 or v3) and its device key.
        public internal(set) var hello: JSONObject?
        public internal(set) var pk = ""
        /// The peer's current hello is a valid v4 one: it gets protocol 4 only.
        public internal(set) var v4 = false
        /// Refused: a v3 hello from a device key seen with v4 before (§ 1).
        public internal(set) var downgrade = false
        public internal(set) var account: Handshake.AccountCheck?
        public internal(set) var bundle: Mailbox.Bundle?
        var lastReceivedReset: Int64 = Int64.min / 2, lastSentReset: Int64 = Int64.min / 2
        /// What waits for the session: ("inner", json), ("sk", json, keyId), ("raw", text).
        var pending: [(kind: String, text: String, keyId: String?)] = []
        /// The key id of our chain whose `sk` waits in `pending` (review P13).
        var queuedChain: String?
        /// File keys from `file` inner messages, by transfer id (the newest 64).
        var fileKeys = OrderedMap<String, Bytes>()
        public internal(set) var establishedAt: Int64 = 0
        /// The peer hello answered (its e|n): the same hello again is a repeat.
        var acceptedTag: String?
        public var hasSession: Bool { session != nil }
        init() {}
    }

    public static let maxPending = 200
    public static let resetGapMs: Int64 = 10_000

    public let roomId: String, check: String
    private let identity: ChatIdentity
    private let store: P4Store
    private weak var extras: P4HelloExtras?
    private weak var link: P4RoomLink?
    private let rng: any Rng
    private let clock: any Clock
    public let senderKeys: SenderKeys4
    private var peers = [String: PeerState]()

    public init(roomId: String, check: String, identity: ChatIdentity, store: P4Store, extras: P4HelloExtras?, link: P4RoomLink?,
                rng: (any Rng)? = nil, clock: any Clock = SystemClock()) {
        self.roomId = roomId
        self.check = check
        self.identity = identity
        self.store = store
        self.extras = extras
        self.link = link
        self.rng = rng ?? SystemRng()
        self.clock = clock
        self.senderKeys = SenderKeys4(roomId: roomId, ownerPk: identity.publicKey, rng: self.rng)
    }

    /// Wires the room to its link and hello extras (when they could not be given at init).
    public func connect(link: P4RoomLink?, extras: P4HelloExtras?) { self.link = link; self.extras = extras }

    private func state(_ peerId: String) -> PeerState {
        if let ps = peers[peerId] { return ps }
        let ps = PeerState()
        peers[peerId] = ps
        return ps
    }

    public func peer(_ peerId: String) -> PeerState? { peers[peerId] }

    /* -------------------------------------------------------------- hello */

    /// A new hello for this channel (open, or after a reset): the protocol-3 hello `v3` made a hello v4. The
    /// previous session with the peer ends. Nil when protocol 4 cannot be offered (then send `v3` as it is).
    public func hello(myId: String, peerId: String, v3: JSONObject) -> JSONObject? {
        let ps = state(peerId)
        endSession(ps)
        do {
            ps.hs = try PairHandshake.start(roomId: roomId, check: check, selfPeerId: myId, peerPeerId: peerId, v3: v3, signer: IdentitySigner(identity),
                                            mb: extras?.mailbox().map { .object($0) }, acc: extras?.account().map { .object($0) },
                                            sth: extras?.sth().map { .object($0) }, rng: rng)
            return ps.hs?.hello
        } catch {
            M5Log.shared.warn("p4", "no hello v4: \(error)")
            ps.hs = nil
            return nil
        }
    }

    /// Is a hello of ours waiting for the peer's?
    public func helloSent(_ peerId: String) -> Bool { peers[peerId]?.hs != nil }

    /// Is this the very hello the current handshake (or session) already answered?
    public func repeatHello(_ peerId: String, _ raw: JSONObject) -> Bool {
        guard let ps = peers[peerId], let tag = ps.acceptedTag, ps.session != nil || ps.hs != nil else { return false }
        return tag == P4Room.tagOf(raw)
    }

    static func tagOf(_ raw: JSONObject) -> String { raw.optString("e") + "|" + raw.optString("n") }

    /// Does this hello say protocol 4 (v: 4)?
    public static func saysV4(_ raw: JSONObject) -> Bool { raw.double("v").map { Int($0) == P4.version } ?? false }

    /// The peer's hello, after its protocol-3 part was accepted: "v4" (our KEM message went out), "legacy"
    /// (protocol 3), "downgrade" (refused) or "pending" (we could not offer protocol 4 to a peer that speaks it).
    public func onHello(_ peerId: String, _ raw: JSONObject, ref: String?, now: Int64) -> String {
        let ps = state(peerId)
        ps.acceptedTag = P4Room.tagOf(raw)
        let pk = raw.optString("pk")
        if pk != ps.pk { ps.account = nil; ps.bundle = nil }
        ps.pk = pk
        ps.hello = raw
        ps.downgrade = false
        guard let hs = ps.hs else {
            ps.v4 = false
            ps.acceptedTag = nil
            return P4Room.saysV4(raw) || store.p4Seen(pk) ? "pending" : "legacy"
        }
        let verdict = try? hs.acceptHello(.object(raw), now: now)
        guard let verdict, verdict.ok, let vh = verdict.hello else {
            ps.v4 = false
            if store.p4Seen(pk) {
                ps.downgrade = true
                endSession(ps)
                M5Log.shared.warn("p4", "protocol downgrade refused (\(verdict?.why ?? "no handshake"))")
                return "downgrade"
            }
            return "legacy"
        }
        ps.v4 = true
        store.markP4(pk)
        ps.account = Handshake.verifyAccount(vh["acc"], pk: pk, now: now)
        if let mb = verdict.mailbox { ps.bundle = mb }
        // § 7.4 (review P01): the device pin — with its account attestation, filed under the member reference.
        store.rememberDevice(roomId: roomId, pk: pk, bundle: verdict.mailbox, acc: vh.object("acc"),
                             accApk: ps.account?.valid == true ? ps.account?.publicKey : nil, ref: ref)
        if let kem = hs.kem { _ = link?.send(peerId, kem.stringify()) }
        maybeEstablish(peerId, ps)
        return "v4"
    }

    /* --------------------------------------------------------- KEM, frames */

    public func onKem(_ peerId: String, _ raw: JSONObject) {
        guard let ps = peers[peerId], let hs = ps.hs else { return }
        do {
            if try !hs.acceptKem(.object(raw)) { return } // answers another hello of ours
        } catch let e as P4Error {
            reset(peerId, ps, e.code)
            return
        } catch { return }
        maybeEstablish(peerId, ps)
    }

    private func maybeEstablish(_ peerId: String, _ ps: PeerState) {
        guard let hs = ps.hs, hs.ready else { return }
        do {
            ps.session = try hs.establish()
        } catch {
            M5Log.shared.warn("p4", "session failed: \(error)")
            reset(peerId, ps, (error as? P4Error)?.code ?? "state")
            return
        }
        ps.hs = nil
        ps.establishedAt = clock.now()
        // A new pair session with a peer that held our chain: ours is replaced (§ 6).
        senderKeys.rehello(peerId)
        let waiting = ps.pending
        ps.pending.removeAll()
        for w in waiting {
            switch w.kind {
            case "inner": _ = sendInnerNow(peerId, ps, w.text)
            case "sk":
                // Review P13: the peer holds our chain only once its `sk` went.
                if sendInnerNow(peerId, ps, w.text), let k = w.keyId { senderKeys.handedOut(peerId, k) }
                if w.keyId == ps.queuedChain { ps.queuedChain = nil }
            default: _ = link?.send(peerId, w.text)
            }
        }
        link?.established(peerId)
    }

    /// A "p4" frame: its inner message is handled; a failure may reset the session (§ 5.5).
    public func onFrame(_ peerId: String, _ raw: JSONObject) {
        guard let ps = peers[peerId], let session = ps.session else { return }
        let r = session.ratchet.decrypt(raw)
        guard r.ok, let inner = r.inner else {
            M5Log.shared.warn("p4", "a pair frame did not open: \(r.error ?? "")" + (r.reset ? " — reset" : ""))
            if r.reset { reset(peerId, ps, r.error) }
            return
        }
        self.inner(peerId, ps, inner)
    }

    private static func isTransferId(_ s: String) -> Bool {
        let u = Array(s.utf8)
        return (1...96).contains(u.count) && u.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 95 || $0 == 58 || $0 == 46 || $0 == 45 }
    }

    private func inner(_ peerId: String, _ ps: PeerState, _ inner: JSONObject) {
        switch inner.optString("t") {
        case "sk":
            if !senderKeys.acceptChain(peerId, ps.pk, .object(inner)) { M5Log.shared.warn("p4", "a sender-key chain was refused (bad or foreign cert)") }
        case "msg":
            let id = inner.optString("id")
            guard let p = inner.object("p"), !id.isEmpty, p.string("id") == id else { M5Log.shared.warn("p4", "a private message with another id"); return }
            link?.delivered(peerId, p, P4Room.signerOf(ps), pairSealed: true)
        case "file":
            let tx = inner.optString("transferId")
            guard P4Room.isTransferId(tx), let key = try? Prim.unb64(inner["key"], length: 32) else { M5Log.shared.warn("p4", "a bad file key"); return }
            ps.fileKeys[tx] = key
            while ps.fileKeys.count > 64, let first = ps.fileKeys.first { ps.fileKeys.remove(first.key) }
        default: break // media (no frame E2EE here), unknown types: ignored (forward compatibility)
        }
    }

    /// The Signer of a protocol-4 message (§ 6): the hello's device key, valid; the account when attested.
    static func signerOf(_ ps: PeerState) -> Envelopes.Signer {
        Envelopes.Signer(publicKey: ps.pk, valid: true, accountKey: ps.account?.publicKey, accountValid: ps.account?.valid ?? false)
    }

    /* -------------------------------------------------------------- resets */

    public func onReset(_ peerId: String, _ raw: JSONObject) {
        guard let ps = peers[peerId], ps.v4 else { return }
        let now = clock.now()
        if now - ps.lastReceivedReset < P4Room.resetGapMs { link?.flood(peerId); return }
        ps.lastReceivedReset = now
        M5Log.shared.warn("p4", "the peer reset the session: \(raw.optString("why"))")
        // Our own reset crossed theirs: the new hello is already out.
        if ps.session == nil && ps.hs != nil && now - ps.lastSentReset < P4Room.resetGapMs { return }
        endSession(ps)
        link?.rehello(peerId)
    }

    /// § 5.5: our session with the peer broke. Only RECEIVED resets count toward closing the channel; a second
    /// one of ours within resetGapMs goes without the p4-reset frame (review P13).
    private func reset(_ peerId: String, _ ps: PeerState, _ why: String?) {
        let now = clock.now()
        if now - ps.lastSentReset >= P4Room.resetGapMs {
            ps.lastSentReset = now
            _ = link?.send(peerId, JSONObject([("kind", "p4-reset"), ("v", 4), ("why", .string(why ?? "error"))]).stringify())
        }
        endSession(ps)
        link?.rehello(peerId)
    }

    private func endSession(_ ps: PeerState) {
        ps.acceptedTag = nil
        ps.session?.wipe()
        ps.hs?.wipe()
        ps.session = nil
        ps.hs = nil
    }

    /* ----------------------------------------------------------- queries */

    public func v4(_ peerId: String) -> Bool { peers[peerId]?.v4 ?? false }
    public func ready(_ peerId: String) -> Bool { peers[peerId].map { $0.v4 && $0.session != nil } ?? false }
    public func downgrade(_ peerId: String) -> Bool { peers[peerId]?.downgrade ?? false }
    public func account(_ peerId: String) -> Handshake.AccountCheck? { peers[peerId]?.account }
    public func helloPk(_ peerId: String) -> String { peers[peerId]?.pk ?? "" }

    /// The device of the peer's valid hello v4 with its bundle, when that bundle is valid now; else nil.
    public func helloDevice(_ peerId: String, now: Int64) -> P4Relay.Device? {
        guard let ps = peers[peerId], ps.v4, let b = ps.bundle, b.exp > now else { return nil }
        return P4Relay.Device(pk: ps.pk, apk: ps.account?.valid == true ? ps.account?.publicKey : nil, bundle: b)
    }

    /* ------------------------------------------------------------- sending */

    /// Encrypts and sends an inner message now, or keeps it for the session (in order). False: not a v4 peer.
    @discardableResult
    public func sendInner(_ peerId: String, _ innerJson: String) -> Bool {
        guard let ps = peers[peerId], ps.v4 else { return false }
        if ps.session == nil { return queue(ps, "inner", innerJson, nil) }
        return sendInnerNow(peerId, ps, innerJson)
    }

    private func queue(_ ps: PeerState, _ kind: String, _ text: String, _ keyId: String?) -> Bool {
        if ps.pending.count >= P4Room.maxPending { return false }
        ps.pending.append((kind, text, keyId))
        return true
    }

    private func sendInnerNow(_ peerId: String, _ ps: PeerState, _ innerJson: String) -> Bool {
        guard let session = ps.session else { return false }
        do { return link?.send(peerId, try session.ratchet.encrypt(innerJson).stringify()) ?? false }
        catch { M5Log.shared.warn("p4", "cannot seal for a peer: \(error)"); return false }
    }

    /// A private message (receipt, profile frame…) as a ratchet `msg`.
    @discardableResult
    public func sendPrivate(_ peerId: String, _ payload: JSONObject) -> Bool {
        guard let id = payload.string("id") else { return false }
        return sendInner(peerId, JSONObject([("t", "msg"), ("id", .string(id)), ("p", .object(payload))]).stringify())
    }

    /// A room message to these protocol-4 peers (§ 6): the chain renewed when due; a peer that does not hold our
    /// current chain gets it first (`sk`), then the one envelope for all. Returns how many peers took it.
    public func sendRoom(_ peerIds: [String], id: String, payloadJson: String, now: Int64) throws -> Int {
        try senderKeys.prepare(now)
        guard let keyId = senderKeys.currentKeyId else { return 0 }
        var to = [String]()
        for peerId in peerIds {
            guard let ps = peers[peerId], ps.v4 else { continue }
            if !senderKeys.hasOurChain(peerId) && keyId != ps.queuedChain {
                let sk = try senderKeys.chainFor(peerId).stringify()
                if ps.session == nil {
                    if !queue(ps, "sk", sk, keyId) { continue }
                    ps.queuedChain = keyId
                } else if sendInnerNow(peerId, ps, sk) {
                    senderKeys.handedOut(peerId, keyId)
                } else { continue }
            }
            to.append(peerId)
        }
        if to.isEmpty { return 0 }
        let text = try senderKeys.seal(id, payloadJson).stringify()
        var sent = 0
        for peerId in to {
            guard let ps = peers[peerId] else { continue }
            if ps.session == nil ? queue(ps, "raw", text, nil) : (link?.send(peerId, text) ?? false) { sent += 1 }
        }
        return sent
    }

    /// A file key for a transfer to this peer (§ 8): the `file` inner message, before the meta.
    @discardableResult
    public func sendFileKey(_ peerId: String, transferId: String, fk: Bytes) -> Bool {
        sendInner(peerId, JSONObject([("t", "file"), ("transferId", .string(transferId)), ("key", .string(Prim.b64(fk)))]).stringify())
    }

    /// The file key the peer sent for a transfer (used once), or nil (then it is not a protocol-4 transfer).
    public func fileKey(_ peerId: String, transferId: String) -> Bytes? { peers[peerId]?.fileKeys.remove(transferId) }

    /* ------------------------------------------------------------ receiving */

    /// Is this a protocol-4 room message ({v:4, id, sk, n, c, s}, no kind)?
    public static func isRoomEnvelope(_ raw: JSONObject) -> Bool {
        !raw.has("kind") && raw.double("v").map { Int($0) == P4.version } == true && raw.string("sk") != nil && raw.has("s")
    }

    /// Opens a peer's room message (sender key v4); throws when it does not open.
    public func openRoom(_ peerId: String, _ envelope: JSONObject) throws -> JSONObject {
        guard let ps = peers[peerId], ps.v4 else { throw P4Error("no-chain", "not a protocol-4 peer") }
        return try senderKeys.open(peerId, .object(envelope))
    }

    public func signer(_ peerId: String) -> Envelopes.Signer? { peers[peerId].map(P4Room.signerOf) }

    /* ------------------------------------------------------------ lifecycle */

    /// The peer left (or its channel is gone for good): its session and chains go, our chain is replaced (§ 6).
    public func peerGone(_ peerId: String) {
        if let ps = peers.removeValue(forKey: peerId) { endSession(ps) }
        senderKeys.peerLeft(peerId)
    }

    public func clear() {
        for ps in peers.values { endSession(ps) }
        peers.removeAll()
        senderKeys.clear()
    }
}
