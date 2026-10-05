// Key transparency for this device and its server (the KT part of Android
// chat/P4Device): the HTTP API (server/kt/routes.ts) and the checks run on it.
//
//   GET /api/kt/key                    → { key }      the KT public key (raw Ed25519, b64) — pinned on first use
//   GET /api/kt/sth                    → SignedTreeHead
//   GET /api/kt/lookup?u=<u>   Bearer  → KtLookup     the CALLER's own entries only (a member's: the hub's kt-lookup)
//   GET /api/kt/consistency?from=&to=  → { from, to, proof }
//   503 kt-off / kt-failed / kt-busy: no key transparency there — nothing to check.
//
// refresh (at most every 10 minutes): pin the key, update to the newest head,
// ask again for proofs that could not be asked for, check this account's own
// entries (an unknown device or another account key raises the alert).

import Foundation

public struct KtClient: Sendable {
    public let http: HTTPClient
    public init(http: HTTPClient = HTTPClient()) { self.http = http }

    public func key(base: String) async throws -> String {
        try await http.json("GET", try HTTPClient.url(base, "/api/kt/key"), maxBytes: 2 << 20).str("key")
    }

    public func sth(base: String) async throws -> NetJSON {
        try await http.json("GET", try HTTPClient.url(base, "/api/kt/sth"), maxBytes: 2 << 20)
    }

    public func consistency(base: String, from: Int64, to: Int64) async throws -> NetJSON {
        try await http.json("GET", try HTTPClient.url(base, "/api/kt/consistency?from=\(from)&to=\(to)"), maxBytes: 2 << 20)
    }

    /// The caller's own entries (§ 14.3): needs the account session.
    public func lookup(base: String, u: String, token: String) async throws -> NetJSON {
        let q = u.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "+&=")))!
        return try await http.json("GET", try HTTPClient.url(base, "/api/kt/lookup?u=\(q)"), headers: ["Authorization": "Bearer \(token)"], maxBytes: 2 << 20)
    }

    /// The fetcher of consistency proofs for KtMonitor (an HTTPError is an answer; NetError.network is none).
    public func fetcher(base: String) -> KtConsistencyFetch {
        let client = self
        return { from, to in try await client.consistency(base: base, from: from, to: to) }
    }
}

/// What this device knows of its own account for the self-check (signed in, with a device certificate).
public struct KtSelf: Sendable {
    public let token: String
    public let username: String
    /// This device's account key as its certificate names it (raw Ed25519, base64).
    public let accountKey: String
    /// This device's key (P-256 SPKI, base64).
    public let devicePublicKey: String
    public init(token: String, username: String, accountKey: String, devicePublicKey: String) {
        self.token = token
        self.username = username
        self.accountKey = accountKey
        self.devicePublicKey = devicePublicKey
    }
}

