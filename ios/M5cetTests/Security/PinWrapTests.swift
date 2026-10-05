// The PIN wrap is M5Crypto's PinWrap (Android's format; its own tests cover v 1, the
// move to v 2 and damaged wraps) with the Secure Enclave PRF as the KEK: the vault's
// user.pin is exactly that format (v 2, "m5/user.pin/2"), opens with M5Crypto's code
// given the enclave KEK, and — the property Android gets from its TEE HMAC — the
// right PIN opens nothing on another device.

import CryptoKit
import M5Core
import M5Crypto
import XCTest
@testable import M5cet

final class PinWrapTests: XCTestCase {
    private static let it = 1000

    func testTheVaultsWrapIsM5CryptosFormatWithTheEnclaveKek() throws {
        for enclave in [false, true] where !enclave || EnclaveKeyMaker.available {
            let dir = TempDir()
            let keyring = enclave ? try TestKeys.enclave(MemorySecureStore()) : TestKeys.software(MemorySecureStore())
            let v = Vault(paths: .under(dir.url), keyring: keyring, iterations: Self.it)
            try v.createUserKey(pin: "482915")
            let wrap = try XCTUnwrap(SecData.json(Data(contentsOf: v.paths.pinWrap)))
            XCTAssertEqual(PinWrap.version(wrap), 2)
            XCTAssertEqual(wrap.optString("hw"), enclave ? "secure-enclave" : "software")
            XCTAssertEqual(Set(wrap.keys), ["salt", "iter", "iv", "ct", "v", "hw"], "Android's v 2 fields")
            XCTAssertEqual(try PinWrap.iterations(wrap), Self.it)
            // M5Crypto's PinWrap opens it with the enclave PRF of "m5/pin/2|" ‖ PBKDF2(PIN).
            let kek: PinWrap.Kek = { s, version in
                XCTAssertEqual(version, 2)
                return Array(try keyring.prf("pin", Data(PinWrap.kekInput(s))))
            }
            let stretched = PinWrap.stretch(pin: "482915", salt: try PinWrap.salt(wrap), iterations: Self.it)
            XCTAssertEqual(try PinWrap.open(wrap, stretched: stretched, kek: kek), try v.userKey().bytes())
            XCTAssertNil(try PinWrap.open(wrap, stretched: PinWrap.stretch(pin: "482916", salt: try PinWrap.salt(wrap), iterations: Self.it), kek: kek))
            // The version is in the AAD: relabelled as v 1 it does not open (the KEK refuses v 1 on iOS at all).
            XCTAssertThrowsError(try PinWrap.open(wrap.without("v"), stretched: stretched, kek: { _, _ in throw SecurityError.unavailable("v 1") }))
            XCTAssertNil(try PinWrap.open(wrap.without("v"), stretched: stretched, kek: { s, _ in try kek(s, 2) }))
            // Nothing in it is the PIN or the stretched PIN.
            let text = wrap.stringify()
            XCTAssertFalse(text.contains("482915"))
            XCTAssertFalse(text.contains(Crypto.b64(stretched)))
        }
    }

    func testTheEnclaveKekNeedsThisDevice() throws {
        // Two "devices": two enclave keyrings. A wrap made on one opens only there.
        let a = try TestKeys.enclave(MemorySecureStore()), b = try TestKeys.enclave(MemorySecureStore())
        try a.ensureAgreementKey("pin", access: .foreground)
        try b.ensureAgreementKey("pin", access: .foreground)
        let kekA: PinWrap.Kek = { s, _ in Array(try a.prf("pin", Data(PinWrap.kekInput(s)))) }
        let kekB: PinWrap.Kek = { s, _ in Array(try b.prf("pin", Data(PinWrap.kekInput(s)))) }
        let dek = Crypto.random(32)
        let salt = Crypto.random(16)
        let s = PinWrap.stretch(pin: "482915", salt: salt, iterations: Self.it)
        let wrap = try PinWrap.seal(dek: dek, stretched: s, salt: salt, iterations: Self.it, version: 2, hw: "secure-enclave", kek: kekA)
        XCTAssertEqual(try PinWrap.open(wrap, stretched: s, kek: kekA), dek)
        XCTAssertNil(try PinWrap.open(wrap, stretched: s, kek: kekB), "the right PIN on another device opens nothing")
    }
}
