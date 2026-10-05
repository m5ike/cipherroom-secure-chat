// Who a sender is (android chat/Trust.java, Verified.java, Rooms pins):
//
//   Trust     a peer's identity state (docs/protocol-v4.md § 12.1): new,
//             verified, account, changed — from the pins, the person's
//             verifications and key transparency
//   Verified  what the "verified" mark of a message means (6.7, S15 / F-07):
//             signed by the key pinned for the name it is shown under
//   NamePins  trust on first use per (room, name) → device key id, kept in
//             the vault record "pins"

import Foundation
import M5Core
import M5Crypto
import Synchronization

public enum Trust {
    public static let new = "new", verified = "verified", account = "account", changed = "changed"

    /// Review P08: an account verified under `verifiedName` counts as verified under `name` only when it is that name ("" — any).
    public static func verifiedUnder(_ verifiedName: String?, _ name: String?) -> Bool {
        guard let v = verifiedName, !v.isEmpty else { return true }
        return Verified.sameName(v, name)
    }

    /// The identity state (§ 12.1). `ktConfirmed`: key transparency confirms the account and the device, or this server runs none.
    public static func of(attested: Bool, accountPin: String?, namePin: String?, deviceVerified: Bool, accountVerified: Bool,
                          ktRevoked: Bool, ktConfirmed: Bool = true) -> String {
        if ktRevoked { return changed }
        if attested {
            if accountPin == "changed" { return changed }
            // A first-seen account under a name pinned to another, unattested key: as a changed key.
            if accountPin == "new" && namePin == "changed" { return changed }
            if deviceVerified { return verified }
            if !ktConfirmed { return new }
            return accountVerified ? verified : account
        }
        if namePin == "changed" { return changed }
        return deviceVerified ? verified : new
    }
}

public enum Verified {
    /// Over the peer-to-peer channel: signed by the key the sender's hello presented (pinned under the peer's name),
    /// that pin did not change, and the message carries the same name.
    public static func p2p(_ signer: Envelopes.Signer?, helloKey: String?, changed: Bool, claimedName: String?, peerName: String?) -> Bool {
        guard let signer, signer.valid, !changed, let hk = helloKey, !hk.isEmpty, hk == signer.publicKey else { return false }
        return sameName(claimedName, peerName)
    }

    /// Through the relay (no hello): signed by the key pinned for the name the message carries.
    public static func relay(_ signer: Envelopes.Signer?, pinnedKid: String?) -> Bool {
        guard let signer, signer.valid, let pinned = pinnedKid, !pinned.isEmpty else { return false }
        return Ec.kid(signer.publicKey) == pinned
    }

    /// Review P09: is "forwarded from X" backed by an original in `messages` — the same text, from the device
    /// key pinned for X (`pinnedKid`), or mine when X is my name (`myName`)?
    public static func forward(_ fwd: ChatMessage?, _ messages: [ChatMessage], pinnedKid: String?, myName: String?) -> Bool {
        guard let fwd, let from = fwd.forwardedFrom, !from.javaTrimmed.isEmpty else { return false }
        let text = fwd.visibleText
        if text.isEmpty { return false }
        for x in messages {
            if x.id == fwd.id { continue } // the forward itself
            if x.forwardedFrom != nil || x.changed || x.kind == "sys" || text != x.visibleText { continue }
            if x.mine && fwd.mine { continue } // the forwarder's own
            if !x.mine && !fwd.mine && !x.senderId.isEmpty && x.senderId == fwd.senderId { continue }
            if x.mine { if sameName(from, myName) { return true }; continue }
            if let p = pinnedKid, !p.isEmpty, p == x.senderKid, sameName(x.senderName, from) { return true }
        }
        return false
    }

    /// As the pins are keyed: trimmed, case-insensitive.
    public static func sameName(_ a: String?, _ b: String?) -> Bool {
        guard let a, let b else { return false }
        let x = a.javaTrimmed.lowercased(), y = b.javaTrimmed.lowercased()
        return !x.isEmpty && x == y
    }
}

