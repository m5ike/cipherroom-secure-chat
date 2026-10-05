// The app's own tags: connection tag v2 against the web's vectors (TagV2VectorTest.java,
// test/vectors/nfc-tag-v2.json) — codes, AAD, ciphertext and exact bodies, the invitation's link key,
// code and body, the share invitation sealed by the web; format 1 against test/fixtures/android-interop.json;
// the M5Cet card (M5CardTest.java + the interop fixture), byte for byte.
//
// Argon2id is M5Crypto's: the offline tags' keys come from the vectors' `argon2idKeyHex` (VectorKdf); a real
// Argon2id run is integration-tested once the app wires `TagKdf` to M5Crypto.

import Testing
import Foundation
@testable import M5NFC

/// The vectors' precomputed Argon2id keys; anything else gets a deterministic stand-in (SHA-256 of the inputs),
/// so a wrong code or a changed parameter gives another key — as Argon2id would.
struct VectorKdf: TagKdf {
    let known: [String: [UInt8]]
    static func id(_ password: [UInt8], _ salt: [UInt8], _ passes: Int, _ m: Int) -> String { "\(H(password))|\(H(salt))|\(passes)|\(m)" }
    func argon2id(password: [UInt8], salt: [UInt8], passes: Int, memoryKiB: Int, parallelism: Int, length: Int) throws -> [UInt8] {
        if let k = known[Self.id(password, salt, passes, memoryKiB)] { return k }
        return Array(NfcHash.sha256(Array("stand-in|\(Self.id(password, salt, passes, memoryKiB))|\(parallelism)".utf8)).prefix(length))
    }
}

enum TagVectors {
    static let v: NfcJSONObject = try! Repo.json("test/vectors/nfc-tag-v2.json").objectValue!
    static let interop: NfcJSONObject = try! Repo.json("test/fixtures/android-interop.json").objectValue!

    static let kdf: VectorKdf = {
        var known = [String: [UInt8]]()
        for c in v.objects("offline") {
            let kd = c.optObject("kdf")!
            known[VectorKdf.id(Array(c.optString("canonicalCode").utf8), Array(c.optObject("tag")!.optString("s").utf8), kd.optInt("passes"), kd.optInt("memoryKiB"))] = b(c.optString("argon2idKeyHex"))
        }
        return VectorKdf(known: known)
    }()
}

/// The server's share endpoints (server/share.ts) in memory: create keeps what it cannot open, redeem checks the proof.
final class FakeShareServer: ShareInviteHTTP, @unchecked Sendable {
    private let lock = NSLock()
    private var invites = [String: NfcJSONObject]()
    var posts = [String]()

    func post(_ url: String, json body: [UInt8]) async throws -> (status: Int, body: [UInt8]) {
        let o = try NfcJSON.parse(String(decoding: body, as: UTF8.self)).objectValue!
        return lock.withLock { handle(url, o) }
    }

    private func handle(_ url: String, _ o: NfcJSONObject) -> (status: Int, body: [UInt8]) {
        posts.append(url)
        func answer(_ status: Int, _ j: NfcJSONObject) -> (Int, [UInt8]) { (status, Array(j.compact.utf8)) }
        if url.hasSuffix("/api/share/create") {
            invites[o.optString("id")] = o.with("uses", 0)
            return answer(200, ["ok": true, "expiresAt": 1_900_000_000_000, "maxUses": .number(Double(o.optInt("maxUses")))])
        }
        guard var inv = invites[o.optString("id")] else { return answer(404, ["ok": false, "reason": "not-found"]) }
        guard inv.optString("proof") == o.optString("proof") else { return answer(403, ["ok": false, "reason": "wrong-code"]) }
        guard inv.optInt("uses") < inv.optInt("maxUses") else { return answer(410, ["ok": false, "reason": "burned"]) }
        inv["uses"] = .number(Double(inv.optInt("uses") + 1))
        invites[o.optString("id")] = inv
        return answer(200, ["ok": true, "serverKey": .string(inv.optString("serverKey")), "iv": .string(inv.optString("iv")), "ciphertext": .string(inv.optString("ciphertext"))])
    }
}

