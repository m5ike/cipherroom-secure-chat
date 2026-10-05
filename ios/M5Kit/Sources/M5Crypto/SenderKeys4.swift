// Room messages in protocol 4 (docs/protocol-v4.md § 6; sender-keys4.ts;
// android p4/SenderKeys4.java): sender keys with a per-chain ECDSA P-256
// signing key. The owner signs AAD ‖ ciphertext with the chain's key; a
// receiver verifies BEFORE it advances the chain, so a member who holds the
// chain can neither forge a message nor burn indices. The chain's `cert` (the
// chain's own key signing roomId, keyId and the owner's hello pk) binds it to
// its owner device. Chains are found by (sending peer, keyId); each peer keeps
// its newest chain and ONE older (messages in flight across a rotation).

import M5Core
import Synchronization

public final class SenderKeys4: Sendable {

    struct OwnChain: Sendable {
        let keyId: String
        var ck: Bytes
        var index: Int64
        let createdAt: Int64
        let sign: P256Pair
        let cert: String
    }

    struct PeerChain: Sendable {
        let owner: String, ownerPk: String, keyId: String, spk: String
        var ck: Bytes
        var index: Int64
        var skipped = OrderedMap<Int64, Bytes>()
    }

    private static func slot(_ owner: String, _ keyId: String) -> String { owner + "\u{0}" + keyId }

    /// § 6 AAD = join(LABEL.senderKey, roomId, id, keyId, n).
    public static func aad(_ roomId: String, _ id: String, _ keyId: String, _ n: Int64) throws -> Bytes {
        try Prim.join(P4.lSenderKey, roomId, id, keyId, n)
    }

    /// § 6: what a chain's `cert` signs (with the chain's spk) — join(LABEL.skCert, roomId, keyId, ownerPk).
    public static func certData(_ roomId: String, _ keyId: String, _ ownerPk: String) throws -> Bytes {
        try Prim.join(P4.lSkCert, roomId, keyId, ownerPk)
    }

    private struct State: Sendable {
        var own: OwnChain?
        var chains = OrderedMap<String, PeerChain>()
        /// Peers that hold our current chain.
        var sentTo = Set<String>()
    }

    public let roomId: String
    private let ownerPk: String
    private let rng: any Rng
    private let state = Mutex(State())

    /// `ownerPk`: this device's hello pk — every chain names it in its cert.
    public init(roomId: String, ownerPk: String, rng: (any Rng)? = nil) {
        self.roomId = roomId
        self.ownerPk = ownerPk
        self.rng = rng ?? SystemRng()
    }

    /* -------------------------------------------------------- own chain */

    private static func due(_ own: OwnChain?, _ now: Int64) -> Bool {
        guard let own else { return true }
        return own.index >= P4.senderKeyRotateMessages || now - own.createdAt >= P4.senderKeyRotateMs
    }

    /// Is our chain missing or due for replacement (SENDER_KEY_ROTATE)?
    public func due(_ now: Int64) -> Bool { state.withLock { SenderKeys4.due($0.own, now) } }

    /// Starts a new chain when there is none or it is due; true when it did
    /// (then nobody holds it yet). Draws: "sk.keyId", "sk.chain", "sk.spk".
    @discardableResult
    public func prepare(_ now: Int64) throws -> Bool {
        try state.withLock { s in
            if !SenderKeys4.due(s.own, now) { return false }
            let keyId = Prim.b64url(try rng.bytes(12, "sk.keyId"))
            let ck = try rng.bytes(32, "sk.chain")
            let sign = try rng.p256(.ecdsa, "sk.spk")
            let cert = try Prim.ecdsaSign(sign, try SenderKeys4.certData(roomId, keyId, ownerPk))
            s.own = OwnChain(keyId: keyId, ck: ck, index: 0, createdAt: now, sign: sign, cert: cert)
            s.sentTo.removeAll()
            return true
        }
    }

    /// Drops our chain; the next prepare() starts a new one (a member left, was excluded, …).
    public func rotate() { state.withLock { s in s.own = nil; s.sentTo.removeAll() } }

