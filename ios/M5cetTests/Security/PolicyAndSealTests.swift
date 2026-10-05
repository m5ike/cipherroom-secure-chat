// The signed policy (Android SignedPolicyTest — the server's own signature, byte
// for byte), its application and limits; the server key pin (ServerPinTest); the
// duress verifier (DuressTest); the process-bound payload seal (IntentSealTest,
// with a node:crypto vector).

import CryptoKit
import XCTest
@testable import M5cet

final class PolicyAndSealTests: XCTestCase {
    /// Signed by the server's code (server/android/crypto.ts signPolicy) — Android's test vector.
    private static let nodeKey = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEkbXImCDqgGYKZpLQXxNgmWauLY/95ict9xpD99v0DRKBB2FBS04nu/7QDeGD/yDfS0KdIil5PTqP65jPmBRXGQ=="
    private static let nodeWire = "{\"at\":1767225600000,\"policy\":\"{\\\"lock\\\":{\\\"pinLength\\\":6,\\\"maxAttempts\\\":8,\\\"wipe\\\":true,\\\"screenshots\\\":false,\\\"autolockSeconds\\\":60},\\\"logs\\\":\\\"errors\\\"}\","
        + "\"sig\":\"MBx8PB0dZ3HvzifYelc46hPRQ2zAg2mDDTCvM+ZHQJ35DKYjsonwez7y8QzZCZ7XhKzqhAiVITVTdWqF0DUHOw==\"}"

    func testTheServersSignatureOpens() throws {
        let wire = try XCTUnwrap(SecJSON.parse(Self.nodeWire))
        let p = try XCTUnwrap(SignedPolicy.open(wire, serverKey: Self.nodeKey, deviceId: "and_test1", lastAt: 0))
        XCTAssertEqual(p.jObject("lock")?.jBool("screenshots"), false)
        XCTAssertEqual(p.jObject("lock")?.jInt("maxAttempts"), 8)
        XCTAssertNotNil(SignedPolicy.open(wire, serverKey: Self.nodeKey, deviceId: "and_test1", lastAt: 1_767_225_600_000), "the same again: fine")
    }

    func testAnythingElseIsRefused() throws {
        let wire = try XCTUnwrap(SecJSON.parse(Self.nodeWire))
        XCTAssertNil(SignedPolicy.open(wire, serverKey: Self.nodeKey, deviceId: "and_other", lastAt: 0), "another device")
        XCTAssertNil(SignedPolicy.open(wire, serverKey: Bytes.b64(P256.Signing.PrivateKey().publicKey.derRepresentation), deviceId: "and_test1", lastAt: 0))
        XCTAssertNil(SignedPolicy.open(wire, serverKey: Self.nodeKey, deviceId: "and_test1", lastAt: 1_767_225_600_001), "a replay")
        var tampered = wire
        tampered["policy"] = wire.jString("policy").replacingOccurrences(of: "\"screenshots\":false", with: "\"screenshots\":true")
        XCTAssertNil(SignedPolicy.open(tampered, serverKey: Self.nodeKey, deviceId: "and_test1", lastAt: 0), "the shield off by a proxy")
        var moved = wire
        moved["at"] = 1_767_225_600_002
        XCTAssertNil(SignedPolicy.open(moved, serverKey: Self.nodeKey, deviceId: "and_test1", lastAt: 0), "the time is signed too")
        var stringAt = wire
        stringAt["at"] = "1767225600000"
        XCTAssertNil(SignedPolicy.open(stringAt, serverKey: Self.nodeKey, deviceId: "and_test1", lastAt: 0))
        XCTAssertNil(SignedPolicy.open(nil, serverKey: Self.nodeKey, deviceId: "and_test1", lastAt: 0))
        XCTAssertNil(SignedPolicy.open([:], serverKey: Self.nodeKey, deviceId: "and_test1", lastAt: 0))
        XCTAssertNil(SignedPolicy.open(wire, serverKey: "", deviceId: "and_test1", lastAt: 0))
    }

    func testThePolicyStoreAppliesOnlySignedNewerPolicies() throws {
        let dir = TempDir()
        let vault = Vault(paths: .under(dir.url), keyring: TestKeys.software(MemorySecureStore()), iterations: 1000)
        let store = PolicyStore(vault: vault)
        XCTAssertEqual(store.lock, LockPolicy(), "Android's defaults before the first signed policy")
        let server = TestServer()
        XCTAssertFalse(store.apply(answer: ["policy": ["lock": ["wipe": false]]], serverKey: server.spki, deviceId: "d"), "unsigned: ignored")
        XCTAssertTrue(store.apply(answer: ["policySigned": try server.signedPolicy(["screenshots": true, "pinLength": 99, "autolockSeconds": -5],
                                                                                    deviceId: "d", at: 10)], serverKey: server.spki, deviceId: "d"))
        XCTAssertTrue(store.lock.screenshots)
        XCTAssertEqual(store.lock.pinLength, 12, "clamped to 4–12")
        XCTAssertEqual(store.lock.autolockSeconds, 0)
        XCTAssertFalse(store.apply(answer: ["policySigned": try server.signedPolicy(["screenshots": false], deviceId: "d", at: 9)],
                                   serverKey: server.spki, deviceId: "d"), "older than the applied one")
        XCTAssertTrue(PolicyStore(vault: vault).lock.screenshots, "kept in the SYS tier")
        store.reset()
        XCTAssertEqual(store.appliedAt, 0)
        let l = LockPolicy(["maxAttempts": 1, "biometric": "sometimes", "autolockSeconds": 100_000])
        XCTAssertEqual(l.maxAttempts, 3)
        XCTAssertEqual(l.biometric, "optional")
        XCTAssertEqual(l.autolockSeconds, 86_400)
    }

