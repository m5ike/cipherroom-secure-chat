// Key transparency against the web reference's vectors (test/vectors/p4.json
// kt): signed tree heads, consistency and inclusion proofs (checked by the
// test verifier), the monitor's state machine (pin, update, consistency,
// unreachable → pending → unproven, gossip and split views, lookups), the
// own-entries check and the HTTP refresh.

import CryptoKit
import Foundation
import Testing
@testable import M5Net

private let origin = "https://chat.example.com"

struct KtVectors {
    let kt: NetJSON
    init() throws { kt = try #require(try Fixtures.p4().obj("kt")) }
    var key: String { kt.str("ktKey") }
    var sth5: NetJSON { kt.arr("sth")![0] }
    var sth7: NetJSON { kt.arr("sth")![1] }
    var entries: [NetJSON] { kt.arr("entries")! }
    func consistency(_ from: Int64, _ to: Int64) -> NetJSON? { kt.arr("consistency")!.first { $0.int("from") == from && $0.int("to") == to } }
    func inclusion(_ index: Int64, _ size: Int64) -> [NetJSON] { kt.arr("inclusion")!.first { $0.int("index") == index && $0.int("size") == size }!.arr("path")! }
    /// A tree head signed with the vectors' KT seed.
    func signedHead(size: Int64, root: Data, ts: Int64) throws -> NetJSON {
        let k = try Curve25519.Signing.PrivateKey(rawRepresentation: Bytes.unb64(kt.str("ktSeed"))!)
        let r = Bytes.b64(root)
        let sig = try k.signature(for: Data("m5cet/kt/sth/4|\(size)|\(r)|\(ts)".utf8))
        return ["size": .int(size), "root": .string(r), "ts": .int(ts), "sig": .string(Bytes.b64(sig))]
    }
    /// A lookup of user `u` at size 7 with inclusion proofs.
    func lookup(u: String) -> NetJSON {
        let items: [NetJSON] = entries.enumerated().filter { $0.element.str("u") == u }.map { i, e in
            ["entry": e, "index": .int(Int64(i)), "proof": .array(inclusion(Int64(i), 7))]
        }
        return ["sth": sth7, "entries": .array(items)]
    }
    var alice: String { kt.arr("users")![0].str("u") }
}

let unreachable: KtConsistencyFetch = { _, _ in throw NetError.network("offline") }

@Suite struct KtVectorTests {
    @Test func theTestVerifierHoldsTheVectors() throws {
        let v = try KtVectors()
        let verifier = TestKtVerifier()
        for u in v.kt.arr("users")! { #expect(KtLogEntry.user(u.str("name")) == u.str("u")) }
        for (i, e) in v.entries.enumerated() {
            let text = try #require(TestKtVerifier.canonical(e))
            #expect(text == v.kt.arr("leaves")![i].stringValue)
            #expect(Bytes.b64(TestKtVerifier.leaf(text)) == v.kt.arr("leafHashes")![i].stringValue)
        }
        let roots = v.kt.arr("roots")!.map { Bytes.unb64($0.stringValue!)! }
        for c in v.kt.arr("consistency")! where c.int("from") > 0 {
            let proof = c.arr("proof")!.map { Bytes.unb64($0.stringValue!)! }
            #expect(verifier.verifyConsistency(from: c.int("from"), to: c.int("to"), fromRoot: roots[Int(c.int("from"))], toRoot: roots[Int(c.int("to"))], proof: proof),
                    "\(c.int("from"))→\(c.int("to"))")
            if !proof.isEmpty {
                #expect(!verifier.verifyConsistency(from: c.int("from"), to: c.int("to"), fromRoot: roots[Int(c.int("from"))], toRoot: roots[0], proof: proof))
            }
        }
        for inc in v.kt.arr("inclusion")! {
            let i = inc.int("index"), size = inc.int("size")
            let leaf = Bytes.unb64(v.kt.arr("leafHashes")![Int(i)].stringValue!)!
            #expect(TestKtVerifier.verifyInclusion(leaf: leaf, index: i, size: size, path: inc.arr("path")!.map { Bytes.unb64($0.stringValue!)! }, root: roots[Int(size)]))
        }
        #expect(verifier.verifySTH(v.sth5, key: v.key) && verifier.verifySTH(v.sth7, key: v.key))
        #expect(!verifier.verifySTH(v.sth7.with("ts", 1), key: v.key))
    }
}

@Suite struct KtMonitorTests {
    let v: KtVectors
    init() throws { v = try KtVectors() }