@Suite struct TagV2Tests {
    @Test func offlineTagsByteForByte() throws {
        let cases = TagVectors.v.objects("offline")
        #expect(cases.count == 2)
        for c in cases {
            let m = c.optObject("kdf")!.optInt("memoryKiB"), passes = c.optObject("kdf")!.optInt("passes")
            #expect(TagV2.normalize(c.optString("code"), TagV2.offlineCodeSymbols) == c.optString("canonicalCode"))
            #expect(TagV2.format(c.optString("canonicalCode")) == c.optString("code"))
            let tag = c.optObject("tag")!
            #expect(H(try TagV2.offlineKey(code: c.optString("canonicalCode"), m: m, i: passes, s: tag.optString("s"), kdf: TagVectors.kdf)) == JSText.upperASCII(c.optString("argon2idKeyHex")))
            #expect(String(decoding: TagV2.offlineAad(m, passes, tag.optString("s")), as: UTF8.self) == c.optString("aad"))
            let plain = try NfcJSON.parse(c.optString("plaintext")).objectValue!
            let sealed = try TagV2.sealOffline(TagV2.Room(room: plain.optString("room"), passphrase: plain.optString("passphrase"), name: plain.optString("name")),
                                               code: c.optString("code"), m: m, i: passes, kdf: TagVectors.kdf, salt: b(c.optString("saltHex")), iv: b(c.optString("ivHex")))
            #expect(TagV2.serialize(sealed) == c.optString("body"))
            let parsed = try TagV2.parse(c.optString("body"))
            #expect(TagV2.serialize(parsed) == c.optString("body"))
            let room = try TagV2.openOffline(parsed, code: c.optString("code").lowercased().replacingOccurrences(of: "-", with: " "), kdf: TagVectors.kdf)
            #expect(room.room == "brno-secure")
            #expect(room.passphrase == plain.optString("passphrase"))
            #expect(room.name == "Alice")
            // A wrong code, or a changed parameter (it is in the AAD), fails.
            let e = #expect(throws: TagV2.TagError.self) { try TagV2.openOffline(parsed, code: "7K3QD-M9X2V-PH4TW-8RZ6P", kdf: TagVectors.kdf) }
            #expect(e?.code == "auth-failed")
            if m == 64 {
                let other = c.optString("body").replacingOccurrences(of: "\"i\":1", with: "\"i\":2")
                let e2 = #expect(throws: TagV2.TagError.self) { try TagV2.openOffline(try TagV2.parse(other), code: c.optString("code"), kdf: TagVectors.kdf) }
                #expect(e2?.code == "auth-failed")
            }
        }
    }

    @Test func invitationKeysAndBody() throws {
        let v = TagVectors.v.optObject("invite")!
        let keys = try TagV2.inviteKeys(id: v.optString("id"), k: v.optString("k"))
        #expect(H(keys.linkKey) == JSText.upperASCII(v.optString("linkKeyHex")))
        #expect(keys.code == v.optString("code"))
        let tag = try TagV2.parse(v.optString("body"))
        #expect(tag.invite)
        #expect(tag.o == v.optString("origin"))
        #expect(TagV2.serialize(tag) == v.optString("body"))
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
        #expect(TagV2.safeOrigin("https://chat.example.org:443") == "https://chat.example.org")
        #expect(TagV2.safeOrigin("http://localhost:5173") == "http://localhost:5173")
        #expect(TagV2.safeOrigin("http://[::1]:8080") == "http://[::1]:8080")
        #expect(TagV2.safeOrigin("http://chat.example.org") == nil)
        #expect(TagV2.safeOrigin("https://user:pw@chat.example.org") == nil)
        #expect(TagV2.safeOrigin("ftp://x") == nil)
        let inv = try TagV2.newInvite(origin: "https://chat.example.org/")
        #expect(inv.k?.count == 26)
        #expect(try TagV2.parse(TagV2.serialize(inv)).k == inv.k)
    }

