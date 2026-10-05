// NFC connection tag v2 (protocol 4 § 16) against the web's vectors
// (test/vectors/nfc-tag-v2.json): codes, the offline tag's Argon2id key, AAD,
// ciphertext and exact body (both costs), the invitation's link key, code and
// body; the share invitation it rides on, sealed by the web and opened here.

import Foundation
import M5Core
@testable import M5Crypto
import Testing

@Suite(.serialized) struct NfcTagV2VectorTests {
    static let vectors: JSON = try! Repo.json("test/vectors/nfc-tag-v2.json")

    @Test func offlineTagsByteForByte() throws {
        let cases = NfcTagV2VectorTests.vectors.a("offline")
        #expect(cases.count == 2)
        for c in cases {
            let m = Int(c.o("kdf").i("memoryKiB")), passes = Int(c.o("kdf").i("passes"))
            #expect(TagV2.normalize(c.s("code"), TagV2.offlineCodeSymbols) == c.s("canonicalCode"))
            #expect(TagV2.format(c.s("canonicalCode")) == c.s("code"))
            let tag = c.o("tag")
            #expect(Hex.encode(try TagV2.offlineKey(code: c.s("canonicalCode"), m: m, i: passes, s: tag.s("s"))) == c.s("argon2idKeyHex"))
            #expect(text(TagV2.offlineAad(m: m, i: passes, s: tag.s("s"))) == c.s("aad"))
            let plain = JSON.parseObject(c.s("plaintext"))!
            let sealed = try TagV2.sealOffline(TagV2.Room(room: plain.optString("room"), passphrase: plain.optString("passphrase"), name: plain.optString("name")),
                                               code: c.s("code"), m: m, i: passes, salt: Hex.decode(c.s("saltHex")), iv: Hex.decode(c.s("ivHex")))
            #expect(TagV2.serialize(sealed) == c.s("body"))
            let parsed = try TagV2.parse(c.s("body"))
            #expect(TagV2.serialize(parsed) == c.s("body"))
            let room = try TagV2.openOffline(parsed, code: c.s("code").lowercased().replacingOccurrences(of: "-", with: " "))
            #expect(room.room == "brno-secure")
            #expect(room.passphrase == plain.optString("passphrase"))
            #expect(room.name == "Alice")
            // A wrong code, or a changed parameter (it is in the AAD), fails.
            #expect(throws: TagV2.TagError("auth-failed", "wrong code, or the tag was changed")) { try TagV2.openOffline(parsed, code: "7K3QD-M9X2V-PH4TW-8RZ6P") }
            if m == 64 {
                let other = c.s("body").replacingOccurrences(of: "\"i\":1", with: "\"i\":2")
                #expect(throws: TagV2.TagError("auth-failed", "wrong code, or the tag was changed")) { try TagV2.openOffline(try TagV2.parse(other), code: c.s("code")) }
            }
        }
    }

    @Test func invitationKeysAndBody() throws {
        let v = NfcTagV2VectorTests.vectors.o("invite")
        let keys = try TagV2.inviteKeys(id: v.s("id"), k: v.s("k"))
        #expect(Hex.encode(keys.linkKey) == v.s("linkKeyHex"))
        #expect(keys.code == v.s("code"))
        let tag = try TagV2.parse(v.s("body"))
        #expect(tag.invite)
        #expect(tag.o == v.s("origin"))
        #expect(TagV2.serialize(tag) == v.s("body"))
    }

