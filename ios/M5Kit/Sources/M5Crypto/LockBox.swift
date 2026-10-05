// The lock inbox's cryptography and record format (6.12, F-16; android
// security/LockBox.java) — what the rooms receive while the app is locked (the
// vault's data key is gone then) is kept sealed to a key the locked app cannot
// open:
//
//   a generation   at each lock a new P-256 key pair; its id (kid) is
//                  Ec.kid(public key). The private key is sealed by the vault's
//                  data key (wrapKey: AES-256-GCM, AAD "m5/lockbox/1|key|<kid>").
//   an item        sealed to that public key: a fresh ephemeral P-256 key, ECDH,
//                  HKDF-SHA256 (salt "m5/lockbox/1", info "<kid>|<seq>|<eph SPKI>"),
//                  AES-256-GCM with AAD "m5/lockbox/1|<kid>|<seq>"
//                  — {"s": seq, "e": ephemeral SPKI, "iv", "ct"}
//   the log        one item per line (JSON), appended; a line cut by a crash is skipped
//   opening        at the unlock: every item in the order of its seq, each once;
//                  one that does not open is skipped and counted
//
// The file itself is the app's (Platform); the line format and the crypto are here.

import CryptoKit
import Foundation
import M5Core

public enum LockBox {
    static let label = "m5/lockbox/1"

    /// A new generation's key pair (software P-256: its private key is kept only sealed by the data key).
    public static func newKeyPair() -> P256Pair { Prim.generateP256() }

    public static func kid(_ pub: P256Pair) -> String { Ec.kid(pub.spki) }
    public static func kid(spki: String) -> String { Ec.kid(spki) }

    static func aad(_ kid: String, _ seq: Int64) -> Bytes { Crypto.utf8(label + "|" + kid + "|" + String(seq)) }

    private static func itemKey(_ shared: Bytes, _ kid: String, _ seq: Int64, _ eph: String) -> Bytes {
        Crypto.hkdf(shared, Crypto.utf8(label), Crypto.utf8(kid + "|" + String(seq) + "|" + eph), 32)
    }

    /// One item sealed to the generation's public key (SPKI b64).
    public static func seal(publicKey: String, kid: String, seq: Int64, _ plain: Bytes) throws -> JSONObject {
        let eph = Prim.generateP256()
        let shared = try eph.agree(with: try Ec.publicFromSpki(publicKey))
        let k = itemKey(shared, kid, seq, eph.spki)
        let iv = Crypto.random(12)
        let ct = try Crypto.gcmSeal(k, iv, plain, aad(kid, seq))
        return JSONObject([("s", .int(seq)), ("e", .string(eph.spki)), ("iv", .string(Crypto.b64(iv))), ("ct", .string(Crypto.b64(ct)))])
    }

    /// An item's plaintext; throws when it does not open with this generation's private key.
    public static func open(_ priv: any KeyAgreer, kid: String, _ rec: JSONObject) throws -> Bytes {
        let seq = rec.optInt64("s", -1)
        let e = rec.optString("e")
        if seq < 0 || e.isEmpty { throw CryptoError("not an item") }
        let shared = try priv.agree(with: try Ec.publicFromSpki(e))
        let k = itemKey(shared, kid, seq, e)
        return try Crypto.gcmOpen(k, try Crypto.unb64(rec.optString("iv")), try Crypto.unb64(rec.optString("ct")), aad(kid, seq))
    }

    /* ------------------------------------------------- the private key */

    static func keyAad(_ kid: String) -> Bytes { Crypto.utf8(label + "|key|" + kid) }

    /// The generation's private key (PKCS#8) sealed by the vault's data key: iv ‖ ct.
    public static func wrapKey(dek: Bytes, kid: String, pkcs8: Bytes) throws -> Bytes {
        let iv = Crypto.random(12)
        return iv + (try Crypto.gcmSeal(dek, iv, pkcs8, keyAad(kid)))
    }

    /// The private key again; throws with another data key (or another generation's file).
    public static func unwrapKey(dek: Bytes, kid: String, _ wrapped: Bytes) throws -> P256Pair {
        if wrapped.count < 28 { throw CryptoError("not a key") }
        let pkcs8 = try Crypto.gcmOpen(dek, Array(wrapped[0..<12]), Array(wrapped[12...]), keyAad(kid))
        return try Ec.privateFromPkcs8(pkcs8)
    }

    /* ------------------------------------------------------------ the log */

    /// One record as its log line (JSON + "\n").
    public static func line(_ rec: JSONObject) -> Bytes { Crypto.utf8(rec.stringify() + "\n") }

