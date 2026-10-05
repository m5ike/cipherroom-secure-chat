// The PIN wrap "user.pin" — the USER tier's data key sealed by the key the PIN
// gives (Android security/PinWrap, 6.12 F-16):
//
//   v 2  {v: 2, salt, iter, iv, ct, hw}
//        KEK = PRF_pin("m5/pin/2|" ‖ PBKDF2-SHA256(PIN, salt, iter, 32))     AAD "m5/user.pin/2"
//
// PRF_pin is the Secure Enclave's (Keyring.prf, alias "pin"): Android's HMAC by
// the Keystore key m5.pin. `hw` says where that key is: "secure-enclave" or
// "software". iOS writes only v 2 (there is no 6.11 install to move from); v 1
// ({salt, iter, iv, ct}, AAD "m5/user.pin") still reads, as Android's tests require
// of the format. The KEK is given (Kek) — the format is pure: PinWrapTests.

import CryptoKit
import Foundation

enum PinWrap {
    /// The KEK from the stretched PIN for the wrap's version.
    typealias Kek = (_ stretched: Data, _ version: Int) throws -> Data

    static func version(_ o: SecRecord) -> Int { o.jInt("v", 1) }

    static func aad(_ version: Int) -> Data { Bytes.utf8(version >= 2 ? "m5/user.pin/2" : "m5/user.pin") }

    /// "m5/pin/2|" ‖ stretched — what the v 2 PRF is asked for.
    static func prfInput(_ stretched: Data) -> Data { Bytes.utf8("m5/pin/2|") + stretched }

    /// A wrap of the data key (v 2 carries the PIN key's place, hw).
    static func seal(dek: SecretBytes, stretched: Data, salt: Data, iterations: Int, version: Int, hw: String?, kek: Kek) throws -> SecRecord {
        var k = try kek(stretched, version)
        defer { Bytes.wipe(&k) }
        let iv = Bytes.random(12)
        let ct = try dek.withBytes { raw in try SecCrypto.gcmSeal(SymmetricKey(data: k), iv: iv, Data(raw), aad: aad(version)) }
        var o: SecRecord = ["salt": Bytes.b64(salt), "iter": iterations, "iv": Bytes.b64(iv), "ct": Bytes.b64(ct)]
        if version >= 2 {
            o["v"] = version
            o["hw"] = hw ?? KeyLevel.secureEnclave.rawValue
        }
        return o
    }

    /// The data key, or nil when this stretched PIN is not the one (a wrong PIN); throws when the wrap is damaged.
    static func open(_ o: SecRecord, stretched: Data, kek: Kek) throws -> SecretBytes? {
        let v = version(o)
        guard let iv = Bytes.unb64(o.jString("iv")), let ct = Bytes.unb64(o.jString("ct")), iv.count == 12, ct.count >= 16 else {
            throw SecurityError.damaged("the PIN wrap")
        }
        var k = try kek(stretched, v)
        defer { Bytes.wipe(&k) }
        do {
            var plain = try SecCrypto.gcmOpen(SymmetricKey(data: k), iv: iv, ct, aad: aad(v))
            defer { Bytes.wipe(&plain) }
            return SecretBytes(plain)
        } catch {
            return nil
        }
    }

    static func salt(_ o: SecRecord) throws -> Data {
        guard let s = o["salt"] as? String, let d = Bytes.unb64(s) else { throw SecurityError.damaged("the PIN wrap") }
        return d
    }

    static func iterations(_ o: SecRecord) throws -> Int {
        let it = o.jInt("iter", 0)
        guard it >= 1 else { throw SecurityError.damaged("the PIN wrap") }
        return it
    }

    /// A v 1 wrap moved to v 2 after an unlock with it: same data key, salt and iterations.
    static func moved(_ v1: SecRecord, dek: SecretBytes, stretched: Data, hw: String, kek: Kek) throws -> SecRecord {
        try seal(dek: dek, stretched: stretched, salt: salt(v1), iterations: iterations(v1), version: 2, hw: hw, kek: kek)
    }

    /// PBKDF2-SHA256(PIN, salt, iterations, 32) over the PIN's UTF-8 bytes.
    static func stretch(_ pin: String, salt: Data, iterations: Int) -> Data {
        var p = Bytes.utf8(pin)
        defer { Bytes.wipe(&p) }
        return SecCrypto.pbkdf2(p, salt: salt, iterations: iterations, length: 32)
    }
}
