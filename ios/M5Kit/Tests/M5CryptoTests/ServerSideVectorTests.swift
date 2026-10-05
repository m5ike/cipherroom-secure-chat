// test/vectors/p4.json "hubProof", "kt", "replay", "release".

import Foundation
import M5Core
@testable import M5Crypto
import Testing

@Suite struct ServerSideVectorTests {
    let V = Repo.p4

    @Test func hubProofFromTheRoomSecret() throws {
        for c in V.a("hubProof") {
            // RoomKeys.derive(info, n) is exactly this HKDF (salt "m5cet:v2") over the room secret.
            let seed = Crypto.hkdf(try Prim.unb64(c.s("roomSecret")), Crypto.utf8("m5cet:v2"), Crypto.utf8(P4.lHubSeed), 32)
            #expect(Prim.b64(seed) == c.s("seed"))
            #expect(try HubProof.pub(seed) == c.s("pub"))
            #expect(text(try HubProof.joinData(c.s("roomId"), c.s("nonce"))) == c.s("signedData"))
            let proof = try HubProof.build(seed: seed, roomId: c.s("roomId"), nonce: c.s("nonce"))
            #expect(proof.string("sig") == c.s("sig"))
            #expect(proof.string("pub") == c.s("pub"))
            #expect(HubProof.verify(pub: c.s("pub"), sig: c.s("sig"), roomId: c.s("roomId"), nonce: c.s("nonce")))
            #expect(!HubProof.verify(pub: c.s("pub"), sig: c.s("sig"), roomId: "r3.other", nonce: c.s("nonce")))
            // The same seed through RoomKeys' derive (the room's HKDF tree).
            #expect(RoomKeys.fromSeed(room: "x", seed: try Prim.unb64(c.s("roomSecret"))).hubSeed() == seed)
        }
    }

    static func b64s(_ list: [Bytes]) -> JSON { .array(list.map { .string(Prim.b64($0)) }) }
    static func decode(_ a: [JSON]) throws -> [Bytes] { try a.map { try Prim.unb64($0) } }

