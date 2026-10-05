// The primitives agree with the published vectors and with node:crypto / WebCrypto
// (the values below were computed with node:crypto): PBKDF2-HMAC-SHA256, HKDF-SHA256,
// AES-256-GCM, the P1363 ⇄ DER conversion, kid and fingerprint, base64 forms, and
// the hash to the curve the Secure Enclave PRF uses.

import CryptoKit
import XCTest
@testable import M5cet

final class CryptoPrimitivesTests: XCTestCase {
    func testPbkdf2MatchesRfc7914AndNode() {
        let dk = SecCrypto.pbkdf2(Data("passwd".utf8), salt: Data("salt".utf8), iterations: 1, length: 64)
        XCTAssertEqual(Bytes.hex(dk), "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783")
        let pin = PinWrap.stretch("246810", salt: Data("0123456789abcdef".utf8), iterations: 1000)
        XCTAssertEqual(Bytes.hex(pin), "fbf1e93e4e78eea4ec4fd8524339bd6c24696a44b8a2344d483d77b509571fa7")
    }

    func testHkdfMatchesRfc5869() {
        let ikm = Data(repeating: 0x0b, count: 22)
        let okm = SecCrypto.hkdf(ikm, salt: Bytes.unhex("000102030405060708090a0b0c")!, info: Bytes.unhex("f0f1f2f3f4f5f6f7f8f9")!, length: 42)
        XCTAssertEqual(Bytes.hex(okm), "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865")
        // An empty salt is 32 zero bytes (WebCrypto, Android Crypto.hkdf).
        XCTAssertEqual(Bytes.hex(SecCrypto.hkdf(ikm, salt: Data(), info: Data(), length: 42)),
                       "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8")
    }

    func testGcmBindsKeyIvAndAad() throws {
        let key = SecretBytes(random: 32)
        let iv = Bytes.random(12)
        let ct = try SecCrypto.gcmSeal(key, iv: iv, Data("hello".utf8), aad: Data("SYS|config".utf8))
        XCTAssertEqual(ct.count, 5 + 16)
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
        k.wipe()
        XCTAssertTrue(reader.isWiped)
        XCTAssertThrowsError(try reader.symmetricKey())
        XCTAssertFalse(copy.isWiped, "an independent copy (a file writer) keeps going")
        XCTAssertTrue(copy.same(as: Data(repeating: 7, count: 32)))
    }

    func testP1363AndDerConvert() throws {
        let key = P256.Signing.PrivateKey()
        for _ in 0..<20 {
            let sig = try key.signature(for: Bytes.random(40))
            XCTAssertEqual(try EcP256.derToP1363(sig.derRepresentation), sig.rawRepresentation)
            XCTAssertEqual(try EcP256.p1363ToDer(sig.rawRepresentation), sig.derRepresentation)
        }
        XCTAssertThrowsError(try EcP256.derToP1363(Data([0x31, 0x00])))
        XCTAssertThrowsError(try EcP256.p1363ToDer(Data(count: 63)))
    }

    func testVerifyTakesSpkiAndP1363() throws {
        let key = P256.Signing.PrivateKey()
        let spki = Bytes.b64(key.publicKey.derRepresentation)
        let data = Data("m5policy/1|dev|1|{}".utf8)
        let sig = Bytes.b64(try key.signature(for: data).rawRepresentation)
        XCTAssertTrue(EcP256.verify(spki: spki, data: data, signature: sig))
        XCTAssertFalse(EcP256.verify(spki: spki, data: data + Data([0]), signature: sig))
        XCTAssertFalse(EcP256.verify(spki: Bytes.b64(P256.Signing.PrivateKey().publicKey.derRepresentation), data: data, signature: sig))
        XCTAssertFalse(EcP256.verify(spki: "not base64!", data: data, signature: sig))
    }

    func testKidAndFingerprintAreTheServersForms() throws {
        let spki = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEkbXImCDqgGYKZpLQXxNgmWauLY/95ict9xpD99v0DRKBB2FBS04nu/7QDeGD/yDfS0KdIil5PTqP65jPmBRXGQ=="
        let hash = SecCrypto.sha256(Bytes.unb64(spki)!)
        XCTAssertEqual(EcP256.kid(spki: spki), String(Bytes.b64url(hash).prefix(16)))
        let fp = try XCTUnwrap(EcP256.fingerprint(spki: spki))
        XCTAssertEqual(fp.count, 39) // 8 groups of 4
        XCTAssertEqual(fp.replacingOccurrences(of: " ", with: ""), Bytes.hex(hash.prefix(16)).uppercased())
        XCTAssertNoThrow(try EcP256.publicKey(spki: spki))
        XCTAssertThrowsError(try EcP256.publicKey(spki: Bytes.b64(Data(count: 91))))
    }

    func testBase64Forms() {
        XCTAssertEqual(Bytes.unb64("AQID"), Data([1, 2, 3]))
        XCTAssertEqual(Bytes.unb64("AQ"), Data([1]), "padding is optional, as Java's decoder")
        XCTAssertNil(Bytes.unb64("A-_B"), "base64url characters are not standard base64")
        XCTAssertEqual(Bytes.b64url(Data([0xfb, 0xff])), "-_8")
        XCTAssertEqual(Bytes.unb64url("-_8"), Data([0xfb, 0xff]))
        XCTAssertEqual(Bytes.unhex("00ff10"), Data([0, 255, 16]))
        XCTAssertNil(Bytes.unhex("0g"))
    }

    func testHashToCurveIsDeterministicAndSpread() {
        let a = EcP256.hashToCurve(Data("m5/pin/2|x".utf8))
        XCTAssertEqual(a.rawRepresentation, EcP256.hashToCurve(Data("m5/pin/2|x".utf8)).rawRepresentation)
        var seen = Set<Data>()
        for i in 0..<64 { seen.insert(EcP256.hashToCurve(Data("input \(i)".utf8)).rawRepresentation) }
        XCTAssertEqual(seen.count, 64)
    }
}
