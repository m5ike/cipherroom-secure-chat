// Key transparency, client side (docs/protocol-v4.md § 14, F-13; kt.ts;
// android p4/Kt.java). The server keeps an append-only Merkle log of every
// account key, device certification and revocation and signs its tree heads
// with an Ed25519 key the client pins per server. This catches a server that
// shows one user a fake key:
//   * every new tree head must be consistent with the newest one kept;
//   * a lookup's entries must be included in its (signed) head;
//   * gossip: a peer's head (from its hello) of the same size with another
//     root, or not consistent with ours, is a split view.

import M5Core
import Synchronization

public enum Kt {

    /* ------------------------------------------------------------ entries */

    private static func text(_ v: JSON?) throws -> String {
        guard let s = v?.stringValue, !s.isEmpty,
              s.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 43 || $0 == 47 || $0 == 61 || $0 == 95 || $0 == 45 })
        else { throw P4Error.malformed("KT entry field is not base64 text") }
        return s
    }

    /// § 14.1: the canonical JSON of an entry (keys in KtEntry order, no spaces); the leaf bytes are its UTF-8.
    public static func canonicalEntry(_ entry: JSON?) throws -> String {
        guard let x = entry?.objectValue else { throw P4Error.malformed("KT entry") }
        switch x.string("t") {
        case "acct":
            return "{\"t\":\"acct\",\"u\":\"\(try text(x["u"]))\",\"apk\":\"\(try text(x["apk"]))\",\"ts\":\(try Prim.count(x["ts"]))}"
        case "dev":
            return "{\"t\":\"dev\",\"u\":\"\(try text(x["u"]))\",\"apk\":\"\(try text(x["apk"]))\",\"dpk\":\"\(try text(x["dpk"]))\",\"exp\":\(try Prim.count(x["exp"])),\"ts\":\(try Prim.count(x["ts"]))}"
        case "rev":
            return "{\"t\":\"rev\",\"u\":\"\(try text(x["u"]))\",\"apk\":\"\(try text(x["apk"]))\",\"dpk\":\"\(try text(x["dpk"]))\",\"ts\":\(try Prim.count(x["ts"]))}"
        default:
            throw P4Error.malformed("unknown KT entry type")
        }
    }

    /// § 14.1: u = b64url(H(LABEL.ktUser + username)).
    public static func user(_ username: String) -> String { Prim.b64url(Prim.H(Prim.utf8(P4.lKtUser + username))) }

    public static func entryLeafHash(_ entry: JSON?) throws -> Bytes { Merkle.leafHash(try canonicalEntry(entry)) }

    /* ---------------------------------------------------- signed tree heads */

    /// § 14.2: the bytes an STH's signature covers.
    public static func sthData(_ size: Int64, _ root: String, _ ts: Int64) throws -> Bytes { try Prim.join(P4.lKtSth, size, root, ts) }

    public static func isSth(_ v: JSON?) -> Bool {
        guard let s = v?.objectValue, Prim.isSafeCount(s["size"]), Prim.isSafeCount(s["ts"]), s.string("root") != nil, s.string("sig") != nil else { return false }
        return (try? Prim.unb64(s["root"], length: 32)) != nil && (try? Prim.unb64(s["sig"], length: 64)) != nil
    }

    /// Server (and tests): signs a tree head with the KT key's seed.
    public static func signSth(_ ktSeed: Bytes, _ size: Int64, _ root: Bytes, _ ts: Int64) throws -> JSONObject {
        let r = Prim.b64(root)
        let sig = try Prim.ed25519Sign(ktSeed, try sthData(size, r, ts))
        return JSONObject([("size", .int(size)), ("root", .string(r)), ("ts", .int(ts)), ("sig", .string(Prim.b64(sig)))])
    }

    /// Is this tree head signed by `ktKey` (raw Ed25519 public key, b64)? Never throws.
    public static func verifySth(_ sth: JSON?, _ ktKey: String?) -> Bool {
        guard isSth(sth), let ktKey, let s = sth?.objectValue,
              let data = try? sthData(s.optInt64("size"), s.optString("root"), s.optInt64("ts")) else { return false }
        return Prim.ed25519Verify(ktKey, data, s.string("sig"))
    }

    static func decodeProof(_ proof: JSON?) throws -> [Bytes] {
        guard let a = proof?.arrayValue, a.count <= 64 else { throw P4Error.malformed("bad proof") }
        return try a.map { try Prim.unb64($0, length: 32) }
    }

    /* -------------------------------------------------------------- lookup */

    public struct Entry: Sendable {
        public let entry: JSONObject
        public let index: Int64
    }

    public struct Checked: Sendable {
        public let ok: Bool
        /// bad-signature, malformed, not-included, wrong-user (or a KtState.update status).
        public let why: String?
        public let sth: JSONObject?
        public let entries: [Entry]
        static func no(_ why: String) -> Checked { Checked(ok: false, why: why, sth: nil, entries: []) }
    }

    /// § 14.3/14.4: checks a lookup against its own tree head: the head's
    /// signature, every entry's user `u` (when given) and its inclusion proof.
    public static func verifyLookup(_ lookup: JSON?, _ ktKey: String?, _ u: String?) -> Checked {
        guard let l = lookup?.objectValue, let items = l.array("entries") else { return .no("malformed") }
        if !verifySth(l["sth"], ktKey) { return .no("bad-signature") }
        let sth = l.object("sth")!
        guard let root = try? Prim.unb64(sth["root"], length: 32) else { return .no("malformed") }
        var out = [Entry]()
        for it in items {
            guard let item = it.objectValue, Prim.isSafeCount(item["index"]),
                  let leaf = try? entryLeafHash(item["entry"]), let path = try? decodeProof(item["proof"]), let entry = item.object("entry") else {
                return .no("malformed")
            }
            if let u, entry.string("u") != u { return .no("wrong-user") }
            let index = (try? Prim.count(item["index"])) ?? 0
            if !Merkle.verifyInclusion(leaf, index, sth.optInt64("size"), path, root) { return .no("not-included") }
            out.append(Entry(entry: entry, index: index))
        }
        return Checked(ok: true, why: nil, sth: sth, entries: out)
    }

    /// What the verified entries of one user say about account key `apk` and device key `dpk` (§ 14.4).
    public struct Status: Sendable, Equatable {
        public let account: Bool, device: Bool, revoked: Bool
        public var ok: Bool { account && device && !revoked }
    }

    /// The account key is the user's CURRENT one (the latest `acct` entry), the
    /// device is certified (a `dev` entry not expired at `now`), and no `rev`
    /// for it comes after its latest `dev` entry.
    public static func deviceStatus(_ entries: [Entry], apk: String, dpk: String, now: Int64) -> Status {
        let sorted = entries.enumerated().sorted { ($0.element.index, $0.offset) < ($1.element.index, $1.offset) }.map(\.element)
        var lastAcct: Entry?, lastDev: Entry?
        for e in sorted {
            let t = e.entry.optString("t")
            if t == "acct" { lastAcct = e }
            if t == "dev" && e.entry.optString("apk") == apk && e.entry.optString("dpk") == dpk { lastDev = e }
        }
        let account = lastAcct.map { $0.entry.optString("apk") == apk } ?? false
        let device = lastDev.map { $0.entry.optInt64("exp") > now } ?? false
        var revoked = false
        for e in sorted where e.entry.optString("t") == "rev" && e.entry.optString("apk") == apk && e.entry.optString("dpk") == dpk
            && (lastDev == nil || e.index > lastDev!.index) { revoked = true }
        return Status(account: account, device: device, revoked: revoked)
    }

    /* --------------------------------------------------------------- state */

    /// A persistent alert: inconsistent, split-view, unproven or key-changed.
    public struct Alert: Sendable, Equatable {
        public let kind: String
        public let at: Int64
        public let detail: String
        public init(kind: String, at: Int64, detail: String) { self.kind = kind; self.at = at; self.detail = detail }
        public var json: JSONObject { JSONObject([("kind", .string(kind)), ("at", .int(at)), ("detail", .string(detail))]) }
        public static func parse(_ o: JSONObject?) -> Alert? {
            guard let o, !o.optString("kind").isEmpty else { return nil }
            return Alert(kind: o.optString("kind"), at: o.optInt64("at"), detail: o.optString("detail"))
        }
    }

    /// One server's state: its pinned KT key, the newest verified head, the
    /// alert, and the heads whose consistency the server could not be asked to
    /// prove yet: [{sth, via: "update" | "gossip", since}], at most `maxPending`.
    public struct OriginState: Sendable {
        public let key: String?
        public let sth: JSONObject?
        public let alert: Alert?
        public let pending: [JSON]?

        public init(key: String?, sth: JSONObject?, alert: Alert?, pending: [JSON]? = nil) {
            self.key = key; self.sth = sth; self.alert = alert
            self.pending = pending?.isEmpty == false ? pending : nil
        }

        func with(sth s: JSONObject?) -> OriginState { OriginState(key: key, sth: s, alert: alert, pending: pending) }
        func with(alert a: Alert?) -> OriginState { OriginState(key: key, sth: sth, alert: a, pending: pending) }
        func with(pending p: [JSON]?) -> OriginState { OriginState(key: key, sth: sth, alert: alert, pending: p) }

        public var json: JSONObject {
            var o = JSONObject()
            if let key { o["key"] = .string(key) }
            if let sth { o["sth"] = .object(sth) }
            if let alert { o["alert"] = .object(alert.json) }
            if let pending { o["pending"] = .array(pending) }
            return o
        }

        public static func parse(_ o: JSONObject?) -> OriginState? {
            guard let o else { return nil }
            let key = o.optString("key")
            return OriginState(key: key.isEmpty ? nil : key, sth: o.object("sth"), alert: Alert.parse(o.object("alert")), pending: o.array("pending"))
        }
    }

    /// Heads waiting for a proof, kept per server (a full list keeps its oldest).
    public static let maxPending = 8

    /// How long a consistency proof may stay unanswered (server unreachable) before the alert (review P05).
    public static let pendingMaxMs: Int64 = 24 * 3600_000

    /// Thrown by a consistency fetcher when the server could not be reached at
    /// all (no answer). Anything else — an error answer, a proof that does not
    /// verify — between two heads the pinned key signed is the alert.
    public struct Unreachable: Error, Sendable {
        public let reason: String
        public init(_ reason: String = "unreachable") { self.reason = reason }
    }

    /// Fetches GET /api/kt/consistency?from=&to= → {from, to, proof}.
    public typealias ConsistencyFetcher = @Sendable (_ from: Int64, _ to: Int64) async throws -> JSONObject?

    /// The outcome of KtState.update / gossip.
    public struct Outcome: Sendable {
        /// ok, no-key, bad-signature, inconsistent, unknown, ignored, need-consistency, split-view, pending, unproven.
        public let status: String
        public let alert: Alert?
        public let from: Int64, to: Int64
        static func of(_ status: String) -> Outcome { Outcome(status: status, alert: nil, from: 0, to: 0) }
    }

    enum Proof { case consistent, refused, unreachable }

    /// Is `small` a prefix of `big`? (Both signature-checked; sizes differ.)
    static func consistency(_ small: JSONObject, _ big: JSONObject, _ fetch: ConsistencyFetcher) async -> Proof {
        let ss = small.optInt64("size"), bs = big.optInt64("size")
        if ss == 0 { return .consistent }
        do {
            guard let answer = try await fetch(ss, bs), answer.optInt64("from", -1) == ss, answer.optInt64("to", -1) == bs else { return .refused }
            return Merkle.verifyConsistency(ss, bs, try Prim.unb64(small["root"], length: 32), try Prim.unb64(big["root"], length: 32), try decodeProof(answer["proof"]))
                ? .consistent : .refused
        } catch is Unreachable {
            return .unreachable
        } catch {
            return .refused
        }
    }
}

