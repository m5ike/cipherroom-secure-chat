// Messages for absent members (docs/protocol-v4.md § 7; mailbox.ts; android
// p4/Mailbox.java): sealed for each recipient DEVICE, to that device's signed
// mailbox bundle (a P-256 key and an ML-KEM-768 key, renewed weekly):
//
//   ss1 = ECDH(eph, Rb.dh)          fresh per item
//   ss2 = ECDH(Sb.dh, Rb.dh)        the sender's bundle — deniable authentication
//   ss3 = ML-KEM.Encaps(Rb.kem)     post-quantum
//   key, iv = HKDF(H(AAD), ss1 ‖ ss2 ‖ ss3, "m5cet/p4/mb", 44)
//
// A bundle's private keys outlive its expiry by MAILBOX_KEEP_MS and are then
// wiped. They go through a `MailboxStore`; the app's store is the vault.

import M5Core
import Synchronization

public final class Mailbox: Sendable {

    /* ------------------------------------------------------------ bundles */

    /// A signed mailbox bundle as it travels (hello `mb`, key directory, an item's `sb`).
    public struct Bundle: Sendable, Equatable {
        public let id: String, dh: String, kem: String, sig: String
        public let exp: Int64

        public init(id: String, dh: String, kem: String, exp: Int64, sig: String) { self.id = id; self.dh = dh; self.kem = kem; self.exp = exp; self.sig = sig }

        public var json: JSONObject {
            JSONObject([("id", .string(id)), ("dh", .string(dh)), ("kem", .string(kem)), ("exp", .int(exp)), ("sig", .string(sig))])
        }

        /// A bundle of the right shape (sizes, canonical base64), else nil.
        public static func parse(_ value: JSON?) -> Bundle? {
            guard let b = value?.objectValue, let id = b.string("id"), let dh = b.string("dh"), let kem = b.string("kem"),
                  Prim.isSafeCount(b["exp"]), let sig = b.string("sig") else { return nil }
            do {
                _ = try Prim.unb64url(id, length: 8)
                _ = try Prim.unb64(dh)
                _ = try Prim.unb64(kem, length: P4.kemEk)
                _ = try Prim.unb64(sig, length: 64)
            } catch { return nil }
            return Bundle(id: id, dh: dh, kem: kem, exp: (try? Prim.count(b["exp"])) ?? 0, sig: sig)
        }
    }

    /// One own bundle with its private keys.
    public struct Keys: Sendable {
        public let bundle: Bundle
        public let dh: P256Pair
        public let kemDk: Bytes
        public let created: Int64

        public init(bundle: Bundle, dh: P256Pair, kemDk: Bytes, created: Int64) { self.bundle = bundle; self.dh = dh; self.kemDk = kemDk; self.created = created }

        /// For an encrypted store: the bundle, the ECDH key as PKCS#8 and the KEM key (all b64).
        public var json: JSONObject {
            JSONObject([("bundle", .object(bundle.json)), ("dh", .string(dh.pkcs8)), ("kem", .string(Prim.b64(kemDk))), ("created", .int(created))])
        }

        public static func parse(_ o: JSONObject?) throws -> Keys {
            guard let o, let b = Bundle.parse(o["bundle"]) else { throw P4Error.malformed("stored bundle") }
            let dh = try Prim.importP256Pkcs8(o.string("dh"))
            if dh.spki != b.dh { throw P4Error.malformed("stored bundle key does not match") }
            return Keys(bundle: b, dh: dh, kemDk: try Prim.unb64(o.string("kem"), length: P4.kemDk), created: o.optInt64("created"))
        }
    }

    /// § 7.1: the bytes a bundle's `sig` covers.
    public static func signedData(_ id: String, _ dh: String, _ kem: String, _ exp: Int64) throws -> Bytes {
        try Prim.join(P4.lMailboxBundle, id, dh, Prim.hB64(try Prim.unb64(kem)), exp)
    }

