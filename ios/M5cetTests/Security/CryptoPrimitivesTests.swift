// What the platform layer adds to M5Crypto's primitives (those have their vectors in
// M5CryptoTests): AES-GCM with a zeroable key gives M5Crypto's bytes, SecretBytes is
// zeroed for every reader, and the hash to the curve the Secure Enclave PRF uses.

import CryptoKit
import M5Core
import M5Crypto
import XCTest
@testable import M5cet

final class CryptoPrimitivesTests: XCTestCase {
    func testGcmBindsKeyIvAndAadAndIsM5Cryptos() throws {
        let key = SecretBytes(random: 32)
        let iv = Bytes.random(12)
        let ct = try SecCrypto.gcmSeal(key, iv: iv, Data("hello".utf8), aad: Data("SYS|config".utf8))
        XCTAssertEqual(ct.count, 5 + 16)
        // The same bytes as M5Crypto's Crypto.gcmSeal (Android's iv / ct ‖ tag).
        XCTAssertEqual(try Crypto.gcmOpen(key.bytes(), Array(iv), Array(ct), Crypto.utf8("SYS|config")), Crypto.utf8("hello"))
        XCTAssertEqual(try SecCrypto.gcmOpen(key, iv: iv, ct, aad: Data("SYS|config".utf8)), Data("hello".utf8))
        XCTAssertThrowsError(try SecCrypto.gcmOpen(key, iv: iv, ct, aad: Data("SYS|other".utf8)))
        XCTAssertThrowsError(try SecCrypto.gcmOpen(SecretBytes(random: 32), iv: iv, ct, aad: Data("SYS|config".utf8)))
        var flipped = ct
        flipped[0] ^= 1
        XCTAssertThrowsError(try SecCrypto.gcmOpen(key, iv: iv, flipped, aad: Data("SYS|config".utf8)))
        // A zeroed key opens nothing any more.
        key.wipe()
        XCTAssertThrowsError(try SecCrypto.gcmOpen(key, iv: iv, ct, aad: Data("SYS|config".utf8))) { XCTAssertEqual($0 as? SecurityError, .locked) }
    }

    func testSecretBytesAreZeroedForEveryReader() throws {
        let k = SecretBytes(Data(repeating: 7, count: 32))
        let reader = k // readers share the instance, as Android's array
        let copy = try k.copy()
        XCTAssertEqual(try k.bytes(), Bytes(repeating: 7, count: 32))
        k.wipe()
        XCTAssertTrue(reader.isWiped)
        XCTAssertThrowsError(try reader.symmetricKey())
        XCTAssertThrowsError(try reader.bytes())
        XCTAssertFalse(copy.isWiped, "an independent copy (a file writer) keeps going")
        XCTAssertTrue(copy.same(as: Data(repeating: 7, count: 32)))
        var d = Data([1, 2, 3])
        SecData.wipe(&d)
        XCTAssertTrue(d.isEmpty)
        XCTAssertEqual(SecData.fresh(Data([9, 8, 7]).dropFirst()).startIndex, 0)
    }

    func testHashToCurveIsDeterministicAndSpread() {
        let a = EnclavePRF.hashToCurve(Data("m5/pin/2|x".utf8))
        XCTAssertEqual(a.rawRepresentation, EnclavePRF.hashToCurve(Data("m5/pin/2|x".utf8)).rawRepresentation)
        var seen = Set<Data>()
        for i in 0..<64 { seen.insert(EnclavePRF.hashToCurve(Data("input \(i)".utf8)).rawRepresentation) }
        XCTAssertEqual(seen.count, 64)
    }

    func testThePrfIsAnHmacOfTheAgreementWithTheHashedPoint() throws {
        let store = MemorySecureStore()
        let k = TestKeys.software(store)
        try k.ensureAgreementKey("pin", access: .foreground)
        let input = Data("m5/pin/2|stretched".utf8)
        // prf(alias, x) = HMAC-SHA256(ECDH(d, H(x)), x) — computed here from the software key's scalar.
        let raw = try XCTUnwrap(try store.read("key.pin")).dropFirst()
        let d = try P256.KeyAgreement.PrivateKey(rawRepresentation: raw)
        let shared = try d.sharedSecretFromKeyAgreement(with: EnclavePRF.hashToCurve(input)).withUnsafeBytes { Array($0) }
        XCTAssertEqual(try k.prf("pin", input), Data(Crypto.hmac256(shared, Array(input))))
    }
}
