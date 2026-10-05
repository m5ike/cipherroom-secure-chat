// test/vectors/p4.json "senderKey", "mailbox" (incl. re-seal), "files", "media".

import Foundation
import M5Core
@testable import M5Crypto
import Testing

@Suite struct MessagesVectorTests {
    let V = Repo.p4

    @Test func senderKeyChainWithCertAndMessages() throws {
        let S = V.o("senderKey"), hs = V.o("handshake")
        #expect(S.s("owner") == hs.o("A").s("peerId"))
        #expect(S.s("ownerPk") == hs.o("A").s("pk"))
        let roomId = S.s("roomId")
        let alice = SenderKeys4(roomId: roomId, ownerPk: S.s("ownerPk"), rng: TapeRng(S.a("tape")))
        #expect(try alice.prepare(1_800_000_000_000))
        let chain = try alice.chainFor(hs.o("B").s("peerId"))
        let expected = S.o("chain")
        #expect(without(expected, "cert") == JSON.object(chain.without("cert"))) // the cert is ECDSA: randomized
        #expect(text(try SenderKeys4.certData(roomId, expected.s("keyId"), S.s("ownerPk"))) == S.s("certSignedData"))
        #expect(Prim.ecdsaVerify(expected.s("spk"), Prim.utf8(S.s("certSignedData")), expected.s("cert")))
        #expect(Prim.ecdsaVerify(expected.s("spk"), Prim.utf8(S.s("certSignedData")), chain.string("cert")))
        let messages = S.a("messages")
        for (i, m) in messages.enumerated() {
            let env = try alice.seal(m.o("payload").s("id"), m.s("json"))
            #expect(without(m.o("envelope"), "s") == JSON.object(env.without("s")), "message \(i)")
            #expect(text(try SenderKeys4.aad(roomId, env.string("id")!, env.string("sk")!, env.int64("n")!)) == m.s("aad"))
        }
        let bob = SenderKeys4(roomId: roomId, ownerPk: hs.o("B").s("pk"))
        #expect(!bob.acceptChain(S.s("owner"), hs.o("B").s("pk"), expected)) // names A's device, not B's
        #expect(bob.acceptChain(S.s("owner"), S.s("ownerPk"), expected))
        for i in [3, 0, 2, 1] {
            let m = messages[i]
            #expect(JSON.object(try bob.open(S.s("owner"), m.o("envelope"))) == m.o("payload"), "open \(i)")
        }
        // The chain A hands to B in the ratchet script is this one.
        let sent = V.o("ratchet").a("script").last { $0.s("op") == "send" && $0.o("inner").s("t") == "sk" }
        #expect(sent?.s("by") == "A")
        #expect(sent?.o("inner") == expected)
    }

    @Test func senderKeyRefusals() throws {
        let S = V.o("senderKey")
        let roomId = S.s("roomId"), owner = S.s("owner"), ownerPk = S.s("ownerPk")
        let chain = S.o("chain")
        let first = S.a("messages")[0].o("envelope")
        let bob = SenderKeys4(roomId: roomId, ownerPk: "x")
        expectP4("no-chain") { _ = try bob.open(owner, first) }
        #expect(bob.acceptChain(owner, ownerPk, chain))
        // Another member re-announcing A's chain (same spk) under its own device is refused.
        #expect(!bob.acceptChain("peer-mallory", ownerPk + "x", chain))
        #expect(!bob.acceptChain("peer-mallory", ownerPk, .object(chain.obj.with("cert", .string(Prim.b64(Bytes(repeating: 0, count: 64)))))))
        // A chain is found by (sender, keyId): the same envelope from another peer has no chain.
        expectP4("no-chain") { _ = try bob.open("peer-mallory", first) }
        // A forged signature is refused BEFORE the chain moves; the real message still opens afterwards.
        expectP4("signature") { _ = try bob.open(owner, .object(first.obj.with("s", .string(Prim.b64(Bytes(repeating: 0, count: 64)))))) }
        expectP4("signature") { _ = try bob.open(owner, .object(first.obj.with("id", "sk-msg-x"))) }
        _ = try bob.open(owner, first)
        expectP4("replay") { _ = try bob.open(owner, first) }
    }

