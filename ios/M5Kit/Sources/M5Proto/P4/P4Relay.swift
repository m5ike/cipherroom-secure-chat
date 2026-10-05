// Messages for members who are away (docs/protocol-v4.md § 7.4; android
// chat/P4Relay.java): the relay frame with an envelope per recipient. For each
// away account one mailbox item per TRUSTED device (an `mb-set` for several),
// the protocol-3 room envelope for recipients without one.
//
//   { type:"relay", messageId, to:[ref…], per?: { ref: mb | mb-set }, envelope?, mention? }
//
// Which devices (review P01): a device pinned from a valid hello v4 under the
// member's reference (its bundle valid, certified by the member's pinned
// account when there is one, not revoked); a key-directory device only with a
// v2 certificate by the account pinned for the member — and, where the server
// runs key transparency, its `dev` entry in a verified lookup. Pure: the room
// hands in the answers, the pins, the time and the sealing.
//
// Also the keys of proxied files (§ 8, review P07; android chat/ProxyKeys.java).

import Foundation
import M5Core
import M5Crypto

public struct P4Relay: Sendable {
    /// One device of an away account that a message can be sealed for.
    public struct Device: Sendable, Equatable {
        public let pk: String
        public let apk: String?
        public let bundle: Mailbox.Bundle
        public init(pk: String, apk: String?, bundle: Mailbox.Bundle) { self.pk = pk; self.apk = apk; self.bundle = bundle }
    }

    public static let cacheMs: Int64 = 5 * 60_000
    /// A set holds at most this many items (server: 1–16).
    public static let maxDevices = 16

    private struct Cached: Sendable { let devices: [Device]; let at: Int64 }
    private struct KtSeen: Sendable { let entries: [Kt.Entry]?; let at: Int64 }

    private var directory = [String: Cached]()
    private var asked = [String: Int64]()
    private var kt = [String: KtSeen]()
    private var ktAsked = [String: Int64]()

    public init() {}

    /// Is a directory answer for this reference fresh?
    public func known(_ ref: String, now: Int64) -> Bool {
        guard let c = directory[ref] else { return false }
        return now - c.at < P4Relay.cacheMs
    }

    /// Should a `key-bundles` frame go out for this reference now (not known, not asked in the last 3 s)?
    public mutating func shouldAsk(_ ref: String, now: Int64) -> Bool {
        if known(ref, now: now) { return false }
        if let at = asked[ref], now - at < 3_000 { return false }
        asked[ref] = now
        return true
    }

    public static func askFrame(_ ref: String) -> JSONObject { JSONObject([("type", "key-bundles"), ("ref", .string(ref))]) }

    /// The hub's `key-bundles` answer: the devices whose v2 certificate and bundle check out, unexpired. Returns the reference.
    @discardableResult
    public mutating func onKeyBundles(_ f: JSONObject, now: Int64) -> String {
        let ref = f.optString("ref")
        if ref.isEmpty { return "" }
        var out = [Device]()
        for d in f.array("devices") ?? [] where out.count < 64 { if let dev = P4Relay.check(d.objectValue, now: now) { out.append(dev) } }
        directory[ref] = Cached(devices: out, at: now)
        asked[ref] = nil
        return ref
    }

    /// One DirectoryDevice {pk, apk, cert:{v:2, exp, sig}, bundle}, or nil when it does not check out.
    public static func check(_ d: JSONObject?, now: Int64) -> Device? {
        guard let d, let cert = d.object("cert"), cert.optInt64("v") == 2 else { return nil }
        let pk = d.optString("pk"), apk = d.optString("apk")
        guard Prim.isP256Spki(pk) else { return nil }
        let acc = JSONObject([("apk", .string(apk)), ("ac", .string(cert.optString("sig"))), ("cv", 2), ("exp", .int(cert.optInt64("exp")))])
        guard let a = Handshake.verifyAccount(.object(acc), pk: pk, now: now), a.valid else { return nil }
        if Mailbox.check(d["bundle"], pk, now) != nil { return nil }
        return Mailbox.Bundle.parse(d["bundle"]).map { Device(pk: pk, apk: apk, bundle: $0) }
    }

    /* ------------------------------------------- key transparency (§ 14) */

    public func ktKnown(_ ref: String, now: Int64) -> Bool {
        guard let k = kt[ref] else { return false }
        return now - k.at < P4Relay.cacheMs
    }