    @Test func malformedTagsAreRefused() {
        let bad = [
            "m5cet:nfc:v2:{\"v\":3,\"t\":\"inv\"}",
            "m5cet:nfc:v2:{\"v\":2,\"t\":\"inv\",\"o\":\"http://evil.example\",\"id\":\"QEFCQ0RFRkdISUpLTE1OTw\",\"k\":\"0123456789ABCDEFGHJKMNPQRS\"}",
            "m5cet:nfc:v2:{\"v\":2,\"t\":\"off\",\"kdf\":\"argon2id\",\"m\":1048576,\"i\":3,\"p\":1,\"s\":\"EBESExQVFhcYGRobHB0eHw\",\"n\":\"oKGio6Slpqeoqaqr\",\"c\":\"xxxxxxxxxxxxxxxxxxxxxxxxxx\"}",
            "m5cet:nfc:v2:{\"v\":2,\"t\":\"off\",\"kdf\":\"pbkdf2\",\"m\":64,\"i\":1,\"p\":1,\"s\":\"EBESExQVFhcYGRobHB0eHw\",\"n\":\"oKGio6Slpqeoqaqr\",\"c\":\"xxxxxxxxxxxxxxxxxxxxxxxxxx\"}",
            "m5cet:nfc:v2:{\"v\":2,\"t\":\"x\"}",
            "m5cet:nfc:v2:not json",
        ]
        for body in bad {
            let e = #expect(throws: TagV2.TagError.self) { try TagV2.parse(body) }
            #expect(e?.code == "card-error", "\(body)")
        }
    }

    /// The share invitation an invitation tag rides on: sealed by the web (lib/share-link.ts), opened here; the proof the server checks.
    @Test func shareInvitationSealedByTheWeb() throws {
        let id = "QEFCQ0RFRkdISUpLTE1OTw", k = "0123456789ABCDEFGHJKMNPQRS"
        let keys = try TagV2.inviteKeys(id: id, k: k)
        #expect(keys.code == "752592939447")
        #expect(try ShareInvite.proof(code: keys.code, id: id) == "-CygMqG2SOyIRHk4g4XR2HWNgzHOjNePieK-7EJxSpU")
        let room = try ShareInvite.open(code: keys.code, id: id, linkKey: keys.linkKey, serverKey: try TagV2.fromB64url("AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw"),
                                        iv: "fPLXx5czTcWqq7V6",
                                        ciphertext: "rPVoM_mA633NCAnepDQ1fG6wd_fVRD_N2CgySRhI4W79D6wKQSfdrhrZewZ3RFeB3flN4mZYCEaDkhDkClE5hYxCV5Ez9Evc8u2Bc_mmqtgiaM1l2xdYaXKvHPjVWpWOKtAP1amA4YRqYJQOOLE-cLRCW98uFcVKE2HctqwCneA")
        #expect(room.room == "brno-secure")
        #expect(room.passphrase == "Kq7xVm-2PnRt4-Wz9cLd-8HsJ3e")
        // And back: what this app seals opens with the same keys.
        var serverKey = [UInt8](repeating: 0, count: 32)
        serverKey[3] = 9
        let sealed = try ShareInvite.seal(code: keys.code, id: id, linkKey: keys.linkKey, serverKey: serverKey, payload: ["v": 1, "room": "r", "passphrase": "p", "name": "n", "createdAt": 1])
        #expect(try ShareInvite.open(code: keys.code, id: id, linkKey: keys.linkKey, serverKey: serverKey, iv: sealed.iv, ciphertext: sealed.ciphertext).room == "r")
        #expect(throws: NfcError.self) { try ShareInvite.open(code: "000000000000", id: id, linkKey: keys.linkKey, serverKey: serverKey, iv: sealed.iv, ciphertext: sealed.ciphertext) }
    }

