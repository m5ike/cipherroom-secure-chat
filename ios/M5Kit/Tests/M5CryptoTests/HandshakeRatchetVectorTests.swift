// test/vectors/p4.json "handshake" and "ratchet": both hellos verify (the
// protocol-3 sig, sig4 with its digests), replaying each party's tape rebuilds
// the same hellos, KEM messages, TH / RK0 / CK_B0 / SID, and the whole scripted
// conversation byte for byte — every send produces exactly the web's frame,
// every receive opens the web's frame to the same inner message.

import Foundation
import M5Core
@testable import M5Crypto
import Testing

func signerOf(_ pkcs8: String, _ pk: String) throws -> any DeviceSigner {
    let pair = try Prim.importP256Pkcs8(pkcs8)
    #expect(pair.spki == pk)
    return Prim.signer(pair)
}

@Suite struct HandshakeRatchetVectorTests {
    let V = Repo.p4

    @Test func handshakeAndWholeRatchetScript() throws {
        let hs = V.o("handshake")
        let roomId = hs.s("roomId"), check = hs.s("check"), roomName = hs.s("roomName")
        let now = hs.i("now")
        let party = [hs.o("A"), hs.o("B")]
        let rng = [TapeRng(party[0].a("tape")), TapeRng(party[1].a("tape"))]
        var built = [Handshake.Built]()

        for side in 0..<2 {
            let p = party[side], q = party[1 - side]
            let hello = p.o("hello").obj
            // The protocol-3 signature (over the readable room name) and sig4.
            #expect(Prim.ecdsaVerify(p.s("pk"), Prim.utf8("m5cet/hello/1|\(roomName)|\(p.s("peerId"))|\(q.s("peerId"))|\(check)|\(p.s("dh"))"), hello.string("sig")))
            #expect(text(try Handshake.sig4Data(roomId, p.s("peerId"), q.s("peerId"), hello)) == p.s("sig4Data"))
            let verdict = Handshake.verifyHello(.object(hello), roomId: roomId, from: p.s("peerId"), to: q.s("peerId"), check: check, now: now)
            #expect(verdict.ok, "\(verdict.why ?? "")")
            if hello["mb"] == .null { #expect(verdict.mailbox == nil) }
            else { #expect(verdict.mailbox.map { JSON.object($0.json) } == hello["mb"]) }
            #expect(try Handshake.mbDigest(hello["mb"]) == p.s("mbDigest"))
            #expect(try Handshake.accDigest(hello["acc"]) == p.s("accDigest"))
            if p["capsDigest"] != nil { #expect(try Handshake.capsDigest(hello["caps"]) == p.s("capsDigest")) }
            if p["userDigest"] != nil { #expect(try Handshake.userDigest(hello["user"]) == p.s("userDigest")) }
            if p["sthDigest"] != nil { #expect(try Handshake.sthDigest(hello["sth"]) == p.s("sthDigest")) }
            #expect(try Handshake.helloRef(hello) == p.s("helloRef"))
            // A hello for another recipient, another room or with a changed check does not verify as v4.
            #expect(Handshake.verifyHello(.object(hello), roomId: roomId, from: p.s("peerId"), to: "peer-x", check: check, now: now).why == "bad-sig4")
            #expect(Handshake.verifyHello(.object(hello), roomId: "r3.other", from: p.s("peerId"), to: q.s("peerId"), check: check, now: now).why == "bad-sig4")
            #expect(Handshake.verifyHello(.object(hello), roomId: roomId, from: p.s("peerId"), to: q.s("peerId"), check: "0000000000000000", now: now).why == "key-mismatch")
            // Replaying the tape gives the same hello (but the randomized sig4).
            var v3 = JSONObject([("check", .string(check)), ("pk", .string(p.s("pk"))), ("dh", .string(p.s("dh"))), ("sig", hello["sig"]!), ("caps", hello["caps"]!)])
            if let user = hello["user"] { v3["user"] = user }
            let b = try Handshake.buildHello(roomId: roomId, from: p.s("peerId"), to: q.s("peerId"), v3: v3, signer: try signerOf(p.s("devicePkcs8"), p.s("pk")),
                                             mb: hello["mb"], acc: hello["acc"], sth: hello["sth"], rng: rng[side])
            #expect(JSON.object(hello.without("sig4")) == JSON.object(b.hello.without("sig4")), "hello \(side)")
            #expect(Handshake.verifyHello(.object(b.hello), roomId: roomId, from: p.s("peerId"), to: q.s("peerId"), check: check, now: now).ok)
            built.append(b)
        }

        // A's mailbox bundle (from its own tape) and B's v2 account certificate.
        let A = party[0], B = party[1]
        let mbHello = A.o("hello").o("mb")
        let mbRebuilt = try Mailbox.createBundle(try signerOf(A.s("devicePkcs8"), A.s("pk")), now, TapeRng(A.a("mailboxBundleTape")))
        #expect(without(mbHello, "sig") == JSON.object(mbRebuilt.bundle.json.without("sig")))
        #expect(text(try Mailbox.signedData(mbHello.s("id"), mbHello.s("dh"), mbHello.s("kem"), mbHello.i("exp"))) == A.s("mailboxBundleSignedData"))
        #expect(Mailbox.check(mbHello, A.s("pk"), now) == nil)
        #expect(Mailbox.check(mbHello, A.s("pk"), mbHello.i("exp")) == "expired")
        #expect(Mailbox.check(mbHello, B.s("pk"), now) == "bad-signature")
        let acc = B.o("hello").o("acc")
        let accountSeed = try Prim.unb64(B.s("accountSeed"))
        #expect(Prim.b64(try Prim.ed25519Public(accountSeed)) == acc.s("apk"))
        #expect(try Prim.joinText(P4.lDeviceCert, B.s("pk"), acc.i("exp")) == B.s("certSignedData"))
        let ac = Handshake.verifyAccount(acc, pk: B.s("pk"), now: now)
        #expect(ac?.valid == true)
        #expect(ac?.v == 2)
        #expect(Handshake.verifyAccount(acc, pk: A.s("pk"), now: now)?.valid == false)
        #expect(Handshake.verifyAccount(acc, pk: B.s("pk"), now: acc.i("exp"))?.valid == false)
        // Ed25519 is deterministic: this port certifies the device exactly as the web did.
        #expect(try Handshake.certifyDeviceV2(accountSeed: accountSeed, devicePk: B.s("pk"), exp: acc.i("exp"), now: now).string("sig") == acc.s("ac"))

        // KEM messages: A's (to B's k) first in A's tape after its hello.
        let toB = try Handshake.buildKemMessage(B.o("hello").obj, rng[0])
        let toA = try Handshake.buildKemMessage(A.o("hello").obj, rng[1])
        #expect(JSON.object(toB.message) == hs.o("kemAtoB").o("message"))
        #expect(JSON.object(toA.message) == hs.o("kemBtoA").o("message"))
        #expect(Prim.b64(toB.ss) == hs.o("kemAtoB").s("ss"))
        #expect(Prim.b64(toA.ss) == hs.o("kemBtoA").s("ss"))
        let atA = try #require(try Handshake.openKemMessage(hs.o("kemBtoA").o("message"), ownHello: built[0].hello, own: built[0].secrets))
        let atB = try #require(try Handshake.openKemMessage(hs.o("kemAtoB").o("message"), ownHello: built[1].hello, own: built[1].secrets))
        #expect(Prim.b64(atA.ss) == hs.o("kemBtoA").s("ss"))
        #expect(Prim.b64(atB.ss) == hs.o("kemAtoB").s("ss"))
        // A KEM message for another hello is ignored.
        #expect(try Handshake.openKemMessage(hs.o("kemAtoB").o("message"), ownHello: built[0].hello, own: built[0].secrets) == nil)

        // § 4: dh0, TH, RK0, CK_B0, SID.
        #expect(Prim.b64(try Prim.ecdh(built[0].secrets.e, B.o("hello").s("e"))) == hs.s("dh0"))
        #expect(Prim.b64(try Prim.ecdh(built[1].secrets.e, A.o("hello").s("e"))) == hs.s("dh0"))
        let root = Handshake.rootSchedule(th: try Prim.unb64(hs.s("TH")), dh0: try Prim.unb64(hs.s("dh0")),
                                          ssA: try Prim.unb64(hs.o("kemAtoB").s("ss")), ssB: try Prim.unb64(hs.o("kemBtoA").s("ss")))
        #expect(Prim.b64(root.rk0) == hs.s("RK0"))
        #expect(Prim.b64(root.ckB0) == hs.s("CK_B0"))
        #expect(Prim.b64(root.sid) == hs.s("SID"))
        let sa = try Handshake.establish(roomId: roomId, check: check, selfPeerId: A.s("peerId"), selfHello: built[0].hello, selfSecrets: built[0].secrets,
                                         peerPeerId: B.s("peerId"), peerHello: B.o("hello").obj, sent: (toB.ct, toB.ss), received: atA, rng: rng[0])
        let sb = try Handshake.establish(roomId: roomId, check: check, selfPeerId: B.s("peerId"), selfHello: built[1].hello, selfSecrets: built[1].secrets,
                                         peerPeerId: A.s("peerId"), peerHello: A.o("hello").obj, sent: (toA.ct, toA.ss), received: atB, rng: rng[1])
        #expect(sa.role == "A")
        #expect(sb.role == "B")
        #expect(Prim.b64(sa.th) == hs.s("TH"))
        #expect(Prim.b64(sb.th) == hs.s("TH"))
        #expect(Prim.b64(sa.sid) == hs.s("SID"))
        #expect(Prim.b64(sb.sid) == hs.s("SID"))

        // The script: every send byte for byte, every receive to its inner message.
        let r = [sa.ratchet, sb.ratchet]
        let ids = [A.s("peerId"), B.s("peerId")]
        let script = V.o("ratchet").a("script")
        var wires = [Int: JSON]()
        var kct = 0, sends = 0, recvs = 0
        var lastFrame = 0
        for step in script {
            let by = step.s("by") == "A" ? 0 : 1
            let frameNo = Int(step.i("frame"))
            if step.s("op") == "send" {
                let frame = try r[by].encrypt(step.s("json"))
                #expect(JSON.object(frame) == step.o("wire"), "send #\(frameNo)")
                #expect(text(try Ratchet.pairAad(roomId, ids[by], ids[1 - by], sa.th, frame.object("h")!)) == step.s("aad"))
                wires[frameNo] = step.o("wire")
                if frame.object("h")!.has("kct") { kct += 1 }
                sends += 1
                lastFrame = frameNo
            } else {
                let res = r[by].decrypt(wires[frameNo] ?? .null)
                #expect(res.ok, "recv #\(frameNo): \(res.message ?? "")")
                #expect(res.inner.map { JSON.object($0) } == step.o("inner"), "recv #\(frameNo)")
                recvs += 1
            }
        }
        #expect(sends >= 12)
        #expect(sends == recvs)
        let steps = V.o("ratchet").o("kemSteps")
        #expect(Int64(kct) == steps.i("A") + steps.i("B"))
        #expect(steps.i("A") >= 3 && steps.i("B") >= 3)
        #expect(rng[0].remaining == 0)
        #expect(rng[1].remaining == 0)

        // A frame already opened is a replay; the session keeps working, the second failure asks for a reset.
        let byOfLast = script.last { $0.s("op") == "send" && Int($0.i("frame")) == lastFrame }!.s("by") == "A" ? 0 : 1
        let receiver = r[1 - byOfLast]
        let again = receiver.decrypt(wires[lastFrame]!)
        #expect(!again.ok)
        #expect(!again.reset)
        let twice = receiver.decrypt(wires[lastFrame]!)
        #expect(twice.reset)
        #expect(twice.error != nil)
    }

    /// The same exchange through PairHandshake objects with recorded randomness (Swift ↔ Swift).
    @Test func pairHandshakeRoundTripAndTamper() throws {
        let roomId = "r3.Vm9jdG9yUm9vbUlkRm9yUDQ", check = "5a17c0de5a17c0de", now: Int64 = 1_800_000_000_000
        let a = Prim.generateP256(), b = Prim.generateP256()
        func v3(_ p: P256Pair) -> JSONObject {
            JSONObject([("check", .string(check)), ("pk", .string(p.spki)), ("dh", .string(Prim.generateP256().spki)), ("sig", "x"), ("caps", .array(["files"]))])
        }
        let ha = try PairHandshake.start(roomId: roomId, check: check, selfPeerId: "pa", peerPeerId: "pb", v3: v3(a), signer: Prim.signer(a), mb: nil, acc: nil, sth: nil)
        let hb = try PairHandshake.start(roomId: roomId, check: check, selfPeerId: "pb", peerPeerId: "pa", v3: v3(b), signer: Prim.signer(b), mb: nil, acc: nil, sth: nil)
        #expect(try ha.acceptHello(.object(hb.hello), now: now).ok)
        #expect(try hb.acceptHello(.object(ha.hello), now: now).ok)
        // Idempotent: the same hello again keeps the same KEM message.
        let kemA = ha.kem
        _ = try ha.acceptHello(.object(hb.hello), now: now)
        #expect(ha.kem == kemA)
        #expect(try ha.acceptKem(hb.kem.map { .object($0) }))
        #expect(try hb.acceptKem(ha.kem.map { .object($0) }))
        #expect(ha.ready && hb.ready)
        let sa = try ha.establish(), sb = try hb.establish()
        #expect(sa.th == sb.th)
        #expect(sa.sid == sb.sid)
        #expect(sa.role != sb.role)
        // A conversation with KEM steps both ways, out of order and with a lost frame.
        var frames = [JSONObject]()
        for i in 0..<5 { frames.append(try sa.ratchet.encrypt(#"{"t":"msg","id":"a\#(i)"}"#)) }
        for i in [4, 0, 2, 1, 3] { #expect(sb.ratchet.decrypt(frames[i]).inner?.string("id") == "a\(i)") }
        for round in 0..<4 {
            let x = try sb.ratchet.encrypt(#"{"t":"msg","id":"b\#(round)"}"#)
            #expect(sa.ratchet.decrypt(x).ok)
            let y = try sa.ratchet.encrypt(#"{"t":"msg","id":"a-r\#(round)"}"#)
            #expect(sb.ratchet.decrypt(y).ok)
        }
        // Tampering: a changed ciphertext, header or kct fails; the second failure asks for a reset.
        var bad = try sa.ratchet.encrypt(#"{"t":"msg","id":"z"}"#)
        var h = bad.object("h")!
        h["n"] = .int(h.int64("n")! + 1)
        bad["h"] = .object(h)
        let r1 = sb.ratchet.decrypt(bad)
        #expect(!r1.ok && !r1.reset)
        let r2 = sb.ratchet.decrypt(JSONObject([("kind", "p4"), ("v", 4), ("h", .object(h)), ("c", "AAAA")]))
        #expect(!r2.ok && r2.reset)
        // An inner message needs a type.
        expectP4("malformed") { _ = try sa.ratchet.encrypt(#"{"id":"no-t"}"#) }
        sa.ratchet.wipe()
        expectP4("state") { _ = try sa.ratchet.encrypt(#"{"t":"msg"}"#) }
    }
}