    @Test func codesAndOrigins() throws {
        #expect(TagV2.normalize("o123-4567-89ab-cdef-ghjk-mnpq-rs", 26) == "0123456789ABCDEFGHJKMNPQRS")
        #expect(TagV2.normalize("iIlL", 4) == "1111")
        #expect(TagV2.normalize("UUUU", 4) == nil)
        #expect(TagV2.normalize("ABC", 4) == nil)
        #expect(TagV2.newCode().count == 20)
        #expect(TagV2.normalize(TagV2.newCode(), 20) != nil)
        #expect(TagV2.safeOrigin("https://chat.example.org/") == "https://chat.example.org")
        #expect(TagV2.safeOrigin("https://chat.example.org:8443") == "https://chat.example.org:8443")
        #expect(TagV2.safeOrigin("http://localhost:5173") == "http://localhost:5173")
        #expect(TagV2.safeOrigin("http://chat.example.org") == nil)
        #expect(TagV2.safeOrigin("https://user:pw@chat.example.org") == nil)
        #expect(TagV2.safeOrigin("ftp://x") == nil)
        let inv = try TagV2.newInvite("https://chat.example.org/")
        #expect(inv.k?.count == 26)
        #expect(try TagV2.parse(TagV2.serialize(inv)).k == inv.k)
    }