    @Test func readingFormatsAndTheWeakOldTag() async throws {
        let c = TagVectors.v.objects("offline")[0]
        var r = await ConnTag.open(c.optString("body"), secret: "", trustedOrigin: "https://chat.example.org", kdf: TagVectors.kdf, http: nil)
        #expect(r.format == "v2-off" && r.need == "code")
        r = await ConnTag.open(c.optString("body"), secret: c.optString("code"), trustedOrigin: "https://chat.example.org", kdf: TagVectors.kdf, http: nil)
        #expect(r.room?.room == "brno-secure")
        #expect(!r.weak)
        r = await ConnTag.open(c.optString("body"), secret: "7K3QD-M9X2V-PH4TW-8RZ6P", trustedOrigin: "", kdf: TagVectors.kdf, http: nil)
        #expect(r.error == "wrong-code")
        // An invitation of another server is not redeemed here.
        let inviteBody = TagVectors.v.optObject("invite")!.optString("body")
        r = await ConnTag.open(inviteBody, secret: "", trustedOrigin: "https://other.example", kdf: TagVectors.kdf, http: nil)
        #expect(r.error == "other-server")
        #expect(r.origin == "https://chat.example.org")
        r = await ConnTag.open(inviteBody, secret: "", trustedOrigin: "https://chat.example.org", redeem: false, kdf: TagVectors.kdf, http: nil)
        #expect(r.need == "redeem")
        // Format 1 still opens with its PIN — marked weak.
        let v1 = try ConnectionCard.sealV1(["v": 1, "room": "old-room", "passphrase": "old-pass"], pin: "4321")
        r = await ConnTag.open(v1, secret: "", trustedOrigin: "", kdf: TagVectors.kdf, http: nil)
        #expect(r.format == "v1" && r.weak && r.need == "pin")
        r = await ConnTag.open(v1, secret: "4321", trustedOrigin: "", kdf: TagVectors.kdf, http: nil)
        #expect(r.room?.room == "old-room" && r.weak)
        #expect(await ConnTag.open(v1, secret: "1234", trustedOrigin: "", kdf: TagVectors.kdf, http: nil).error == "wrong-pin")
        #expect(await ConnTag.open("hello", secret: "", trustedOrigin: "", kdf: TagVectors.kdf, http: nil).format == "")
    }

    /// An invitation end to end: prepared (created on the server), read back and redeemed; a second server's tag is not.
    @Test func anInvitationIsCreatedAndRedeemedOnTheServer() async throws {
        let server = FakeShareServer()
        let p = try await ConnTag.prepare(["room": "team", "passphrase": "pass", "name": "Alice"], kind: "inv", origin: "https://chat.example.org/", appVersion: "6.14.0", kdf: TagVectors.kdf, http: server)
        #expect(p.code == nil && p.expiresAt == 1_900_000_000_000)
        #expect(p.body.hasPrefix(TagV2.prefix + "{\"v\":2,\"t\":\"inv\",\"o\":\"https://chat.example.org\""))
        let r = await ConnTag.open(p.body, secret: "", trustedOrigin: "https://chat.example.org", kdf: TagVectors.kdf, http: server)
        #expect(r.format == "v2-inv")
        #expect(r.room?.room == "team" && r.room?.passphrase == "pass")
        #expect(r.room?.name == "guest") // a reader keeps its own name: the writer's nickname is not handed out
        #expect(server.posts == ["https://chat.example.org/api/share/create", "https://chat.example.org/api/share/redeem"])
        // An unknown invite: the server's reason.
        let unknown = TagV2.serialize(try TagV2.newInvite(origin: "https://chat.example.org"))
        #expect(await ConnTag.open(unknown, secret: "", trustedOrigin: "https://chat.example.org", kdf: TagVectors.kdf, http: server).error == "not-found")
    }

    @Test func anOfflineTagIsPreparedWithTheRoomKdfsCostAndOpensWithItsCode() async throws {
        let p = try await ConnTag.prepare(["room": "team", "passphrase": "pass"], kind: "off", origin: "", appVersion: "6.14.0", kdf: TagVectors.kdf, http: nil)
        let code = try #require(p.code)
        #expect(code.count == 23) // 20 symbols in groups of five
        let tag = try TagV2.parse(p.body)
        #expect(tag.m == TagV2.writeMemoryKiB && tag.i == TagV2.writePasses)
        let r = await ConnTag.open(p.body, secret: code, trustedOrigin: "", kdf: TagVectors.kdf, http: nil)
        #expect(r.room?.room == "team" && r.room?.app == "6.14.0")
    }

    @Test func jsonQuotingIsJavaScripts() {
        #expect(TagV2.quote("a/b") == "\"a/b\"")
        #expect(TagV2.quote("\"\\\n\u{01}ž😀") == "\"\\\"\\\\\\n\\u0001ž😀\"")
    }