    /// Checks a peer's bundle: nil when it is valid at `now`, else "malformed", "bad-signature" or "expired".
    public static func check(_ bundle: JSON?, _ devicePk: String, _ now: Int64) -> String? {
        guard let b = Bundle.parse(bundle), Prim.isP256Spki(b.dh) else { return "malformed" }
        do {
            if !Prim.ecdsaVerify(devicePk, try signedData(b.id, b.dh, b.kem, b.exp), b.sig) { return "bad-signature" }
        } catch { return "malformed" }
        return b.exp > now ? nil : "expired"
    }

    public static func check(_ bundle: Bundle, _ devicePk: String, _ now: Int64) -> String? { check(.object(bundle.json), devicePk, now) }

    /// § 7.1: a new signed bundle. Draws: "mailbox.id", "mailbox.dh", "mailbox.kem-seed".
    public static func createBundle(_ signer: any DeviceSigner, _ now: Int64, _ rng: any Rng) throws -> Keys {
        let id = Prim.b64url(try rng.bytes(8, "mailbox.id"))
        let dh = try rng.p256(.ecdh, "mailbox.dh")
        let kem = try Kem.keygen(rng, "mailbox.kem-seed")
        let exp = now + P4.mailboxLifetimeMs
        let kemB64 = Prim.b64(kem.ek)
        let sig = try signer.sign(try signedData(id, dh.spki, kemB64, exp))
        return Keys(bundle: Bundle(id: id, dh: dh.spki, kem: kemB64, exp: exp, sig: sig), dh: dh, kemDk: kem.dk, created: now)
    }

    /* ------------------------------------------------------------ sealing */

    /// § 7.2 AAD — 6.12 review P13: it ends with saccDigest (the sender's
    /// account attestation as § 2's accDigest, "-" without one).
    public static func aad(_ roomId: String, _ id: String, _ senderPk: String, _ senderBundleId: String, _ recipientBundleId: String,
                           _ eph: String, _ kctHash: String, _ saccDigest: String) throws -> Bytes {
        try Prim.join(P4.lMailbox, roomId, id, senderPk, senderBundleId, recipientBundleId, eph, kctHash, saccDigest)
    }

    private static func itemKey(_ aad: Bytes, _ ss1: Bytes, _ ss2: Bytes, _ ss3: Bytes) -> (key: Bytes, iv: Bytes) {
        let okm = Prim.hkdf(Prim.H(aad), ss1 + ss2 + ss3, P4.lMailbox, 44)
        return (Array(okm[0..<32]), Array(okm[32..<44]))
    }

    static func hasId(_ payload: JSONObject, _ id: String) -> Bool { payload.string("id") == id }

    /// The parsed JSON object of `json`, or `malformed`.
    public static func object(_ json: String) throws -> JSONObject {
        guard let o = JSON.parseObject(json) else { throw P4Error.malformed("not a JSON object") }
        return o
    }

    /// § 7.2 with explicit sender keys: seals `payloadJson` (its UTF-8, padded;
    /// its `id` must be `id`) for one recipient device. The recipient's bundle
    /// is checked first. Draws: "mailbox.eph", "mailbox.kem-m".
    public static func seal(roomId: String, id: String, payloadJson: String, recipientPk: String, recipient: Bundle, senderPk: String,
                            sacc: JSONObject?, sender: Keys, now: Int64, rng: any Rng) throws -> JSONObject {
        if !hasId(try object(payloadJson), id) { throw P4Error("id-mismatch", "payload.id must be the message id") }
        if let problem = check(recipient, recipientPk, now) { throw P4Error(problem == "expired" ? "expired" : "signature", "recipient bundle: \(problem)") }
        let eph = try rng.p256(.ecdh, "mailbox.eph")
        let ss1 = try Prim.ecdh(eph, recipient.dh)
        let ss2 = try Prim.ecdh(sender.dh, recipient.dh)
        let k = try Kem.encaps(try Prim.unb64(recipient.kem, length: P4.kemEk), rng, "mailbox.kem-m")
        let a = try aad(roomId, id, senderPk, sender.bundle.id, recipient.id, eph.spki, Prim.hB64(k.ct), try Handshake.accDigest(sacc.map { .object($0) }))
        let key = itemKey(a, ss1, ss2, k.ss)
        let c = try Prim.aesGcmSeal(key.key, key.iv, a, Pad.pad(Prim.utf8(payloadJson)))
        var item = JSONObject([("v", 4), ("kind", "mb"), ("id", .string(id)), ("to", .string(recipient.id)), ("sb", .object(sender.bundle.json)), ("spk", .string(senderPk))])
        if let sacc { item["sacc"] = .object(sacc) }
        item["e"] = .string(eph.spki)
        item["kct"] = .string(Prim.b64(k.ct))
        item["c"] = .string(Prim.b64(c))
        return item
    }

