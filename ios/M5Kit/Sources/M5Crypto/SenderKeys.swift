// Pairwise channels and sender keys of protocol 3 (client/src/lib/sender-keys.ts;
// android chat/SenderKeys.java):
//   hello      signed (device key) DH key + key check, per peer
//   pair key   HKDF(ECDH, salt room, info "m5cet/pair/1|" + both device keys sorted)
//   chain      MK = HMAC(CK, 0x01), CK' = HMAC(CK, 0x02); handed to each peer sealed with the pair key
// Live messages use our chain; private ones the pair key.

import Foundation
import M5Core
import Synchronization

public final class SenderKeys: Sendable {
    public static let maxSkip = 1000
    public static let rotateMessages = 500
    public static let rotateMs: Int64 = 60 * 60 * 1000

    private static func mac(_ key: Bytes, _ b: UInt8) -> Bytes { Crypto.hmac256(key, [b]) }

    struct Own: Sendable {
        let keyId: String
        var chain: Bytes
        var index = 0
        let createdAt: Int64

        init(now: Int64) {
            keyId = Crypto.b64url(Crypto.random(12))
            chain = Crypto.random(32)
            createdAt = now
        }

        mutating func next() -> Bytes {
            let key = SenderKeys.mac(chain, 0x01)
            chain = SenderKeys.mac(chain, 0x02)
            index += 1
            return key
        }

        var wire: JSONObject { JSONObject([("keyId", .string(keyId)), ("chain", .string(Crypto.b64(chain))), ("index", .int(index))]) }

        func due(_ now: Int64) -> Bool { index >= SenderKeys.rotateMessages || now - createdAt >= SenderKeys.rotateMs }
    }

    struct PeerChain: Sendable {
        let keyId: String
        let owner: String
        var chain: Bytes
        var index: Int
        var skipped = OrderedMap<Int, Bytes>()

        mutating func keyFor(_ n: Int) -> Bytes? {
            if let kept = skipped.remove(n) { return kept }
            if n < index || n - index > SenderKeys.maxSkip { return nil }
            while index < n {
                skipped[index] = SenderKeys.mac(chain, 0x01)
                advance()
                if skipped.count > SenderKeys.maxSkip, let first = skipped.first { skipped.remove(first.key) }
            }
            let key = SenderKeys.mac(chain, 0x01)
            advance()
            return key
        }

        mutating func advance() {
            chain = SenderKeys.mac(chain, 0x02)
            index += 1
        }
    }

    public struct Pair: Sendable {
        public let key: Bytes
        public let peerPublicKey: String
    }

    private struct State: Sendable {
        var own: Own?
        var chains = OrderedMap<String, PeerChain>()
        var pairs = [String: Pair]()
        var sentTo = Set<String>()
    }

    private let state = Mutex(State())
    private let clock: any Clock

    public init(clock: (any Clock)? = nil) { self.clock = clock ?? SystemClock() }

    private static func helloContext(_ room: String, _ from: String, _ to: String, _ check: String, _ dh: String) -> Bytes {
        Crypto.utf8("m5cet/hello/1|" + room + "|" + from + "|" + to + "|" + check + "|" + dh)
    }

    /* ---------------------------------------------------------------- hello */

    public func hello(_ keys: RoomKeys, _ id: ChatIdentity, from: String, to: String, user: JSON? = nil) throws -> JSONObject {
        var h = JSONObject([("kind", "hello"), ("v", 3), ("check", .string(keys.check)), ("pk", .string(id.publicKey)), ("dh", .string(id.dhPublicKey)),
                            ("sig", .string(try id.sign(SenderKeys.helloContext(keys.room, from, to, keys.check, id.dhPublicKey)))), ("caps", .array([]))])
        if let user { h["user"] = user }
        return h
    }