    public mutating func shouldAskKt(_ ref: String, now: Int64) -> Bool {
        if ktKnown(ref, now: now) { return false }
        if let at = ktAsked[ref], now - at < 3_000 { return false }
        ktAsked[ref] = now
        return true
    }

    public static func ktFrame(_ ref: String) -> JSONObject { JSONObject([("type", "kt-lookup"), ("ref", .string(ref))]) }

    /// A checked lookup of a member reference: its entries when it verified, else nothing is confirmed by it.
    public mutating func onKt(_ ref: String, _ checked: Kt.Checked?, now: Int64) {
        if ref.isEmpty { return }
        kt[ref] = KtSeen(entries: checked?.ok == true ? checked!.entries : nil, at: now)
        ktAsked[ref] = nil
    }

    /// What the lookup of `ref` says of device `dpk` of account `apk`: ok, revoked, absent, unverified or unknown.
    public func ktStatus(_ ref: String, apk: String, dpk: String, now: Int64) -> String {
        guard let k = kt[ref] else { return "unknown" }
        guard let entries = k.entries else { return "unverified" }
        let st = Kt.deviceStatus(entries, apk: apk, dpk: dpk, now: now)
        if st.revoked { return "revoked" }
        return st.ok ? "ok" : "absent"
    }

    /// The devices to seal for (§ 7.4, review P01), at most maxDevices.
    public func devices(_ ref: String, pinnedApk: String?, remembered: [P4Store.Remembered], ktOn: Bool, now: Int64) -> [Device] {
        var out = OrderedMap<String, Device>()
        let pinned = !(pinnedApk ?? "").isEmpty
        for r in remembered {
            guard out.count < P4Relay.maxDevices, out[r.pk] == nil, let bundle = r.bundle, Mailbox.check(bundle, r.pk, now) == nil else { continue }
            var apk: String?
            if let acc = r.acc, let a = Handshake.verifyAccount(.object(acc), pk: r.pk, now: now), a.valid { apk = a.publicKey }
            if pinned && pinnedApk != apk { continue } // not certified (now) by the member's account
            if let apk, ktStatus(ref, apk: apk, dpk: r.pk, now: now) == "revoked" { continue }
            out[r.pk] = Device(pk: r.pk, apk: apk, bundle: bundle)
        }
        if pinned, let c = directory[ref] {
            for d in c.devices {
                guard out.count < P4Relay.maxDevices, out[d.pk] == nil, d.apk == pinnedApk, d.bundle.exp > now else { continue }
                let st = ktStatus(ref, apk: d.apk ?? "", dpk: d.pk, now: now)
                if ktOn ? st != "ok" : st == "revoked" { continue }
                out[d.pk] = d
            }
        }
        return out.orderedValues
    }

    /// The relay frame for one message: per[ref] for every recipient with a device sealed to, `envelope` (made
    /// only when needed) for the rest. Nil when there is no recipient. Also returns the references sealed per device.
    public static func frame(messageId: String, refs: [String], devices: [String: [Device]], seal: (Device) throws -> JSONObject,
                             roomEnvelope: () throws -> JSONObject?, mention: [String]?) rethrows -> (frame: JSONObject, sealed: [String])? {
        if refs.isEmpty { return nil }
        var per = JSONObject()
        var needRoom = false
        for ref in refs {
            var items = [JSONObject]()
            for d in devices[ref] ?? [] { if let item = try? seal(d) { items.append(item) } }
            if items.isEmpty { needRoom = true; continue }
            if items.count == 1 { per[ref] = .object(items[0]) }
            else if let set = try? Mailbox.set(messageId, items) { per[ref] = .object(set) }
            else { needRoom = true }
        }
        let env = needRoom ? try roomEnvelope() : nil
        // Without a room envelope, a recipient without its own envelope cannot be addressed.
        let to = refs.filter { per.has($0) || env != nil }
        if to.isEmpty { return nil }
        var frame = JSONObject([("type", "relay"), ("messageId", .string(messageId)), ("to", .array(to.map { .string($0) }))])
        if !per.isEmpty { frame["per"] = .object(per) }
        if let env { frame["envelope"] = .object(env) }
        if let mention {
            let m = mention.filter { to.contains($0) }
            if !m.isEmpty { frame["mention"] = .array(m.map { .string($0) }) }
        }
        return (frame, to.filter { per.has($0) })
    }

