// The app's side of the signed policy (the verification is M5Crypto's SignedPolicy,
// tested there with the server's own signature): PolicyStore applies the server's
// signed policy, keeps it in the SYS tier, refuses replays, and LockPolicy keeps
// Android's limits. The duress verifier (Android DuressTest). The notification
// userInfo carrying M5Crypto's IntentSeal tag.

import CryptoKit
import M5Core
import M5Crypto
import XCTest
@testable import M5cet

final class PolicyAndSealTests: XCTestCase {
    /// Signed by the server's code (server/android/crypto.ts signPolicy) — Android's SignedPolicyTest vector.
    private static let nodeKey = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEkbXImCDqgGYKZpLQXxNgmWauLY/95ict9xpD99v0DRKBB2FBS04nu/7QDeGD/yDfS0KdIil5PTqP65jPmBRXGQ=="
    private static let nodeWire = "{\"at\":1767225600000,\"policy\":\"{\\\"lock\\\":{\\\"pinLength\\\":6,\\\"maxAttempts\\\":8,\\\"wipe\\\":true,\\\"screenshots\\\":false,\\\"autolockSeconds\\\":60},\\\"logs\\\":\\\"errors\\\"}\","
        + "\"sig\":\"MBx8PB0dZ3HvzifYelc46hPRQ2zAg2mDDTCvM+ZHQJ35DKYjsonwez7y8QzZCZ7XhKzqhAiVITVTdWqF0DUHOw==\"}"

    private func store() -> (TempDir, PolicyStore, Vault) {
        let dir = TempDir()
        let vault = Vault(paths: .under(dir.url), keyring: TestKeys.software(MemorySecureStore()), iterations: 1000)
        return (dir, PolicyStore(vault: vault), vault)
    }

