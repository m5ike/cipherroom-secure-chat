// The unlock-attempt counter bound to the secure hardware, so that putting back an
// older copy of the app's data does not give the attempts back (Android
// security/LockStore, 6.12 F-16).
//
// The record (LockCounter's fields) is sealed by a PRF of the Secure Enclave key of
// one generation (Keyring "ctr.N"), and the generation is in the record. Every write
// makes a key of the next generation, seals with it, writes the record durably and
// only then deletes the older keys. A copy of an older record names a generation
// whose key is gone — a rollback, and a rollback counts as every attempt used
// (AppLock: the policy's wipe or lock-out). Deleting the record while a key exists
// is one too.
//
// iOS: the record itself is a Keychain item ("lock", WhenUnlockedThisDeviceOnly —
// the contract's "counter in the Keychain with a generation"), not a file: copying
// the app's files back cannot touch it at all; restoring the whole Keychain
// database (a jailbroken device) restores it with its key blobs — Android's
// residual risk too. Not a defence against code running as the app.
//
// The first seal marks the record ("mig": the generation it is about to get) before
// it makes the key, so a stop between the two is not taken for a rollback. Pure
// (the keys and the record are protocols): LockStoreTests run every order of a stop.

import Foundation
import M5Core
import M5Crypto

/// The secure-hardware side (Keyring's counter keys).
protocol LockAnchor {
    /// The generations whose keys exist now; nil when that cannot be read.
    func generations() -> Set<Int64>?
    /// Makes the key of this generation; false when it could not.
    func create(_ gen: Int64) -> Bool
    func delete(_ gen: Int64)
    /// The generation key's MAC (PRF) of the data; nil when it cannot.
    func mac(_ gen: Int64, _ data: Data) -> Data?
}

/// Where the record is.
protocol LockRecords {
    /// The record; [:] when there is none; nil when it cannot be read now (nothing is decided then);
    /// [unreadable: true] when it does not parse (changed by someone).
    func read() -> JSONObject?
    /// Durably; false when it could not be written.
    func write(_ record: JSONObject) -> Bool
}

final class LockStore {
    enum Verdict: Equatable {
        /// Sealed and current.
        case ok
        /// Never sealed yet (no key): taken as it is.
        case legacy
        /// The keys cannot be read now: taken as it is (the next write needs them, so no attempt is checked meanwhile).
        case unverified
        /// An older copy, a deleted record or a forged one: every attempt counts as used.
        case rollback
    }

    struct View {
        var state: JSONObject
        var verdict: Verdict
    }

    static let gen = "g", mac = "mac", mig = "mig", unreadable = "unreadable"

    private let anchor: any LockAnchor
    private let records: any LockRecords

    init(anchor: any LockAnchor, records: any LockRecords) {
        self.anchor = anchor
        self.records = records
    }

    /// The counter's fields without the seal.
    static func fields(_ r: JSONObject) -> JSONObject {
        var out = JSONObject()
        for (k, v) in r where ![gen, mac, mig, unreadable].contains(k) { out[k] = v }
        return out
    }

    /// What the seal covers: the generation and every field that decides, in a fixed order
    /// (Android's "m5/lock/1|gen|attempts|until|pending" + the monotonic wait of iOS).
    static func canonical(_ r: JSONObject, gen g: Int64) -> Data {
        let pending = r.isPresent("pending") ? String(r.optInt64("pending")) : "-1"
        let parts = ["m5/lock/ios/1", String(g), String(r.optInt("attempts")), String(r.optInt64("until")), pending,
                     String(r.optInt64("untilMono")), r.optString("boot"), String(r.optInt64("wait"))]
        return SecData.utf8(parts.joined(separator: "|"))
    }

    /// Reads and checks the record.
    func load() -> View {
        guard let r = records.read() else { return View(state: JSONObject(), verdict: .unverified) }
        guard let gens = anchor.generations() else { return View(state: Self.fields(r), verdict: .unverified) }
        // A record that does not parse: someone changed it — but before the first seal it reads as none.
        if r.bool(Self.unreadable) == true { return View(state: JSONObject(), verdict: gens.isEmpty ? .legacy : .rollback) }
        let sealed = r.isPresent(Self.gen)
        if gens.isEmpty {
            // No key at all: never sealed — unless the record says it was (its keys are gone).
            return View(state: Self.fields(r), verdict: sealed ? .rollback : .legacy)
        }
        if !sealed {
            // A first seal that stopped after making its key (the record names the generation it was getting).
            if r.isPresent(Self.mig), gens.contains(r.optInt64(Self.mig, -1)) { return View(state: Self.fields(r), verdict: .legacy) }
            return View(state: Self.fields(r), verdict: .rollback)
        }
        let g = r.optInt64(Self.gen, -1)
        guard gens.contains(g) else { return View(state: Self.fields(r), verdict: .rollback) }
        guard let want = anchor.mac(g, Self.canonical(r, gen: g)) else { return View(state: Self.fields(r), verdict: .unverified) }
        let have = Bytes.unb64(r.optString(Self.mac)) ?? Data()
        return View(state: Self.fields(r), verdict: Bytes.same(want, have) ? .ok : .rollback)
    }

    /// Writes the counter's state sealed by a new generation; the older keys go after the record is
    /// stored. False when it could not be written (AppLock then checks no PIN). Keys that cannot be
    /// made at all leave the record unsealed; no new key now seals with the one there is.
    func save(_ state: JSONObject) -> Bool {
        guard let gens = anchor.generations() else { return false }
        let cur = gens.max() ?? -1
        var next = cur < 0 ? 1 : cur + 1
        let plain = Self.fields(state)
        if cur < 0 {
            // The first seal: say so in the record before the key exists.
            var marked = plain
            marked[Self.mig] = .int(next)
            guard records.write(marked) else { return false }
            if !anchor.create(next) { return true } // no key on this device: the unsealed record stays
        } else if !anchor.create(next) {
            next = cur // no new key now: sealed with the one there is (no rotation this time)
        }
        guard let mac = anchor.mac(next, Self.canonical(plain, gen: next)) else {
            if next != cur { anchor.delete(next) }
            return false
        }
        var sealed = plain
        sealed[Self.gen] = .int(next)
        sealed[Self.mac] = .string(Bytes.b64(mac))
        guard records.write(sealed) else {
            if next != cur { anchor.delete(next) }
            return false
        }
        for g in gens where g != next { anchor.delete(g) }
        return true
    }
}

/// The counter's keys in the Keyring (Secure Enclave keys "ctr.N").
struct KeyringLockAnchor: LockAnchor {
    let keyring: Keyring

    func generations() -> Set<Int64>? { keyring.counterGenerations() }
    func create(_ gen: Int64) -> Bool { keyring.newCounterKey(gen) }
    func delete(_ gen: Int64) { keyring.delete(Keyring.counterPrefix + String(gen)) }
    func mac(_ gen: Int64, _ data: Data) -> Data? { try? keyring.prf(Keyring.counterPrefix + String(gen), data) }
}

/// The record as a Keychain item (SecureStore "lock").
struct SecureStoreLockRecords: LockRecords {
    let store: SecureStore
    var name = "lock"

    func read() -> JSONObject? {
        do {
            guard let d = try store.read(name) else { return JSONObject() }
            return SecData.json(d) ?? JSONObject([(LockStore.unreadable, .bool(true))])
        } catch {
            return nil
        }
    }

    func write(_ record: JSONObject) -> Bool {
        (try? store.write(name, SecData.json(record), access: .foreground)) != nil
    }
}
