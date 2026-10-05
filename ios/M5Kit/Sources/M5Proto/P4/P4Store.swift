// What protocol 4 keeps on this device, encrypted in the vault (android
// chat/P4Store.java; user tier, like the identity and the pins):
//
//   p4.mailbox    this device's mailbox bundles with their private keys (§ 7.1)
//   p4.seen       device key id → when it was first seen with a valid v4 hello (the downgrade rule, § 1)
//   p4.bundles    device key id → a peer device seen in a valid hello v4 (the device pin, § 7.4)
//   p4.refs       member reference → the account key pinned for it (§ 7.4, review P01)
//   p4.accounts   account pins (§ 12.2): apk → {kids, user, at, verified, verifiedName}; users: username → apk
//   p4.kt         key transparency per server (§ 14.4)
//   p4.own        this account's own key-transparency monitor (§ 14.4, review P04)
//   p4.cert       this device's v2 certificate by the account key and what was uploaded
//   p4.replay.*   accepted message ids per room (§ 11), as replay keys — never a readable id
//
// One instance per app, thread-safe. Records read while locked are empty
// stand-ins, never written over the stored ones; changes made then are kept
// and written at the unlock (`flush`).

import Foundation
import M5Core
import M5Crypto
import Synchronization

public final class P4Store: Sendable {
    /// Every record but the replay windows.
    public static let records = ["p4.seen", "p4.bundles", "p4.refs", "p4.mailbox", "p4.accounts", "p4.kt", "p4.own", "p4.cert"]

    private struct State: Sendable {
        var cache = [String: JSONObject]()
        var standIns = Set<String>()
        var dirty = Set<String>()
        var pendingReplay = [String: JSONObject]()
    }

    private let backend: any RecordVault
    private let clock: any Clock
    private let state = Mutex(State())

    public init(backend: any RecordVault, clock: any Clock = SystemClock()) { self.backend = backend; self.clock = clock }

    private func read(_ s: inout State, _ name: String) -> JSONObject {
        if let o = s.cache[name] { return o }
        var o = backend.record(name)
        if o == nil { s.standIns.insert(name); o = JSONObject() }
        s.cache[name] = o!
        return o!
    }

    private func write(_ s: inout State, _ name: String, _ value: JSONObject) {
        s.cache[name] = value
        if s.standIns.contains(name) { return } // never an empty stand-in over what the vault holds
        if !backend.put(name, value) { s.dirty.insert(name) }
    }

    private func update(_ name: String, _ body: (inout JSONObject) -> Bool) {
        state.withLock { s in
            var o = read(&s, name)
            if body(&o) { write(&s, name, o) }
        }
    }

    /// Reads every record now (before a lock takes the data key).
    public func warm() { state.withLock { s in for r in P4Store.records { _ = read(&s, r) } } }

    /// After the unlock: what changed while locked into the vault; stand-ins forgotten (read again).
    public func flush() {
        state.withLock { s in
            for name in s.standIns { s.cache[name] = nil }
            s.standIns.removeAll()
            for name in s.dirty { if let v = s.cache[name], backend.put(name, v) { s.dirty.remove(name) } }
            for (name, v) in s.pendingReplay where backend.put(name, v) { s.pendingReplay[name] = nil }
        }
    }

    /// Forgets what is cached (the vault was wiped).
    public func reset() { state.withLock { $0 = State() } }

    static func kid(_ pk: String) -> String { pk.isEmpty || B64.decode(pk) == nil ? "" : Ec.kid(pk) }

    /* ---------------------------------------------------- downgrade (§ 1) */

    public func p4Seen(_ pk: String) -> Bool {
        let k = P4Store.kid(pk)
        return !k.isEmpty && state.withLock { read(&$0, "p4.seen").has(k) }
    }

    public func markP4(_ pk: String) {
        let k = P4Store.kid(pk)
        if k.isEmpty { return }
        let now = clock.now()
        update("p4.seen") { o in
            if o.has(k) { return false }
            o[k] = .int(now)
            return true
        }
    }

    /* ------------------------------------------------- peers' devices (§ 7) */

    /// A peer device seen in a valid hello v4 (the device pin): its newest bundle and its hello's account attestation.
    public struct Remembered: Sendable {
        public let pk: String
        public let bundle: Mailbox.Bundle?
        public let acc: JSONObject?
    }