    func fetch(_ answers: [String: NetJSON]) -> KtConsistencyFetch {
        { from, to in
            guard let a = answers["\(from)-\(to)"] else { throw HTTPError(status: 400, code: "bad-request") }
            return a
        }
    }

    @Test func pinsTheKeyAndKeepsNewerConsistentHeads() async throws {
        let m = KtMonitor(store: MemoryKtStateStore(), verifier: TestKtVerifier())
        #expect(await m.update(origin, sth: v.sth5, fetch: unreachable).status == "no-key")
        #expect(try await m.pinKey(origin, key: v.key) == "new")
        #expect(try await m.pinKey(origin, key: v.key) == "match")
        #expect(await m.update(origin, sth: v.sth5, fetch: unreachable).status == "ok")
        let f = fetch(["5-7": v.consistency(5, 7)!])
        #expect(await m.update(origin, sth: v.sth7, fetch: f).status == "ok")
        #expect(await m.newest(origin) == v.sth7)
        // An older head that is a prefix: fine, the newest stays.
        #expect(await m.update(origin, sth: v.sth5, fetch: f).status == "ok")
        #expect(await m.newest(origin) == v.sth7)
        #expect(await m.update(origin, sth: v.sth7.with("sig", .string(Bytes.b64(Data(count: 64)))), fetch: f).status == "bad-signature")
        #expect(await m.alert(origin) == nil)
        await #expect(throws: NetError.self) { _ = try await m.pinKey(origin, key: "short") }
    }

    @Test func aRewrittenHistoryIsTheAlert() async throws {
        let m = KtMonitor(store: MemoryKtStateStore(), verifier: TestKtVerifier())
        _ = try await m.pinKey(origin, key: v.key)
        _ = await m.update(origin, sth: v.sth5, fetch: unreachable)
        // The server answers with a proof that does not verify (or an error): inconsistent.
        let bad = fetch(["5-7": v.consistency(5, 7)!.with("proof", .array([.string(Bytes.b64(Data(count: 32)))]))])
        let o = await m.update(origin, sth: v.sth7, fetch: bad)
        #expect(o.status == "inconsistent" && o.alert?.kind == "inconsistent")
        // Two roots for one size.
        let m2 = KtMonitor(store: MemoryKtStateStore(), verifier: TestKtVerifier())
        _ = try await m2.pinKey(origin, key: v.key)
        _ = await m2.update(origin, sth: v.sth7, fetch: unreachable)
        let fork = try v.signedHead(size: 7, root: Data(repeating: 9, count: 32), ts: 1_800_000_300_000)
        #expect(await m2.update(origin, sth: fork, fetch: unreachable).status == "inconsistent")
        // The first alert stays until dismissed.
        #expect(try await m2.pinKey(origin, key: Bytes.b64(Data(repeating: 1, count: 32))) == "changed")
        #expect(await m2.alert(origin)?.kind == "inconsistent")
        await m2.dismissAlert(origin)
        #expect(await m2.alert(origin) == nil)
    }

    @Test func anUnreachableServerWaitsThenIsUnproven() async throws {
        let clock = TestClock(1_800_000_000_000)
        let store = MemoryKtStateStore()
        let m = KtMonitor(store: store, verifier: TestKtVerifier(), clock: clock.clock)
        _ = try await m.pinKey(origin, key: v.key)
        _ = await m.update(origin, sth: v.sth5, fetch: unreachable)
        #expect(await m.update(origin, sth: v.sth7, fetch: unreachable).status == "pending")
        #expect(await m.pendingCount(origin) == 1)
        #expect(await m.update(origin, sth: v.sth7, fetch: unreachable).status == "pending")
        #expect(await m.pendingCount(origin) == 1) // the same head once
        // Back online: the waiting proof is asked for.
        #expect(await m.retryPending(origin, fetch: fetch(["5-7": v.consistency(5, 7)!])).status == "ok")
        #expect(await m.pendingCount(origin) == 0)
        #expect(await m.newest(origin) == v.sth7)
        // Another server state: unreachable for more than 24 h.
        let m2 = KtMonitor(store: MemoryKtStateStore(), verifier: TestKtVerifier(), clock: clock.clock)
        _ = try await m2.pinKey(origin, key: v.key)
        _ = await m2.update(origin, sth: v.sth5, fetch: unreachable)
        _ = await m2.update(origin, sth: v.sth7, fetch: unreachable)
        clock.advance(25 * 3600_000)
        let o = await m2.retryPending(origin, fetch: unreachable)
        #expect(o.status == "unproven" && o.alert?.kind == "unproven")
        #expect(await m2.pendingCount(origin) == 1)
        // The state persists in Android's shape.
        let kept = try #require(await store.get(origin))
        #expect(KtOriginState(json: kept.json) == kept)
    }

