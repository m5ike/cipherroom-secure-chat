// The pair ratchet of protocol 4 (docs/protocol-v4.md § 5; ratchet.ts; android
// p4/Ratchet.java): a Double Ratchet (P-256 DH steps + HMAC chains) whose DH
// steps also run an ML-KEM-768 step carried in the headers.
//
//   KDF_RK(rk, dhOut, kss) = HKDF(salt = rk, ikm = dhOut ‖ kss, "m5cet/p4/rk", 64)
//   KDF_CK(ck)             = (mk = HMAC(ck, 0x01), ck' = HMAC(ck, 0x02))
//
// Copy-on-write: a frame is processed on a copy of the state (a value), which
// becomes the state only after the AEAD check passed. Failures are returned
// (`Result`), with `reset` on the second failure of the session or a KEM
// ciphertext that cannot be decapsulated (§ 5.5). One operation at a time (a
// Mutex, as Java's synchronized). Sessions live in memory only.

import M5Core
import Synchronization

public final class Ratchet: Sendable {

    /* --------------------------------------------------------------- KDFs */

    /// § 5.1 KDF_RK; `kss` is the KEM shared secret or nil (0 bytes).
    public static func kdfRk(_ rk: Bytes, _ dhOut: Bytes, _ kss: Bytes?) -> (rk: Bytes, ck: Bytes) {
        let okm = Prim.hkdf(rk, dhOut + (kss ?? []), P4.lRatchet, 64)
        return (Array(okm[0..<32]), Array(okm[32..<64]))
    }

    /// § 5.1 KDF_CK → (mk, ck').
    public static func kdfCk(_ ck: Bytes) -> (mk: Bytes, next: Bytes) {
        (Prim.hmac(ck, [0x01]), Prim.hmac(ck, [0x02]))
    }

    /// § 5.2 AAD = join(LABEL.pairAad, roomId, from, to, b64(TH), Hs) — Hs spliced in as its six parts.
    public static func pairAad(_ roomId: String, _ from: String, _ to: String, _ th: Bytes, _ h: JSONObject) throws -> Bytes {
        guard let dh = h.string("dh") else { throw P4Error.malformed("transcript part is not a string or an integer") }
        let kid: String = h["kid"].map { $0.stringValue ?? "\u{7f}" } ?? "-"
        let kct = try h["kct"].map { Prim.hB64(try Prim.unb64($0)) } ?? "-"
        let kek = try h["kek"].map { Prim.hB64(try Prim.unb64($0)) } ?? "-"
        return try Prim.join(P4.lPairAad, roomId, from, to, Prim.b64(th), dh, try Prim.count(h["pn"]), try Prim.count(h["n"]), kid, kct, kek)
    }

    /* -------------------------------------------------------------- state */

    struct KemKeys: Sendable {
        let ek: Bytes, dk: Bytes
        let ekB64: String, kid: String
        init(_ ek: Bytes, _ dk: Bytes) { self.ek = ek; self.dk = dk; ekB64 = Prim.b64(ek); kid = Kem.kid(ek) }
    }

    struct Skipped: Sendable {
        let chain: String
        let mk: Bytes
    }

    struct State: Sendable {
        var rk: Bytes = []
        var dhs: P256Pair
        var dhr: String?
        var cks: Bytes = []
        var ckr: Bytes?
        var ns: Int64 = 0, nr: Int64 = 0, pn: Int64 = 0
        /// Own KEM key pairs, oldest first; the last is the current one (announced as kek). At most 3.
        var myKem: [KemKeys] = []
        var peerKem: String?
        var usedPeerKem: String?
        /// kid / kct of the step that started the current sending chain, sent with its n = 0.
        var pendingKct: (kid: String, kct: String)?
        var skipped = OrderedMap<String, Skipped>()
        var perChain: [String: Int] = [:]
    }

    private struct Inner: Sendable {
        var state: State
        var failures = 0
        var sinceFailure = 0
        var wiped = false
    }

    static let keepKems = 3

    /// Review P13: after this many frames that opened since the last failure, the failure count starts again from 0.
    public static let failureDecayFrames = 32

    /// decrypt's answer: the inner message, or why not and whether to reset (§ 5.5).
    public struct Result: Sendable {
        public let ok: Bool
        public let inner: JSONObject?
        public let error: String?
        public let reset: Bool
        public let message: String?
    }

    public let role: String
    private let roomId: String, selfPeerId: String, peerPeerId: String
    private let th: Bytes
    private let rng: any Rng
    private let m: Mutex<Inner>

