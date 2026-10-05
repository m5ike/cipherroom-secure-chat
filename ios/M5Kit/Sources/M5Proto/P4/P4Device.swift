// Protocol 4 for this device, across its rooms (android chat/P4Device.java):
// the mailbox (own bundles, private keys in the vault, § 7.1), the account
// attestation (a v2 device certificate by the account key while signed in,
// § 12.3) and what goes to the key directory (PUT /api/keys/bundle, § 7.5),
// key transparency for the server (the pinned KT key, the newest verified
// tree head, gossip, the own-entries monitor — § 14.4). The HTTP calls are
// M5Net's: it calls `refreshKt` / `selfCheck` with what the server answered.

import Foundation
import M5Core
import M5Crypto
import Synchronization

/// The signed-in account, as protocol 4 needs it (the app's account module implements it).
public protocol P4AccountProvider: Sendable {
    var signedIn: Bool { get }
    var username: String { get }
    /// The account session token for authenticated lookups ("" when none).
    var token: String { get }
    /// The account key's 32-byte Ed25519 seed while signed in with the account root on this device; nil otherwise.
    func accountSeed() -> Bytes?
}

public final class P4Device: Sendable {
    public let store: P4Store
    public let kt: KtState
    /// The server whose key transparency this device follows (its origin).
    public let origin: String
    private let account: (any P4AccountProvider)?
    private let clock: any Clock
    private let rng: any Rng

    private struct State: Sendable {
        var mailbox: Mailbox?
        var mailboxOwner = ""
        var quotaMark = ""
        var ktRefreshedAt: Int64 = 0
    }
    private let state = Mutex(State())

    public init(store: P4Store, origin: String, account: (any P4AccountProvider)?, clock: any Clock = SystemClock(), rng: (any Rng)? = nil) {
        self.store = store
        self.origin = origin
        self.account = account
        self.clock = clock
        self.rng = rng ?? SystemRng()
        self.kt = KtState(store: store.kt, clock: clock)
    }

    /* ------------------------------------------------------------ mailbox */

    public func mailbox(_ id: ChatIdentity) -> Mailbox {
        state.withLock { s in
            if let m = s.mailbox, s.mailboxOwner == id.publicKey { return m }
            let m = Mailbox(store: store.mailbox, signer: IdentitySigner(id), rng: rng)
            s.mailbox = m
            s.mailboxOwner = id.publicKey
            return m
        }
    }

    /// The current bundle for the hello's `mb` (renewed when due — only while `unlocked`), or nil.
    public func bundle(_ id: ChatIdentity, unlocked: Bool) -> JSONObject? {
        let now = clock.now()
        if !unlocked {
            // Locked (the rooms keep receiving): no new bundle now — its private keys could not be stored safely.
            return store.mailbox.all().filter { $0.bundle.exp > now }.max { $0.bundle.exp < $1.bundle.exp }?.bundle.json
        }
        do { return try mailbox(id).current(now)?.bundle.json } catch {
            M5Log.shared.warn("p4", "no mailbox bundle: \(error)")
            return nil
        }
    }

    /* -------------------------------------------------- account (§ 12.3) */

    /// The hello's `acc` {apk, ac, cv:2, exp} while signed in with the account root here; the certificate is
    /// renewed when less than a third of its lifetime is left. Nil otherwise.
    public func account(_ id: ChatIdentity) -> JSONObject? {
        guard let account, account.signedIn else { return nil }
        let now = clock.now()
        var cert = store.cert
        let fresh = id.publicKey == cert.optString("pk") && account.username == cert.optString("user")
            && cert.optInt64("exp") - now > P4.deviceCertLifetimeMs / 3
        if !fresh {
            guard var seed = account.accountSeed() else { return nil }
            defer { ByteOps.wipe(&seed) }
            do {
                let exp = now + P4.deviceCertLifetimeMs - 60_000
                let v2 = try Handshake.certifyDeviceV2(accountSeed: seed, devicePk: id.publicKey, exp: exp, now: now)
                cert = JSONObject([("apk", .string(Prim.b64(try Prim.ed25519Public(seed)))), ("pk", .string(id.publicKey)), ("exp", .int(exp)),
                                   ("sig", v2["sig"] ?? .null), ("user", .string(account.username))])
                store.putCert(cert)
            } catch {
                M5Log.shared.warn("p4", "no device certificate: \(error)")
                return nil
            }
        }
        guard let apk = cert.string("apk"), let sig = cert.string("sig"), let exp = cert.int64("exp") else { return nil }
        return JSONObject([("apk", .string(apk)), ("ac", .string(sig)), ("cv", 2), ("exp", .int(exp))])
    }