    /// A peer device's valid hello v4 in room `roomId` (review P01): filed under ONE member reference per room —
    /// the first it was seen with; never under a reference pinned to another account.
    public func rememberDevice(roomId: String?, pk: String, bundle: Mailbox.Bundle?, acc: JSONObject?, accApk: String?, ref: String?) {
        let k = P4Store.kid(pk)
        if k.isEmpty { return }
        let now = clock.now()
        let pinned = ref.map { refAccount($0) } ?? ""
        update("p4.bundles") { all in
            var row = all.object(k) ?? JSONObject([("pk", .string(pk))])
            let prev = Mailbox.Bundle.parse(row["bundle"])
            if let bundle, prev == nil || prev!.exp <= bundle.exp { row["bundle"] = .object(bundle.json) }
            if let acc { row["acc"] = .object(acc) } else { row["acc"] = nil }
            if let roomId, let ref, !ref.isEmpty {
                var refs = row.object("refs") ?? JSONObject()
                let slot = History.hashKey(roomId)
                if !refs.has(slot) && (pinned.isEmpty || pinned == accApk) { refs[slot] = .string(ref) }
                row["refs"] = .object(refs)
            }
            row["at"] = .int(now)
            all[k] = .object(row)
            // Bounded: the oldest go first.
            while all.count > 2000 {
                var oldest: String?
                var at = Int64.max
                for (key, v) in all { let t = v.objectValue?.optInt64("at") ?? 0; if t < at { at = t; oldest = key } }
                guard let o = oldest else { break }
                all[o] = nil
            }
            return true
        }
    }

    /// A newer bundle of a device already pinned (its relayed item carried it); a device never seen in a hello is not remembered.
    public func updateBundle(_ pk: String, _ bundle: Mailbox.Bundle?) {
        let k = P4Store.kid(pk)
        guard !k.isEmpty, let bundle else { return }
        update("p4.bundles") { all in
            guard var row = all.object(k) else { return false }
            if let prev = Mailbox.Bundle.parse(row["bundle"]), prev.exp >= bundle.exp { return false }
            row["bundle"] = .object(bundle.json)
            all[k] = .object(row)
            return true
        }
    }

    /// The pinned devices filed under a member reference (any room), with whatever bundle they last showed.
    public func devicesOfRef(_ ref: String?) -> [Remembered] {
        guard let ref, !ref.isEmpty else { return [] }
        return state.withLock { s in
            var out = [Remembered]()
            for (_, v) in read(&s, "p4.bundles") {
                guard let row = v.objectValue, let refs = row.object("refs") else { continue }
                if !refs.contains(where: { $0.value.stringValue == ref }) { continue }
                out.append(Remembered(pk: row.optString("pk"), bundle: Mailbox.Bundle.parse(row["bundle"]), acc: row.object("acc")))
            }
            return out
        }
    }

    /* --------------------------------------- member references (§ 7.4, P01) */

    /// The account key pinned for a member reference ("" when none).
    public func refAccount(_ ref: String?) -> String {
        guard let ref else { return "" }
        return state.withLock { read(&$0, "p4.refs").object(ref)?.optString("apk") ?? "" }
    }

    /// A live member under reference `ref` showed a valid attestation by `apk`: "new" (pinned now), "match", or "changed".
    public func pinRef(_ ref: String?, _ apk: String?) -> String {
        guard let ref, !ref.isEmpty, let apk, !apk.isEmpty else { return "new" }
        let old = refAccount(ref)
        if old == apk { return "match" }
        if !old.isEmpty { return "changed" }
        repinRef(ref, apk)
        return "new"
    }

    /// The person accepted (or verified) this member's account: the reference now pins `apk`.
    public func repinRef(_ ref: String?, _ apk: String?) {
        guard let ref, !ref.isEmpty, let apk, !apk.isEmpty else { return }
        let now = clock.now()
        update("p4.refs") { all in
            all[ref] = .object(JSONObject([("apk", .string(apk)), ("at", .int(now))]))
            while all.count > 5000 {
                var oldest: String?
                var at = Int64.max
                for (key, v) in all { let t = v.objectValue?.optInt64("at") ?? 0; if t < at { at = t; oldest = key } }
                guard let o = oldest else { break }
                all[o] = nil
            }
            return true
        }
    }

    /* --------------------------------------------------- own mailbox (§ 7.1) */

    /// This device's bundles with their private keys, in the vault.
    public var mailbox: any MailboxStore { P4MailboxStore(store: self) }

    func mailboxAll() -> [Mailbox.Keys] {
        state.withLock { s in (read(&s, "p4.mailbox").array("bundles") ?? []).compactMap { try? Mailbox.Keys.parse($0.objectValue) } }
    }

    func mailboxPut(_ keys: Mailbox.Keys) {
        update("p4.mailbox") { o in
            var next = (o.array("bundles") ?? []).filter { $0.objectValue?.object("bundle")?.optString("id") != keys.bundle.id }
            next.append(.object(keys.json))
            o["bundles"] = .array(next)
            return true
        }
    }