    @Test func keyTransparencyEntriesTreeProofsHeads() throws {
        let K = V.o("kt")
        for u in K.a("users") { #expect(Kt.user(u.s("name")) == u.s("u")) }
        let entries = K.a("entries")
        var leaves = [Bytes]()
        for (i, e) in entries.enumerated() {
            #expect(try Kt.canonicalEntry(e) == K.a("leaves")[i].stringValue)
            let h = try Kt.entryLeafHash(e)
            #expect(Prim.b64(h) == K.a("leafHashes")[i].stringValue)
            #expect(Prim.b64(Merkle.leafHash(K.a("leaves")[i].stringValue!)) == K.a("leafHashes")[i].stringValue)
            leaves.append(h)
        }
        let roots = K.a("roots").map { $0.stringValue! }
        for size in 0..<roots.count { #expect(Prim.b64(Merkle.treeHash(leaves, 0, size)) == roots[size]) }
        for c in K.a("inclusion") {
            let index = Int(c.i("index")), size = Int(c.i("size"))
            let path = Merkle.inclusionProof(leaves, index, size)
            #expect(ServerSideVectorTests.b64s(path) == c.o("path"))
            #expect(Merkle.verifyInclusion(leaves[index], Int64(index), Int64(size), try ServerSideVectorTests.decode(c.a("path")), try Prim.unb64(roots[size])))
            if size > 1 {
                #expect(!Merkle.verifyInclusion(leaves[(index + 1) % size], Int64(index), Int64(size), try ServerSideVectorTests.decode(c.a("path")), try Prim.unb64(roots[size])))
            }
        }
        for c in K.a("consistency") {
            let from = Int(c.i("from")), to = Int(c.i("to"))
            let proof = Merkle.consistencyProof(leaves, from, to)
            #expect(ServerSideVectorTests.b64s(proof) == c.o("proof"))
            #expect(Merkle.verifyConsistency(Int64(from), Int64(to), try Prim.unb64(roots[from]), try Prim.unb64(roots[to]), try ServerSideVectorTests.decode(c.a("proof"))))
            if from > 0 && from < to {
                #expect(!Merkle.verifyConsistency(Int64(from), Int64(to), try Prim.unb64(roots[from - 1]), try Prim.unb64(roots[to]), try ServerSideVectorTests.decode(c.a("proof"))))
            }
        }
        let ktSeed = try Prim.unb64(K.s("ktSeed"))
        #expect(Prim.b64(try Prim.ed25519Public(ktSeed)) == K.s("ktKey"))
        for s in K.a("sth") {
            #expect(text(try Kt.sthData(s.i("size"), s.s("root"), s.i("ts"))) == s.s("signedData"))
            #expect(try Kt.signSth(ktSeed, s.i("size"), try Prim.unb64(s.s("root")), s.i("ts")).string("sig") == s.s("sig"))
            let head = JSONObject([("size", .int(s.i("size"))), ("root", .string(s.s("root"))), ("ts", .int(s.i("ts"))), ("sig", .string(s.s("sig")))])
            #expect(Kt.verifySth(.object(head), K.s("ktKey")))
            #expect(!Kt.verifySth(.object(head.with("ts", .int(s.i("ts") + 1))), K.s("ktKey")))
        }
    }

    /// The KT client state against the vector log: lookups, device status, rewritten history and split views.
    @Test func keyTransparencyState() async throws {
        let K = V.o("kt")
        let ktSeed = try Prim.unb64(K.s("ktSeed"))
        let entries = K.a("entries")
        let leaves = try entries.map { try Kt.entryLeafHash($0) }
        let fetch: Kt.ConsistencyFetcher = { from, to in
            JSONObject([("from", .int(from)), ("to", .int(to)), ("proof", ServerSideVectorTests.b64s(Merkle.consistencyProof(leaves, Int(from), Int(to))))])
        }
        let sth5 = try Kt.signSth(ktSeed, 5, Merkle.treeHash(leaves, 0, 5), 1_800_000_100_000)
        let sth7 = try Kt.signSth(ktSeed, 7, Merkle.treeHash(leaves, 0, 7), 1_800_000_200_000)
        let kt = KtState(clock: ManualClock(1_800_000_300_000))
        #expect(await kt.update("s", .object(sth5), fetch: fetch).status == "no-key")
        #expect(try await kt.pinKey("s", K.s("ktKey")) == "new")
        #expect(try await kt.pinKey("s", K.s("ktKey")) == "match")
        #expect(await kt.update("s", .object(sth5), fetch: fetch).status == "ok")
        #expect(await kt.update("s", .object(sth7), fetch: fetch).status == "ok")
        #expect(await kt.newest("s")?.int64("size") == 7)
        #expect(await kt.update("s", .object(sth5), fetch: fetch).status == "ok") // an older consistent head is fine (not kept)
        #expect(await kt.gossip("s", .object(sth7)).status == "ok")
        #expect(await kt.gossip("s", .object(sth5)).status == "need-consistency")
        #expect(await kt.resolveGossip("s", .object(sth5), fetch: fetch).status == "ok")
        #expect(await kt.gossip("s", .object(try Kt.signSth(Bytes(repeating: 0, count: 32), 7, Merkle.treeHash(leaves, 0, 7), 1))).status == "ignored")
        // Lookup of alice: her entries with inclusion proofs in the 7-head.
        let ua = Kt.user("alice")
        var found = [JSON]()
        for (i, e) in entries.enumerated() where e.s("u") == ua {
            found.append(.object(JSONObject([("entry", e), ("index", .int(i)), ("proof", ServerSideVectorTests.b64s(Merkle.inclusionProof(leaves, i, 7)))])))
        }
        let c = await kt.lookup("s", JSONObject([("sth", .object(sth7)), ("entries", .array(found))]), u: ua, fetch: fetch)
        #expect(c.ok, "\(c.why ?? "")")
        #expect(c.entries.count == found.count)
        let dev = entries[2]
        // alice's account key changed (entry 6), and her device was revoked after its certificate (entry 4).
        let st = Kt.deviceStatus(c.entries, apk: dev.s("apk"), dpk: dev.s("dpk"), now: 1_800_000_000_000)
        #expect(!st.account)
        #expect(st.revoked)
        #expect(!st.ok)
        #expect(Kt.verifyLookup(.object(JSONObject([("sth", .object(sth7)), ("entries", .array(found))])), K.s("ktKey"), Kt.user("bob")).why == "wrong-user")
        // bob: account and device fine.
        let bobDev = entries[5]
        let ub = Kt.user("bob")
        var bobFound = [JSON]()
        for (i, e) in entries.enumerated() where e.s("u") == ub {
            bobFound.append(.object(JSONObject([("entry", e), ("index", .int(i)), ("proof", ServerSideVectorTests.b64s(Merkle.inclusionProof(leaves, i, 7)))])))
        }
        let bob = Kt.verifyLookup(.object(JSONObject([("sth", .object(sth7)), ("entries", .array(bobFound))])), K.s("ktKey"), ub).entries
        #expect(Kt.deviceStatus(bob, apk: bobDev.s("apk"), dpk: bobDev.s("dpk"), now: 1_800_000_000_000).ok)
        #expect(!Kt.deviceStatus(bob, apk: bobDev.s("apk"), dpk: bobDev.s("dpk"), now: bobDev.i("exp")).ok)
        // A proof for another index does not verify.
        let wrong = found[0].obj.with("index", 1)
        #expect(Kt.verifyLookup(.object(JSONObject([("sth", .object(sth7)), ("entries", .array([.object(wrong)]))])), K.s("ktKey"), ua).why == "not-included")
        #expect(await kt.alert("s") == nil)
        // A rewritten history: another root for size 7 → a persistent alert.
        var forged = leaves
        forged[3] = Merkle.leafHash("forged")
        let fake7 = try Kt.signSth(ktSeed, 7, Merkle.treeHash(forged, 0, 7), 1_800_000_250_000)
        #expect(await kt.update("s", .object(fake7), fetch: fetch).status == "inconsistent")
        #expect(await kt.alert("s")?.kind == "inconsistent")
        let peerView = KtState()
        _ = try await peerView.pinKey("t", K.s("ktKey"))
        _ = await peerView.update("t", .object(sth7), fetch: fetch)
        #expect(await peerView.gossip("t", .object(fake7)).status == "split-view")
        #expect(await peerView.alert("t")?.kind == "split-view")
        let fake9 = try Kt.signSth(ktSeed, 9, Bytes(repeating: 0, count: 32), 1_800_000_260_000)
        let other = KtState()
        _ = try await other.pinKey("u", K.s("ktKey"))
        _ = await other.update("u", .object(sth7), fetch: fetch)
        let lying: Kt.ConsistencyFetcher = { from, to in JSONObject([("from", .int(from)), ("to", .int(to)), ("proof", .array([.string(Prim.b64(Bytes(repeating: 0, count: 32)))]))]) }
        #expect(await other.update("u", .object(fake9), fetch: lying).status == "inconsistent")
        #expect(try await kt.pinKey("s", Prim.b64(Bytes(repeating: 0, count: 32))) == "changed")
        await kt.dismissAlert("s")
        #expect(await kt.alert("s") == nil)
    }

    /// Review P05: an unreachable server leaves the head pending; past 24 h the alert is raised; a retry that succeeds clears it.
    @Test func keyTransparencyPendingProofs() async throws {
        let K = V.o("kt")
        let ktSeed = try Prim.unb64(K.s("ktSeed"))
        let leaves = try K.a("entries").map { try Kt.entryLeafHash($0) }
        let clock = ManualClock(1_800_000_300_000)
        let kt = KtState(clock: clock)
        _ = try await kt.pinKey("s", K.s("ktKey"))
        let sth5 = try Kt.signSth(ktSeed, 5, Merkle.treeHash(leaves, 0, 5), 1)
        let sth7 = try Kt.signSth(ktSeed, 7, Merkle.treeHash(leaves, 0, 7), 2)
        let down: Kt.ConsistencyFetcher = { _, _ in throw Kt.Unreachable() }
        let up: Kt.ConsistencyFetcher = { from, to in
            JSONObject([("from", .int(from)), ("to", .int(to)), ("proof", ServerSideVectorTests.b64s(Merkle.consistencyProof(leaves, Int(from), Int(to))))])
        }
        #expect(await kt.update("s", .object(sth5), fetch: down).status == "ok")
        #expect(await kt.update("s", .object(sth7), fetch: down).status == "pending")
        #expect(await kt.pendingCount("s") == 1)
        clock.advance(Kt.pendingMaxMs + 1)
        #expect(await kt.retryPending("s", fetch: down).status == "unproven")
        #expect(await kt.alert("s")?.kind == "unproven")
        await kt.dismissAlert("s")
        #expect(await kt.retryPending("s", fetch: up).status == "ok")
        #expect(await kt.pendingCount("s") == 0)
        #expect(await kt.newest("s")?.int64("size") == 7)
    }

    @Test func replayKeysAndGuard() throws {
        for c in V.a("replay") { #expect(try Replay.key(c.s("roomId"), c.s("id")) == c.s("key")) }
        let now: Int64 = 1_800_000_000_000
        let g = ReplayGuard(store: MemoryReplayStore(), pruneEvery: 0)
        #expect(g.check("r3.a", "m1", createdAt: now, now: now) == "ok")
        #expect(g.check("r3.a", "m1", createdAt: now, now: now) == "replay")
        #expect(g.check("r3.b", "m1", createdAt: now, now: now) == "ok")
        #expect(g.check("r3.a", "m2", createdAt: now - P4.replayWindowMs - 1, now: now) == "too-old")
        // § 11 (6.12): a sender whose clock runs ahead is accepted, its time clamped — and its id remembered with now.
        #expect(g.check("r3.a", "m3", createdAt: now + P4.replayFutureMs + 1, now: now) == "clamped")
        #expect(g.check("r3.a", "m3", createdAt: now + P4.replayFutureMs + 1, now: now) == "replay")
        #expect(g.check("r3.a", "m3b", createdAt: now + P4.replayFutureMs, now: now) == "ok")
        #expect(g.check("r3.a", "m|4", createdAt: now, now: now) == "malformed")
        #expect(g.check("r3.a", "m5", createdAt: .string("soon"), now: now) == "malformed")
        #expect(g.check("r3.a", "m1", createdAt: now - P4.replayWindowMs * 2, now: now, restored: true) == "ok") // restored history: remembered only
        #expect(g.checkId("r3.c", "p3", now: now) == "ok")
        #expect(g.checkId("r3.c", "p3", now: now) == "replay")
        // The store prunes by age, then by count.
        let store = MemoryReplayStore()
        for i in 0..<5 { store.add("r", "k\(i)", Int64(i)) }
        store.prune("r", before: 2, max: 2)
        #expect(store.snapshot("r").map(\.key) == ["k3", "k4"])
    }

    @Test func signedReleaseManifest() throws {
        let R = V.o("release")
        let m = try Release.parse(R.s("manifest"))
        let seed = try Prim.unb64(R.s("seed"))
        #expect(Prim.b64(try Prim.ed25519Public(seed)) == R.s("publicKey"))
        #expect(Prim.b64(try Prim.ed25519Sign(seed, Prim.utf8(R.s("manifest")))) == R.s("sig"))
        #expect(Release.verifySignature(Prim.utf8(R.s("manifest")), signature: R.s("sig"), publicKey: R.s("publicKey")))
        #expect(!Release.verifySignature(Prim.utf8(R.s("manifest") + " "), signature: R.s("sig"), publicKey: R.s("publicKey")))
        let files = R.o("files").obj
        let list = m.array("files")!
        #expect(files.count == list.count)
        for f in list {
            let body = Prim.utf8(files.string(f.s("path"))!)
            #expect(f.i("size") == Int64(body.count))
            #expect(Release.sha256Hex(body) == f.s("sha256"))
        }
        for k in files.keys { #expect(Release.isReleasePath(k)) }
        #expect(!Release.isReleasePath("../etc/passwd"))
        #expect(!Release.isReleasePath("/abs"))
        #expect(!Release.isReleasePath("a//b"))
        // Unsorted or duplicate files are refused.
        var bad = m
        bad["files"] = .array(list.reversed())
        if list.count > 1 { expectP4("malformed") { _ = try Release.parse(bad.stringify()) } }
    }
}