    /// An opened item: the payload, and who sent it (to check against the pins, § 7.3).
    public struct Opened: Sendable {
        public let payload: JSONObject
        /// The sender's device key.
        public let spk: String
        /// The sender's account attestation (check like a hello's `acc`), or nil.
        public let sacc: JSONObject?
        /// The sender's bundle (verified with spk), to remember with the pin.
        public let senderBundle: Bundle
    }

    public static func isItem(_ v: JSON?) -> Bool { v?["kind"]?.stringValue == "mb" && isV4(v?["v"]) }

    public static func isSet(_ v: JSON?) -> Bool { v?["kind"]?.stringValue == "mb-set" && isV4(v?["v"]) && v?["items"]?.arrayValue != nil }

    static func isV4(_ v: JSON?) -> Bool { v?.doubleValue == 4 }

    private static func itemShape(_ m: JSONObject) -> Bool {
        guard isItem(.object(m)) else { return false }
        for f in ["id", "to", "spk", "e", "kct", "c"] where m.string(f) == nil { return false }
        if Bundle.parse(m["sb"]) == nil { return false }
        if let sacc = m["sacc"], sacc.objectValue == nil { return false }
        return true
    }

    /// § 7.3 with the recipient bundle's private keys. Throws on a broken item.
    public static func open(_ item: JSONObject, roomId: String, mine: Keys) throws -> Opened {
        guard itemShape(item) else { throw P4Error.malformed("not a mailbox item") }
        let id = item.optString("id"), to = item.optString("to"), spk = item.optString("spk"), e = item.optString("e")
        if to != mine.bundle.id { throw P4Error("state", "item for another bundle") }
        let sb = Bundle.parse(item["sb"])!
        if !Prim.ecdsaVerify(spk, try signedData(sb.id, sb.dh, sb.kem, sb.exp), sb.sig) { throw P4Error("signature", "sender bundle not signed by the sender key") }
        let kct = try Prim.unb64(item.string("kct"), length: P4.kemCt)
        let c = try Prim.unb64(item.string("c"))
        let ss1 = try Prim.ecdh(mine.dh, e)
        let ss2 = try Prim.ecdh(mine.dh, sb.dh)
        let ss3 = try Kem.decaps(kct, mine.kemDk)
        let a = try aad(roomId, id, spk, sb.id, to, e, Prim.hB64(kct), try Handshake.accDigest(item["sacc"]))
        let key = itemKey(a, ss1, ss2, ss3)
        let plain = try Prim.aesGcmOpen(key.key, key.iv, a, c)
        let payload: JSONObject
        do { payload = try object(try Prim.fromUtf8(try Pad.unpad(plain))) } catch { throw P4Error.malformed("item body is not padded JSON") }
        if !hasId(payload, id) { throw P4Error("id-mismatch", "payload.id is not the item id") }
        return Opened(payload: payload, spk: spk, sacc: item.object("sacc"), senderBundle: sb)
    }

    /* --------------------------------------------------------------- sets */

    /// § 7.4: one message for every known device of one away account.
    public static func set(_ id: String, _ items: [JSONObject]) throws -> JSONObject {
        if items.isEmpty { throw P4Error.malformed("a set holds items of one message") }
        for m in items where m.optString("id") != id { throw P4Error.malformed("a set holds items of one message") }
        return JSONObject([("v", 4), ("kind", "mb-set"), ("id", .string(id)), ("items", .array(items.map { .object($0) }))])
    }