    // MARK: the server key pin

    private let key = Bytes.b64(P256.Signing.PrivateKey().publicKey.derRepresentation)
    private let other = Bytes.b64(P256.Signing.PrivateKey().publicKey.derRepresentation)

    func testTheRightKeyPasses() throws {
        let kid = try XCTUnwrap(EcP256.kid(spki: key))
        XCTAssertEqual(try ServerPin.check(publicKey: key, statedKid: kid), kid)
        XCTAssertEqual(try ServerPin.check(publicKey: key, statedKid: kid, pins: ["", nil, kid]), kid)
        XCTAssertEqual(try ServerPin.check(publicKey: key, statedKid: kid, pins: [EcP256.fingerprint(spki: key), kid]), kid)
    }

    func testAForgedServerRepeatingTheKidIsRefused() throws {
        let pinned = try XCTUnwrap(EcP256.kid(spki: key))
        expect("does not match the key id") { try ServerPin.check(publicKey: self.other, statedKid: pinned, pins: [pinned]) }
        expect("is not the pinned key") { try ServerPin.check(publicKey: self.other, statedKid: EcP256.kid(spki: self.other), pins: [pinned]) }
    }

    func testEveryFormOfThePinNamesTheKey() throws {
        let hash = SecCrypto.sha256(Bytes.unb64(key)!)
        let hex = Bytes.hex(hash)
        XCTAssertTrue(ServerPin.matches(spki: key, pin: EcP256.kid(spki: key)))
        XCTAssertTrue(ServerPin.matches(spki: key, pin: EcP256.fingerprint(spki: key)))
        XCTAssertTrue(ServerPin.matches(spki: key, pin: EcP256.fingerprint(spki: key)?.replacingOccurrences(of: " ", with: "")))
        XCTAssertTrue(ServerPin.matches(spki: key, pin: hex))
        let colons = stride(from: 0, to: hex.count, by: 2).map { i -> String in
            let a = hex.index(hex.startIndex, offsetBy: i)
            return String(hex[a..<hex.index(a, offsetBy: 2)]).uppercased()
        }.joined(separator: ":")
        XCTAssertTrue(ServerPin.matches(spki: key, pin: colons))
        XCTAssertTrue(ServerPin.matches(spki: key, pin: Bytes.b64url(hash)))
        XCTAssertTrue(ServerPin.matches(spki: key, pin: Bytes.b64(hash)))
        XCTAssertTrue(ServerPin.matches(spki: key, pin: "  " + EcP256.kid(spki: key)! + " "))
        for o in [EcP256.kid(spki: other), EcP256.fingerprint(spki: other), Bytes.hex(SecCrypto.sha256(Bytes.unb64(other)!)), "", "x", String(hex.prefix(40))] {
            XCTAssertFalse(ServerPin.matches(spki: key, pin: o), o ?? "nil")
        }
        XCTAssertFalse(ServerPin.matches(spki: key, pin: nil))
    }

    func testABrokenKeyIsRefusedAndTheKeyMustNotChange() throws {
        expect("no key") { try ServerPin.check(publicKey: "", statedKid: "abc") }
        expect("no key") { try ServerPin.check(publicKey: nil, statedKid: "abc") }
        expect("not a valid P-256 key") { try ServerPin.check(publicKey: "not base64!", statedKid: "abc") }
        expect("not a valid P-256 key") { try ServerPin.check(publicKey: Bytes.b64(Data(count: 91)), statedKid: "abc") }
        expect("does not match the key id") { try ServerPin.check(publicKey: self.key, statedKid: nil) }
        XCTAssertNoThrow(try ServerPin.same(checked: key, answered: key, answeredKid: EcP256.kid(spki: key)))
        expect("changed its key") { try ServerPin.same(checked: self.key, answered: self.other, answeredKid: EcP256.kid(spki: self.other)) }
        expect("does not match the key id") { try ServerPin.same(checked: self.key, answered: self.key, answeredKid: EcP256.kid(spki: self.other)) }
        expect("changed its key") { try ServerPin.same(checked: "", answered: "", answeredKid: "") }
    }