/// Persistent per-origin state (the app keeps it in the vault).
public protocol KtStore: Sendable {
    func get(_ origin: String) -> Kt.OriginState?
    func set(_ origin: String, _ state: Kt.OriginState)
}

public final class MemoryKtStore: KtStore {
    private let rows = Mutex([String: Kt.OriginState]())
    public init() {}
    public func get(_ origin: String) -> Kt.OriginState? { rows.withLock { $0[origin] } }
    public func set(_ origin: String, _ state: Kt.OriginState) { rows.withLock { $0[origin] = state } }
}

/// The client's key-transparency state for every server it talks to (kt.ts KtState).
public actor KtState {
    private let store: any KtStore
    private let clock: any Clock

    public init(store: (any KtStore)? = nil, clock: (any Clock)? = nil) {
        self.store = store ?? MemoryKtStore()
        self.clock = clock ?? SystemClock()
    }

    private func load(_ origin: String) -> Kt.OriginState { store.get(origin) ?? Kt.OriginState(key: nil, sth: nil, alert: nil) }

    private func raise(_ origin: String, _ st: Kt.OriginState, _ kind: String, _ detail: String) -> Kt.Alert {
        let alert = Kt.Alert(kind: kind, at: clock.now(), detail: detail)
        // The first alert stays (persistent) until the user deals with it.
        let kept = st.alert ?? alert
        store.set(origin, st.with(alert: kept))
        return kept
    }

    /// An alert of the app's own checks (review P04), kept like the others.
    @discardableResult
    public func raiseAlert(_ origin: String, kind: String, detail: String) -> Kt.Alert { raise(origin, load(origin), kind, detail) }

    /// § 14.2: pins the server's KT key on first use: "new", "match" or "changed" (an alert; the pin stays).
    public func pinKey(_ origin: String, _ key: String) throws -> String {
        _ = try Prim.unb64(key, length: 32)
        let st = load(origin)
        guard let pinned = st.key else { store.set(origin, Kt.OriginState(key: key, sth: st.sth, alert: st.alert, pending: st.pending)); return "new" }
        if pinned == key { return "match" }
        _ = raise(origin, st, "key-changed", "the server's key-transparency key changed")
        return "changed"
    }

    public func key(_ origin: String) -> String? { load(origin).key }
    public func newest(_ origin: String) -> JSONObject? { load(origin).sth }
    public func alert(_ origin: String) -> Kt.Alert? { load(origin).alert }
    /// How many heads wait for a proof the server could not be asked for.
    public func pendingCount(_ origin: String) -> Int { load(origin).pending?.count ?? 0 }

    /// Clears the alert after the user saw it.
    public func dismissAlert(_ origin: String) { store.set(origin, load(origin).with(alert: nil)) }

    /// § 14.4: a tree head from the server. Kept when newer and consistent; a rewritten history raises the alert.
    public func update(_ origin: String, _ sth: JSON?, fetch: Kt.ConsistencyFetcher) async -> Kt.Outcome {
        let st = load(origin)
        guard let key = st.key else { return .of("no-key") }
        if !Kt.verifySth(sth, key) { return .of("bad-signature") }
        let head = sth!.objectValue!
        guard let kept = st.sth else { store.set(origin, st.with(sth: head)); return .of("ok") }
        let hs = head.optInt64("size"), ks = kept.optInt64("size")
        if hs == ks {
            if head.optString("root") != kept.optString("root") {
                return Kt.Outcome(status: "inconsistent", alert: raise(origin, st, "inconsistent", "two roots for tree size \(hs)"), from: 0, to: 0)
            }
            if head.optInt64("ts") > kept.optInt64("ts") { store.set(origin, st.with(sth: head)) }
            return .of("ok")
        }
        let small = hs < ks ? head : kept, big = hs < ks ? kept : head
        switch await Kt.consistency(small, big, fetch) {
        case .unreachable:
            return waitForProof(origin, head, "update")
        case .refused:
            return Kt.Outcome(status: "inconsistent",
                              alert: raise(origin, load(origin), "inconsistent", "tree \(small.optInt64("size")) is not a prefix of tree \(big.optInt64("size"))"), from: 0, to: 0)
        case .consistent:
            if hs > ks { store.set(origin, load(origin).with(sth: head)) }
            return .of("ok")
        }
    }

    /// § 14.4 gossip: a peer's tree head (from its hello) compared with ours.
    public func gossip(_ origin: String, _ peerSth: JSON?) -> Kt.Outcome {
        let st = load(origin)
        guard let key = st.key, let kept = st.sth else { return .of("unknown") }
        if !Kt.verifySth(peerSth, key) { return .of("ignored") }
        let peer = peerSth!.objectValue!
        let ps = peer.optInt64("size"), ks = kept.optInt64("size")
        if ps == ks {
            if peer.optString("root") == kept.optString("root") { return .of("ok") }
            return Kt.Outcome(status: "split-view", alert: raise(origin, st, "split-view", "a peer saw another root for tree size \(ps)"), from: 0, to: 0)
        }
        return Kt.Outcome(status: "need-consistency", alert: nil, from: min(ps, ks), to: max(ps, ks))
    }

    /// Finishes a need-consistency gossip with the server's proof; a newer
    /// consistent peer head becomes ours. An error answer or a bad proof is the
    /// split-view alert (review P05); an unreachable server is asked again.
    public func resolveGossip(_ origin: String, _ peerSth: JSON?, fetch: Kt.ConsistencyFetcher) async -> Kt.Outcome {
        let st = load(origin)
        guard let key = st.key, let kept = st.sth else { return .of("unknown") }
        if !Kt.verifySth(peerSth, key) { return .of("ignored") }
        let peer = peerSth!.objectValue!
        let ps = peer.optInt64("size"), ks = kept.optInt64("size")
        if ps == ks {
            if peer.optString("root") == kept.optString("root") { return .of("ok") }
            return Kt.Outcome(status: "split-view", alert: raise(origin, st, "split-view", "a peer saw another root for tree size \(ps)"), from: 0, to: 0)
        }
        let small = ps < ks ? peer : kept, big = ps < ks ? kept : peer
        switch await Kt.consistency(small, big, fetch) {
        case .unreachable:
            return waitForProof(origin, peer, "gossip")
        case .refused:
            return Kt.Outcome(status: "split-view", alert: raise(origin, load(origin), "split-view", "a peer's tree \(ps) is not consistent with ours (\(ks))"), from: 0, to: 0)
        case .consistent:
            if ps > ks { store.set(origin, load(origin).with(sth: peer)) }
            return .of("ok")
        }
    }

    static func sameHead(_ a: JSONObject?, _ b: JSONObject?) -> Bool {
        guard let a, let b else { return false }
        return a.optInt64("size") == b.optInt64("size") && a.optString("root") == b.optString("root") && a.optInt64("ts") == b.optInt64("ts")
    }

    /// Review P05: a head whose proof the server could not be asked for waits
    /// (persistently) — "pending"; once one has waited longer than PENDING_MAX_MS
    /// the alert is raised ("unproven").
    private func waitForProof(_ origin: String, _ head: JSONObject, _ via: String) -> Kt.Outcome {
        let st = load(origin)
        let now = clock.now()
        let list = st.pending ?? []
        var oldest = now
        var have = false
        for p in list {
            guard let o = p.objectValue else { continue }
            oldest = min(oldest, o.optInt64("since", now))
            if KtState.sameHead(o.object("sth"), head) { have = true }
        }
        var next = list
        if !have && next.count < Kt.maxPending {
            next.append(.object(JSONObject([("sth", .object(head)), ("via", .string(via)), ("since", .int(now))])))
        }
        store.set(origin, st.with(pending: next))
        if now - oldest > Kt.pendingMaxMs {
            return Kt.Outcome(status: "unproven", alert: raise(origin, load(origin), "unproven",
                                                                "the server has not proved its key history consistent for \((now - oldest) / 3600_000) h"), from: 0, to: 0)
        }
        return .of("pending")
    }

    private static func rank(_ status: String) -> Int {
        switch status {
        case "inconsistent", "split-view", "unproven": return 3
        case "pending": return 2
        case "ok": return 0
        default: return 1
        }
    }

    /// Asks again for the proofs that could not be asked for (review P05). The worst outcome.
    public func retryPending(_ origin: String, fetch: Kt.ConsistencyFetcher) async -> Kt.Outcome {
        let st = load(origin)
        guard let list = st.pending else { return .of("ok") }
        store.set(origin, st.with(pending: nil))
        var worst = Kt.Outcome.of("ok")
        for item in list {
            guard let p = item.objectValue else { continue }
            let head = p.object("sth")
            var o = p.optString("via") == "gossip" ? await resolveGossip(origin, head.map { .object($0) }, fetch: fetch)
                                                     : await update(origin, head.map { .object($0) }, fetch: fetch)
            if o.status == "pending" || o.status == "unproven" {
                // Still waiting: keep its first time (waitForProof added it with now).
                let now = load(origin)
                var kept = now.pending ?? []
                for j in kept.indices {
                    guard var q = kept[j].objectValue, KtState.sameHead(q.object("sth"), head) else { continue }
                    q["since"] = .int(min(q.optInt64("since"), p.optInt64("since")))
                    kept[j] = .object(q)
                }
                store.set(origin, now.with(pending: kept))
                let waited = clock.now() - p.optInt64("since")
                if waited > Kt.pendingMaxMs {
                    o = Kt.Outcome(status: "unproven", alert: raise(origin, load(origin), "unproven",
                                                                    "the server has not proved its key history consistent for \(waited / 3600_000) h"), from: 0, to: 0)
                }
            }
            if KtState.rank(o.status) > KtState.rank(worst.status) { worst = o }
        }
        return worst
    }

    /// A lookup: its head goes through update first, then inclusion of every entry.
    public func lookup(_ origin: String, _ lookup: JSONObject?, u: String?, fetch: Kt.ConsistencyFetcher) async -> Kt.Checked {
        let upd = await update(origin, lookup?["sth"], fetch: fetch)
        if upd.status != "ok" { return .no(upd.status) }
        return Kt.verifyLookup(lookup.map { .object($0) }, key(origin), u)
    }
}