    func testTheServersSignedPolicyApplies() throws {
        let (dir, store, _) = store()
        defer { _ = dir }
        XCTAssertTrue(store.apply(answerText: "{\"policySigned\":\(Self.nodeWire)}", serverKey: Self.nodeKey, deviceId: "and_test1"))
        XCTAssertEqual(store.lock.maxAttempts, 8)
        XCTAssertFalse(store.lock.screenshots)
        XCTAssertEqual(store.appliedAt, 1_767_225_600_000)
        XCTAssertFalse(store.apply(answerText: "{\"policySigned\":\(Self.nodeWire)}", serverKey: Self.nodeKey, deviceId: "and_other"), "another device")
        XCTAssertFalse(store.apply(answerText: "{\"policySigned\":\(Self.nodeWire.replacingOccurrences(of: "\\\"screenshots\\\":false", with: "\\\"screenshots\\\":true"))}",
                                   serverKey: Self.nodeKey, deviceId: "and_test1"), "the shield off by a proxy")
    }

    func testThePolicyStoreAppliesOnlySignedNewerPolicies() throws {
        let (dir, store, vault) = store()
        defer { _ = dir }
        XCTAssertEqual(store.lock, LockPolicy(), "Android's defaults before the first signed policy")
        let server = TestServer()
        XCTAssertFalse(store.apply(answer: JSONObject([("policy", ["lock": ["wipe": false]])]), serverKey: server.spki, deviceId: "d"), "unsigned: ignored")
        XCTAssertTrue(store.apply(answer: JSONObject([("policySigned", .object(try server.signedPolicy(["screenshots": true, "pinLength": 99, "autolockSeconds": -5],
                                                                                                         deviceId: "d", at: 10)))]),
                                  serverKey: server.spki, deviceId: "d"))
        XCTAssertTrue(store.lock.screenshots)
        XCTAssertEqual(store.lock.pinLength, 12, "clamped to 4–12")
        XCTAssertEqual(store.lock.autolockSeconds, 0)
        XCTAssertFalse(store.apply(answer: JSONObject([("policySigned", .object(try server.signedPolicy(["screenshots": false], deviceId: "d", at: 9)))]),
                                   serverKey: server.spki, deviceId: "d"), "older than the applied one")
        XCTAssertTrue(PolicyStore(vault: vault).lock.screenshots, "kept in the SYS tier")
        // A policy M5Net's DeviceState verified already.
        XCTAssertFalse(store.adopt(policy: JSONObject([("lock", ["wipe": false])]), at: 5), "older")
        XCTAssertTrue(store.adopt(policy: JSONObject([("lock", ["wipe": false])]), at: 11))
        XCTAssertFalse(store.lock.wipe)
        store.reset()
        XCTAssertEqual(store.appliedAt, 0)
        let l = LockPolicy(JSONObject([("maxAttempts", 1), ("biometric", "sometimes"), ("autolockSeconds", 100_000)]))
        XCTAssertEqual(l.maxAttempts, 3)
        XCTAssertEqual(l.biometric, "optional")
        XCTAssertEqual(l.autolockSeconds, 86_400)
    }

    // MARK: the duress verifier

    private static let macKey = Crypto.random(32)
    private static func mac(_ data: Data) -> Data { Data(Crypto.hmac256(macKey, Array(data))) }

    func testTheDuressVerifierMatchesItsPinOnly() throws {
        let v = try DuressVerifier.make(pin: "135790", salt: Bytes.random(16), iterations: 2000, mac: Self.mac)
        XCTAssertEqual(v.optInt("iter"), 2000)
        XCTAssertFalse(v.stringify().contains("135790"))
        XCTAssertTrue(DuressVerifier.matches(v, pin: "135790", mac: Self.mac))
        XCTAssertFalse(DuressVerifier.matches(v, pin: "135791", mac: Self.mac))
        XCTAssertFalse(DuressVerifier.matches(v, pin: "", mac: Self.mac))
        XCTAssertFalse(DuressVerifier.matches(v, pin: nil, mac: Self.mac))
        let other = Crypto.random(32)
        XCTAssertFalse(DuressVerifier.matches(v, pin: "135790", mac: { Data(Crypto.hmac256(other, Array($0))) }), "another device's key")
        XCTAssertFalse(DuressVerifier.matches(v.with("iter", 10), pin: "135790", mac: Self.mac))
        XCTAssertFalse(DuressVerifier.matches(v.with("iter", 50_000_000), pin: "135790", mac: Self.mac))
        XCTAssertFalse(DuressVerifier.matches(v, pin: "135790", mac: { _ in throw SecurityError.noKey("duress") }))
        XCTAssertNil(DuressVerifier.refusal("123456", length: 6, isUnlockPin: false))
        XCTAssertEqual(DuressVerifier.refusal("123456", length: 6, isUnlockPin: true), "same")
        XCTAssertEqual(DuressVerifier.refusal("12345", length: 6, isUnlockPin: false), "length")
        XCTAssertEqual(DuressVerifier.refusal("12a456", length: 6, isUnlockPin: false), "length")
        XCTAssertEqual(DuressVerifier.refusal(nil, length: 6, isUnlockPin: false), "length")
        XCTAssertEqual(SecuritySetting.duress, "security.duress")
    }

    // MARK: the notification userInfo with M5Crypto's IntentSeal

    func testANotificationsRoomCountsOnlyWithThisProcesssTag() {
        let info = IntentSealUserInfo.userInfo(room: "rodina", purpose: IntentSeal.reply)
        XCTAssertEqual(info[IntentSealUserInfo.key], IntentSeal.tag(IntentSeal.reply, "rodina"))
        XCTAssertEqual(IntentSealUserInfo.room(from: info, purpose: IntentSeal.reply), "rodina")
        XCTAssertNil(IntentSealUserInfo.room(from: info, purpose: IntentSeal.open), "another purpose")
        XCTAssertNil(IntentSealUserInfo.room(from: ["room": "rodina"], purpose: IntentSeal.reply), "a forged action without a tag")
        XCTAssertNil(IntentSealUserInfo.room(from: ["room": "prace", IntentSealUserInfo.key: info[IntentSealUserInfo.key]!], purpose: IntentSeal.reply),
                     "the room replaced")
        XCTAssertEqual(IntentSealUserInfo.key, "cz.m5cet.seal", "Android's extra")
    }
}