    private init(_ state: State, role: String, roomId: String, selfPeerId: String, peerPeerId: String, th: Bytes, rng: any Rng) {
        self.role = role; self.roomId = roomId; self.selfPeerId = selfPeerId; self.peerPeerId = peerPeerId
        self.th = th; self.rng = rng
        m = Mutex(Inner(state: state))
    }

    /// § 4: the initial state for role A or B. Draws (A): "init.dhs", "init.kem-seed"; (B): "init.kem-seed".
    public static func create(role: String, roomId: String, selfPeerId: String, peerPeerId: String, th: Bytes, rk0: Bytes, ckB0: Bytes,
                              peerE: String, ownE: P256Pair?, rng: (any Rng)? = nil) throws -> Ratchet {
        let r = rng ?? SystemRng()
        if rk0.count != 32 || ckB0.count != 32 { throw P4Error.malformed("root and chain keys are 32 bytes") }
        var s: State
        if role == "A" {
            let dhs = try r.p256(.ecdh, "init.dhs")
            s = State(dhs: dhs)
            s.myKem.append(try newKem(r, "init.kem-seed"))
            let dhOut = try Prim.ecdh(dhs, peerE)
            let out = kdfRk(rk0, dhOut, nil)
            s.rk = out.rk; s.cks = out.ck; s.dhr = peerE; s.ckr = ckB0
        } else {
            guard let own = ownE else { throw P4Error("state", "role B needs its hello key pair") }
            s = State(dhs: own)
            s.myKem.append(try newKem(r, "init.kem-seed"))
            s.rk = rk0; s.dhr = nil; s.cks = ckB0; s.ckr = nil
        }
        return Ratchet(s, role: role, roomId: roomId, selfPeerId: selfPeerId, peerPeerId: peerPeerId, th: th, rng: r)
    }

    private static func newKem(_ rng: any Rng, _ what: String) throws -> KemKeys {
        let k = try Kem.keygen(rng, what)
        return KemKeys(k.ek, k.dk)
    }

    /// Counters and public keys (no secrets), for tests and the security info.
    public var info: String {
        m.withLock { i in
            let s = i.state
            return "role=\(role) ns=\(s.ns) nr=\(s.nr) pn=\(s.pn) skipped=\(s.skipped.count) kems=\(s.myKem.count) peerKem=\(s.peerKem != nil) failures=\(i.failures) wiped=\(i.wiped)"
        }
    }

    public var isWiped: Bool { m.withLock { $0.wiped } }
    public var skippedCount: Int { m.withLock { $0.state.skipped.count } }

    /* ---------------------------------------------------------- sending */

    /// § 5.2: seals one inner message given as its JSON text (an object with a string `t`; its UTF-8 is padded and sealed as is).
    public func encrypt(_ innerJson: String) throws -> JSONObject {
        try m.withLock { i in
            if i.wiped { throw P4Error("state", "session wiped") }
            let inner = try Mailbox.object(innerJson)
            guard inner.string("t") != nil else { throw P4Error.malformed("inner message needs a type t") }
            var s = i.state
            var h = JSONObject()
            h["dh"] = .string(s.dhs.spki)
            h["pn"] = .int(s.pn)
            h["n"] = .int(s.ns)
            if s.ns == 0 {
                if let p = s.pendingKct { h["kid"] = .string(p.kid); h["kct"] = .string(p.kct) }
                h["kek"] = .string(s.myKem[s.myKem.count - 1].ekB64)
            }
            let step = Ratchet.kdfCk(s.cks)
            let aad = try Ratchet.pairAad(roomId, selfPeerId, peerPeerId, th, h)
            let k = Prim.keyIv(step.mk, P4.lPairKey)
            let c = try Prim.aesGcmSeal(k.key, k.iv, aad, Pad.pad(Prim.utf8(innerJson)))
            s.cks = step.next
            let n = s.ns
            s.ns += 1
            if n == 0 { s.pendingKct = nil }
            i.state = s
            return JSONObject([("kind", "p4"), ("v", 4), ("h", .object(h)), ("c", .string(Prim.b64(c)))])
        }
    }

    public func encrypt(_ inner: JSONObject) throws -> JSONObject { try encrypt(inner.stringify()) }

    /* -------------------------------------------------------- receiving */