    /* ------------------------------------------------------------ mailbox */

    private let store: any MailboxStore
    private let signer: any DeviceSigner
    private let rng: any Rng
    private let lock = Mutex(())

    public init(store: any MailboxStore, signer: any DeviceSigner, rng: (any Rng)? = nil) {
        self.store = store
        self.signer = signer
        self.rng = rng ?? SystemRng()
    }

    /// Renews and wipes as due; returns the bundle created (or nil) and the ids wiped.
    @discardableResult
    public func maintain(_ now: Int64) throws -> (created: Bundle?, wiped: [String]) {
        try lock.withLock { _ in try maintainLocked(now) }
    }

    private func maintainLocked(_ now: Int64) throws -> (created: Bundle?, wiped: [String]) {
        var fresh = false
        var wiped = [String]()
        for keys in store.all() {
            if now >= keys.bundle.exp + P4.mailboxKeepMs {
                store.remove(keys.bundle.id)
                wiped.append(keys.bundle.id)
            } else if keys.bundle.exp - now > P4.mailboxRenewBeforeMs {
                fresh = true
            }
        }
        if fresh { return (nil, wiped) }
        let keys = try Mailbox.createBundle(signer, now, rng)
        store.put(keys)
        return (keys.bundle, wiped)
    }

    /// The current bundle with its keys (renewing first when due).
    public func current(_ now: Int64) throws -> Keys? {
        try lock.withLock { _ in
            _ = try maintainLocked(now)
            return store.all().filter { $0.bundle.exp > now }.sorted { $0.bundle.exp > $1.bundle.exp }.first
        }
    }

    /// § 7.2 with our current bundle.
    public func seal(roomId: String, id: String, payloadJson: String, recipientPk: String, recipient: Bundle, sacc: JSONObject?, now: Int64) throws -> JSONObject {
        guard let mine = try current(now) else { throw P4Error("state", "no mailbox bundle") }
        return try Mailbox.seal(roomId: roomId, id: id, payloadJson: payloadJson, recipientPk: recipientPk, recipient: recipient,
                                senderPk: signer.publicKey, sacc: sacc, sender: mine, now: now, rng: rng)
    }

    /// § 7.3: opens an item or a set; nil when nothing in it is addressed to a
    /// bundle of this device. Keys past exp + MAILBOX_KEEP_MS are `wiped`.
    public func open(_ value: JSONObject, roomId: String, now: Int64) throws -> Opened? {
        var items = [JSONObject?]()
        if Mailbox.isSet(.object(value)) {
            let id = value.optString("id")
            for m in value.array("items") ?? [] {
                guard Mailbox.isItem(m), m["id"]?.stringValue == id, let o = m.objectValue else { throw P4Error.malformed("set items of another message") }
                items.append(o)
            }
        } else {
            items.append(value)
        }
        var kept = [String: Keys]()
        for k in store.all() { kept[k.bundle.id] = k }
        for item in items {
            guard let item, let mine = kept[item.optString("to")] else { continue }
            if now >= mine.bundle.exp + P4.mailboxKeepMs { throw P4Error("wiped", "the bundle's keys are past their retention") }
            return try Mailbox.open(item, roomId: roomId, mine: mine)
        }
        return nil
    }
}

/// Where own bundles and their private keys live; the integrator encrypts them at rest (the vault).
public protocol MailboxStore: Sendable {
    func all() -> [Mailbox.Keys]
    func put(_ keys: Mailbox.Keys)
    func remove(_ id: String)
}

public final class MemoryMailboxStore: MailboxStore {
    private let rows = Mutex(OrderedMap<String, Mailbox.Keys>())
    public init() {}
    public func all() -> [Mailbox.Keys] { rows.withLock { $0.orderedValues } }
    public func put(_ keys: Mailbox.Keys) { rows.withLock { $0[keys.bundle.id] = keys } }
    public func remove(_ id: String) { rows.withLock { _ = $0.remove(id) } }
}