    @Test func gossipCatchesSplitViews() async throws {
        let m = KtMonitor(store: MemoryKtStateStore(), verifier: TestKtVerifier())
        #expect(await m.gossip(origin, peerSth: v.sth7).status == "unknown")
        _ = try await m.pinKey(origin, key: v.key)
        _ = await m.update(origin, sth: v.sth7, fetch: unreachable)
        #expect(await m.gossip(origin, peerSth: v.sth7).status == "ok")
        #expect(await m.gossip(origin, peerSth: v.sth7.with("ts", 5)).status == "ignored")
        let need = await m.gossip(origin, peerSth: v.sth5)
        #expect(need.status == "need-consistency" && need.from == 5 && need.to == 7)
        #expect(await m.resolveGossip(origin, peerSth: v.sth5, fetch: fetch(["5-7": v.consistency(5, 7)!])).status == "ok")
        let fork = try v.signedHead(size: 7, root: Data(repeating: 3, count: 32), ts: 1)
        let split = await m.gossip(origin, peerSth: fork)
        #expect(split.status == "split-view" && split.alert?.kind == "split-view")
    }

    @Test func lookupsAreCheckedAgainstTheirHead() async throws {
        let m = KtMonitor(store: MemoryKtStateStore(), verifier: TestKtVerifier())
        _ = try await m.pinKey(origin, key: v.key)
        let c = await m.lookup(origin, lookup: v.lookup(u: v.alice), u: v.alice, fetch: unreachable)
        #expect(c.ok && c.entries.count == v.entries.filter { $0.str("u") == v.alice }.count)
        #expect(await m.lookup(origin, lookup: v.lookup(u: v.alice), u: "someone-else", fetch: unreachable).why == "wrong-user")
        var broken = v.lookup(u: v.alice)
        broken = broken.with("entries", .array(broken.arr("entries")!.map { $0.with("index", 6) }))
        #expect(await m.lookup(origin, lookup: broken, u: v.alice, fetch: unreachable).why == "not-included")
    }
}

@Suite struct KtOwnCheckTests {
    func e(_ t: String, apk: String, dpk: String = "", exp: Int64 = 0, i: Int64) -> KtLogEntry {
        KtLogEntry(entry: .compact(["t": .string(t), "u": "u1", "apk": .string(apk), "dpk": dpk.isEmpty ? nil : .string(dpk), "exp": exp > 0 ? .int(exp) : nil, "ts": 1]), index: i)
    }

    @Test func deviceStatusReadsTheLatestEntries() {
        let entries = [e("acct", apk: "A", i: 0), e("dev", apk: "A", dpk: "D", exp: 100, i: 1)]
        #expect(KtLogEntry.deviceStatus(entries, apk: "A", dpk: "D", now: 50).ok)
        #expect(!KtLogEntry.deviceStatus(entries, apk: "A", dpk: "D", now: 150).ok) // expired
        #expect(KtLogEntry.deviceStatus(entries + [e("rev", apk: "A", dpk: "D", i: 2)], apk: "A", dpk: "D", now: 50).revoked)
        #expect(!KtLogEntry.deviceStatus(entries + [e("rev", apk: "A", dpk: "D", i: 2), e("dev", apk: "A", dpk: "D", exp: 100, i: 3)], apk: "A", dpk: "D", now: 50).revoked)
        #expect(!KtLogEntry.deviceStatus(entries + [e("acct", apk: "B", i: 4)], apk: "A", dpk: "D", now: 50).account) // account key replaced
    }