    func mailboxRemove(_ id: String) {
        update("p4.mailbox") { o in
            o["bundles"] = .array((o.array("bundles") ?? []).filter { $0.objectValue?.object("bundle")?.optString("id") != id })
            return true
        }
    }

    /* -------------------------------------------------- account pins (§ 12.2) */

    static func userKey(_ username: String?) -> String { (username ?? "").javaTrimmed.lowercased() }

    /// An attested device: the account key is pinned across rooms. "new", "match", or "changed" (the username is pinned to another account key).
    public func pinAccount(_ apk: String, devicePk: String, username: String?) -> String {
        let now = clock.now()
        var verdict = "new"
        update("p4.accounts") { root in
            var accounts = root.object("apk") ?? JSONObject(), users = root.object("users") ?? JSONObject()
            let u = P4Store.userKey(username)
            var row = accounts.object(apk)
            if !u.isEmpty && users.has(u) && users.optString(u) != apk { verdict = "changed"; return false } // the old pin stays until accepted
            verdict = row == nil ? "new" : "match"
            if row == nil { row = JSONObject([("at", .int(now)), ("kids", .object(JSONObject()))]) }
            var kids = row!.object("kids") ?? JSONObject()
            let k = P4Store.kid(devicePk)
            if !k.isEmpty && !kids.has(k) { kids[k] = .int(now) }
            row!["kids"] = .object(kids)
            if !u.isEmpty { users[u] = .string(apk); row!["user"] = .string(u) }
            accounts[apk] = .object(row!)
            root["apk"] = .object(accounts)
            root["users"] = .object(users)
            return true
        }
        return verdict
    }

    /// May a message be sealed to this account key: not when the username is pinned to another account key.
    public func accountAllowed(_ apk: String, username: String?) -> Bool {
        let u = P4Store.userKey(username)
        return state.withLock { s in
            guard let users = read(&s, "p4.accounts").object("users"), !u.isEmpty, users.has(u) else { return true }
            return users.optString(u) == apk
        }
    }

    /// The user accepted a changed account: the username now pins `apk`.
    public func acceptAccount(_ apk: String, devicePk: String, username: String?) {
        let u = P4Store.userKey(username)
        update("p4.accounts") { root in
            if var users = root.object("users"), !u.isEmpty { users[u] = nil; root["users"] = .object(users) }
            return true
        }
        _ = pinAccount(apk, devicePk: devicePk, username: username)
    }

    /// "match" when this account key is pinned, else "new" (nothing is pinned).
    public func accountKnown(_ apk: String?) -> String {
        guard let apk else { return "new" }
        return state.withLock { read(&$0, "p4.accounts").object("apk")?.has(apk) ?? false } ? "match" : "new"
    }

    public func accountVerified(_ apk: String?) -> Bool {
        guard let apk else { return false }
        return state.withLock { read(&$0, "p4.accounts").object("apk")?.object(apk)?.bool("verified") ?? false }
    }

    /// Review P08: the display name the person verified the account under ("" when unknown).
    public func accountVerifiedName(_ apk: String?) -> String {
        guard let apk else { return "" }
        return state.withLock { read(&$0, "p4.accounts").object("apk")?.object(apk)?.optString("verifiedName") ?? "" }
    }

    /// `name`: the display name it was verified under (review P08).
    public func setAccountVerified(_ apk: String?, _ on: Bool, name: String? = nil) {
        guard let apk else { return }
        update("p4.accounts") { root in
            guard var accounts = root.object("apk"), var row = accounts.object(apk) else { return false }
            row["verified"] = .bool(on)
            if on, let n = name?.javaTrimmed, !n.isEmpty { row["verifiedName"] = .string(n) }
            if !on { row["verifiedName"] = nil }
            accounts[apk] = .object(row)
            root["apk"] = .object(accounts)
            return true
        }
    }

    /* ------------------------------------- own KT entries (§ 14.4, P04) */

    public var own: JSONObject { state.withLock { read(&$0, "p4.own") } }

    public func putOwn(_ own: JSONObject) { state.withLock { write(&$0, "p4.own", own) } }

    /* ------------------------------------------------ key transparency (§ 14) */

    public var kt: any KtStore { P4KtStore(store: self) }

    func ktGet(_ origin: String) -> Kt.OriginState? { state.withLock { Kt.OriginState.parse(read(&$0, "p4.kt").object(origin)) } }

    func ktSet(_ origin: String, _ st: Kt.OriginState) {
        update("p4.kt") { o in o[origin] = .object(st.json); return true }
    }

    /* ---------------------------------------------- own certificate (§ 12.3) */

    public var cert: JSONObject { state.withLock { read(&$0, "p4.cert") } }

