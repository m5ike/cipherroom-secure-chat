// Protocol 4 handshake (docs/protocol-v4.md §§ 2–4; handshake.ts; android
// p4/Handshake.java): the hello v4, the KEM message that answers it, and the
// key schedule that seeds the pair ratchet. Each side sends ONE hello per
// data-channel open — the protocol-3 fields and signature unchanged (a 6.11
// peer reads it as protocol 3), plus a fresh ephemeral P-256 key `e`, a fresh
// ML-KEM-768 key `k`, a nonce `n`, its mailbox bundle, its account
// attestation, its newest KT tree head and `sig4`. The session secret mixes
// ECDH(e, e') with BOTH KEM secrets under a transcript hash of everything both
// hellos and both KEM ciphertexts said.

import M5Core
import Synchronization

public enum Handshake {

    /// The private halves of one hello; memory only.
    public struct Secrets: Sendable {
        public let e: P256Pair
        public let k: Kem.KeyPair
    }

    public struct Built: Sendable {
        public let hello: JSONObject
        public let secrets: Secrets
    }

    /* ------------------------------------------------------------ digests */

    static func isNull(_ v: JSON?) -> Bool { v == nil || v == .null }

    static func str(_ o: JSONObject, _ field: String) throws -> String {
        guard let s = o.string(field) else { throw P4Error.malformed(field) }
        return s
    }

    /// § 2 mbDigest: b64(H(join(mb.id, mb.dh, b64(H(kem bytes)), mb.exp, mb.sig))), or "-".
    public static func mbDigest(_ mb: JSON?) throws -> String {
        if isNull(mb) { return "-" }
        guard let b = mb?.objectValue else { throw P4Error.malformed("mb") }
        return Prim.hB64(try Prim.join(try str(b, "id"), try str(b, "dh"), Prim.hB64(try Prim.unb64(b["kem"])), try Prim.count(b["exp"]), try str(b, "sig")))
    }

    /// § 2 accDigest: b64(H(join(acc.apk, acc.ac, acc.cv ?? 1, acc.exp ?? 0))), or "-".
    public static func accDigest(_ acc: JSON?) throws -> String {
        if isNull(acc) { return "-" }
        guard let a = acc?.objectValue else { throw P4Error.malformed("acc") }
        let cv: Int64 = a["cv"] == nil ? 1 : try Prim.count(a["cv"])
        let exp: Int64 = a["exp"] == nil ? 0 : try Prim.count(a["exp"])
        return Prim.hB64(try Prim.join(try str(a, "apk"), try str(a, "ac"), cv, exp))
    }

    /// § 2 capsDigest (6.12 review P02): b64(H(join(…caps sorted, duplicates removed))) — never "-".
    public static func capsDigest(_ caps: JSON?) throws -> String {
        if isNull(caps) { return Prim.hB64(try Prim.join([])) }
        guard let a = caps?.arrayValue else { throw P4Error.malformed("caps") }
        var set = Set<String>()
        for c in a {
            guard let s = c.stringValue else { throw P4Error.malformed("caps") }
            set.insert(s)
        }
        // Ordinal (UTF-16) order, as Java's TreeSet<String> and JavaScript's sort.
        let sorted = set.sorted(by: Ordinal.less)
        return Prim.hB64(try Prim.join(sorted.map { $0 as any JoinPart }))
    }

    /// § 2 userDigest (review P02): b64(H(UTF-8(user))), or "-" without one (absent, null or empty).
    public static func userDigest(_ user: JSON?) throws -> String {
        if isNull(user) || user?.stringValue == "" { return "-" }
        guard let s = user?.stringValue else { throw P4Error.malformed("user") }
        return Prim.hB64(Prim.utf8(s))
    }

    /// § 2 sthDigest (review P02): b64(H(join(sth.size, sth.root, sth.ts, sth.sig))), or "-".
    public static func sthDigest(_ sth: JSON?) throws -> String {
        if isNull(sth) { return "-" }
        guard let s = sth?.objectValue else { throw P4Error.malformed("sth") }
        return Prim.hB64(try Prim.join(try Prim.count(s["size"]), try str(s, "root"), try Prim.count(s["ts"]), try str(s, "sig")))
    }

    /// § 2: the bytes `sig4` signs. `from` is the hello's sender, `to` its recipient.
    public static func sig4Data(_ roomId: String, _ from: String, _ to: String, _ h: JSONObject) throws -> Bytes {
        let parts: [any JoinPart] = [P4.lHello, roomId, from, to, try str(h, "check"), try str(h, "pk"), try str(h, "dh"), try str(h, "e"),
                                     Prim.hB64(try Prim.unb64(h["k"])), try str(h, "n"), try mbDigest(h["mb"]), try accDigest(h["acc"]),
                                     try capsDigest(h["caps"]), try userDigest(h["user"]), try sthDigest(h["sth"])]
        return try Prim.join(parts)
    }