    /// The current chain as an `sk` inner message for `peerId` — from its current
    /// index, nothing before. The peer counts as holding it only once the message
    /// actually went (`handedOut`).
    public func chainFor(_ peerId: String) throws -> JSONObject {
        try state.withLock { s in
            guard let own = s.own else { throw P4Error("state", "no chain: call prepare() first") }
            return JSONObject([("t", "sk"), ("keyId", .string(own.keyId)), ("chain", .string(Prim.b64(own.ck))), ("index", .int(own.index)),
                               ("spk", .string(own.sign.spki)), ("cert", .string(own.cert))])
        }
    }

    /// The `sk` message for chain `keyId` was sent to `peerId`: it holds our chain (unless the chain was replaced meanwhile).
    public func handedOut(_ peerId: String, _ keyId: String) {
        state.withLock { s in if s.own?.keyId == keyId { s.sentTo.insert(peerId) } }
    }

    public func hasOurChain(_ peerId: String) -> Bool { state.withLock { $0.own != nil && $0.sentTo.contains(peerId) } }

    /// The chain did not reach the peer after all (its channel refused it).
    public func notSent(_ peerId: String) { state.withLock { _ = $0.sentTo.remove(peerId) } }

    public var currentKeyId: String? { state.withLock { $0.own?.keyId } }

    /// § 6: seals a room message (its JSON text, whose `id` must be `id`) with our current chain.
    public func seal(_ id: String, _ payloadJson: String) throws -> JSONObject {
        try state.withLock { s in
            guard var own = s.own else { throw P4Error("state", "no chain: call prepare() first") }
            if !Mailbox.hasId(try Mailbox.object(payloadJson), id) { throw P4Error("id-mismatch", "payload.id must be the message id") }
            let n = own.index
            let a = try SenderKeys4.aad(roomId, id, own.keyId, n)
            let step = Ratchet.kdfCk(own.ck)
            let k = Prim.keyIv(step.mk, P4.lSenderKey)
            let c = try Prim.aesGcmSeal(k.key, k.iv, a, Pad.pad(Prim.utf8(payloadJson)))
            let sig = try Prim.ecdsaSign(own.sign, a + c)
            own.ck = step.next
            own.index = n + 1
            s.own = own
            return JSONObject([("v", 4), ("id", .string(id)), ("sk", .string(own.keyId)), ("n", .int(n)), ("c", .string(Prim.b64(c))), ("s", .string(sig))])
        }
    }

    /* ------------------------------------------------------ peer chains */

    /// A peer's chain from its `sk` inner message, delivered by the pair session
    /// with `peerId` whose hello carried device key `peerPk`. Refused (false)
    /// unless `cert` is the chain spk's signature over (roomId, keyId, peerPk),
    /// or when that spk is already held for another owner device.
    @discardableResult
    public func acceptChain(_ peerId: String, _ peerPk: String?, _ raw: JSON?) -> Bool {
        guard let m = raw?.objectValue, m.string("t") == "sk", let keyId = m.string("keyId"), Prim.isSafeCount(m["index"]),
              let spk = m.string("spk"), let cert = m.string("cert") else { return false }
        guard (try? Prim.unb64url(keyId, length: 12)) != nil, let ck = try? Prim.unb64(m["chain"], length: 32) else { return false }
        if !Prim.isP256Spki(spk) { return false }
        guard let peerPk, let data = try? SenderKeys4.certData(roomId, keyId, peerPk), Prim.ecdsaVerify(spk, data, cert) else { return false }
        let index = (try? Prim.count(m["index"])) ?? 0
        return state.withLock { s in
            for c in s.chains.orderedValues where c.spk == spk && c.ownerPk != peerPk { return false }
            let key = SenderKeys4.slot(peerId, keyId)
            s.chains.remove(key)
            s.chains[key] = PeerChain(owner: peerId, ownerPk: peerPk, keyId: keyId, spk: spk, ck: ck, index: index) // last = newest
            let older = s.chains.orderedValues.filter { $0.owner == peerId && $0.keyId != keyId }
            if older.count > 1 { for c in older.dropLast() { s.chains.remove(SenderKeys4.slot(c.owner, c.keyId)) } } // grace for ONE older chain
            return true
        }
    }