    /// nil when accepted; "key-mismatch" or "bad-signature" otherwise.
    public func acceptHello(_ keys: RoomKeys, _ id: ChatIdentity, _ hello: JSONObject, from: String, to: String) -> String? {
        let check = hello.optString("check")
        if keys.check != check { return "key-mismatch" }
        let pk = hello.optString("pk"), dh = hello.optString("dh")
        if !Ec.verify(pk, SenderKeys.helloContext(keys.room, from, to, check, dh), hello.string("sig")) { return "bad-signature" }
        guard let secret = try? id.sharedSecret(dh) else { return "bad-signature" }
        let a = id.publicKey, b = pk
        let info = "m5cet/pair/1|" + (Ordinal.compare(a, b) <= 0 ? a + "|" + b : b + "|" + a)
        let key = Crypto.hkdf(secret, Crypto.utf8(keys.room), Crypto.utf8(info), 32)
        state.withLock { s in
            s.pairs[from] = Pair(key: key, peerPublicKey: pk)
            s.sentTo.remove(from)
        }
        return nil
    }

    public func hasPair(_ peerId: String) -> Bool { state.withLock { $0.pairs[peerId] != nil } }
    public func pairOf(_ peerId: String) -> Pair? { state.withLock { $0.pairs[peerId] } }

    /* --------------------------------------------------------- distribution */

    private func ensureOwn(_ s: inout State) -> Own {
        let now = clock.now()
        if let own = s.own, !own.due(now) { return own }
        let own = Own(now: now)
        s.own = own
        s.sentTo.removeAll()
        return own
    }

    public func rotate() {
        state.withLock { s in
            s.own = Own(now: clock.now())
            s.sentTo.removeAll()
        }
    }

    /// Our chain for `to`, sealed with the pair key; nil without a pair.
    public func senderKeyFor(_ keys: RoomKeys, from: String, to: String) throws -> JSONObject? {
        try state.withLock { s in
            guard let pair = s.pairs[to] else { return nil }
            let own = ensureOwn(&s)
            let iv = Crypto.random(12)
            let ct = try Crypto.gcmSeal(pair.key, iv, Crypto.utf8(own.wire.stringify()), Envelopes.context("sender-key", keys.room, from, to))
            s.sentTo.insert(to)
            return JSONObject([("kind", "sender-key"), ("v", 3), ("iv", .string(Crypto.b64(iv))), ("ct", .string(Crypto.b64(ct)))])
        }
    }

    public func acceptSenderKey(_ keys: RoomKeys, _ message: JSONObject, from: String, to: String) -> Bool {
        state.withLock { s in
            guard let pair = s.pairs[from],
                  let iv = try? Crypto.unb64(message.optString("iv")), let ct = try? Crypto.unb64(message.optString("ct")),
                  let plain = try? Crypto.gcmOpen(pair.key, iv, ct, Envelopes.context("sender-key", keys.room, from, to)),
                  let wire = JSON.parseObject(Crypto.str(plain)),
                  let keyId = wire.string("keyId"), let chainB64 = wire.string("chain"),
                  let idx = wire.int64("index"), let index = Int32(exactly: idx), let chain = try? Crypto.unb64(chainB64) else { return false }
            s.chains.remove(keyId)
            s.chains[keyId] = PeerChain(keyId: keyId, owner: from, chain: chain, index: Int(index))
            // Older chains of the same peer go, but one stays for messages in flight.
            let older = s.chains.orderedValues.filter { $0.owner == from && $0.keyId != keyId }
            if older.count > 1 { for c in older.dropLast() { s.chains.remove(c.keyId) } }
            return true
        }
    }

    public func hasOurKey(_ peerId: String) -> Bool { state.withLock { $0.own != nil && $0.sentTo.contains(peerId) } }

    public func forgetPeer(_ peerId: String) {
        state.withLock { s in
            s.pairs[peerId] = nil
            s.sentTo.remove(peerId)
            for c in s.chains.orderedValues where c.owner == peerId { s.chains.remove(c.keyId) }
            if let own = s.own, own.index > 0 { s.own = Own(now: clock.now()); s.sentTo.removeAll() }
        }
    }

    public func clear() { state.withLock { $0 = State() } }

    /* -------------------------------------------------------------- messages */