    @Test func ownEntriesFindUnknownDevicesAndAnotherAccountKey() {
        let first = KtService.ownCheck(nil, u: "u1", entries: [e("acct", apk: "A", i: 0), e("dev", apk: "A", dpk: "D1", i: 1)], apk: "A", myPk: "ME", now: 1)
        #expect(first.unknown == 0 && !first.accountChanged) // trust on first use
        let second = KtService.ownCheck(first.state, u: "u1", entries: [e("acct", apk: "A", i: 0), e("dev", apk: "A", dpk: "D1", i: 1), e("dev", apk: "A", dpk: "D2", i: 2)],
                                        apk: "A", myPk: "ME", now: 2)
        #expect(second.unknown == 1 && second.state.arr("pending") == ["D2"])
        let revoked = KtService.ownCheck(second.state, u: "u1", entries: [e("dev", apk: "A", dpk: "D2", i: 2), e("rev", apk: "A", dpk: "D2", i: 3)], apk: "A", myPk: "ME", now: 3)
        #expect(revoked.unknown == 0)
        let changed = KtService.ownCheck(second.state, u: "u1", entries: [e("acct", apk: "A", i: 0), e("acct", apk: "B", i: 5)], apk: "A", myPk: "ME", now: 4)
        #expect(changed.accountChanged && changed.state.str("account") == "B")
        // Another account on this device: a first check again.
        #expect(KtService.ownCheck(second.state, u: "u2", entries: [e("dev", apk: "A", dpk: "D9", i: 1)], apk: "A", myPk: "ME", now: 5).unknown == 0)
    }
}

@Suite struct KtServiceTests {
    @Test func refreshPinsUpdatesAndChecksOwnEntries() async throws {
        let v = try KtVectors()
        let http = StubHTTP { req in
            switch req.url.path {
            case "/api/kt/key": return StubHTTP.json(["key": .string(v.key)])
            case "/api/kt/sth": return StubHTTP.json(v.sth7)
            case "/api/kt/lookup":
                #expect(req.headers["Authorization"] == "Bearer tok")
                #expect(req.url.query == "u=\(v.alice)")
                return StubHTTP.json(v.lookup(u: v.alice))
            default: return StubHTTP.json(404, ["ok": false])
            }
        }
        // This device: one of alice's devices under her CURRENT account key (the latest `acct` entry).
        let current = v.entries.last { $0.str("u") == v.alice && $0.str("t") == "acct" }!.str("apk")
        let alice = v.entries.last { $0.str("u") == v.alice && $0.str("t") == "dev" && $0.str("apk") == current }
            ?? ["apk": .string(current), "dpk": "bm90LWxvZ2dlZA=="]
        let own = MemoryNetStateStore()
        let clock = TestClock(1_800_000_000_000)
        let service = KtService(origin: origin, client: KtClient(http: HTTPClient(transport: http)), monitor: KtMonitor(store: MemoryKtStateStore(), verifier: TestKtVerifier()),
                                ownStore: own, clock: clock.clock)
        let me = KtSelf(token: "tok", username: "alice", accountKey: alice.str("apk"), devicePublicKey: alice.str("dpk"))
        let first = await service.refresh(me: me)
        #expect(first == .ran(pin: "new", update: "ok", pending: "ok", own: "ok"), "\(first)")
        #expect(await service.ktOn())
        #expect(await service.sth() == v.sth7)
        #expect(await own.load(KtService.ownKey)?.str("u") == v.alice)
        #expect(await service.refresh(me: me) == .skipped)
        clock.advance(11 * 60_000)
        #expect(await service.refresh(me: me) == .ran(pin: "match", update: "ok", pending: "ok", own: "ok"))
    }

    @Test func aServerWithoutKeyTransparencyIsOff() async {
        let http = StubHTTP { _ in StubHTTP.json(503, ["ok": false, "code": "kt-off", "message": "off"]) }
        let service = KtService(origin: origin, client: KtClient(http: HTTPClient(transport: http)), monitor: KtMonitor(store: MemoryKtStateStore(), verifier: TestKtVerifier()),
                                ownStore: MemoryNetStateStore())
        #expect(await service.refresh(me: nil) == .off("kt-off"))
        #expect(await !service.ktOn())
    }

    @Test func dismissingAnUnknownDeviceMakesItKnown() async throws {
        let own = MemoryNetStateStore([KtService.ownKey: ["u": "u1", "apk": "A", "known": ["ME": 1], "pending": ["D2"], "account": "B"]])
        let monitor = KtMonitor(store: MemoryKtStateStore(), verifier: TestKtVerifier())
        let service = KtService(origin: origin, monitor: monitor, ownStore: own)
        await monitor.raiseAlert(origin, kind: "account-key", detail: "x")
        await service.dismissAlert()
        let state = try #require(await own.load(KtService.ownKey))
        #expect(state.obj("known")?["D2"] != nil && state.arr("pending") == [] && state.str("acceptedAccount") == "B")
        #expect(await service.alertKind() == "")
    }
}