    /// § 3: r = b64(H(join(e, b64(H(k)), n))) — names the hello a KEM message answers.
    public static func helloRef(_ h: JSONObject) throws -> String {
        Prim.hB64(try Prim.join(try str(h, "e"), Prim.hB64(try Prim.unb64(h["k"])), try str(h, "n")))
    }

    /* -------------------------------------------------------------- hello */

    /// § 2: a hello v4 from the protocol-3 hello `v3` (check, pk, dh, sig, caps, user).
    /// Draws: "hello.e", "hello.k", "hello.n".
    public static func buildHello(roomId: String, from: String, to: String, v3: JSONObject, signer: any DeviceSigner,
                                  mb: JSON?, acc: JSON?, sth: JSON?, rng: any Rng) throws -> Built {
        if signer.publicKey != v3.optString("pk") { throw P4Error("state", "the signer is not the hello's device key") }
        let e = try rng.p256(.ecdh, "hello.e")
        let k = try Kem.keygen(rng, "hello.k")
        let n = Prim.b64(try rng.bytes(16, "hello.n"))
        var hello = v3
        var caps = v3.array("caps") ?? []
        if !caps.contains(.string(P4.cap)) { caps.append(.string(P4.cap)) }
        hello["kind"] = "hello"
        hello["v"] = 4
        hello["caps"] = .array(caps)
        hello["e"] = .string(e.spki)
        hello["k"] = .string(Prim.b64(k.ek))
        hello["n"] = .string(n)
        hello["mb"] = isNull(mb) ? .null : mb
        hello["acc"] = isNull(acc) ? .null : acc
        hello["sth"] = isNull(sth) ? .null : sth
        hello["sig4"] = .string(try signer.sign(try sig4Data(roomId, from, to, hello)))
        return Built(hello: hello, secrets: Secrets(e: e, k: k))
    }

    /// What `verifyHello` found.
    public struct Verdict: Sendable {
        /// True: a valid v4 hello. False: `why` is key-mismatch, not-v4, malformed or bad-sig4 (treat as protocol 3, § 1).
        public let ok: Bool
        public let why: String?
        public let hello: JSONObject?
        /// The peer's mailbox bundle when it is valid now; else nil (`mailboxProblem` says why).
        public let mailbox: Mailbox.Bundle?
        public let mailboxProblem: String?
        static func no(_ why: String) -> Verdict { Verdict(ok: false, why: why, hello: nil, mailbox: nil, mailboxProblem: nil) }
    }

    public static func isAccShape(_ a: JSON?) -> Bool {
        guard let acc = a?.objectValue, acc.string("apk") != nil, acc.string("ac") != nil else { return false }
        guard let cv = acc["cv"] else { return acc["exp"] == nil }
        return cv.doubleValue == 2 && Prim.isSafeCount(acc["exp"])
    }

    public static func isSthShape(_ s: JSON?) -> Bool {
        guard let sth = s?.objectValue else { return false }
        return Prim.isSafeCount(sth["size"]) && sth.string("root") != nil && Prim.isSafeCount(sth["ts"]) && sth.string("sig") != nil
    }

    /// § 2: checks a peer's hello. `from` is the PEER's id, `to` ours. The
    /// protocol-3 `sig` is checked by SenderKeys.acceptHello (over the readable
    /// room name); a hello is protocol 4 only when both hold.
    public static func verifyHello(_ raw: JSON?, roomId: String, from: String, to: String, check: String, now: Int64) -> Verdict {
        guard let h = raw?.objectValue, h.string("kind") == "hello" else { return .no("malformed") }
        if h.string("check") != check { return .no("key-mismatch") }
        guard let v = h["v"]?.doubleValue, v == 4 else { return .no("not-v4") }
        do {
            for f in ["pk", "dh", "sig", "sig4"] where h.string(f) == nil { throw P4Error.malformed(f) }
            if h.array("caps") == nil { throw P4Error.malformed("caps") }
            if let user = h["user"], user != .null, user.stringValue == nil { throw P4Error.malformed("user") }
            _ = try Prim.p256Public(h["e"])
            _ = try Prim.unb64(h["k"], length: P4.kemEk)
            _ = try Prim.unb64(h["n"], length: 16)
            let mb = h["mb"], acc = h["acc"], sth = h["sth"]
            if mb != .null && Mailbox.Bundle.parse(mb) == nil { throw P4Error.malformed("mb") }
            if acc != .null && !isAccShape(acc) { throw P4Error.malformed("acc") }
            if sth != .null && !isSthShape(sth) { throw P4Error.malformed("sth") }
            if !Prim.ecdsaVerify(h.string("pk"), try sig4Data(roomId, from, to, h), h.string("sig4")) { return .no("bad-sig4") }
        } catch {
            return .no("malformed")
        }
        let mb = h["mb"]
        if mb == .null { return Verdict(ok: true, why: nil, hello: h, mailbox: nil, mailboxProblem: nil) }
        if let problem = Mailbox.check(mb, h.optString("pk"), now) { return Verdict(ok: true, why: nil, hello: h, mailbox: nil, mailboxProblem: problem) }
        return Verdict(ok: true, why: nil, hello: h, mailbox: Mailbox.Bundle.parse(mb), mailboxProblem: nil)
    }