    public func sealLive(_ keys: RoomKeys, id: String, payload: JSONObject, identity: ChatIdentity?) throws -> JSONObject {
        let (keyId, index, key) = state.withLock { s -> (String, Int, Bytes) in
            var own = ensureOwn(&s)
            let index = own.index
            let key = own.next()
            s.own = own
            return (own.keyId, index, key)
        }
        let ctx = Envelopes.context("msg-sk", keys.room, id, keyId, index)
        let plain = try Envelopes.signBody(payload.stringify(), ctx, identity)
        let iv = Crypto.random(12)
        let ct = try Crypto.gcmSeal(key, iv, Crypto.utf8(plain), ctx)
        return JSONObject([("v", 3), ("id", .string(id)), ("sk", .string(keyId)), ("n", .int(index)), ("iv", .string(Crypto.b64(iv))), ("ciphertext", .string(Crypto.b64(ct)))])
    }

    public func openLive(_ keys: RoomKeys, _ envelope: JSONObject, from: String) throws -> Envelopes.Opened {
        guard let sk = envelope.string("sk"), let id = envelope.string("id"), let n64 = envelope.int64("n"), let n32 = Int32(exactly: n64) else {
            throw CryptoError("no sender key for this message")
        }
        let n = Int(n32)
        let key: Bytes = try state.withLock { s in
            guard var chain = s.chains[sk], chain.owner == from else { throw CryptoError("no sender key for this message") }
            guard let k = chain.keyFor(n) else { throw CryptoError("message key already used or too far ahead") }
            s.chains[sk] = chain
            return k
        }
        let ctx = Envelopes.context("msg-sk", keys.room, id, sk, n)
        let b = try Envelopes.readBody(try Envelopes.open(key, envelope.optString("iv"), envelope.optString("ciphertext"), ctx), ctx)
        let payload = try Envelopes.parse(b.body)
        if payload.string("id") != id { throw CryptoError("envelope id mismatch") }
        return Envelopes.Opened(payload: payload, version: 3, signer: b.signer)
    }

    public func sealPrivate(_ keys: RoomKeys, id: String, payload: JSONObject, from: String, to: String, identity: ChatIdentity?) throws -> JSONObject? {
        guard let pair = pairOf(to) else { return nil }
        let ctx = Envelopes.context("msg-pair", keys.room, id, from, to)
        let plain = try Envelopes.signBody(payload.stringify(), ctx, identity)
        let iv = Crypto.random(12)
        return JSONObject([("v", 3), ("id", .string(id)), ("sk", "pair"), ("iv", .string(Crypto.b64(iv))),
                           ("ciphertext", .string(Crypto.b64(try Crypto.gcmSeal(pair.key, iv, Crypto.utf8(plain), ctx))))])
    }

    public func openPrivate(_ keys: RoomKeys, _ envelope: JSONObject, from: String, to: String) throws -> Envelopes.Opened {
        guard let pair = pairOf(from), let id = envelope.string("id") else { throw CryptoError("no pair key with this peer") }
        let ctx = Envelopes.context("msg-pair", keys.room, id, from, to)
        let b = try Envelopes.readBody(try Envelopes.open(pair.key, envelope.optString("iv"), envelope.optString("ciphertext"), ctx), ctx)
        let payload = try Envelopes.parse(b.body)
        if payload.string("id") != id { throw CryptoError("envelope id mismatch") }
        if let signer = b.signer, signer.publicKey != pair.peerPublicKey { throw CryptoError("signed by another device than the pair") }
        return Envelopes.Opened(payload: payload, version: 3, signer: b.signer)
    }

    /// "sender-key", "pair" or "room".
    public static func kind(_ envelope: JSONObject) -> String {
        let v = Envelopes.optInt(envelope, "v", 0)
        if v == 3 && envelope.string("sk") == "pair" { return "pair" }
        if v == 3 && envelope.has("sk"), let n = envelope.int64("n"), Int32(exactly: n) != nil { return "sender-key" }
        return "room"
    }
}
