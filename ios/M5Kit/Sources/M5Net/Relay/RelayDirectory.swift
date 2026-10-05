// Port of A/chat/P4Relay.java (6.12, docs/protocol-v4.md § 7.4): messages for
// members who are away — the relay frame with an envelope per recipient. For
// each away account the sender seals one mailbox item per TRUSTED device of
// it (an `mb-set` when it has several) and falls back to the protocol-3 room
// envelope (which the server cannot open) for recipients without one.
//
//   { type:"relay", messageId, to:[ref…], per?: { ref: mb | mb-set }, envelope? }
//
// Which devices (§ 7.4, review P01) — a bundle is never trusted because the
// server delivered it, and the hub's member reference only routes:
//   1. a device pinned from a valid hello v4 under that member's reference,
//      its bundle signed by its device key and unexpired; when the member's
//      account is pinned, the device's hello carried a valid certificate by
//      THAT account key; not revoked in key transparency;
//   2. a device of the key directory (`key-bundles`) with a v2 certificate by
//      the account key pinned for the member — and, when this server runs key
//      transparency, its `dev` entry included in a verified lookup and not
//      revoked.
// A member whose account this device never authenticated gets the room
// envelope. Pure: the room hands in the answers, the pins, the time, the
// crypto checks (RelayDeviceChecker) and the sealing (M5Crypto Mailbox).

import Foundation

/// The crypto checks the relay needs (M5Crypto: Handshake.verifyAccount, Mailbox.check).
public protocol RelayDeviceChecker: Sendable {
    /// The account key (raw Ed25519, base64) when `certificate` — {apk, ac, cv: 2, exp} — is a valid v2 device
    /// certificate of `devicePublicKey` now; nil otherwise.
    func certifiedAccountKey(certificate: NetJSON, devicePublicKey: String, now: Millis) -> String?
    /// Is `bundle` a mailbox bundle signed by `devicePublicKey` and unexpired at `now`?
    func bundleValid(_ bundle: NetJSON, devicePublicKey: String, now: Millis) -> Bool
}

/// One device of an away account that a message can be sealed for.
public struct RelayDevice: Sendable, Equatable {
    /// The device key (P-256 SPKI, base64).
    public let pk: String
    /// Its account key, nil when not attested.
    public let apk: String?
    /// Its mailbox bundle {id, dh, kem, exp, sig}.
    public let bundle: NetJSON
    public var bundleExp: Millis { bundle.int("exp") }

    public init(pk: String, apk: String?, bundle: NetJSON) {
        self.pk = pk
        self.apk = apk
        self.bundle = bundle
    }
}

/// A device pinned from a member's hello v4 (P4Store.Remembered): its key, bundle and account certificate.
public struct RelayRememberedDevice: Sendable, Equatable {
    public let pk: String
    public let bundle: NetJSON?
    public let acc: NetJSON?
    public init(pk: String, bundle: NetJSON?, acc: NetJSON?) {
        self.pk = pk
        self.bundle = bundle
        self.acc = acc
    }
}

public struct RelayDirectory: Sendable {
    public static let cacheMs: Millis = 5 * 60_000
    /// A set holds at most this many items (server: 1–16).
    public static let maxDevices = 16
    static let askAgainMs: Millis = 3_000

    private var directory: [String: (devices: [RelayDevice], at: Millis)] = [:]
    private var asked: [String: Millis] = [:]
    /// A lookup's verified entries (nil: it did not verify), by reference.
    private var kt: [String: (entries: [KtLogEntry]?, at: Millis)] = [:]
    private var ktAsked: [String: Millis] = [:]

    public init() {}

    /* ---------------------------------------------------- key directory */

    /// Is a directory answer for this reference fresh?
    public func known(_ ref: String, now: Millis) -> Bool {
        guard let c = directory[ref] else { return false }
        return now - c.at < Self.cacheMs
    }