    /// § 12.3: what an account attestation says about device key `pk`.
    public struct AccountCheck: Sendable, Equatable {
        public let publicKey: String
        public let valid: Bool
        public let v: Int
        public let exp: Int64
    }

    /// v1 device certificates (protocol 3, identity.ts): Ed25519 over "m5cet/device-cert/1|" + device SPKI.
    public static func verifyDeviceCertV1(_ accountKey: String?, _ cert: String?, _ devicePk: String) -> Bool {
        Prim.ed25519Verify(accountKey, Prim.utf8("m5cet/device-cert/1|" + devicePk), cert)
    }

    /// § 12.3: does the account `acc.apk` vouch for device key `pk`? v2 (`cv: 2`):
    /// Ed25519 over join(LABEL.deviceCert, pk, exp), and exp > now. v1 (no `cv`):
    /// the protocol-3 certificate, valid without expiry. Nil without `acc`.
    public static func verifyAccount(_ acc: JSON?, pk: String, now: Int64) -> AccountCheck? {
        if isNull(acc) { return nil }
        guard isAccShape(acc), let a = acc?.objectValue else {
            return AccountCheck(publicKey: acc?.objectValue?.optString("apk") ?? "", valid: false, v: 1, exp: 0)
        }
        if a["cv"] != nil {
            let exp = a.optInt64("exp")
            var valid = exp > now
            if valid {
                if let data = try? Prim.join(P4.lDeviceCert, pk, exp) { valid = Prim.ed25519Verify(a.string("apk"), data, a.string("ac")) } else { valid = false }
            }
            return AccountCheck(publicKey: a.optString("apk"), valid: valid, v: 2, exp: exp)
        }
        return AccountCheck(publicKey: a.optString("apk"), valid: verifyDeviceCertV1(a.string("apk"), a.string("ac"), pk), v: 1, exp: 0)
    }

    /// § 12.3: a v2 device certificate {v: 2, exp, sig} — the account key (its 32-byte Ed25519 seed) signs.
    public static func certifyDeviceV2(accountSeed: Bytes, devicePk: String, exp: Int64, now: Int64) throws -> JSONObject {
        if exp < 0 || exp > now + P4.deviceCertLifetimeMs { throw P4Error.malformed("certificate lifetime too long") }
        let sig = try Prim.ed25519Sign(accountSeed, try Prim.join(P4.lDeviceCert, devicePk, exp))
        return JSONObject([("v", 2), ("exp", .int(exp)), ("sig", .string(Prim.b64(sig)))])
    }

    /// A v1 device certificate (identity.ts certifyDevice): Ed25519 over "m5cet/device-cert/1|" + device SPKI, b64.
    public static func certifyDeviceV1(accountSeed: Bytes, devicePk: String) throws -> String {
        Prim.b64(try Prim.ed25519Sign(accountSeed, Prim.utf8("m5cet/device-cert/1|" + devicePk)))
    }

    /* -------------------------------------------------------- KEM message */

    public struct KemSent: Sendable {
        public let message: JSONObject
        public let ct: Bytes
        public let ss: Bytes
    }

    /// § 3: the KEM message answering a peer's (accepted) hello. Draw: "hello.kem-m".
    public static func buildKemMessage(_ peerHello: JSONObject, _ rng: any Rng) throws -> KemSent {
        let k = try Kem.encaps(try Prim.unb64(peerHello["k"], length: P4.kemEk), rng, "hello.kem-m")
        let message = JSONObject([("kind", "p4-kem"), ("v", 4), ("ct", .string(Prim.b64(k.ct))), ("r", .string(try helloRef(peerHello)))])
        return KemSent(message: message, ct: k.ct, ss: k.ss)
    }