    public func putCert(_ cert: JSONObject) { state.withLock { write(&$0, "p4.cert", cert) } }

    /* ------------------------------------------------------- replay (§ 11) */

    public static func replayName(_ roomId: String?) -> String { "p4.replay." + History.hashKey(roomId ?? "") }

    /// The replay window of one room; a stand-in (`persistent` false) while the stored one cannot be read (review P10).
    public func replay(_ roomId: String) -> P4ReplayWindow {
        let w = P4ReplayWindow()
        if let saved = backend.recordStrict(P4Store.replayName(roomId)) {
            w.load(roomId, P4Store.rows(saved))
        } else {
            w.setStandIn(true)
            w.load(roomId, OrderedMap())
        }
        return w
    }

    static func rows(_ saved: JSONObject) -> OrderedMap<String, Int64> {
        var rows = OrderedMap<String, Int64>()
        for (k, v) in saved.object("ids") ?? JSONObject() { rows[k] = v.int64Value ?? Int64(v.doubleValue ?? 0) }
        return rows
    }

    /// A stand-in window tries to read the stored one again (true when it now is the stored one).
    public func reloadReplay(_ roomId: String, _ window: P4ReplayWindow) -> Bool {
        if window.persistent { return true }
        guard let saved = backend.recordStrict(P4Store.replayName(roomId)) else { return false }
        window.merge(roomId, stored: P4Store.rows(saved))
        window.setStandIn(false)
        return true
    }

    /// Saves a room's window (while locked: kept, written at the unlock).
    public func saveReplay(_ roomId: String, _ window: P4ReplayWindow) {
        if !window.persistent { return }
        let value = JSONObject([("ids", .object(window.snapshotObject(roomId)))])
        let name = P4Store.replayName(roomId)
        if backend.put(name, value) { state.withLock { $0.pendingReplay[name] = nil } } else { state.withLock { $0.pendingReplay[name] = value } }
    }
}

struct P4MailboxStore: MailboxStore {
    let store: P4Store
    func all() -> [Mailbox.Keys] { store.mailboxAll() }
    func put(_ keys: Mailbox.Keys) { store.mailboxPut(keys) }
    func remove(_ id: String) { store.mailboxRemove(id) }
}

struct P4KtStore: KtStore {
    let store: P4Store
    func get(_ origin: String) -> Kt.OriginState? { store.ktGet(origin) }
    func set(_ origin: String, _ state: Kt.OriginState) { store.ktSet(origin, state) }
}

/// A room's replay window (android P4Store.Store): insertion-ordered ids with their times; a stand-in while the
/// stored window cannot be read — in memory only, never saved over the stored one.
public final class P4ReplayWindow: ReplayStore {
    private struct State: Sendable {
        var rooms = [String: OrderedMap<String, Int64>]()
        var standIn = false
    }
    private let state = Mutex(State())

    public init() {}

    /// Is this window the stored one (not a stand-in)?
    public var persistent: Bool { state.withLock { !$0.standIn } }
    func setStandIn(_ on: Bool) { state.withLock { $0.standIn = on } }

    func load(_ roomId: String, _ rows: OrderedMap<String, Int64>) { state.withLock { $0.rooms[roomId] = rows } }

    /// The stored ids first (older), then those accepted while it could not be read.
    func merge(_ roomId: String, stored: OrderedMap<String, Int64>) {
        state.withLock { s in
            var merged = stored
            for (k, v) in s.rooms[roomId]?.entries ?? [] { merged[k] = v }
            s.rooms[roomId] = merged
        }
    }

    func snapshotObject(_ roomId: String) -> JSONObject {
        state.withLock { s in JSONObject((s.rooms[roomId]?.entries ?? []).map { ($0.key, JSON.int($0.value)) }) }
    }

    public func has(_ roomId: String, _ key: String) -> Bool { state.withLock { $0.rooms[roomId]?[key] != nil } }

    public func add(_ roomId: String, _ key: String, _ at: Int64) { state.withLock { $0.rooms[roomId, default: OrderedMap()][key] = at } }

    public func prune(_ roomId: String, before: Int64, max: Int) {
        state.withLock { s in
            guard var room = s.rooms[roomId] else { return }
            for (k, at) in room.entries where at < before { room.remove(k) }
            if room.count > max {
                let byAge = room.entries.enumerated().sorted { ($0.element.value, $0.offset) < ($1.element.value, $1.offset) }
                for e in byAge.prefix(room.count - max) { room.remove(e.element.key) }
            }
            s.rooms[roomId] = room
        }
    }

    public func size(_ roomId: String) -> Int { state.withLock { $0.rooms[roomId]?.count ?? 0 } }
}
