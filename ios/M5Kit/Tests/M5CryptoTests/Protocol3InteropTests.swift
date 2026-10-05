// The Swift port against what the web client and the server really produce
// (test/fixtures/android-interop.json, script/android-vectors.ts — the same
// file android InteropTest reads): Argon2id (RFC 9106 and hash-wasm), room
// keys from the passphrase, envelopes, sealed signals, pair keys, sender keys,
// private messages, files, identity helpers, the safety number, ECIES pushes.

import Foundation
import M5Core
@testable import M5Crypto
import Testing

@Suite(.serialized) struct Protocol3InteropTests {
    static let v: JSON = try! Repo.json("test/fixtures/android-interop.json")
    /// Derived once (Argon2id, 64 MiB, 3 passes).
    static let keys: RoomKeys = {
        let r = v.o("room")
        return try! RoomKeys.derive(room: r.s("room"), passphrase: r.s("passphrase"))
    }()

    @Test func argon2idMatchesRfc9106() throws {
        let tag = try Argon2.argon2id(password: Bytes(repeating: 1, count: 32), salt: Bytes(repeating: 2, count: 16), passes: 3, memoryKiB: 32, lanes: 4, length: 32,
                                      secret: Bytes(repeating: 3, count: 8), data: Bytes(repeating: 4, count: 12))
        #expect(Hex.encode(tag) == "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659")
    }

    @Test func argon2idMatchesHashWasm() throws {
        let list = Protocol3InteropTests.v.a("argon2id")
        #expect(!list.isEmpty)
        for c in list {
            let tag = try Argon2.argon2id(password: Crypto.utf8(c.s("password")), salt: Crypto.utf8(c.s("salt")), passes: Int(c.i("t")),
                                          memoryKiB: Int(c.i("m")), lanes: Int(c.i("p")), length: Int(c.i("len")))
            #expect(Hex.encode(tag) == c.s("hex"), "\(c.s("password"))")
        }
    }

    @Test func roomKeysMatchTheWeb() throws {
        let r = Protocol3InteropTests.v.o("room")
        let keys = Protocol3InteropTests.keys
        #expect(RoomKeys.normalizeRoom(r.s("input")) == r.s("room"))
        #expect(keys.roomId == r.s("roomId"))
        #expect(keys.check == r.s("check"))
        #expect(Hex.encode(keys.message) == r.s("message"))
        #expect(Hex.encode(keys.signal) == r.s("signal"))
        #expect(Hex.encode(keys.files) == r.s("files"))
        #expect(text(Envelopes.context("msg", "team", "id-1")) == Protocol3InteropTests.v.s("context"))
        // The stored room secret gives the same keys.
        let again = RoomKeys.fromSeed(room: keys.room, seed: keys.secret)
        #expect(again.roomId == keys.roomId && again.message == keys.message)
        #expect(RoomKeys.normalizeRoom("  Brno  Secure!! ") == "brno-secure")
        #expect(RoomKeys.normalizeRoom("A--b c") == "a--b-c")
        #expect(RoomKeys.normalizeRoom("---") == "secure-room")
    }

    @Test func opensWebMessagesAndChecksTheSignature() throws {
        let v = Protocol3InteropTests.v, keys = Protocol3InteropTests.keys
        let m = v.o("message")
        let signed = try Envelopes.openMessage(keys, m.o("signed").obj)
        #expect(signed.payload.string("text") == m.o("payload").s("text"))
        #expect(signed.signer?.valid == true)
        #expect(signed.signer?.publicKey == v.o("alice").s("publicKey"))
        let plain = try Envelopes.openMessage(keys, m.o("plain").obj)
        #expect(plain.signer == nil)
        // Tampering is caught.
        #expect(throws: (any Error).self) { try Envelopes.openMessage(keys, m.o("signed").obj.with("id", "msg-other")) }
    }