    /// This device's account key as its certificate names it — "" when signed out or not certified yet.
    public func myAccountKey(_ id: ChatIdentity) -> String {
        guard let account, account.signedIn else { return "" }
        let cert = store.cert
        return id.publicKey == cert.optString("pk") && account.username == cert.optString("user") ? cert.optString("apk") : ""
    }

    /// The key directory upload (PUT /api/keys/bundle) when the bundle or certificate is new since the last one:
    /// its body and its mark (hand the mark to `uploaded` / `quotaRefused` with the answer); nil when nothing is due.
    public func uploadBody(_ id: ChatIdentity, unlocked: Bool) -> (body: JSONObject, mark: String)? {
        guard let account, account.signedIn, let acc = self.account(id), let mb = bundle(id, unlocked: unlocked) else { return nil }
        let mark = mb.optString("id") + "|" + String(acc.optInt64("exp")) + "|" + account.username
        if mark == store.cert.optString("uploaded") || mark == state.withLock({ $0.quotaMark }) { return nil }
        let body = JSONObject([("pk", .string(id.publicKey)),
                               ("cert", .object(JSONObject([("v", 2), ("exp", acc["exp"]!), ("sig", acc["ac"]!)]))),
                               ("bundle", .object(mb)), ("apk", acc["apk"]!)])
        return (body, mark)
    }

    /// The directory has this upload.
    public func uploaded(_ mark: String) {
        var cert = store.cert
        cert["uploaded"] = .string(mark)
        store.putCert(cert)
    }

    /// 6.12 review S10: 429 kt-quota — not tried again in this session.
    public func quotaRefused(_ mark: String) { state.withLock { $0.quotaMark = mark } }

    /* ------------------------------------------- key transparency (§ 14) */

    /// Does this server run key transparency (its KT key is pinned here)?
    public func ktOn() async -> Bool { await kt.key(origin) != nil }

    /// The newest verified tree head for the hello's `sth` (nil before one).
    public func sth() async -> JSONObject? { await kt.newest(origin) }

    /// Is a refresh due (at most every 10 minutes)?
    public func ktRefreshDue() -> Bool { clock.now() - state.withLock { $0.ktRefreshedAt } >= 10 * 60_000 }

    /// The server's KT key and newest head (GET /api/kt/key, /api/kt/sth): pinned on first use, checked against
    /// the head kept; the proofs that could not be asked for are asked again. Returns the update's status.
    public func refreshKt(key: String, sth: JSONObject, fetch: Kt.ConsistencyFetcher) async -> (pin: String, update: String, retry: String) {
        let pin = (try? await kt.pinKey(origin, key)) ?? "bad-key"
        if pin == "changed" { M5Log.shared.warn("p4", "the server's key-transparency key changed — alert kept") }
        let up = await kt.update(origin, .object(sth), fetch: fetch)
        let again = await kt.retryPending(origin, fetch: fetch)
        state.withLock { $0.ktRefreshedAt = clock.now() }
        return (pin, up.status, again.status)
    }

    /// § 14.4 / review P04: this account's own entries (GET /api/kt/lookup with the session) — a device or an
    /// account key this device does not know raises the alert. Returns the lookup's verdict.
    public func selfCheck(_ id: ChatIdentity, lookup: JSONObject, fetch: Kt.ConsistencyFetcher) async -> Kt.Checked? {
        let apk = myAccountKey(id)
        guard !apk.isEmpty, let account else { return nil }
        let u = Kt.user(account.username)
        let c = await kt.lookup(origin, lookup, u: u, fetch: fetch)
        guard c.ok else { M5Log.shared.warn("p4", "own key-transparency entries: \(c.why ?? "")"); return c }
        let verdict = P4Device.ownCheck(store.own, u: u, entries: c.entries, apk: apk, myPk: id.publicKey, now: clock.now())
        store.putOwn(verdict.state)
        if verdict.accountChanged { await kt.raiseAlert(origin, kind: "account-key", detail: "another account key was logged for this account") }
        else if verdict.unknown > 0 { await kt.raiseAlert(origin, kind: "unknown-device", detail: "\(verdict.unknown) device(s) added to this account") }
        return c
    }