    @Test func malformedTagsAreRefused() {
        let bad = [
            #"m5cet:nfc:v2:{"v":3,"t":"inv"}"#,
            #"m5cet:nfc:v2:{"v":2,"t":"inv","o":"http://evil.example","id":"QEFCQ0RFRkdISUpLTE1OTw","k":"0123456789ABCDEFGHJKMNPQRS"}"#,
            #"m5cet:nfc:v2:{"v":2,"t":"off","kdf":"argon2id","m":1048576,"i":3,"p":1,"s":"EBESExQVFhcYGRobHB0eHw","n":"oKGio6Slpqeoqaqr","c":"xxxxxxxxxxxxxxxxxxxxxxxxxx"}"#,
            #"m5cet:nfc:v2:{"v":2,"t":"off","kdf":"pbkdf2","m":64,"i":1,"p":1,"s":"EBESExQVFhcYGRobHB0eHw","n":"oKGio6Slpqeoqaqr","c":"xxxxxxxxxxxxxxxxxxxxxxxxxx"}"#,
            #"m5cet:nfc:v2:{"v":2,"t":"x"}"#,
            "m5cet:nfc:v2:not json",
        ]
        for b in bad {
            do { _ = try TagV2.parse(b); Issue.record("accepted \(b)") } catch let e as TagV2.TagError { #expect(e.code == "card-error") } catch { Issue.record("\(error)") }
        }
    }

    /// The share invitation an invitation tag rides on: sealed by the web (lib/share-link.ts), opened here; the proof the server checks.
    @Test func shareInvitationSealedByTheWeb() throws {
        let id = "QEFCQ0RFRkdISUpLTE1OTw", k = "0123456789ABCDEFGHJKMNPQRS"
        let keys = try TagV2.inviteKeys(id: id, k: k)
        #expect(keys.code == "752592939447")
        #expect(ShareInvite.proof(code: keys.code, id: id) == "-CygMqG2SOyIRHk4g4XR2HWNgzHOjNePieK-7EJxSpU")
        let room = try ShareInvite.open(code: keys.code, id: id, linkKey: keys.linkKey, serverKey: try ShareInvite.fromB64url("AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw"),
                                        iv: "fPLXx5czTcWqq7V6",
                                        ciphertext: "rPVoM_mA633NCAnepDQ1fG6wd_fVRD_N2CgySRhI4W79D6wKQSfdrhrZewZ3RFeB3flN4mZYCEaDkhDkClE5hYxCV5Ez9Evc8u2Bc_mmqtgiaM1l2xdYaXKvHPjVWpWOKtAP1amA4YRqYJQOOLE-cLRCW98uFcVKE2HctqwCneA")
        #expect(room.room == "brno-secure")
        #expect(room.passphrase == "Kq7xVm-2PnRt4-Wz9cLd-8HsJ3e")
        // And back: what this app seals opens with the same keys.
        var serverKey = Bytes(repeating: 0, count: 32)
        serverKey[3] = 9
        let sealed = try ShareInvite.seal(code: keys.code, id: id, linkKey: keys.linkKey, serverKey: serverKey,
                                          payload: JSONObject([("v", 1), ("room", "r"), ("passphrase", "p"), ("name", "n"), ("createdAt", 1)]))
        #expect(try ShareInvite.open(code: keys.code, id: id, linkKey: keys.linkKey, serverKey: serverKey, iv: sealed.iv, ciphertext: sealed.ciphertext).room == "r")
        #expect(throws: (any Error).self) { try ShareInvite.open(code: "000000000000", id: id, linkKey: keys.linkKey, serverKey: serverKey, iv: sealed.iv, ciphertext: sealed.ciphertext) }
        // The create body carries everything the server keeps, nothing it could open.
        let tag = try TagV2.parse(NfcTagV2VectorTests.vectors.o("invite").s("body"))
        let body = try ShareInvite.createBody(tag: tag, room: TagV2.Room(room: "r", passphrase: "p"), name: " ", maxUses: 10, ttlSec: 60, now: 5,
                                              serverKey: serverKey, revoke: Bytes(repeating: 7, count: 32))
        #expect(body.string("proof") == ShareInvite.proof(code: keys.code, id: id))
        let back = try ShareInvite.redeemed(tag: tag, answer: JSONObject([("ok", true), ("serverKey", .string(Crypto.b64url(serverKey))), ("iv", body["iv"]!), ("ciphertext", body["ciphertext"]!)]))
        #expect(back.name == "guest")
        #expect(throws: ShareInvite.RedeemError("burned")) { try ShareInvite.redeemed(tag: tag, answer: JSONObject([("ok", false), ("reason", "burned")])) }
    }

    @Test func readingFormatsAndTheWeakOldTag() async throws {
        let c = NfcTagV2VectorTests.vectors.a("offline")[0]
        var r = await ConnTag.open(c.s("body"), secret: "", trustedOrigin: "https://chat.example.org", redeem: nil)
        #expect(r.format == "v2-off")
        #expect(r.need == "code")
        r = await ConnTag.open(c.s("body"), secret: c.s("code"), trustedOrigin: "https://chat.example.org", redeem: nil)
        #expect(r.room?.room == "brno-secure")
        #expect(!r.weak)
        r = await ConnTag.open(c.s("body"), secret: "7K3QD-M9X2V-PH4TW-8RZ6P", trustedOrigin: "", redeem: nil)
        #expect(r.error == "wrong-code")
        // An invitation of another server is not redeemed here.
        let inv = NfcTagV2VectorTests.vectors.o("invite").s("body")
        r = await ConnTag.open(inv, secret: "", trustedOrigin: "https://other.example", redeem: nil)
        #expect(r.error == "other-server")
        #expect(r.origin == "https://chat.example.org")
        r = await ConnTag.open(inv, secret: "", trustedOrigin: "https://chat.example.org", redeem: nil)
        #expect(r.need == "redeem")
        r = await ConnTag.open(inv, secret: "", trustedOrigin: "https://chat.example.org", redeem: { _ in throw ShareInvite.RedeemError("burned") })
        #expect(r.error == "burned")
        r = await ConnTag.open(inv, secret: "", trustedOrigin: "https://chat.example.org", redeem: { _ in TagV2.Room(room: "x", passphrase: "y") })
        #expect(r.room?.room == "x")
        // Format 1 still opens with its PIN — marked weak.
        let v1 = try ConnTagV1.seal(JSONObject([("v", 1), ("room", "old-room"), ("passphrase", "old-pass")]), pin: "4321")
        r = await ConnTag.open(v1, secret: "", trustedOrigin: "", redeem: nil)
        #expect(r.format == "v1")
        #expect(r.weak)
        #expect(r.need == "pin")
        r = await ConnTag.open(v1, secret: "4321", trustedOrigin: "", redeem: nil)
        #expect(r.room?.room == "old-room")
        #expect(await ConnTag.open(v1, secret: "1234", trustedOrigin: "", redeem: nil).error == "wrong-pin")
        #expect(await ConnTag.open("hello", secret: "", trustedOrigin: "", redeem: nil).format == "")
    }

    @Test func jsonQuotingIsJavaScripts() {
        #expect(TagV2.quote("a/b") == "\"a/b\"")
        #expect(TagV2.quote("\"\\\n\u{1}ž😀") == "\"\\\"\\\\\\n\\u0001ž😀\"")
    }
}