    @Test func swiftSealsWhatSwiftOpens() throws {
        let keys = Protocol3InteropTests.keys
        let me = ChatIdentity.generate()
        let payload = JSONObject([("id", "msg-swift-1"), ("text", "ze Swiftu ✓"), ("createdAt", 1), ("senderId", "p-me"), ("senderName", "Me")])
        let o = try Envelopes.openMessage(keys, try Envelopes.sealMessage(keys, id: "msg-swift-1", payload: payload, identity: me))
        #expect(o.payload.string("text") == "ze Swiftu ✓")
        #expect(o.signer?.valid == true)
        // A sealed signal both ways, and swapped peers fail.
        let s = try Envelopes.sealSignal(keys, from: "pa", to: "pb", payload: JSONObject([("type", "offer")]))
        #expect(try Envelopes.openSignal(keys, from: "pa", to: "pb", sealed: s.object("sealed")).string("type") == "offer")
        #expect(throws: (any Error).self) { try Envelopes.openSignal(keys, from: "pb", to: "pa", sealed: s.object("sealed")) }
    }

    @Test func opensASealedSignal() throws {
        let v = Protocol3InteropTests.v, keys = Protocol3InteropTests.keys
        let s = v.o("signal")
        let opened = try Envelopes.openSignal(keys, from: s.s("from"), to: s.s("to"), sealed: s.o("sealed").o("sealed").obj)
        #expect(opened.string("type") == "offer")
        #expect(throws: (any Error).self) { try Envelopes.openSignal(keys, from: s.s("to"), to: s.s("from"), sealed: s.o("sealed").o("sealed").obj) }
    }

    static func identity(_ who: JSON) throws -> ChatIdentity {
        try ChatIdentity.fromPkcs8(signPkcs8: who.s("signPkcs8"), publicKey: who.s("publicKey"), dhPkcs8: who.s("dhPkcs8"), dhPublicKey: who.s("dhPublicKey"))
    }

    @Test func pairKeysSenderKeysAndPrivateMessagesMatchTheWeb() throws {
        let v = Protocol3InteropTests.v, keys = Protocol3InteropTests.keys
        let pair = v.o("pair")
        let bob = try Protocol3InteropTests.identity(v.o("bob"))
        let store = SenderKeys()
        #expect(store.acceptHello(keys, bob, pair.o("helloA").obj, from: "p-alice", to: "p-bob") == nil)
        #expect(store.pairOf("p-alice").map { Hex.encode($0.key) } == pair.s("pairKey"))
        #expect(store.acceptSenderKey(keys, pair.o("senderKey").obj, from: "p-alice", to: "p-bob"))
        let live = pair.a("live")
        // Out of order: the third first (skipping), then the others.
        for i in [2, 0, 1] {
            let o = try store.openLive(keys, live[i].o("envelope").obj, from: "p-alice")
            #expect(o.payload.string("text") == live[i].o("payload").s("text"))
            #expect(o.signer?.valid == true)
        }
        // A message key is used only once.
        #expect(throws: (any Error).self) { try store.openLive(keys, live[0].o("envelope").obj, from: "p-alice") }
        let priv = try store.openPrivate(keys, pair.o("private").o("envelope").obj, from: "p-alice", to: "p-bob")
        #expect(priv.payload.string("text") == "jen pro Boba")
        // The hello is checked: a wrong check value or a forged signature is refused.
        #expect(SenderKeys().acceptHello(keys, bob, pair.o("helloA").obj.with("check", "0000000000000000"), from: "p-alice", to: "p-bob") == "key-mismatch")
        #expect(SenderKeys().acceptHello(keys, bob, pair.o("helloA").obj, from: "p-mallory", to: "p-bob") == "bad-signature")
        #expect(SenderKeys.kind(live[0].o("envelope").obj) == "sender-key")
        #expect(SenderKeys.kind(pair.o("private").o("envelope").obj) == "pair")
        #expect(SenderKeys.kind(v.o("message").o("signed").obj) == "room")
    }