    /// § 6: opens a peer's room message. The signature is verified before the
    /// chain moves; the chain moves only when the message decrypts. Throws
    /// malformed, no-chain, signature, replay, skip, aead, id-mismatch.
    public func open(_ peerId: String, _ raw: JSON?) throws -> JSONObject {
        guard let e = raw?.objectValue, e["v"]?.doubleValue == 4, let id = e.string("id"), !id.isEmpty, let sk = e.string("sk"),
              Prim.isSafeCount(e["n"]), e.string("c") != nil, e.string("s") != nil else {
            throw P4Error.malformed("not a protocol-4 sender-key message")
        }
        return try state.withLock { s in
            let key = SenderKeys4.slot(peerId, sk)
            guard var chain = s.chains[key] else { throw P4Error("no-chain", "no chain for this sender and key id") }
            let n = try Prim.count(e["n"])
            let a = try SenderKeys4.aad(roomId, id, sk, n)
            let c = try Prim.unb64(e["c"])
            if !Prim.ecdsaVerify(chain.spk, a + c, e.string("s")) { throw P4Error("signature", "not signed by the chain's key") }

            // Derive on the side; the chain changes only after the AEAD check.
            let mk: Bytes
            var nextCk: Bytes?
            var skippedNow = [(Int64, Bytes)]()
            let kept = chain.skipped[n]
            if let kept {
                mk = kept
            } else {
                if n < chain.index { throw P4Error("replay", "message key already used") }
                if n - chain.index > Int64(P4.maxSkip) { throw P4Error("skip", "too far ahead") }
                var ck = chain.ck
                var i = chain.index
                while i < n {
                    let step = Ratchet.kdfCk(ck)
                    skippedNow.append((i, step.mk))
                    ck = step.next
                    i += 1
                }
                let last = Ratchet.kdfCk(ck)
                mk = last.mk
                nextCk = last.next
            }
            let k = Prim.keyIv(mk, P4.lSenderKey)
            let plain = try Prim.aesGcmOpen(k.key, k.iv, a, c)
            // Commit.
            if kept != nil {
                chain.skipped.remove(n)
            } else {
                chain.ck = nextCk!
                chain.index = n + 1
                for (i, mk) in skippedNow { chain.skipped[i] = mk }
                while chain.skipped.count > P4.maxSkip, let first = chain.skipped.first { chain.skipped.remove(first.key) }
            }
            s.chains[key] = chain
            let payload: JSONObject
            do { payload = try Mailbox.object(try Prim.fromUtf8(try Pad.unpad(plain))) } catch { throw P4Error.malformed("body is not padded JSON") }
            if !Mailbox.hasId(payload, id) { throw P4Error("id-mismatch", "payload.id is not the envelope id") }
            return payload
        }
    }

    public func hasChain(_ peerId: String, _ keyId: String) -> Bool { state.withLock { $0.chains[SenderKeys4.slot(peerId, keyId)] != nil } }

    /// Do we hold any chain of this peer (a v4 room message of theirs can be opened)?
    public func hasAnyChainOf(_ peerId: String) -> Bool { state.withLock { $0.chains.orderedValues.contains { $0.owner == peerId } } }

    /* -------------------------------------------------------- lifecycle */

    /// A member left or was excluded: forget their chains and drop ours (§ 6).
    public func peerLeft(_ peerId: String) {
        state.withLock { s in
            for c in s.chains.orderedValues where c.owner == peerId { s.chains.remove(SenderKeys4.slot(c.owner, c.keyId)) }
            s.own = nil
            s.sentTo.removeAll()
        }
    }

    /// A new pair session with `peerId` (re-hello): when it held our chain, ours is replaced (§ 6).
    public func rehello(_ peerId: String) {
        state.withLock { s in if s.sentTo.contains(peerId) { s.own = nil; s.sentTo.removeAll() } }
    }

    public func clear() {
        state.withLock { s in s.own = nil; s.sentTo.removeAll(); s.chains.removeAll() }
    }
}