    /// Should a `key-bundles` frame go out for this reference now (not known, not asked in the last 3 s)? Marks it asked.
    public mutating func shouldAsk(_ ref: String, now: Millis) -> Bool {
        if known(ref, now: now) { return false }
        if let at = asked[ref], now - at < Self.askAgainMs { return false }
        asked[ref] = now
        return true
    }

    public static func askFrame(_ ref: String) -> HubClientFrame { .keyBundles(ref: ref) }

    /// The hub's `key-bundles` answer: the devices whose v2 certificate (by the device's account key) and bundle
    /// (by the device key) check out, unexpired. Whether that account is the member's is decided when sealing.
    @discardableResult
    public mutating func onKeyBundles(ref: String, devices: [NetJSON], now: Millis, checker: any RelayDeviceChecker) -> String {
        if ref.isEmpty { return "" }
        var out: [RelayDevice] = []
        for d in devices {
            if out.count >= 64 { break }
            if let ok = Self.check(d, now: now, checker: checker) { out.append(ok) }
        }
        directory[ref] = (out, now)
        asked.removeValue(forKey: ref)
        return ref
    }

    /// One DirectoryDevice {pk, apk, cert: {v: 2, exp, sig}, bundle}, or nil when it does not check out.
    public static func check(_ d: NetJSON, now: Millis, checker: any RelayDeviceChecker) -> RelayDevice? {
        let pk = d.str("pk"), apk = d.str("apk")
        guard let cert = d.obj("cert"), cert["v"]?.int64Value == 2, P256Keys.publicKey(spki: pk) != nil else { return nil }
        let acc: NetJSON = ["apk": .string(apk), "ac": .string(cert.str("sig")), "cv": 2, "exp": .int(cert.int("exp"))]
        guard let account = checker.certifiedAccountKey(certificate: acc, devicePublicKey: pk, now: now) else { return nil }
        guard let bundle = d.obj("bundle"), checker.bundleValid(bundle, devicePublicKey: pk, now: now) else { return nil }
        return RelayDevice(pk: pk, apk: account, bundle: bundle)
    }

    /* ---------------------------------------- key transparency (§ 14) */

    public func ktKnown(_ ref: String, now: Millis) -> Bool {
        guard let k = kt[ref] else { return false }
        return now - k.at < Self.cacheMs
    }

    /// Should a `kt-lookup` frame go out for this reference now? Marks it asked.
    public mutating func shouldAskKt(_ ref: String, now: Millis) -> Bool {
        if ktKnown(ref, now: now) { return false }
        if let at = ktAsked[ref], now - at < Self.askAgainMs { return false }
        ktAsked[ref] = now
        return true
    }

    public static func ktFrame(_ ref: String) -> HubClientFrame { .ktLookup(ref: ref) }

    /// A checked lookup of a member reference: its entries when it verified (nil: nothing is confirmed by it).
    public mutating func onKt(ref: String, verifiedEntries: [KtLogEntry]?, now: Millis) {
        if ref.isEmpty { return }
        kt[ref] = (verifiedEntries, now)
        ktAsked.removeValue(forKey: ref)
    }

    /// What the lookup of `ref` says of device `dpk` of account `apk`: "ok", "revoked", "absent",
    /// "unverified" (the lookup did not verify) or "unknown" (no lookup).
    public func ktStatus(_ ref: String, apk: String, dpk: String, now: Millis) -> String {
        guard let k = kt[ref] else { return "unknown" }
        guard let entries = k.entries else { return "unverified" }
        let st = KtLogEntry.deviceStatus(entries, apk: apk, dpk: dpk, now: now)
        if st.revoked { return "revoked" }
        return st.ok ? "ok" : "absent"
    }

    /* ------------------------------------------------------- the devices */

