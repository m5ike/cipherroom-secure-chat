// The PIN wrap's format (Android PinWrapTest): v 1 (Android 6.11's pepper) still
// opens and moves to v 2 with the same data key; the version is bound to the
// ciphertext; a damaged wrap is an error, not a wrong PIN. And on iOS: v 2's KEK is
// the Secure Enclave PRF — a wrap does not open with another device's key.

import CryptoKit
import XCTest
@testable import M5cet

final class PinWrapTests: XCTestCase {
    private static let it = 1000
    /// The two hardware keys as fixed HMAC keys: Android's m5.pep (v 1) and m5.pin (v 2).
    private static let pepper = Bytes.random(32), pinKey = Bytes.random(32)
    private static func kek(_ stretched: Data, _ version: Int) -> Data {
        version >= 2 ? SecCrypto.hmac(key: pinKey, PinWrap.prfInput(stretched)) : SecCrypto.hmac(key: pepper, stretched)
    }

    private func stretch(_ pin: String, _ wrap: SecRecord) throws -> Data {
        PinWrap.stretch(pin, salt: try PinWrap.salt(wrap), iterations: try PinWrap.iterations(wrap))
    }

    /// A wrap exactly as Android 6.11 wrote it (no "v": HMAC(m5.pep, PBKDF2), AAD "m5/user.pin").
    private func v611(_ dek: Data, _ pin: String) throws -> SecRecord {
        let salt = Bytes.random(16), iv = Bytes.random(12)
        let kek = SecCrypto.hmac(key: Self.pepper, PinWrap.stretch(pin, salt: salt, iterations: Self.it))
        let ct = try SecCrypto.gcmSeal(SymmetricKey(data: kek), iv: iv, dek, aad: Data("m5/user.pin".utf8))
        return ["salt": Bytes.b64(salt), "iter": Self.it, "iv": Bytes.b64(iv), "ct": Bytes.b64(ct)]
    }

    func testA611WrapOpensAndMovesWithTheSameDataKey() throws {
        let dek = Bytes.random(32)
        let old = try v611(dek, "246810")
        XCTAssertEqual(PinWrap.version(old), 1)
        XCTAssertNil(try PinWrap.open(old, stretched: stretch("246811", old), kek: Self.kek), "a wrong PIN")
        let stretched = try stretch("246810", old)
        let opened = try XCTUnwrap(try PinWrap.open(old, stretched: stretched, kek: Self.kek))
        XCTAssertTrue(opened.same(as: dek))
        let moved = try PinWrap.moved(old, dek: opened, stretched: stretched, hw: "secure-enclave", kek: Self.kek)
        XCTAssertEqual(PinWrap.version(moved), 2)
        XCTAssertEqual(moved.jString("hw"), "secure-enclave")
        XCTAssertEqual(moved.jString("salt"), old.jString("salt"))
        XCTAssertEqual(moved.jInt("iter"), old.jInt("iter"))
        XCTAssertTrue(try XCTUnwrap(try PinWrap.open(moved, stretched: stretch("246810", moved), kek: Self.kek)).same(as: dek))
        XCTAssertNil(try PinWrap.open(moved, stretched: stretch("000000", moved), kek: Self.kek))
        // v 2 needs the PIN key — the old pepper does not open it.
        let pepperOnly: PinWrap.Kek = { s, _ in SecCrypto.hmac(key: Self.pepper, s) }
        XCTAssertNil(try PinWrap.open(moved, stretched: stretch("246810", moved), kek: pepperOnly))
    }

    func testTheVersionIsBoundToTheCiphertext() throws {
        let dek = SecretBytes(random: 32)
        let salt = Data("0123456789abcdef".utf8)
        let v2 = try PinWrap.seal(dek: dek, stretched: PinWrap.stretch("1357", salt: salt, iterations: Self.it), salt: salt,
                                  iterations: Self.it, version: 2, hw: "secure-enclave", kek: Self.kek)
        var relabelled = v2
        relabelled.removeValue(forKey: "v")
        XCTAssertNil(try PinWrap.open(relabelled, stretched: stretch("1357", relabelled), kek: Self.kek))
        let sameKek: PinWrap.Kek = { s, _ in Self.kek(s, 2) }
        XCTAssertNil(try PinWrap.open(relabelled, stretched: stretch("1357", relabelled), kek: sameKek))
        XCTAssertNotEqual(PinWrap.aad(1), PinWrap.aad(2))
        XCTAssertEqual(String(decoding: PinWrap.aad(1), as: UTF8.self), "m5/user.pin")
        XCTAssertEqual(String(decoding: PinWrap.aad(2), as: UTF8.self), "m5/user.pin/2")
    }

    func testADamagedWrapIsAnErrorNotAWrongPin() throws {
        var bad = try v611(Bytes.random(32), "1111")
        bad["iv"] = "%%%"
        XCTAssertThrowsError(try PinWrap.open(bad, stretched: stretch("1111", bad), kek: Self.kek))
        XCTAssertThrowsError(try PinWrap.salt([:]))
        XCTAssertThrowsError(try PinWrap.iterations([:]))
    }

    func testTheEnclaveKekNeedsThisDevice() throws {
        // Two "devices": two enclave keyrings. A wrap made on one opens only there.
        let a = try TestKeys.enclave(MemorySecureStore()), b = try TestKeys.enclave(MemorySecureStore())
        try a.ensureAgreementKey("pin", access: .foreground)
        try b.ensureAgreementKey("pin", access: .foreground)
        let kekA: PinWrap.Kek = { s, _ in try a.prf("pin", PinWrap.prfInput(s)) }
        let kekB: PinWrap.Kek = { s, _ in try b.prf("pin", PinWrap.prfInput(s)) }
        let dek = SecretBytes(random: 32)
        let salt = Bytes.random(16)
        let s = PinWrap.stretch("482915", salt: salt, iterations: Self.it)
        let wrap = try PinWrap.seal(dek: dek, stretched: s, salt: salt, iterations: Self.it, version: 2, hw: "secure-enclave", kek: kekA)
        XCTAssertNotNil(try PinWrap.open(wrap, stretched: s, kek: kekA))
        XCTAssertNil(try PinWrap.open(wrap, stretched: s, kek: kekB), "the right PIN on another device opens nothing")
        // Nothing in the wrap is the PIN or the stretched PIN.
        let text = SecJSON.string(wrap)
        XCTAssertFalse(text.contains("482915"))
        XCTAssertFalse(text.contains(Bytes.b64(s)))
    }
}
