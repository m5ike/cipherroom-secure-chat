// Port of Kt.State (A/p4/Kt.java, client/src/lib/p4/kt.ts): the per-server
// key-transparency state machine.
//   * every new tree head must be consistent with the newest one kept;
//   * a lookup's entries must be included in its (signed) head;
//   * gossip: a peer's head (from its hello) of the same size with another
//     root, or not consistent with ours, is a split view.
// A server that could not be ASKED for a consistency proof (no answer) is not
// an alert yet: the head waits (persistently) and is asked again; one that
// waited longer than 24 h raises "unproven" (review P05). A server that
// answers with an error, or a proof that does not verify, between two heads
// its pinned key signed, is the alert. The first alert stays until the person
// dismisses it.
//
// Operations run one at a time (Java: synchronized), also across the network
// fetch of a proof.

import Foundation
import M5Core

public actor KtMonitor {
    public static let maxPending = 8
    public static let pendingMaxMs: Millis = 24 * 3600_000

    private let store: any KtStateStore
    private let verifier: any KtVerifier
    private let clock: NetClock
    private var busy = false
    private var queue: [CheckedContinuation<Void, Never>] = []

    public init(store: any KtStateStore, verifier: any KtVerifier, clock: NetClock = .system) {
        self.store = store
        self.verifier = verifier
        self.clock = clock
    }

    /* --------------------------------------------------------- serial */

    private func acquire() async {
        if !busy { busy = true; return }
        await withCheckedContinuation { queue.append($0) }
    }

    private func release() {
        if queue.isEmpty { busy = false } else { queue.removeFirst().resume() }
    }

    private func serial<T: Sendable>(_ body: () async -> T) async -> T {
        await acquire()
        let r = await body()
        release()
        return r
    }

    private func load(_ origin: String) async -> KtOriginState { await store.get(origin) ?? KtOriginState() }

    private func raise(_ origin: String, _ st: KtOriginState, _ kind: String, _ detail: String) async -> KtAlert {
        let alert = KtAlert(kind: kind, at: clock.now(), detail: detail)
        // The first alert stays (persistent) until the user deals with it.
        let kept = st.alert ?? alert
        var next = st
        next.alert = kept
        await store.set(origin, next)
        return kept
    }

    /* --------------------------------------------------------- public */

    /// An alert of the app's own checks (review P04: own entries show an unknown device or account key).
    @discardableResult
    public func raiseAlert(_ origin: String, kind: String, detail: String) async -> KtAlert {
        await serial { await raise(origin, await load(origin), kind, detail) }
    }

    /// § 14.2: pins the server's KT key on first use: "new", "match" or "changed" (an alert; the pin stays).
    public func pinKey(_ origin: String, key: String) async throws -> String {
        guard let raw = Bytes.unb64(key), raw.count == 32, Bytes.b64(raw) == key else { throw NetError.invalid("the KT key is not 32 bytes of base64") }
        return await serial {
            var st = await load(origin)
            if st.key == nil {
                st.key = key
                await store.set(origin, st)
                return "new"
            }
            if st.key == key { return "match" }
            _ = await raise(origin, st, "key-changed", "the server's key-transparency key changed")
            return "changed"
        }
    }

    public func key(_ origin: String) async -> String? { await load(origin).key }
    public func newest(_ origin: String) async -> NetJSON? { await load(origin).sth }
    public func alert(_ origin: String) async -> KtAlert? { await load(origin).alert }
    /// How many heads wait for a proof the server could not be asked for.
    public func pendingCount(_ origin: String) async -> Int { await load(origin).pending?.count ?? 0 }

    /// Clears the alert after the person saw it.
    public func dismissAlert(_ origin: String) async {
        await serial {
            var st = await load(origin)
            st.alert = nil
            await store.set(origin, st)
        }
    }

    /// § 14.4: a tree head from the server. Kept when newer and consistent; a rewritten history raises the alert.
    public func update(_ origin: String, sth: NetJSON?, fetch: KtConsistencyFetch) async -> KtOutcome {
        await serial { await doUpdate(origin, sth, fetch) }
    }

    /// § 14.4 gossip: a peer's tree head (from its hello) compared with ours.
    public func gossip(_ origin: String, peerSth: NetJSON?) async -> KtOutcome {
        await serial {
            let st = await load(origin)
            guard let key = st.key, let kept = st.sth else { return KtOutcome("unknown") }
            guard let peer = peerSth, verifier.verifySTH(peer, key: key) else { return KtOutcome("ignored") }
            let ps = peer.int("size"), ks = kept.int("size")
            if ps == ks {
                if peer.str("root") == kept.str("root") { return KtOutcome("ok") }
                return KtOutcome("split-view", alert: await raise(origin, st, "split-view", "a peer saw another root for tree size \(ps)"))
            }
            return KtOutcome("need-consistency", from: min(ps, ks), to: max(ps, ks))
        }
    }

    /// Finishes a need-consistency gossip with the server's proof; a newer consistent peer head becomes ours.
    public func resolveGossip(_ origin: String, peerSth: NetJSON?, fetch: KtConsistencyFetch) async -> KtOutcome {
        await serial { await doResolveGossip(origin, peerSth, fetch) }
    }

    /// Asks again for the proofs that could not be asked for (review P05). The worst outcome.
    public func retryPending(_ origin: String, fetch: KtConsistencyFetch) async -> KtOutcome {
        await serial {
            var st = await load(origin)
            guard let list = st.pending else { return KtOutcome("ok") }
            st.pending = nil
            await store.set(origin, st)
            var worst = KtOutcome("ok")
            for p in list {
                guard case .object = p else { continue }
                let head = p.obj("sth")
                var o = p.str("via") == "gossip" ? await doResolveGossip(origin, head, fetch) : await doUpdate(origin, head, fetch)
                if o.status == "pending" || o.status == "unproven" {
                    // Still waiting: keep its first time (waitForProof added it with now).
                    var now = await load(origin)
                    now.pending = now.pending?.map { q in
                        guard KtMonitor.sameHead(q.obj("sth"), head) else { return q }
                        return q.with("since", .int(min(q.int("since"), p.int("since"))))
                    }
                    await store.set(origin, now)
                    let waited = clock.now() - p.int("since")
                    if waited > KtMonitor.pendingMaxMs {
                        o = KtOutcome("unproven", alert: await raise(origin, await load(origin), "unproven",
                                                                     "the server has not proved its key history consistent for \(waited / 3600_000) h"))
                    }
                }
                if KtMonitor.rank(o.status) > KtMonitor.rank(worst.status) { worst = o }
            }
            return worst
        }
    }

    /// A lookup: its head goes through update first, then inclusion of every entry.
    public func lookup(_ origin: String, lookup: NetJSON?, u: String?, fetch: KtConsistencyFetch) async -> KtCheckedLookup {
        await serial {
            let upd = await doUpdate(origin, lookup?["sth"], fetch)
            guard upd.status == "ok" else { return .no(upd.status) }
            guard let key = await load(origin).key, let lookup else { return .no("malformed") }
            return verifier.verifyLookup(lookup, key: key, u: u)
        }
    }

    /* -------------------------------------------------------- internals */

    private func doUpdate(_ origin: String, _ sth: NetJSON?, _ fetch: KtConsistencyFetch) async -> KtOutcome {
        var st = await load(origin)
        guard let key = st.key else { return KtOutcome("no-key") }
        guard let head = sth, verifier.verifySTH(head, key: key) else { return KtOutcome("bad-signature") }
        guard let kept = st.sth else {
            st.sth = head
            await store.set(origin, st)
            return KtOutcome("ok")
        }
        let hs = head.int("size"), ks = kept.int("size")
        if hs == ks {
            if head.str("root") != kept.str("root") {
                return KtOutcome("inconsistent", alert: await raise(origin, st, "inconsistent", "two roots for tree size \(hs)"))
            }
            if head.int("ts") > kept.int("ts") {
                st.sth = head
                await store.set(origin, st)
            }
            return KtOutcome("ok")
        }
        let (small, big) = hs < ks ? (head, kept) : (kept, head)
        switch await consistency(small, big, fetch) {
        case .unreachable:
            return await waitForProof(origin, head, "update")
        case .refused:
            return KtOutcome("inconsistent", alert: await raise(origin, await load(origin), "inconsistent",
                                                                 "tree \(small.int("size")) is not a prefix of tree \(big.int("size"))"))
        case .consistent:
            if hs > ks {
                var now = await load(origin)
                now.sth = head
                await store.set(origin, now)
            }
            return KtOutcome("ok")
        }
    }

    private func doResolveGossip(_ origin: String, _ peerSth: NetJSON?, _ fetch: KtConsistencyFetch) async -> KtOutcome {
        let st = await load(origin)
        guard let key = st.key, let kept = st.sth else { return KtOutcome("unknown") }
        guard let peer = peerSth, verifier.verifySTH(peer, key: key) else { return KtOutcome("ignored") }
        let ps = peer.int("size"), ks = kept.int("size")
        if ps == ks {
            if peer.str("root") == kept.str("root") { return KtOutcome("ok") }
            return KtOutcome("split-view", alert: await raise(origin, st, "split-view", "a peer saw another root for tree size \(ps)"))
        }
        let (small, big) = ps < ks ? (peer, kept) : (kept, peer)
        switch await consistency(small, big, fetch) {
        case .unreachable:
            return await waitForProof(origin, peer, "gossip")
        case .refused:
            return KtOutcome("split-view", alert: await raise(origin, await load(origin), "split-view", "a peer's tree \(ps) is not consistent with ours (\(ks))"))
        case .consistent:
            if ps > ks {
                var now = await load(origin)
                now.sth = peer
                await store.set(origin, now)
            }
            return KtOutcome("ok")
        }
    }

    /// Review P05: a head whose proof the server could not be asked for waits — "pending"; once one has waited
    /// longer than pendingMaxMs the alert is raised ("unproven").
    private func waitForProof(_ origin: String, _ head: NetJSON, _ via: String) async -> KtOutcome {
        var st = await load(origin)
        let now = clock.now()
        var list = st.pending ?? []
        var oldest = now
        var have = false
        for p in list {
            oldest = min(oldest, p.int("since", now))
            if KtMonitor.sameHead(p.obj("sth"), head) { have = true }
        }
        // A full list keeps its oldest heads: their wait is what raises the alert.
        if !have, list.count < KtMonitor.maxPending { list.append(["sth": head, "via": .string(via), "since": .int(now)]) }
        st.pending = list.isEmpty ? nil : list
        await store.set(origin, st)
        if now - oldest > KtMonitor.pendingMaxMs {
            return KtOutcome("unproven", alert: await raise(origin, await load(origin), "unproven",
                                                            "the server has not proved its key history consistent for \((now - oldest) / 3600_000) h"))
        }
        return KtOutcome("pending")
    }

    enum Consistency { case consistent, refused, unreachable }

    /// Is `small` a prefix of `big`? (Both signature-checked; sizes differ.)
    private func consistency(_ small: NetJSON, _ big: NetJSON, _ fetch: KtConsistencyFetch) async -> Consistency {
        if small.int("size") == 0 { return .consistent }
        do {
            let answer = try await fetch(small.int("size"), big.int("size"))
            guard answer.int("from", -1) == small.int("size"), answer.int("to", -1) == big.int("size") else { return .refused }
            guard let a = Bytes.unb64(small.str("root")), a.count == 32, let b = Bytes.unb64(big.str("root")), b.count == 32,
                  let items = answer.arr("proof"), items.count <= 64 else { return .refused }
            var proof: [Data] = []
            for i in items {
                guard let s = i.stringValue, let h = Bytes.unb64(s), h.count == 32 else { return .refused }
                proof.append(h)
            }
            return verifier.verifyConsistency(from: small.int("size"), to: big.int("size"), fromRoot: a, toRoot: b, proof: proof) ? .consistent : .refused
        } catch let e as NetError {
            if case .network = e { return .unreachable }
            return .refused
        } catch {
            return .refused
        }
    }

    static func sameHead(_ a: NetJSON?, _ b: NetJSON?) -> Bool {
        guard let a, let b else { return false }
        return a.int("size") == b.int("size") && a.str("root") == b.str("root") && a.int("ts") == b.int("ts")
    }

    static func rank(_ status: String) -> Int {
        switch status {
        case "inconsistent", "split-view", "unproven": return 3
        case "pending": return 2
        case "ok": return 0
        default: return 1
        }
    }
}