    /// The devices to seal for (§ 7.4, review P01): the member's pinned devices (`remembered`, from hellos v4),
    /// then the directory's devices of its pinned account `pinnedApk` ("" or nil: none — then no directory device).
    /// `ktOn`: this server runs key transparency — a directory device needs a verified lookup that includes it.
    public func devices(_ ref: String, pinnedApk: String?, remembered: [RelayRememberedDevice], ktOn: Bool, now: Millis,
                        checker: any RelayDeviceChecker) -> [RelayDevice] {
        var out: [RelayDevice] = []
        var seen = Set<String>()
        let pinned = (pinnedApk ?? "").isEmpty ? nil : pinnedApk
        for r in remembered {
            guard out.count < Self.maxDevices, !seen.contains(r.pk), let bundle = r.bundle, checker.bundleValid(bundle, devicePublicKey: r.pk, now: now) else { continue }
            let apk = r.acc.flatMap { checker.certifiedAccountKey(certificate: $0, devicePublicKey: r.pk, now: now) }
            if let pinned, pinned != apk { continue } // not certified (now) by the member's account
            if let apk, ktStatus(ref, apk: apk, dpk: r.pk, now: now) == "revoked" { continue }
            out.append(RelayDevice(pk: r.pk, apk: apk, bundle: bundle))
            seen.insert(r.pk)
        }
        if let pinned, let c = directory[ref] {
            for d in c.devices {
                guard out.count < Self.maxDevices, !seen.contains(d.pk), d.apk == pinned, d.bundleExp > now else { continue }
                let st = ktStatus(ref, apk: pinned, dpk: d.pk, now: now)
                if ktOn ? st != "ok" : st == "revoked" { continue }
                out.append(d)
                seen.insert(d.pk)
            }
        }
        return out
    }

    public mutating func clear() {
        directory = [:]
        asked = [:]
        kt = [:]
        ktAsked = [:]
    }

    /* --------------------------------------------------------- the frame */

    /// An `mb-set` of one message's items (Mailbox.set): every item of message `id`.
    public static func mailboxSet(id: String, items: [NetJSON]) throws -> NetJSON {
        guard !items.isEmpty, items.allSatisfy({ $0.str("id") == id }) else { throw NetError.invalid("a set holds items of one message") }
        return ["v": 4, "kind": "mb-set", "id": .string(id), "items": .array(items)]
    }

    /// The relay frame for one message: per[ref] for every recipient with at least one device sealed to, the
    /// protocol-3 room envelope (made only when needed) for the rest. nil when there is no recipient.
    /// `sealed`: the references that got per-device items.
    public static func frame(messageId: String, refs: [String], devices: [String: [RelayDevice]], seal: (RelayDevice) throws -> NetJSON,
                             roomEnvelope: () -> NetJSON?, mention: [String]?) -> (relay: HubRelay, sealed: [String])? {
        if refs.isEmpty { return nil }
        var per: [String: NetJSON] = [:]
        var needRoom = false
        for ref in refs {
            var items: [NetJSON] = []
            for d in devices[ref] ?? [] {
                if let item = try? seal(d) { items.append(item) } // a device that fails is left out
            }
            if items.isEmpty { needRoom = true; continue }
            if items.count == 1 { per[ref] = items[0] } else if let set = try? mailboxSet(id: messageId, items: items) { per[ref] = set } else { needRoom = true }
        }
        let env = needRoom ? roomEnvelope() : nil
        // Without a room envelope, a recipient without its own envelope cannot be addressed (the server would refuse the frame).
        let to = refs.filter { per[$0] != nil || env != nil }
        if to.isEmpty { return nil }
        let m = mention?.filter { to.contains($0) }
        let relay = HubRelay(messageId: messageId, to: to, envelope: env, per: per.isEmpty ? nil : per, mention: (m?.isEmpty ?? true) ? nil : m)
        return (relay, to.filter { per[$0] != nil })
    }

    /// Is this relayed envelope protocol 4 (an item or a set)?
    public static func isP4(_ envelope: NetJSON) -> Bool {
        guard envelope["v"]?.doubleValue == 4 else { return false }
        return envelope.str("kind") == "mb" || (envelope.str("kind") == "mb-set" && envelope.arr("items") != nil)
    }
}