    /// § 3: a KEM message for our hello → (ct, ss); nil when it answers another
    /// hello (ignore it). A malformed one throws (`malformed` / `kct`).
    public static func openKemMessage(_ raw: JSON?, ownHello: JSONObject, own: Secrets) throws -> (ct: Bytes, ss: Bytes)? {
        guard let m = raw?.objectValue, m.string("kind") == "p4-kem", m["v"]?.doubleValue == 4, let r = m.string("r"), m.string("ct") != nil else {
            throw P4Error.malformed("not a KEM message")
        }
        if r != (try helloRef(ownHello)) { return nil }
        let ct: Bytes
        do { ct = try Prim.unb64(m["ct"], length: P4.kemCt) } catch { throw P4Error("kct", "KEM ciphertext cannot be decapsulated") }
        return (ct, try Kem.decaps(ct, own.k.dk))
    }

    /* ------------------------------------------------------- key schedule */

    /// One side's contribution to the transcript.
    public struct Party: Sendable {
        let pk: String, peerId: String, e: String, k: String, n: String
        static func of(_ hello: JSONObject, _ peerId: String) -> Party {
            Party(pk: hello.optString("pk"), peerId: peerId, e: hello.optString("e"), k: hello.optString("k"), n: hello.optString("n"))
        }
    }

    /// § 4: the side whose pk + "|" + peerId is smaller (ordinal) is A.
    public static func roleOf(selfPk: String, selfPeerId: String, peerPk: String, peerPeerId: String) throws -> String {
        let a = selfPk + "|" + selfPeerId, b = peerPk + "|" + peerPeerId
        if Ordinal.compare(a, b) == 0 { throw P4Error("state", "both sides are the same device") }
        return Ordinal.less(a, b) ? "A" : "B"
    }

    /// § 4 TH.
    public static func transcriptHash(roomId: String, check: String, A: Party, B: Party, ctA: Bytes, ctB: Bytes) throws -> Bytes {
        Prim.H(try Prim.join(P4.lTranscript, roomId, check,
                             A.pk, A.e, Prim.hB64(try Prim.unb64(A.k)), A.n,
                             B.pk, B.e, Prim.hB64(try Prim.unb64(B.k)), B.n,
                             Prim.hB64(ctA), Prim.hB64(ctB)))
    }

    /// § 4: okm = HKDF(TH, dh0 ‖ ssA ‖ ssB, LABEL.root, 96) → (RK0, CK_B0, SID).
    public static func rootSchedule(th: Bytes, dh0: Bytes, ssA: Bytes, ssB: Bytes) -> (rk0: Bytes, ckB0: Bytes, sid: Bytes) {
        let okm = Prim.hkdf(th, dh0 + ssA + ssB, P4.lRoot, 96)
        return (Array(okm[0..<32]), Array(okm[32..<64]), Array(okm[64..<96]))
    }

    /// A pair session (§ 4): the role, TH, the export secret SID and the ratchet.
    public struct Session: Sendable {
        public let role: String
        public let th: Bytes
        public let sid: Bytes
        public let ratchet: Ratchet
        public func wipe() { ratchet.wipe() }
    }

    /// § 4: the session — TH, SID and the initial ratchet for our role. `sent`
    /// is our KEM message (ct, ss), `received` the peer's (ct, ss).
    public static func establish(roomId: String, check: String, selfPeerId: String, selfHello: JSONObject, selfSecrets: Secrets,
                                 peerPeerId: String, peerHello: JSONObject, sent: (ct: Bytes, ss: Bytes), received: (ct: Bytes, ss: Bytes),
                                 rng: (any Rng)?) throws -> Session {
        let me = Party.of(selfHello, selfPeerId), peer = Party.of(peerHello, peerPeerId)
        let role = try roleOf(selfPk: me.pk, selfPeerId: me.peerId, peerPk: peer.pk, peerPeerId: peer.peerId)
        let a = role == "A"
        let ofA = a ? sent : received, ofB = a ? received : sent
        let th = try transcriptHash(roomId: roomId, check: check, A: a ? me : peer, B: a ? peer : me, ctA: ofA.ct, ctB: ofB.ct)
        let dh0 = try Prim.ecdh(selfSecrets.e, peerHello.string("e"))
        let root = rootSchedule(th: th, dh0: dh0, ssA: ofA.ss, ssB: ofB.ss)
        let r = try Ratchet.create(role: role, roomId: roomId, selfPeerId: selfPeerId, peerPeerId: peerPeerId, th: th, rk0: root.rk0, ckB0: root.ckB0,
                                   peerE: peerHello.optString("e"), ownE: selfSecrets.e, rng: rng)
        return Session(role: role, th: th, sid: root.sid, ratchet: r)
    }
}