    /// § 5.4: opens one frame. Never throws; a failure says whether to reset (§ 5.5).
    public func decrypt(_ frame: JSON) -> Result {
        m.withLock { i in
            if i.wiped { return Result(ok: false, inner: nil, error: "state", reset: true, message: "session wiped") }
            do {
                let inner = try open(&i, frame)
                if i.failures > 0 {
                    i.sinceFailure += 1
                    if i.sinceFailure >= Ratchet.failureDecayFrames { i.failures = 0; i.sinceFailure = 0 }
                }
                return Result(ok: true, inner: inner, error: nil, reset: false, message: nil)
            } catch let e as P4Error {
                i.failures += 1
                i.sinceFailure = 0
                return Result(ok: false, inner: nil, error: e.code, reset: e.code == "kct" || i.failures >= 2, message: e.message)
            } catch {
                i.failures += 1
                i.sinceFailure = 0
                return Result(ok: false, inner: nil, error: "malformed", reset: i.failures >= 2, message: "\(error)")
            }
        }
    }

    public func decrypt(_ frame: JSONObject) -> Result { decrypt(.object(frame)) }

    private struct Parsed {
        var h = JSONObject()
        var ct: Bytes = []
        var kct: Bytes?
    }

    private static let kidChars: Set<UInt8> = Set(Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-".utf8))

    private func parse(_ frame: JSON) throws -> Parsed {
        guard let f = frame.objectValue, f.string("kind") == "p4", let v = f["v"]?.doubleValue, v == 4, let raw = f.object("h") else {
            throw P4Error.malformed("not a p4 frame")
        }
        guard raw.string("dh") != nil, Prim.isSafeCount(raw["pn"]), Prim.isSafeCount(raw["n"]) else { throw P4Error.malformed("bad header") }
        var p = Parsed()
        p.h["dh"] = raw["dh"]
        p.h["pn"] = .int(try Prim.count(raw["pn"]))
        p.h["n"] = .int(try Prim.count(raw["n"]))
        _ = try Prim.unb64(raw.string("dh"))
        if (raw["kid"] == nil) != (raw["kct"] == nil) { throw P4Error.malformed("kid and kct go together") }
        if let kid = raw["kid"] {
            guard let k = kid.stringValue, k.utf8.count == 16, k.utf8.allSatisfy({ Ratchet.kidChars.contains($0) }) else { throw P4Error.malformed("bad kid") }
            do { p.kct = try Prim.unb64(raw["kct"], length: P4.kemCt) } catch { throw P4Error("kct", "KEM ciphertext cannot be decapsulated") }
            p.h["kid"] = kid
            p.h["kct"] = raw["kct"]
        }
        if let kek = raw["kek"] {
            _ = try Prim.unb64(kek, length: P4.kemEk)
            p.h["kek"] = kek
        }
        p.ct = try Prim.unb64(f["c"])
        if p.ct.count < 16 { throw P4Error.malformed("ciphertext too short") }
        return p
    }

    private func open(_ i: inout Inner, _ frame: JSON) throws -> JSONObject {
        let p = try parse(frame)
        let h = p.h
        let dh = h.optString("dh")
        let hn = h.int64("n") ?? 0, hpn = h.int64("pn") ?? 0
        let aad = try Ratchet.pairAad(roomId, peerPeerId, selfPeerId, th, h)
        let old = i.state

        // 1. A stored skipped key: use it, delete it. (A kek here is ignored: § 5.4.)
        let slot = dh + "|" + String(hn)
        if let kept = old.skipped[slot] {
            let plain = try Ratchet.openWith(kept.mk, aad, p.ct)
            var next = old
            Ratchet.dropSkipped(&next, slot)
            i.state = next
            return try Ratchet.parseInner(plain)
        }

        var w = old
        let kek = h.string("kek")
        if dh != w.dhr {
            // 2. A new chain from the peer.
            try Ratchet.skipTo(&w, hpn)                                          // 2.1
            var kss: Bytes?
            if let kct = p.kct {                                                 // 2.2
                guard let mine = w.myKem.last(where: { $0.kid == h.optString("kid") }) else {
                    throw P4Error("kct", "KEM ciphertext for an unknown key")
                }
                kss = try Kem.decaps(kct, mine.dk)
            }
            let dhOut = try Prim.ecdh(w.dhs, dh)                                  // 2.3
            let r = Ratchet.kdfRk(w.rk, dhOut, kss)
            w.rk = r.rk; w.ckr = r.ck; w.pn = w.ns; w.ns = 0; w.nr = 0; w.dhr = dh
            if let kek { Ratchet.takeKek(&w, kek) }                               // 3 (before 2.4)
            try sendingStep(&w)                                                   // 2.4
        } else if let kek {
            Ratchet.takeKek(&w, kek)                                              // 3
        }
        guard let ckr = w.ckr else { throw P4Error.malformed("no receiving chain") }
        if hn < w.nr { throw P4Error("replay", "message key already used") }
        _ = ckr
        try Ratchet.skipTo(&w, hn)                                                // 4
        let step = Ratchet.kdfCk(w.ckr!)
        w.ckr = step.next
        w.nr += 1
        let plain = try Ratchet.openWith(step.mk, aad, p.ct)
        i.state = w
        return try Ratchet.parseInner(plain)
    }

    /// § 5.3 sending ratchet step. Draws: "ratchet.dhs", ["ratchet.kem-m" when encapsulating], "ratchet.kem-seed".
    private func sendingStep(_ w: inout State) throws {
        w.dhs = try rng.p256(.ecdh, "ratchet.dhs")
        var kss: Bytes?
        w.pendingKct = nil
        if let peerKem = w.peerKem {
            let ek = try Prim.unb64(peerKem, length: P4.kemEk)
            let k = try Kem.encaps(ek, rng, "ratchet.kem-m")
            kss = k.ss
            w.pendingKct = (Kem.kid(ek), Prim.b64(k.ct))
            w.usedPeerKem = peerKem
            w.peerKem = nil
        }
        let mine = try Ratchet.newKem(rng, "ratchet.kem-seed")
        var kems = w.myKem
        kems.append(mine)
        while kems.count > Ratchet.keepKems { kems.removeFirst() }
        w.myKem = kems
        let dhOut = try Prim.ecdh(w.dhs, w.dhr)
        let r = Ratchet.kdfRk(w.rk, dhOut, kss)
        w.rk = r.rk
        w.cks = r.ck
    }

    /// Forgets every secret of the session.
    public func wipe() {
        m.withLock { i in
            if i.wiped { return }
            i.wiped = true
            ByteOps.wipe(&i.state.rk)
            ByteOps.wipe(&i.state.cks)
            i.state.ckr = nil
            i.state.myKem.removeAll()
            i.state.skipped.removeAll()
            i.state.perChain.removeAll()
        }
    }

    /* ------------------------------------------------------------ helpers */

    private static func openWith(_ mk: Bytes, _ aad: Bytes, _ ct: Bytes) throws -> Bytes {
        let k = Prim.keyIv(mk, P4.lPairKey)
        return try Prim.aesGcmOpen(k.key, k.iv, aad, ct)
    }

    private static func takeKek(_ w: inout State, _ kek: String) {
        if kek != w.usedPeerKem { w.peerKem = kek }
    }

    /// Stores the keys of the current receiving chain from Nr up to (not including) `until`.
    private static func skipTo(_ w: inout State, _ until: Int64) throws {
        guard var ckr = w.ckr, let dhr = w.dhr, until > w.nr else { return }
        if until - w.nr > Int64(P4.maxSkip) { throw P4Error("skip", "too many skipped messages") }
        while w.nr < until {
            let step = kdfCk(ckr)
            storeSkipped(&w, dhr, w.nr, step.mk)
            ckr = step.next
            w.ckr = ckr
            w.nr += 1
        }
    }

    private static func storeSkipped(_ w: inout State, _ chain: String, _ n: Int64, _ mk: Bytes) {
        let count = w.perChain[chain] ?? 0
        if count >= P4.maxSkip, let first = w.skipped.entries.first(where: { $0.value.chain == chain }) {
            dropSkipped(&w, first.key)
        }
        w.skipped[chain + "|" + String(n)] = Skipped(chain: chain, mk: mk)
        w.perChain[chain] = (w.perChain[chain] ?? 0) + 1
        while w.skipped.count > P4.maxSkippedTotal, let first = w.skipped.first {
            dropSkipped(&w, first.key)
        }
    }

    private static func dropSkipped(_ w: inout State, _ slot: String) {
        guard let v = w.skipped.remove(slot) else { return }
        let left = (w.perChain[v.chain] ?? 1) - 1
        if left > 0 { w.perChain[v.chain] = left } else { w.perChain[v.chain] = nil }
    }

    /// unpad, strict UTF-8, JSON, an object with a string `t`.
    public static func parseInner(_ padded: Bytes) throws -> JSONObject {
        let value: JSONObject
        do { value = try Mailbox.object(try Prim.fromUtf8(try Pad.unpad(padded))) } catch { throw P4Error.malformed("inner message is not padded JSON") }
        guard value.string("t") != nil else { throw P4Error.malformed("inner message needs a type t") }
        return value
    }
}