    /// Is this relayed envelope protocol 4 (an item or a set)?
    public static func isP4(_ envelope: JSONObject?) -> Bool { Mailbox.isItem(envelope.map { .object($0) }) || Mailbox.isSet(envelope.map { .object($0) }) }

    public mutating func clear() { directory.removeAll(); asked.removeAll(); kt.removeAll(); ktAsked.removeAll() }
}

/// The keys of files the server relays ("proxied", § 8, review P07; android chat/ProxyKeys.java): the sender
/// seals each transfer's FK as a mailbox item to this device; kept for (sender, transfer) and used once. A
/// protocol-4 meta that comes before its key waits (≤ 5 s), the transfer's later frames behind it.
public struct ProxyKeys: Sendable {
    public static let waitMs: Int64 = 5_000
    public static let maxKeys = 64, maxWaitingFrames = 4096

    public struct Key: Sendable, Equatable {
        public let fk: Bytes
        /// The device key that sealed it (the file's signer).
        public let spk: String
    }

    /// A frame of a waiting transfer: JSON or a binary chunk.
    public enum Frame: Sendable, Equatable { case json(JSONObject), binary(Bytes) }

    /// A meta waiting for its key: the sender and the frames in order (the meta first); `token` names this wait.
    public struct Waiting: Sendable, Equatable {
        public let from: String
        public var frames: [Frame]
        public let token: Int
    }

    private var keys = OrderedMap<String, Key>()
    private var waiting = [String: Waiting]()
    private var nextToken = 1

    public init() {}

    static func slot(_ from: String?, _ transferId: String) -> String { (from ?? "") + "\u{0}" + transferId }

    /// The FK an opened signal item carries for `transferId` ({id: transferId, t: "fk", fk}); sealed by `expectedPk` when known.
    public static func fkOf(_ o: Mailbox.Opened?, transferId: String?, expectedPk: String?) -> Bytes? {
        guard let o, let transferId, o.payload.optString("t") == "fk", o.payload.optString("id") == transferId else { return nil }
        if let e = expectedPk, !e.isEmpty, e != o.spk { return nil }
        return try? Prim.unb64(o.payload["fk"], length: 32)
    }

    /// Keeps a key; returns the frames of the meta that waited for it (to handle now, in order), or nil.
    public mutating func put(from: String, transferId: String, fk: Bytes, spk: String) -> [Frame]? {
        keys[ProxyKeys.slot(from, transferId)] = Key(fk: fk, spk: spk) // a known slot keeps its place (LinkedHashMap.put)
        while keys.count > ProxyKeys.maxKeys, let first = keys.first { keys.remove(first.key) }
        guard let w = waiting[transferId], w.from == from else { return nil }
        waiting[transferId] = nil
        return w.frames
    }

    /// The key for this transfer from this sender, removed (used once).
    public mutating func take(from: String, transferId: String) -> Key? { keys.remove(ProxyKeys.slot(from, transferId)) }

    /// A protocol-4 meta without its key: it waits (nil: one waits already, or no sender — refuse it).
    public mutating func park(from: String?, transferId: String, meta: JSONObject) -> Waiting? {
        guard let from, !from.isEmpty, waiting[transferId] == nil else { return nil }
        let w = Waiting(from: from, frames: [.json(meta)], token: nextToken)
        nextToken += 1
        waiting[transferId] = w
        return w
    }

    /// A later frame of a waiting transfer: kept behind its meta (true), or not waiting (false).
    public mutating func queue(_ transferId: String, _ frame: Frame) -> Bool {
        guard var w = waiting[transferId] else { return false }
        if w.frames.count < ProxyKeys.maxWaitingFrames { w.frames.append(frame) }
        waiting[transferId] = w
        return true
    }

    public func isWaiting(_ transferId: String) -> Bool { waiting[transferId] != nil }

    /// Its key did not come in time: dropped (true when that wait was still on).
    public mutating func expire(_ transferId: String, token: Int) -> Bool {
        guard waiting[transferId]?.token == token else { return false }
        waiting[transferId] = nil
        return true
    }

    public mutating func clear() { waiting.removeAll(); keys.removeAll() }
}