/* ------------------------------------------------- the whole exchange */

/// One data channel's handshake (handshake.ts PairHandshake; android
/// Handshake.Pair): `hello` to send; acceptHello(peer's) → the verdict and the
/// KEM message to send (`kem`); acceptKem(peer's); then, once ready(),
/// establish() → the session. wipe() when the channel closes first.
public final class PairHandshake: Sendable {
    public let roomId: String, check: String, selfPeerId: String, peerPeerId: String
    public let hello: JSONObject
    private let secrets: Handshake.Secrets
    private let rng: any Rng

    private struct State: Sendable {
        var peer: JSONObject?
        var sent: (ct: Bytes, ss: Bytes)?
        var received: (ct: Bytes, ss: Bytes)?
        var kem: JSONObject?
        var done = false
    }
    private let state = Mutex(State())

    private init(roomId: String, check: String, selfPeerId: String, peerPeerId: String, built: Handshake.Built, rng: any Rng) {
        self.roomId = roomId; self.check = check; self.selfPeerId = selfPeerId; self.peerPeerId = peerPeerId
        self.hello = built.hello; self.secrets = built.secrets; self.rng = rng
    }

    public static func start(roomId: String, check: String, selfPeerId: String, peerPeerId: String, v3: JSONObject, signer: any DeviceSigner,
                             mb: JSON?, acc: JSON?, sth: JSON?, rng: (any Rng)? = nil) throws -> PairHandshake {
        let r = rng ?? SystemRng()
        let built = try Handshake.buildHello(roomId: roomId, from: selfPeerId, to: peerPeerId, v3: v3, signer: signer, mb: mb, acc: acc, sth: sth, rng: r)
        return PairHandshake(roomId: roomId, check: check, selfPeerId: selfPeerId, peerPeerId: peerPeerId, built: built, rng: r)
    }

    /// Checks the peer's hello; when it is a valid v4 hello, the KEM message to
    /// send is `kem`. Idempotent: the SAME hello again (its e, k, n) gets the
    /// same KEM message — a second encapsulation would leave the sides with
    /// different secrets if the peer used the first.
    public func acceptHello(_ raw: JSON?, now: Int64) throws -> Handshake.Verdict {
        try state.withLock { s in
            if s.done { throw P4Error("state", "handshake finished") }
            let verdict = Handshake.verifyHello(raw, roomId: roomId, from: peerPeerId, to: selfPeerId, check: check, now: now)
            guard verdict.ok, let h = verdict.hello else { return verdict }
            if let peer = s.peer, s.sent != nil, s.kem != nil, h.optString("e") == peer.optString("e"),
               h.optString("k") == peer.optString("k"), h.optString("n") == peer.optString("n") {
                return verdict
            }
            s.peer = h
            let built = try Handshake.buildKemMessage(h, rng)
            s.sent = (built.ct, built.ss)
            s.kem = built.message
            return verdict
        }
    }

    /// The KEM message to send after the last accepted hello (nil before one).
    public var kem: JSONObject? { state.withLock { $0.kem } }

    /// The peer's KEM message: false when it answers another hello of ours (ignored).
    public func acceptKem(_ raw: JSON?) throws -> Bool {
        try state.withLock { s in
            if s.done { throw P4Error("state", "handshake finished") }
            guard let opened = try Handshake.openKemMessage(raw, ownHello: hello, own: secrets) else { return false }
            s.received = opened
            return true
        }
    }

    public var ready: Bool { state.withLock { !$0.done && $0.peer != nil && $0.sent != nil && $0.received != nil } }

    /// The peer's hello once accepted.
    public var peerHello: JSONObject? { state.withLock { $0.peer } }

    public func establish() throws -> Handshake.Session {
        try state.withLock { s in
            guard !s.done, let peer = s.peer, let sent = s.sent, let received = s.received else { throw P4Error("state", "handshake not complete") }
            s.done = true
            return try Handshake.establish(roomId: roomId, check: check, selfPeerId: selfPeerId, selfHello: hello, selfSecrets: secrets,
                                           peerPeerId: peerPeerId, peerHello: peer, sent: sent, received: received, rng: rng)
        }
    }

    public func wipe() {
        state.withLock { s in
            s.done = true
            s.sent = nil
            s.received = nil
        }
    }
}