public actor KtService {
    public let origin: String
    public let client: KtClient
    public let monitor: KtMonitor
    private let ownStore: any NetStateStore
    private let clock: NetClock
    public static let ownKey = "kt-own"
    public static let refreshEveryMs: Millis = 10 * 60_000
    private var refreshedAt: Millis = 0
    private var busy = false

    public init(origin: String, client: KtClient = KtClient(), monitor: KtMonitor, ownStore: any NetStateStore, clock: NetClock = .system) {
        self.origin = origin
        self.client = client
        self.monitor = monitor
        self.ownStore = ownStore
        self.clock = clock
    }

    /// Does this server run key transparency (its KT key is pinned here)?
    public func ktOn() async -> Bool { await monitor.key(origin) != nil }

    /// The newest verified tree head (a hello's `sth`), nil before one.
    public func sth() async -> NetJSON? { await monitor.newest(origin) }

    /// The persistent alert's kind ("" when none).
    public func alertKind() async -> String { await monitor.alert(origin)?.kind ?? "" }

    public enum RefreshResult: Sendable, Equatable {
        /// Ran: the key pin ("new", "match", "changed"), the update's and the retries' outcomes.
        case ran(pin: String, update: String, pending: String, own: String?)
        /// Not due (10 minutes) or already running.
        case skipped
        /// The server has no key transparency (503 kt-…).
        case off(String)
        case failed(String)
    }

    /// Pins the key, checks the newest head, retries waiting proofs, checks own entries (`me`, when signed in).
    public func refresh(me: KtSelf?, force: Bool = false) async -> RefreshResult {
        let now = clock.now()
        if busy || (!force && now - refreshedAt < Self.refreshEveryMs) { return .skipped }
        busy = true
        defer { busy = false }
        let fetch = client.fetcher(base: origin)
        do {
            let pin = try await monitor.pinKey(origin, key: try await client.key(base: origin))
            let up = await monitor.update(origin, sth: try await client.sth(base: origin), fetch: fetch)
            let again = await monitor.retryPending(origin, fetch: fetch)
            var own: String?
            if let me { own = try await selfCheck(me) }
            refreshedAt = clock.now()
            return .ran(pin: pin, update: up.status, pending: again.status, own: own)
        } catch let e as HTTPError {
            refreshedAt = clock.now()
            return e.code.hasPrefix("kt-") ? .off(e.code) : .failed("\(e.status) \(e.message)")
        } catch {
            return .failed("\(error)")
        }
    }

    /// § 14.4 / review P04: this account's own entries — a device or an account key this device does not know
    /// raises the alert. Returns "ok", "unknown-device", "account-key" or the lookup's failure.
    public func selfCheck(_ me: KtSelf) async throws -> String {
        let u = KtLogEntry.user(me.username)
        let answer = try await client.lookup(base: origin, u: u, token: me.token)
        let c = await monitor.lookup(origin, lookup: answer, u: u, fetch: client.fetcher(base: origin))
        guard c.ok else { return c.why ?? "unverified" }
        let verdict = KtService.ownCheck(await ownStore.load(Self.ownKey), u: u, entries: c.entries, apk: me.accountKey, myPk: me.devicePublicKey, now: clock.now())
        await ownStore.save(Self.ownKey, verdict.state)
        if verdict.accountChanged {
            await monitor.raiseAlert(origin, kind: "account-key", detail: "another account key was logged for this account")
            return "account-key"
        }
        if verdict.unknown > 0 {
            await monitor.raiseAlert(origin, kind: "unknown-device", detail: "\(verdict.unknown) device(s) added to this account")
            return "unknown-device"
        }
        return "ok"
    }

    /// What ownCheck found: the monitor's next state, unknown devices, another account key.
    public struct Own: Sendable {
        public let state: NetJSON
        public let unknown: Int
        public let accountChanged: Bool
    }

    /// Review P04 (pure; P4Device.ownCheck): this account's verified entries against what this device knows. The
    /// first check (or one for another account) takes the devices logged so far as known — trust on first use;
    /// from then on a `dev` entry of the current account key that is not known, not this device and not revoked
    /// again is an unknown device (kept in `pending` until dismissed), and an `acct` entry with another key than
    /// this device's account key is another account key.
    public static func ownCheck(_ own: NetJSON?, u: String, entries: [KtLogEntry], apk: String, myPk: String, now: Millis) -> Own {
        var state = own ?? .object([:])
        let first = u != state.str("u") || apk != state.str("apk")
        if first { state = ["u": .string(u), "apk": .string(apk), "known": .object([:])] }
        var known = state.obj("known")?.objectValue ?? [:]
        known[myPk] = .int(now)
        let sorted = entries.sorted { $0.index < $1.index }
        var current = ""
        for e in sorted where e.t == "acct" { current = e.apk }
        let accountChanged = !current.isEmpty && current != apk && current != state.str("acceptedAccount")
        var unknown: [String] = []
        for e in sorted {
            guard e.apk == apk, !e.dpk.isEmpty else { continue }
            if e.t == "dev" {
                if first { known[e.dpk] = .int(now) } else if known[e.dpk] == nil, !unknown.contains(e.dpk) { unknown.append(e.dpk) }
            } else if e.t == "rev" {
                unknown.removeAll { $0 == e.dpk }
            }
        }
        state = state.with("known", .object(known)).with("pending", .strings(unknown)).with("account", .string(current)).with("at", .int(now))
        return Own(state: state, unknown: unknown.count, accountChanged: accountChanged)
    }

    /// The person saw the alert: an unknown device becomes known (it was theirs), another account key is accepted;
    /// the other alerts come back while their cause does.
    public func dismissAlert() async {
        if let a = await monitor.alert(origin), a.kind == "unknown-device" || a.kind == "account-key" {
            var own = await ownStore.load(Self.ownKey) ?? .object([:])
            var known = own.obj("known")?.objectValue ?? [:]
            for p in own.arr("pending") ?? [] { if let k = p.stringValue { known[k] = .int(clock.now()) } }
            own = own.with("known", .object(known)).with("pending", .array([]))
            if a.kind == "account-key" { own = own.with("acceptedAccount", .string(own.str("account"))) }
            await ownStore.save(Self.ownKey, own)
        }
        await monitor.dismissAlert(origin)
    }

    /// A peer's tree head from its hello (§ 14.4 gossip); the consistency check runs when needed.
    @discardableResult
    public func gossip(_ peerSth: NetJSON?) async -> KtOutcome {
        let g = await monitor.gossip(origin, peerSth: peerSth)
        guard g.status == "need-consistency" else { return g }
        return await monitor.resolveGossip(origin, peerSth: peerSth, fetch: client.fetcher(base: origin))
    }

    /// A member's lookup from the hub (`kt-lookup` answer) checked: its head against ours, then inclusion.
    public func checkMemberLookup(_ lookup: NetJSON?) async -> KtCheckedLookup? {
        guard let lookup else { return nil }
        return await monitor.lookup(origin, lookup: lookup, u: nil, fetch: client.fetcher(base: origin))
    }
}