    /// The records of a log's bytes; a line that is not one (cut by a crash) is skipped.
    public static func read(_ log: Bytes) -> [JSONObject] {
        var out = [JSONObject]()
        for line in log.split(separator: 0x0a, omittingEmptySubsequences: true) {
            if let o = JSON.parseObject(String(decoding: line, as: UTF8.self)) { out.append(o) }
        }
        return out
    }

    /// What a generation's log held: its items in seq order (each once), and how many did not open.
    public struct Opened: Sendable {
        public var items: [Bytes] = []
        public var failed = 0
    }

    public static func openAll(_ priv: any KeyAgreer, kid: String, _ recs: [JSONObject]) -> Opened {
        var bySeq = [Int64: Bytes]()
        var out = Opened()
        for rec in recs {
            let seq = rec.optInt64("s", -1)
            if bySeq[seq] != nil { continue } // a line written twice: once
            do { bySeq[seq] = try open(priv, kid: kid, rec) } catch { out.failed += 1 }
        }
        out.items = bySeq.keys.sorted().map { bySeq[$0]! }
        return out
    }
}

/// The PIN wrap "user.pin" — the user tier's data key sealed by the key the
/// PIN gives (6.12, F-16; android security/PinWrap.java):
///
///   v 1  {salt, iter, iv, ct}            KEK = HMAC(pepper, PBKDF2(PIN)), AAD "m5/user.pin"
///   v 2  {v: 2, salt, iter, iv, ct, hw}  KEK = HMAC(pin key, "m5/pin/2|" ‖ PBKDF2(PIN)), AAD "m5/user.pin/2"
///
/// The KEK itself is the app's (a Secure Enclave key on iOS, `Kek`); the format,
/// the versions' AAD and the move from v 1 to v 2 are here.
public enum PinWrap {
    /// The KEK from the stretched PIN, for the wrap's version.
    public typealias Kek = (_ stretched: Bytes, _ version: Int) throws -> Bytes

    public static func version(_ o: JSONObject) -> Int { Envelopes.optInt(o, "v", 1) }

    public static func aad(_ version: Int) -> Bytes { Crypto.utf8(version >= 2 ? "m5/user.pin/2" : "m5/user.pin") }

    /// A wrap of the data key (v 2 carries where the PIN key lives, hw).
    public static func seal(dek: Bytes, stretched: Bytes, salt: Bytes, iterations: Int, version: Int, hw: String?, kek: Kek) throws -> JSONObject {
        let k = try kek(stretched, version)
        let iv = Crypto.random(12)
        let ct = try Crypto.gcmSeal(k, iv, dek, aad(version))
        var o = JSONObject([("salt", .string(Crypto.b64(salt))), ("iter", .int(iterations)), ("iv", .string(Crypto.b64(iv))), ("ct", .string(Crypto.b64(ct)))])
        if version >= 2 { o["v"] = .int(version); o["hw"] = .string(hw ?? "tee") }
        return o
    }

    /// The data key, or nil when this stretched PIN is not the one (a wrong PIN). A damaged wrap throws.
    public static func open(_ o: JSONObject, stretched: Bytes, kek: Kek) throws -> Bytes? {
        let v = version(o)
        let k = try kek(stretched, v)
        guard let iv = B64.decode(o.optString("iv")), let ct = B64.decode(o.optString("ct")) else { throw CryptoError("the PIN wrap is damaged") }
        return try? Crypto.gcmOpen(k, iv, ct, aad(v))
    }

    public static func salt(_ o: JSONObject) throws -> Bytes {
        guard let s = o.string("salt"), let b = B64.decode(s) else { throw CryptoError("the PIN wrap is damaged") }
        return b
    }

    public static func iterations(_ o: JSONObject) throws -> Int {
        let it = Envelopes.optInt(o, "iter", 0)
        if it < 1 { throw CryptoError("the PIN wrap is damaged") }
        return it
    }

    /// The v 1 wrap moved to v 2 after an unlock with it: the same data key, salt and iterations, sealed by the v 2 KEK.
    public static func moved(_ v1: JSONObject, dek: Bytes, stretched: Bytes, hw: String?, kek: Kek) throws -> JSONObject {
        try seal(dek: dek, stretched: stretched, salt: try salt(v1), iterations: try iterations(v1), version: 2, hw: hw, kek: kek)
    }

    /// The stretched PIN: PBKDF2-SHA256 of its UTF-8 (32 bytes).
    public static func stretch(pin: String, salt: Bytes, iterations: Int) -> Bytes { Crypto.pbkdf2(Crypto.utf8(pin), salt, iterations, 32) }

    /// v 2's KEK input from a stretched PIN: "m5/pin/2|" ‖ stretched (the app MACs it with its hardware key).
    public static func kekInput(_ stretched: Bytes) -> Bytes { Crypto.utf8("m5/pin/2|") + stretched }
}