    private func expect(_ words: String, _ body: () throws -> Void, line: UInt = #line) {
        do {
            try body()
            XCTFail("accepted, expected: \(words)", line: line)
        } catch let r as ServerPin.Refusal {
            XCTAssertTrue(r.message.contains(words), r.message, line: line)
        } catch {
            XCTFail("\(error)", line: line)
        }
    }

    // MARK: the duress verifier

    private static let macKey = Bytes.random(32)
    private static func mac(_ data: Data) -> Data { SecCrypto.hmac(key: macKey, data) }

    func testTheDuressVerifierMatchesItsPinOnly() throws {
        let v = try DuressVerifier.make(pin: "135790", salt: Bytes.random(16), iterations: 2000, mac: Self.mac)
        XCTAssertEqual(v.jInt("iter"), 2000)
        XCTAssertFalse(SecJSON.string(v).contains("135790"))
        XCTAssertTrue(DuressVerifier.matches(v, pin: "135790", mac: Self.mac))
        XCTAssertFalse(DuressVerifier.matches(v, pin: "135791", mac: Self.mac))
        XCTAssertFalse(DuressVerifier.matches(v, pin: "", mac: Self.mac))
        XCTAssertFalse(DuressVerifier.matches(v, pin: nil, mac: Self.mac))
        XCTAssertFalse(DuressVerifier.matches(v, pin: "135790", mac: { [k = Bytes.random(32)] in SecCrypto.hmac(key: k, $0) }), "another device's key")
        var bad = v
        bad["iter"] = 10
        XCTAssertFalse(DuressVerifier.matches(bad, pin: "135790", mac: Self.mac))
        bad["iter"] = 50_000_000
        XCTAssertFalse(DuressVerifier.matches(bad, pin: "135790", mac: Self.mac))
        XCTAssertFalse(DuressVerifier.matches(v, pin: "135790", mac: { _ in throw SecurityError.noKey("duress") }))
        XCTAssertNil(DuressVerifier.refusal("123456", length: 6, isUnlockPin: false))
        XCTAssertEqual(DuressVerifier.refusal("123456", length: 6, isUnlockPin: true), "same")
        XCTAssertEqual(DuressVerifier.refusal("12345", length: 6, isUnlockPin: false), "length")
        XCTAssertEqual(DuressVerifier.refusal("12a456", length: 6, isUnlockPin: false), "length")
        XCTAssertEqual(DuressVerifier.refusal(nil, length: 6, isUnlockPin: false), "length")
        XCTAssertEqual(SecuritySetting.duress, "security.duress")
    }

    // MARK: the payload seal

    private static let k1 = Bytes.unhex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")!
    private static let k2 = Bytes.unhex("ff0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")!

    func testATagFitsItsRoomAndPurposeOnly() {
        let tag = PayloadSeal.tag(key: Self.k1, purpose: PayloadSeal.reply, value: "room-a")
        XCTAssertEqual(tag, "k-FbPh7rPnVO-V9f4jrphw", "Android's / node's tag")
        XCTAssertEqual(tag.count, 22)
        XCTAssertTrue(PayloadSeal.valid(key: Self.k1, purpose: PayloadSeal.reply, value: "room-a", tag: tag))
        XCTAssertFalse(PayloadSeal.valid(key: Self.k1, purpose: PayloadSeal.reply, value: "room-b", tag: tag))
        XCTAssertFalse(PayloadSeal.valid(key: Self.k1, purpose: PayloadSeal.open, value: "room-a", tag: tag))
        XCTAssertFalse(PayloadSeal.valid(key: Self.k2, purpose: PayloadSeal.reply, value: "room-a", tag: tag))
        XCTAssertFalse(PayloadSeal.valid(key: Self.k1, purpose: PayloadSeal.open, value: "room-a", tag: nil))
        XCTAssertFalse(PayloadSeal.valid(key: Self.k1, purpose: PayloadSeal.open, value: "", tag: PayloadSeal.tag(key: Self.k1, purpose: "open", value: "")))
        XCTAssertFalse(PayloadSeal.valid(key: Self.k1, purpose: PayloadSeal.open, value: "room-a", tag: "AAAAAAAAAAAAAAAAAAAAAA"))
    }

    func testThisProcessKeyAndUserInfo() {
        let t = PayloadSeal.tag(PayloadSeal.open, "rodina")
        XCTAssertTrue(PayloadSeal.valid(PayloadSeal.open, "rodina", tag: t))
        XCTAssertFalse(PayloadSeal.valid(PayloadSeal.open, "prace", tag: t))
        XCTAssertFalse(PayloadSeal.valid(key: Self.k1, purpose: PayloadSeal.open, value: "rodina", tag: t), "not a fixed key")
        let info = PayloadSeal.userInfo(room: "rodina", purpose: PayloadSeal.reply)
        XCTAssertEqual(PayloadSeal.room(from: info, purpose: PayloadSeal.reply), "rodina")
        XCTAssertNil(PayloadSeal.room(from: info, purpose: PayloadSeal.open))
        XCTAssertNil(PayloadSeal.room(from: ["room": "rodina"], purpose: PayloadSeal.reply), "a forged action without a tag")
    }
}
