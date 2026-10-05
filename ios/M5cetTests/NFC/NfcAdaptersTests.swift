// What the app wires for M5NFC's connection tags: Argon2id through M5Crypto
// (the vector's key, byte for byte; an offline tag opened with its code) and the
// invitation's two POSTs through M5Net (the request as the server expects it;
// an invitation made and redeemed end to end against a fake server).

import XCTest
import M5Net
import M5NFC
@testable import M5cet

/// A server for the share API: keeps what /api/share/create stored, answers /api/share/redeem with it.
final class FakeShareServer: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: NfcJSONObject?
    private(set) var requests = [HTTPRequest]()
    var redeemStatus = 200

    func send(_ request: HTTPRequest, progress: HTTPProgress?) async throws -> HTTPResponse {
        lock.withLock { requests.append(request) }
        let body = (try? NfcJSON.parse(request.body ?? Data()))?.objectValue ?? NfcJSONObject()
        if request.url.path == "/api/share/create" {
            lock.withLock { stored = body }
            return HTTPResponse(status: 200, body: Data(#"{"ok":true,"expiresAt":1760000000000,"maxUses":10}"#.utf8))
        }
        if request.url.path == "/api/share/redeem" {
            guard redeemStatus == 200 else { return HTTPResponse(status: redeemStatus, body: Data(#"{"ok":false,"reason":"burned"}"#.utf8)) }
            let s = lock.withLock { stored } ?? NfcJSONObject()
            guard s.optString("id") == body.optString("id"), s.optString("proof") == body.optString("proof") else {
                return HTTPResponse(status: 403, body: Data(#"{"ok":false,"reason":"wrong-code"}"#.utf8))
            }
            let answer: NfcJSONObject = ["ok": true, "serverKey": .string(s.optString("serverKey")), "iv": .string(s.optString("iv")),
                                         "ciphertext": .string(s.optString("ciphertext"))]
            return HTTPResponse(status: 200, body: Data(answer.compact.utf8))
        }
        return HTTPResponse(status: 404)
    }
}

@MainActor
final class NfcAdaptersTests: XCTestCase {
    func offline() throws -> NfcJSONObject { try XCTUnwrap(NfcRepo.json("test/vectors/nfc-tag-v2.json")["offline"]?[0]?.objectValue) }

    func testArgon2idIsM5CryptosByteForByte() throws {
        let v = try offline()
        let kdf = v.optObject("kdf")!
        // TagV2: the password is the canonical code, the salt the tag's "s" as written (base64url text).
        let key = try Argon2TagKdf().argon2id(password: Array(v.optString("canonicalCode").utf8), salt: Array(v.optObject("tag")!.optString("s").utf8),
                                          passes: kdf.optInt("passes"), memoryKiB: kdf.optInt("memoryKiB"), parallelism: 1, length: 32)
        XCTAssertEqual(hexs(key).lowercased(), v.optString("argon2idKeyHex"))
    }

    func testAnOfflineTagOpensWithItsCode() async throws {
        let v = try offline()
        let s = makeNfcService(NfcRig())
        let body = v.optString("body")
        let need = await s.openConnBody(body, secret: "", trustedOrigin: nil)
        XCTAssertEqual(need.format, "v2-off")
        XCTAssertEqual(need.need, "code")
        let wrong = await s.openConnBody(body, secret: "7K3QD-M9X2V-PH4TW-8RZ6P", trustedOrigin: nil)
        XCTAssertEqual(wrong.error, "wrong-code")
        let open = await s.openConnBody(body, secret: v.optString("code"), trustedOrigin: nil)
        XCTAssertEqual(open.room?.room, "brno-secure")
        XCTAssertEqual(open.room?.passphrase, "Kq7xVm-2PnRt4-Wz9cLd-8HsJ3e")
    }

    func testReadingAConnectionTagOpensItAfterTheTap() async throws {
        let v = try offline()
        let rig = NfcRig()
        let tag = FakeTag(.miFare(family: "ultralight", historicalBytes: nil))
        tag.ndef = NdefStatus(state: .readWrite, capacity: 504)
        tag.records = [ConnectionCard.record(v.optString("body"))]
        tag.mifare = { _ in [] }
        rig.present(tag)
        let s = makeNfcService(rig)
        let r = try await s.readConnTag(secret: v.optString("code"), trustedOrigin: "https://chat.example.org", texts: NfcSheetTexts(FixedNfcTexts()))
        XCTAssertEqual(r.tag.identity.tech, NfcCatalog.connectionTag)
        XCTAssertEqual(r.body, v.optString("body"))
        XCTAssertEqual(r.read.room?.room, "brno-secure")
        XCTAssertEqual(rig.last?.invalidations, [nil])   // the sheet was done before Argon2id ran
    }

    func testTheInvitationPostsGoThroughM5Net() async throws {
        let server = FakeShareServer()
        let http = M5ShareInviteHTTP(transport: server, userAgent: "M5cet-iOS/6.14.0")
        let (status, body) = try await http.post("https://chat.example.org/api/share/create", json: Array(#"{"id":"x"}"#.utf8))
        XCTAssertEqual(status, 200)
        XCTAssertTrue(String(decoding: body, as: UTF8.self).contains("\"ok\":true"))
        let req = try XCTUnwrap(server.requests.first)
        XCTAssertEqual(req.method, "POST")
        XCTAssertEqual(req.url.absoluteString, "https://chat.example.org/api/share/create")
        XCTAssertEqual(req.headers["Content-Type"], "application/json")
        XCTAssertEqual(req.headers["User-Agent"], "M5cet-iOS/6.14.0")
        XCTAssertEqual(req.body, Data(#"{"id":"x"}"#.utf8))
        XCTAssertEqual(req.maxBytes, 64 * 1024)
        do { _ = try await http.post("ftp://chat.example.org/x", json: []); XCTFail() } catch let e as NfcError { XCTAssertEqual(e.code, .invalidArgument) }
    }

    func testAnInvitationTagMadeAndRedeemed() async throws {
        let server = FakeShareServer()
        let s = NfcService(configuration: .init(allowedAids: IOSAids.infoPlist), readingAvailable: true, factory: NfcRig().factory, hce: FakeHce(),
                           kdf: Argon2TagKdf(), http: M5ShareInviteHTTP(transport: server))
        let card: NfcJSONObject = ["room": "brno-secure", "passphrase": "Kq7xVm-2PnRt4-Wz9cLd-8HsJ3e", "name": "Alice"]
        let prepared = try await s.prepareConnTag(card, kind: "inv", origin: "https://chat.example.org", appVersion: "6.14.0")
        XCTAssertNil(prepared.code)
        XCTAssertTrue(prepared.body.hasPrefix("m5cet:nfc:v2:"))
        // Only the app's own server redeems it.
        let other = await s.openConnBody(prepared.body, secret: "", trustedOrigin: "https://evil.example.org")
        XCTAssertEqual(other.error, "other-server")
        let unredeemed = await s.openConnBody(prepared.body, secret: "", trustedOrigin: "https://chat.example.org", redeem: false)
        XCTAssertEqual(unredeemed.need, "redeem")
        let r = await s.openConnBody(prepared.body, secret: "", trustedOrigin: "https://chat.example.org")
        XCTAssertEqual(r.error, "")
        XCTAssertEqual(r.room?.room, "brno-secure")
        XCTAssertEqual(r.room?.passphrase, "Kq7xVm-2PnRt4-Wz9cLd-8HsJ3e")
        server.redeemStatus = 410
        let burned = await s.openConnBody(prepared.body, secret: "", trustedOrigin: "https://chat.example.org")
        XCTAssertEqual(burned.error, "burned")
        // An offline tag: the code is shown once, the body carries no room in clear.
        let off = try await s.prepareConnTag(card, kind: "off", origin: "", appVersion: "6.14.0")
        XCTAssertNotNil(off.code)
        XCTAssertFalse(off.body.contains("brno-secure"))
    }
}
