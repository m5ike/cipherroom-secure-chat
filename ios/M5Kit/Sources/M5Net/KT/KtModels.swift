// Key transparency, the client's models (docs/protocol-v4.md § 14; Android
// p4/Kt): the server keeps an append-only Merkle log of every account key,
// device certification and revocation, and signs its tree heads with an
// Ed25519 key the client pins per server. The verification itself (STH
// signatures, Merkle inclusion and consistency proofs) is M5Crypto's
// (KtVerifier); M5Net holds the state machine (KtMonitor), the HTTP calls
// (KtClient) and the checks of an account's own entries (KtService).

import Foundation
import M5Core
import M5Crypto

/// The crypto of key transparency (M5Crypto: Kt.verifySth, Kt.verifyLookup, Merkle.verifyConsistency).
public protocol KtVerifier: Sendable {
    /// Is `sth` {size, root, ts, sig} well-formed and signed by `key` (raw Ed25519, base64) over
    /// "m5cet/kt/sth/4|size|root|ts"?
    func verifySTH(_ sth: NetJSON, key: String) -> Bool
    /// Is the tree of size `from` (root `fromRoot`) a prefix of the tree of size `to` (root `toRoot`) by `proof`
    /// (RFC 6962 consistency proof, 32-byte hashes)?
    func verifyConsistency(from: Int64, to: Int64, fromRoot: Data, toRoot: Data, proof: [Data]) -> Bool
    /// A lookup {sth, entries: [{entry, index, proof}]} checked against its own head: the head's signature, every
    /// entry's user `u` (when given) and its inclusion proof.
    func verifyLookup(_ lookup: NetJSON, key: String, u: String?) -> KtCheckedLookup
}

/// One verified log entry: {t: acct|dev|rev, u, apk, dpk?, exp?, ts} and its index in the log.
public struct KtLogEntry: Sendable, Equatable {
    public let entry: NetJSON
    public let index: Int64
    public init(entry: NetJSON, index: Int64) {
        self.entry = entry
        self.index = index
    }

    public var t: String { entry.str("t") }
    public var apk: String { entry.str("apk") }
    public var dpk: String { entry.str("dpk") }
    public var u: String { entry.str("u") }

    /// § 14.1: u = b64url(SHA-256("m5cet/kt/user|" + username)) — a public, unkeyed hash of the username.
    public static func user(_ username: String) -> String { Bytes.b64url(Bytes.sha256("m5cet/kt/user|" + username)) }

    /// What the entries of one user say about account key `apk` and device key `dpk` (Kt.deviceStatus): the account
    /// key is the CURRENT one (the latest `acct`), the device is certified (a `dev` entry not expired at `now`), and
    /// no `rev` for it comes after its latest `dev` entry.
    public static func deviceStatus(_ entries: [KtLogEntry], apk: String, dpk: String, now: Millis) -> KtDeviceStatus {
        let sorted = entries.sorted { $0.index < $1.index }
        var lastAcct: KtLogEntry?, lastDev: KtLogEntry?
        for e in sorted {
            if e.t == "acct" { lastAcct = e }
            if e.t == "dev", e.apk == apk, e.dpk == dpk { lastDev = e }
        }
        let account = lastAcct?.apk == apk && lastAcct != nil
        let device = (lastDev?.entry.int("exp") ?? 0) > now && lastDev != nil
        var revoked = false
        for e in sorted where e.t == "rev" && e.apk == apk && e.dpk == dpk && (lastDev == nil || e.index > lastDev!.index) { revoked = true }
        return KtDeviceStatus(account: account, device: device, revoked: revoked)
    }
}

public struct KtDeviceStatus: Sendable, Equatable {
    public let account: Bool
    public let device: Bool
    public let revoked: Bool
    public var ok: Bool { account && device && !revoked }
}

/// A lookup checked (Kt.Checked): its head and entries when it verified, else why not
/// (bad-signature, malformed, not-included, wrong-user, or a KtMonitor.update status).
public struct KtCheckedLookup: Sendable, Equatable {
    public let ok: Bool
    public let why: String?
    public let sth: NetJSON?
    public let entries: [KtLogEntry]