    @Test func senderKeysSwiftRoundTripRotationAndSkips() throws {
        let roomId = "r3.room", now: Int64 = 1_800_000_000_000
        let a = Prim.generateP256()
        let alice = SenderKeys4(roomId: roomId, ownerPk: a.spki)
        let bob = SenderKeys4(roomId: roomId, ownerPk: "b")
        #expect(alice.due(now))
        #expect(try alice.prepare(now))
        #expect(try !alice.prepare(now + 1))
        #expect(bob.acceptChain("pa", a.spki, .object(try alice.chainFor("pb"))))
        var envs = [JSONObject]()
        for i in 0..<10 { envs.append(try alice.seal("m\(i)", #"{"id":"m\#(i)","text":"\#(i)"}"#)) }
        for i in [9, 1, 5, 0, 2, 3, 4, 6, 8, 7] { #expect(try bob.open("pa", .object(envs[i])).string("text") == "\(i)") }
        // A payload whose id is not the envelope's.
        expectP4("id-mismatch") { _ = try alice.seal("m1", #"{"id":"other"}"#) }
        // Rotation after 15 minutes: one older chain keeps working.
        #expect(alice.due(now + P4.senderKeyRotateMs))
        let old = try alice.seal("old", #"{"id":"old"}"#)
        #expect(try alice.prepare(now + P4.senderKeyRotateMs))
        #expect(bob.acceptChain("pa", a.spki, .object(try alice.chainFor("pb"))))
        let fresh = try alice.seal("new", #"{"id":"new"}"#)
        #expect(try bob.open("pa", .object(fresh)).string("id") == "new")
        #expect(try bob.open("pa", .object(old)).string("id") == "old")
        // Too far ahead.
        let farChain = try alice.chainFor("pb")
        var far = farChain
        far["index"] = .int(0)
        let x = SenderKeys4(roomId: roomId, ownerPk: "c")
        #expect(x.acceptChain("pa", a.spki, .object(far)))
        for i in 0..<(P4.maxSkip + 1) { _ = try alice.seal("f\(i)", #"{"id":"f\#(i)"}"#) }
        let tooFar = try alice.seal("tf", #"{"id":"tf"}"#)
        expectP4("skip") { _ = try x.open("pa", .object(tooFar)) }
        bob.peerLeft("pa")
        #expect(!bob.hasAnyChainOf("pa"))
    }

    @Test func mailboxOpensAndResealsIdentically() async throws {
        let M = V.o("mailbox")
        let now = M.i("now")
        let rKeys = try keysOf(M.o("recipient"), now)
        let sKeys = try keysOf(M.o("sender"), now)
        let item = M.o("item").obj
        let opened = try Mailbox.open(item, roomId: M.s("roomId"), mine: rKeys)
        #expect(JSON.object(opened.payload) == M.o("payload"))
        #expect(opened.spk == M.o("sender").s("pk"))
        // 6.12 review P13: the sender's account attestation (a v2 sacc) is bound by the AAD's saccDigest.
        #expect(opened.sacc.map { JSON.object($0) } == M.o("sacc"))
        #expect(try Handshake.accDigest(item["sacc"]) == M.s("saccDigest"))
        #expect(text(try Mailbox.aad(M.s("roomId"), item.string("id")!, item.string("spk")!, item.object("sb")!.string("id")!, item.string("to")!,
                                     item.string("e")!, Prim.hB64(try Prim.unb64(item.string("kct"))), try Handshake.accDigest(item["sacc"]))) == M.s("aad"))
        let again = try Mailbox.seal(roomId: M.s("roomId"), id: M.o("payload").s("id"), payloadJson: M.s("json"), recipientPk: M.o("recipient").s("pk"),
                                     recipient: Mailbox.Bundle.parse(M.o("recipient").o("bundle"))!, senderPk: M.o("sender").s("pk"),
                                     sacc: M.o("sacc").obj, sender: sKeys, now: now, rng: TapeRng(M.a("sealTape")))
        #expect(JSON.object(again) == JSON.object(item), "resealed item")
        // Without its sacc (stripped by the relay) the item does not open.
        expectP4("aead") { _ = try Mailbox.open(item.without("sacc"), roomId: M.s("roomId"), mine: rKeys) }
        // Through a Mailbox (store of own bundles): an item, a set, another device's item, another room.
        let store = MemoryMailboxStore()
        store.put(rKeys)
        let box = Mailbox(store: store, signer: try signerOf(M.o("recipient").s("devicePkcs8"), M.o("recipient").s("pk")))
        #expect(try box.open(item, roomId: M.s("roomId"), now: now) != nil)
        let other = item.with("to", "AAAAAAAAAAA")
        #expect(JSON.object(try box.open(try Mailbox.set(item.string("id")!, [other, item]), roomId: M.s("roomId"), now: now)!.payload) == M.o("payload"))
        #expect(try box.open(other, roomId: M.s("roomId"), now: now) == nil)
        expectP4("aead") { _ = try box.open(item, roomId: "r3.another", now: now) }
        expectP4("wiped") { _ = try box.open(item, roomId: M.s("roomId"), now: rKeys.bundle.exp + P4.mailboxKeepMs) }
        // The stored form of a bundle's keys round-trips (the vault keeps it so).
        let back = try Mailbox.Keys.parse(rKeys.json)
        #expect(try Mailbox.open(item, roomId: M.s("roomId"), mine: back).payload.string("id") == M.o("payload").s("id"))
    }

    private func keysOf(_ side: JSON, _ now: Int64) throws -> Mailbox.Keys {
        let rebuilt = try Mailbox.createBundle(try signerOf(side.s("devicePkcs8"), side.s("pk")), now, TapeRng(side.a("bundleTape")))
        #expect(without(side.o("bundle"), "sig") == JSON.object(rebuilt.bundle.json.without("sig")))
        #expect(Mailbox.check(side.o("bundle"), side.s("pk"), now) == nil)
        return Mailbox.Keys(bundle: Mailbox.Bundle.parse(side.o("bundle"))!, dh: rebuilt.dh, kemDk: rebuilt.kemDk, created: rebuilt.created)
    }

    @Test func mailboxMaintainsAndSealsSwiftToSwift() throws {
        let now: Int64 = 1_800_000_000_000
        let a = Prim.generateP256(), b = Prim.generateP256()
        let boxA = Mailbox(store: MemoryMailboxStore(), signer: Prim.signer(a))
        let boxB = Mailbox(store: MemoryMailboxStore(), signer: Prim.signer(b))
        let created = try boxB.maintain(now)
        #expect(created.created != nil)
        #expect(try boxB.maintain(now + 1000).created == nil)
        let bBundle = try boxB.current(now)!.bundle
        let item = try boxA.seal(roomId: "r3.x", id: "m1", payloadJson: #"{"id":"m1","text":"hi"}"#, recipientPk: b.spki, recipient: bBundle, sacc: nil, now: now)
        #expect(try boxB.open(item, roomId: "r3.x", now: now)?.payload.string("text") == "hi")
        // An expired recipient bundle, or one signed by another key, is refused before sealing.
        expectP4("expired") { _ = try boxA.seal(roomId: "r3.x", id: "m2", payloadJson: #"{"id":"m2"}"#, recipientPk: b.spki, recipient: bBundle, sacc: nil, now: bBundle.exp) }
        expectP4("signature") { _ = try boxA.seal(roomId: "r3.x", id: "m2", payloadJson: #"{"id":"m2"}"#, recipientPk: a.spki, recipient: bBundle, sacc: nil, now: now) }
        // Renewal a day before the expiry; the old bundle's keys are wiped a month after it.
        #expect(try boxB.maintain(bBundle.exp - P4.mailboxRenewBeforeMs + 1).created != nil)
        let wiped = try boxB.maintain(bBundle.exp + P4.mailboxKeepMs).wiped
        #expect(wiped.contains(bBundle.id))
    }

    @Test func filesAndMedia() throws {
        let F = V.o("files")
        let tx = F.s("transferId")
        let key = try Files4.fileKey(try Prim.unb64(F.s("fk")), tx)
        #expect(Prim.b64(key) == F.s("fileKey"))
        #expect(text(try Files4.metaAad(tx)) == F.o("aad").s("meta"))
        #expect(text(try Files4.chunkAad(tx, 3, 10)) == F.o("aad").s("chunk"))
        #expect(text(try Files4.endAad(tx)) == F.o("aad").s("end"))
        let meta = F.o("meta")
        #expect(try Files4.openBody(key, try Files4.metaAad(tx), iv: meta.s("iv"), ciphertext: meta.s("ciphertext")) == meta.s("text"))
        let ivTape: [JSON] = [["what": "file.iv", "bytes": .string(meta.s("iv"))]]
        let resealed = try Files4.sealBody(key, try Files4.metaAad(tx), meta.s("text"), TapeRng(ivTape))
        #expect(resealed.string("iv") == meta.s("iv"))
        #expect(resealed.string("ciphertext") == meta.s("ciphertext"))
        expectP4("aead") { _ = try Files4.openBody(key, try Files4.endAad(tx), iv: meta.s("iv"), ciphertext: meta.s("ciphertext")) }
        // A chunk round trip and a fresh FK.
        let chunk = try Files4.sealChunk(key, try Files4.chunkAad(tx, 0, 1), [1, 2, 3], SystemRng())
        #expect(try Files4.openChunk(key, try Files4.chunkAad(tx, 0, 1), iv: chunk.iv, ciphertext: chunk.ciphertext) == [1, 2, 3])
        expectP4("aead") { _ = try Files4.openChunk(key, try Files4.chunkAad(tx, 1, 2), iv: chunk.iv, ciphertext: chunk.ciphertext) }
        let inner = try Files4.newFileKey("tx-1", SystemRng())
        #expect(inner.string("t") == "file")
        #expect(try Files4.fileKey(b64: inner.string("key")!, "tx-1").count == 32)
        expectP4("malformed") { _ = try Files4.newFileKey("a|b", SystemRng()) }

        let media = V.o("media")
        for c in media.a("ivs") {
            #expect(Prim.hex(try Media4.frameIv(c.i("epoch"), c.i("counter"))) == c.s("iv"))
        }
        let f = media.o("frame")
        let mk = try Prim.unb64(f.s("key"))
        let sealed = try Media4.sealFrame(mk, try Prim.unb64(f.s("in")), clear: Int(f.i("clear")), iv: try Media4.frameIv(f.i("epoch"), f.i("counter")))
        #expect(Prim.b64(sealed) == f.s("out"))
        #expect(Media4.openFrame(mk, try Prim.unb64(f.s("out"))).map(Prim.b64) == f.s("in"))
        var bad = try Prim.unb64(f.s("out"))
        bad[bad.count - 10] ^= 1
        #expect(Media4.openFrame(mk, bad) == nil)
        expectP4("malformed") { _ = try Media4.frameIv(-1, 0) }
        expectP4("malformed") { _ = try Media4.frameIv(0, Media4.frameLimit) }
    }
}