    @Test func swiftHelloAndSenderKeysWorkBothWays() throws {
        let keys = Protocol3InteropTests.keys
        let a = ChatIdentity.generate(), b = ChatIdentity.generate()
        let sa = SenderKeys(), sb = SenderKeys()
        #expect(sb.acceptHello(keys, b, try sa.hello(keys, a, from: "pa", to: "pb"), from: "pa", to: "pb") == nil)
        #expect(sa.acceptHello(keys, a, try sb.hello(keys, b, from: "pb", to: "pa"), from: "pb", to: "pa") == nil)
        #expect(sa.pairOf("pb")?.key == sb.pairOf("pa")?.key)
        #expect(sb.acceptSenderKey(keys, try sa.senderKeyFor(keys, from: "pa", to: "pb")!, from: "pa", to: "pb"))
        #expect(try sb.openLive(keys, try sa.sealLive(keys, id: "m1", payload: JSONObject([("id", "m1"), ("text", "hi")]), identity: a), from: "pa").payload.string("text") == "hi")
        let p = try sa.sealPrivate(keys, id: "p1", payload: JSONObject([("id", "p1"), ("text", "jen tobě")]), from: "pa", to: "pb", identity: a)!
        #expect(try sb.openPrivate(keys, p, from: "pa", to: "pb").payload.string("text") == "jen tobě")
        // Signed by another identity than the pair's: refused.
        let q = try sa.sealPrivate(keys, id: "p2", payload: JSONObject([("id", "p2")]), from: "pa", to: "pb", identity: ChatIdentity.generate())!
        #expect(throws: (any Error).self) { try sb.openPrivate(keys, q, from: "pa", to: "pb") }
        sb.forgetPeer("pa")
        #expect(!sb.hasPair("pa"))
    }

    @Test func opensAWebFile() throws {
        let v = Protocol3InteropTests.v, keys = Protocol3InteropTests.keys
        let f = v.o("file")
        let fk = keys.fileKey(f.s("transferId"))
        let meta = try Envelopes.openFileBody(fk, Envelopes.fileMetaContext(f.s("transferId")), iv: f.o("meta").s("iv"), ciphertext: f.o("meta").s("ciphertext"))
        #expect(meta.string("name") == "a.txt")
        let chunk = try Envelopes.openChunk(fk, Envelopes.fileChunkContext(f.s("transferId"), 0, 1), iv: f.o("chunk").s("iv"), ciphertext: f.o("chunk").s("ciphertext"))
        #expect(chunk == B64.decode(f.s("chunkPlain")))
    }

    @Test func identityHelpersMatch() throws {
        let v = Protocol3InteropTests.v
        let a = v.o("alice")
        #expect(Ec.kid(a.s("publicKey")) == a.s("kid"))
        #expect(Ec.fingerprint(a.s("publicKey")) == a.s("fingerprint"))
        #expect(ChatIdentity.safetyNumber(a.s("publicKey"), v.o("bob").s("publicKey")) == v.s("safetyNumber"))
        #expect(ChatIdentity.safetyNumber(v.o("bob").s("publicKey"), a.s("publicKey")) == v.s("safetyNumber"))
        let alice = try Protocol3InteropTests.identity(a)
        #expect(alice.kid == a.s("kid"))
        #expect(alice.signPkcs8 != nil)
    }

    @Test func opensAServerPushMessage() throws {
        let and = Protocol3InteropTests.v.o("android")
        let push = and.o("push")
        let signed = "m5push/1|" + and.s("deviceId") + "|" + push.s("i") + "|" + push.s("e") + "|" + push.s("iv") + "|" + push.s("ct")
        #expect(Ec.verify(and.s("serverPublicKey"), Crypto.utf8(signed), push.s("s")))
        let device = try Ec.privateFromPkcs8(try Crypto.unb64(and.s("devicePkcs8")))
        let content = JSON.parseObject(Crypto.str(try Ecies.open(device, deviceId: and.s("deviceId"), purpose: "push", Ecies.Wire(e: push.s("e"), iv: push.s("iv"), ct: push.s("ct")))))
        #expect(content?.string("kind") == "flash")
        #expect(content?.object("payload")?.string("text") == "ahoj")
        // Another device id (in the HKDF info and the AAD) does not open it.
        #expect(throws: (any Error).self) { try Ecies.open(device, deviceId: "and_other", purpose: "push", Ecies.Wire(e: push.s("e"), iv: push.s("iv"), ct: push.s("ct"))) }
        // And what Swift seals to a device opens there.
        let w = try Ecies.seal(deviceEncSpki: device.spki, deviceId: "ios_1", purpose: "bundle|b1", [1, 2, 3])
        #expect(try Ecies.open(device, deviceId: "ios_1", purpose: "bundle|b1", w) == [1, 2, 3])
    }

    @Test func derAndP1363() throws {
        let k = Prim.generateP256()
        for _ in 0..<20 {
            let sig = try Ec.sign(k, [9])
            #expect(try Ec.derToP1363(Ec.p1363ToDer(sig)) == sig)
            #expect(Ec.verify(k.publicKey, [9], sig))
        }
    }
}