    public init(ok: Bool, why: String?, sth: NetJSON?, entries: [KtLogEntry]) {
        self.ok = ok
        self.why = why
        self.sth = sth
        self.entries = entries
    }

    public static func no(_ why: String) -> KtCheckedLookup { KtCheckedLookup(ok: false, why: why, sth: nil, entries: []) }
}

/// A persistent alert: inconsistent, split-view, key-changed, unproven, unknown-device, account-key.
public struct KtAlert: Sendable, Equatable {
    public let kind: String
    public let at: Millis
    public let detail: String
    public init(kind: String, at: Millis, detail: String) {
        self.kind = kind
        self.at = at
        self.detail = detail
    }
    public var json: NetJSON { ["kind": .string(kind), "at": .int(at), "detail": .string(detail)] }
    public init?(_ j: NetJSON?) {
        guard let j, !j.str("kind").isEmpty else { return nil }
        self.init(kind: j.str("kind"), at: j.int("at"), detail: j.str("detail"))
    }
}

/// One server's KT state (Kt.OriginState): its pinned key, the newest verified head, the alert, and the heads whose
/// consistency the server could not be asked to prove yet ([{sth, via: "update" | "gossip", since}], at most 8).
public struct KtOriginState: Sendable, Equatable {
    public var key: String?
    public var sth: NetJSON?
    public var alert: KtAlert?
    public var pending: [NetJSON]?

    public init(key: String? = nil, sth: NetJSON? = nil, alert: KtAlert? = nil, pending: [NetJSON]? = nil) {
        self.key = key
        self.sth = sth
        self.alert = alert
        self.pending = (pending?.isEmpty ?? true) ? nil : pending
    }

    /// The record as Android keeps it.
    public var json: NetJSON {
        .compact(["key": key.map { .string($0) }, "sth": sth, "alert": alert?.json, "pending": pending.map { .array($0) }])
    }

    public init(json o: NetJSON) {
        let k = o.str("key")
        self.init(key: k.isEmpty ? nil : k, sth: o.obj("sth"), alert: KtAlert(o.obj("alert")), pending: o.arr("pending"))
    }
}

/// Persistent per-server KT state (Android keeps it in the vault's user tier).
public protocol KtStateStore: Sendable {
    func get(_ origin: String) async -> KtOriginState?
    func set(_ origin: String, _ state: KtOriginState) async
}

/// KT state in a NetStateStore document ("kt": { origin: OriginState }).
public actor StoredKtStateStore: KtStateStore {
    private let store: any NetStateStore
    private let key: String
    public init(store: any NetStateStore, key: String = "kt") {
        self.store = store
        self.key = key
    }
    public func get(_ origin: String) async -> KtOriginState? {
        guard let o = await store.load(key)?.obj(origin) else { return nil }
        return KtOriginState(json: o)
    }
    public func set(_ origin: String, _ state: KtOriginState) async {
        let all = await store.load(key) ?? .object([:])
        await store.save(key, all.with(origin, state.json))
    }
}

public actor MemoryKtStateStore: KtStateStore {
    private var rows: [String: KtOriginState] = [:]
    public init() {}
    public func get(_ origin: String) async -> KtOriginState? { rows[origin] }
    public func set(_ origin: String, _ state: KtOriginState) async { rows[origin] = state }
}

/// The outcome of KtMonitor.update / gossip (Kt.Outcome): ok, no-key, bad-signature, inconsistent, unknown, ignored,
/// need-consistency, split-view, pending (server unreachable), unproven (pending too long).
public struct KtOutcome: Sendable, Equatable {
    public let status: String
    public let alert: KtAlert?
    public let from: Int64
    public let to: Int64
    public init(_ status: String, alert: KtAlert? = nil, from: Int64 = 0, to: Int64 = 0) {
        self.status = status
        self.alert = alert
        self.from = from
        self.to = to
    }
}

/// Fetches GET /api/kt/consistency?from=&to= → {from, to, proof}. NetError.network means "no answer at all"
/// (unreachable — asked again later); anything else between two heads the pinned key signed is the alert.
public typealias KtConsistencyFetch = @Sendable (_ from: Int64, _ to: Int64) async throws -> NetJSON