    /// Format 1 written by the web (test/fixtures/android-interop.json "nfc") opens here with its PIN.
    @Test func formatOneFromTheWebOpens() throws {
        let n = TagVectors.interop.optObject("nfc")!
        let card = try #require(ConnectionCard.openV1(n.optString("blob"), pin: n.optString("pin")))
        let want = n.optObject("card")!
        for k in ["room", "passphrase", "name", "app"] { #expect(card.optString(k) == want.optString(k), "\(k)") }
        #expect(card.optInt("v") == 1)
        #expect(ConnectionCard.openV1(n.optString("blob"), pin: "000000") == nil)
        #expect(ConnectionCard.validPin("1234") && !ConnectionCard.validPin("12a4") && !ConnectionCard.validPin("123"))
    }

    @Test func theConnectionBodyIsFoundAmongTheRecords() {
        let body = TagVectors.v.optObject("invite")!.optString("body")
        #expect(ConnectionCard.body(of: [textRecord("en", "x"), ConnectionCard.record(body)]) == body)
        #expect(ConnectionCard.body(of: [try! Ndef.textRecord(body)]) == body) // the older text form
        #expect(ConnectionCard.body(of: [uriRecord(4, "a.cz")]) == nil)
    }
}

@Suite struct M5CardTests {
    // A web-sealed container: [wifi (external, PIN 482915), message (internal, root 00..1f), one-time-message (external)].
    static let pin = "482915"
    static let root = b("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
    static let container = "TTVDRAEAAwgAAOs4ghAbgqD+MWKDi4euZa5QpEG9DLPxV8AH3c2zufccWgBHXKCj8vTwKQxjXKHrGhxZ1L/tPKcUreplYLNIl7DSbJQslwRqD/FuiC+EdNX4anQZh5Soz8vm3F6yTPWxsCX0iH2kwAZnsTYEAQCYC90QLUCQxFiYB3pHED+aPfE/pQxvp92T2KLfpmfztiUAL/jM7aW27KcxS3/osrN0C6m37lqb6BdBrk+PU4do7ulPkf/y6mYfAmznKU75xhavAwABIlWoEO5xQED6MiCMX0fVexwc/B0Mp437NiV5UHEtomrMACLEi3ai5yi/H0HhnHpTPFHsAJqg0e3NnCKCuz4MfoVF/yy2"
    static let afterRemoveOneTime = "TTVDRAEAAggAAOs4ghAbgqD+MWKDi4euZa5QpEG9DLPxV8AH3c2zufccWgBHXKCj8vTwKQxjXKHrGhxZ1L/tPKcUreplYLNIl7DSbJQslwRqD/FuiC+EdNX4anQZh5Soz8vm3F6yTPWxsCX0iH2kwAZnsTYEAQCYC90QLUCQxFiYB3pHED+aPfE/pQxvp92T2KLfpmfztiUAL/jM7aW27KcxS3/osrN0C6m37lqb6BdBrk+PU4do7ulPkf/y6mYfAmznKU75xhav"
    static let oneTimeId = 2250152

    static func bytes(_ b64: String) -> [UInt8] { [UInt8](Data(base64Encoded: b64)!) }
    static func byType(_ recs: [M5Card.Sealed], _ type: String) -> M5Card.Sealed { recs.first { $0.type == type }! }

    @Test func opensWhatTheWebSealed() throws {
        let c = Self.bytes(Self.container)
        #expect(M5Card.isM5Card(c))
        let recs = try M5Card.decodeContainer(c)
        #expect(recs.count == 3)
        let keys = M5Card.keys(pin: Self.pin, root: Self.root)
        let wifi = Self.byType(recs, "wifi")
        #expect(wifi.mode == M5Card.modeExternal)
        let w = try M5Card.open(wifi, keys).data
        #expect(w.optString("ssid") == "M5cet")
        #expect(w.optString("password") == "tajné heslo")
        let msg = Self.byType(recs, "message")
        #expect(msg.mode == M5Card.modeInternal)
        #expect(try M5Card.open(msg, keys).data.optString("text") == "Ahoj z webu ✓ 🔒")
        let one = Self.byType(recs, "one-time-message")
        #expect(one.oneTime)
        #expect(try M5Card.open(one, keys).data.optString("text") == "zmizím")
    }

    @Test func wrongPinIsRejected() throws {
        let wifi = Self.byType(try M5Card.decodeContainer(Self.bytes(Self.container)), "wifi")
        #expect(throws: NfcError.self) { try M5Card.open(wifi, M5Card.keys(pin: "000000", root: Self.root)) }
        #expect(throws: NfcError.self) { try M5Card.open(Self.byType(try M5Card.decodeContainer(Self.bytes(Self.container)), "message"), M5Card.keys(pin: Self.pin, root: nil)) }
    }

    @Test func removeOneTimeMatchesTheWebByteForByte() throws {
        let after = try M5Card.removeRecord(Self.bytes(Self.container), id: Self.oneTimeId)
        #expect(Data(after).base64EncodedString() == Self.afterRemoveOneTime)
        #expect(try M5Card.decodeContainer(after).count == 2)
    }

    @Test func swiftRoundTripsExternalAndInternal() throws {
        let keys = M5Card.keys(pin: "135790", root: Self.root)
        let ext = M5Card.Record(type: "url-login", mode: M5Card.modeExternal, data: ["url": "https://m5cet.cz", "user": "sokol", "password": "p"])
        let intr = M5Card.Record(type: "server-room", mode: M5Card.modeInternal, oneTime: true, data: ["server": "s", "room": "team", "passphrase": "pp"])
        let c = try M5Card.buildCard([ext, intr], keys)
        #expect(M5Card.isM5Card(c))
        let back = try M5Card.decodeContainer(c)
        #expect(back.count == 2)
        #expect(try M5Card.open(Self.byType(back, "url-login"), keys).data.optString("url") == "https://m5cet.cz")
        let room = try M5Card.open(Self.byType(back, "server-room"), keys)
        #expect(room.data.optString("room") == "team")
        #expect(room.oneTime)
    }

    @Test func decodeSkipsUnknownRecordTypes() throws {
        // "M5CD" ver1 flags0 count1 | type=99 mode0 rflags0 id(3)=0 salt(len0) iv(len0) ct(u16=0)
        let bad: [UInt8] = [0x4d, 0x35, 0x43, 0x44, 1, 0, 1, 99, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        #expect(M5Card.isM5Card(bad))
        #expect(try M5Card.decodeContainer(bad).isEmpty) // unknown type skipped, not fatal
        #expect(throws: NfcError.self) { try M5Card.decodeContainer([0x4d, 0x35, 0x43, 0x44, 1, 0, 1, 4]) } // truncated
    }

    @Test func validatesPins() {
        #expect(M5Card.isValidPin("123456") && M5Card.isValidPin("123456789012345678"))
        #expect(!M5Card.isValidPin("12345") && !M5Card.isValidPin("1234567890123456789") && !M5Card.isValidPin("12ab56"))
    }

    @Test func notAnM5CardIsRejected() {
        #expect(!M5Card.isM5Card([1, 2, 3]))
        #expect(!M5Card.isM5Card(Array("NOPE___".utf8)))
    }

    /// The shared fixture (test/fixtures/android-interop.json "m5card"): every record opens to what the web sealed.
    @Test func theInteropFixtureOpens() throws {
        let f = TagVectors.interop.optObject("m5card")!
        let keys = M5Card.keys(pin: f.optString("pin"), root: b(f.optString("rootHex")))
        let recs = try M5Card.decodeContainer(Self.bytes(f.optString("container")))
        let want = f.objects("records")
        #expect(recs.count == want.count)
        for (s, w) in zip(recs, want) {
            #expect(s.type == w.optString("type") && s.mode == w.optString("mode") && s.oneTime == w.optBool("oneTime"))
            let data = try M5Card.open(s, keys).data, wd = w.optObject("data")!
            #expect(data.count == wd.count)
            for e in wd { #expect(data[e.key] == e.value, "\(s.type).\(e.key)") }
        }
    }

    @Test func recordSummariesHoldNoSecrets() {
        #expect(M5Records.summary("wifi", ["ssid": "Home", "password": "secret"]) == "Home")
        #expect(M5Records.summary("wifi", [:]) == "Wi-Fi")
        #expect(M5Records.summary("message", ["text": .string(String(repeating: "a", count: 50))]).count == 40)
        #expect(M5Records.summary("passkey-backup", ["account": ["username": "sokol"]]) == "sokol")
        #expect(M5Records.meta("one-time-message")?.oneTimeDefault == true)
        #expect(M5Records.buildable.count == 9)
    }
}