/// Trust on first use: (room, name) → device key id (android Rooms.pin / pinVerdict / repin / pinned).
/// While locked in the receiving mode the open rooms' pins live in memory (`lockedPins`); a pin made then
/// is reported through `onLockedPin` (the lock inbox) and merged at the unlock (`mergePins`).
public final class NamePins: Sendable {
    public static let record = "pins"
    private let vault: any RecordVault
    private let locked = Mutex<[String: String]?>(nil)
    private let onLockedPin: (@Sendable (_ slot: String, _ kid: String) -> Void)?

    public init(vault: any RecordVault, onLockedPin: (@Sendable (String, String) -> Void)? = nil) {
        self.vault = vault
        self.onLockedPin = onLockedPin
    }

    /// The vault's data key is present (bundles are renewed only then).
    public var vaultUnlocked: Bool { vault.unlocked }

    public static func slot(_ room: String, _ name: String) -> String { room + "\u{0}" + name.javaTrimmed.lowercased() }

    /// Locked in the receiving mode: these pins (the open rooms') work from memory.
    public func lock(with pins: [String: String]) { locked.withLock { $0 = pins } }
    public func unlock() { locked.withLock { $0 = nil } }

    /// The pins of these rooms (for `lock(with:)`).
    public func pinsOf(rooms: Set<String>) -> [String: String] {
        var out = [String: String]()
        for (slot, kid) in vault.record(NamePins.record) ?? JSONObject() {
            if let cut = slot.firstIndex(of: "\u{0}"), rooms.contains(String(slot[..<cut])), let k = kid.stringValue { out[slot] = k }
        }
        return out
    }

    /// The key id pinned for this name in this room ("" when none), without pinning anything.
    public func pinned(_ room: String, _ name: String?) -> String {
        guard let name else { return "" }
        let s = NamePins.slot(room, name)
        if let l = locked.withLock({ $0 }) { return l[s] ?? "" }
        return vault.record(NamePins.record)?.optString(s) ?? ""
    }

    /// What pin() would say, without pinning anything.
    public func verdict(_ room: String, _ name: String, _ kid: String) -> String {
        let old = pinned(room, name)
        return old.isEmpty ? "new" : old == kid ? "match" : "changed"
    }

    /// Trust on first use: "new", "match" or "changed".
    @discardableResult
    public func pin(_ room: String, _ name: String, _ kid: String) -> String {
        let s = NamePins.slot(room, name)
        let lockedVerdict: String? = locked.withLock { l in
            guard var map = l else { return nil }
            let old = map[s] ?? ""
            if old.isEmpty { map[s] = kid; l = map; return "new-locked" }
            return old == kid ? "match" : "changed"
        }
        if let v = lockedVerdict {
            if v == "new-locked" { onLockedPin?(s, kid); return "new" }
            return v
        }
        var pins = vault.record(NamePins.record) ?? JSONObject()
        let old = pins.optString(s)
        if old.isEmpty {
            pins[s] = .string(kid)
            _ = vault.put(NamePins.record, pins)
            return "new"
        }
        return old == kid ? "match" : "changed"
    }

    /// The person accepted another key for this name (People › verify): the pin follows.
    public func repin(_ room: String, _ name: String?, _ kid: String?) {
        guard let name, let kid, !kid.isEmpty else { return }
        let s = NamePins.slot(room, name)
        let done: Bool = locked.withLock { l in
            guard var map = l else { return false }
            map[s] = kid
            l = map
            return true
        }
        if done { return }
        var pins = vault.record(NamePins.record) ?? JSONObject()
        pins[s] = .string(kid)
        _ = vault.put(NamePins.record, pins)
    }

    /// Pins first seen while locked, into the vault — a slot pinned meanwhile keeps its key (first use wins).
    public func mergePins(_ fresh: [String: String]) {
        if fresh.isEmpty { return }
        var pins = vault.record(NamePins.record) ?? JSONObject()
        var changed = false
        for (slot, kid) in fresh where pins.optString(slot).isEmpty { pins[slot] = .string(kid); changed = true }
        if changed { _ = vault.put(NamePins.record, pins) }
    }
}