    /// The lookup path of the own entries: "/api/kt/lookup?u=" + the user's KT id.
    public func selfLookupPath() -> String? {
        guard let account, account.signedIn else { return nil }
        return "/api/kt/lookup?u=" + (Kt.user(account.username).addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")
    }

    /// What `ownCheck` found: the monitor's next state, unknown devices, another account key.
    public struct Own: Sendable {
        public let state: JSONObject
        public let unknown: Int
        public let accountChanged: Bool
    }

    /// Review P04 (pure): this account's verified entries against what this device knows — trust on first use
    /// for the devices logged at the first check; later an unknown `dev` of the current account key (not this
    /// device, not revoked again) is an unknown device, an `acct` with another key another account key.
    public static func ownCheck(_ own: JSONObject?, u: String, entries: [Kt.Entry], apk: String, myPk: String, now: Int64) -> Own {
        var state = own ?? JSONObject()
        let first = u != state.optString("u") || apk != state.optString("apk")
        if first { state = JSONObject([("u", .string(u)), ("apk", .string(apk)), ("known", .object(JSONObject()))]) }
        var known = state.object("known") ?? JSONObject()
        known[myPk] = .int(now)
        let sorted = entries.enumerated().sorted { ($0.element.index, $0.offset) < ($1.element.index, $1.offset) }.map(\.element)
        var current = ""
        for e in sorted where e.entry.optString("t") == "acct" { current = e.entry.optString("apk") }
        let accountChanged = !current.isEmpty && current != apk && current != state.optString("acceptedAccount")
        var unknown = OrderedMap<String, Bool>()
        for e in sorted {
            let t = e.entry.optString("t"), dpk = e.entry.optString("dpk")
            if apk != e.entry.optString("apk") || dpk.isEmpty { continue }
            if t == "dev" {
                if first { known[dpk] = .int(now) } else if !known.has(dpk) { unknown[dpk] = true }
            } else if t == "rev" { unknown.remove(dpk) }
        }
        state["known"] = .object(known)
        state["pending"] = .array(unknown.keys.map { .string($0) })
        state["account"] = .string(current)
        state["at"] = .int(now)
        return Own(state: state, unknown: unknown.count, accountChanged: accountChanged)
    }

    /// Settings › the key-transparency alert, dismissed: an unknown device of this account becomes known, another
    /// account key is accepted; the other alerts come back while their cause does.
    public func dismissKtAlert() async {
        guard let a = await kt.alert(origin) else { return }
        if a.kind == "unknown-device" || a.kind == "account-key" {
            var own = store.own
            var known = own.object("known") ?? JSONObject()
            for p in own.array("pending") ?? [] { if let k = p.stringValue { known[k] = .int(clock.now()) } }
            own["known"] = .object(known)
            own["pending"] = .array([])
            if a.kind == "account-key" { own["acceptedAccount"] = .string(own.optString("account")) }
            store.putOwn(own)
        }
        await kt.dismissAlert(origin)
    }

    /// A peer's tree head from its hello (§ 14.4 gossip); resolved with the server's proof when needed.
    @discardableResult
    public func gossip(_ peerSth: JSON?, fetch: Kt.ConsistencyFetcher?) async -> String {
        guard peerSth?.objectValue != nil else { return "ignored" }
        let g = await kt.gossip(origin, peerSth)
        if g.status == "need-consistency", let fetch {
            let r = await kt.resolveGossip(origin, peerSth, fetch: fetch)
            if r.status != "ok" { M5Log.shared.warn("p4", "key transparency gossip: \(r.status)") }
            return r.status
        }
        if g.status == "split-view" { M5Log.shared.warn("p4", "key transparency: split view") }
        return g.status
    }

    /// The persistent alert for this server ("" when none): inconsistent, split-view, key-changed, unproven, …
    public func ktAlert() async -> String { await kt.alert(origin)?.kind ?? "" }
}
