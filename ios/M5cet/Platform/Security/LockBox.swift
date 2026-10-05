// The lock inbox's cryptography and file format (Android security/LockBox,
// 6.12 F-16) — byte for byte, so a migration tool could read either platform's
// inbox. What the rooms receive while the app is locked (the vault's data key is
// gone then) is kept on the disk sealed to a key the locked app cannot open:
//
//   a generation   at each lock a new P-256 key pair; kid = base64url(SHA-256(SPKI))[0..16].
//                  The private key (PKCS#8) is sealed by the vault's data key
//                  (wrapKey: iv ‖ AES-256-GCM, AAD "m5/lockbox/1|key|<kid>") and written
//                  before that key is zeroed; only the public key stays in memory.
//   an item        sealed to that public key: a fresh ephemeral P-256 key, ECDH,
//                  HKDF-SHA256 (salt "m5/lockbox/1", info "<kid>|<seq>|<ephemeral SPKI>"),
//                  AES-256-GCM with AAD "m5/lockbox/1|<kid>|<seq>" —
//                  {"s": seq, "e": ephemeral SPKI, "iv", "ct"}
//   the log        one item per line, appended and synced (a crash keeps every item
//                  written before it; a line cut by it is skipped)
//   opening        at the unlock, with the private key unwrapped by the data key: every
//                  item in the order of its seq, each once; one that does not open is
//                  skipped and counted
//
// The generation key is a software key on purpose (as Android): its private half
// exists only sealed by the data key — a Secure Enclave key could not be sealed so.

import CryptoKit
import Foundation

enum LockBox {
    static let label = "m5/lockbox/1"

    static func newKeyPair() -> P256.KeyAgreement.PrivateKey { P256.KeyAgreement.PrivateKey() }

    static func kid(_ pub: P256.KeyAgreement.PublicKey) -> String { EcP256.kid(der: pub.derRepresentation) }

    static func aad(kid: String, seq: Int64) -> Data { Bytes.utf8("\(label)|\(kid)|\(seq)") }

    private static func itemKey(_ shared: Data, kid: String, seq: Int64, eph: String) -> Data {
        SecCrypto.hkdf(shared, salt: Bytes.utf8(label), info: Bytes.utf8("\(kid)|\(seq)|\(eph)"), length: 32)
    }

    /// One item sealed to the generation's public key.
    static func seal(_ pub: P256.KeyAgreement.PublicKey, kid: String, seq: Int64, _ plain: Data) throws -> SecRecord {
        let eph = P256.KeyAgreement.PrivateKey()
        let e = EcP256.spki(eph.publicKey)
        var shared = try EcP256.ecdh(eph, pub)
        var k = itemKey(shared, kid: kid, seq: seq, eph: e)
        Bytes.wipe(&shared)
        defer { Bytes.wipe(&k) }
        let iv = Bytes.random(12)
        let ct = try SecCrypto.gcmSeal(SymmetricKey(data: k), iv: iv, plain, aad: aad(kid: kid, seq: seq))
        return ["s": seq, "e": e, "iv": Bytes.b64(iv), "ct": Bytes.b64(ct)]
    }

    /// An item's plaintext; throws when it does not open with this generation's private key.
    static func open(_ priv: P256.KeyAgreement.PrivateKey, kid: String, _ rec: SecRecord) throws -> Data {
        let seq = rec.jInt64("s", -1), e = rec.jString("e")
        guard seq >= 0, !e.isEmpty, let iv = Bytes.unb64(rec.jString("iv")), let ct = Bytes.unb64(rec.jString("ct")) else {
            throw SecurityError.damaged("not an item")
        }
        var shared = try EcP256.ecdh(priv, EcP256.publicKey(spki: e))
        var k = itemKey(shared, kid: kid, seq: seq, eph: e)
        Bytes.wipe(&shared)
        defer { Bytes.wipe(&k) }
        return try SecCrypto.gcmOpen(SymmetricKey(data: k), iv: iv, ct, aad: aad(kid: kid, seq: seq))
    }

    // MARK: the private key

    static func keyAad(_ kid: String) -> Data { Bytes.utf8("\(label)|key|\(kid)") }

    /// The generation's private key (PKCS#8) sealed by the vault's data key: iv ‖ ct.
    static func wrapKey(dek: SecretBytes, kid: String, _ priv: P256.KeyAgreement.PrivateKey) throws -> Data {
        var pkcs8 = priv.derRepresentation
        defer { Bytes.wipe(&pkcs8) }
        return try SecCrypto.sealWithIV(dek, pkcs8, aad: keyAad(kid))
    }

    /// The private key again; throws with another data key (or another generation's file).
    static func unwrapKey(dek: SecretBytes, kid: String, _ wrapped: Data) throws -> P256.KeyAgreement.PrivateKey {
        guard wrapped.count >= 28 else { throw SecurityError.damaged("not a key") }
        var pkcs8 = try SecCrypto.openWithIV(dek, wrapped, aad: keyAad(kid))
        defer { Bytes.wipe(&pkcs8) }
        do { return try P256.KeyAgreement.PrivateKey(derRepresentation: pkcs8) } catch { throw SecurityError.damaged("not a key") }
    }

    // MARK: the log

    /// One record as its line (Android: rec.toString() + "\n").
    static func line(_ rec: SecRecord) -> Data { SecJSON.data(rec) + Data([0x0a]) }

    /// The log's records; a line that is not one (cut by a crash) is skipped.
    static func read(_ log: URL) throws -> [SecRecord] {
        guard let data = try ProtectedFiles.read(log) else { return [] }
        return data.split(separator: 0x0a, omittingEmptySubsequences: true).compactMap { SecJSON.parse(Data($0)) }
    }

    /// What a generation's log held: its items in seq order (each once), and how many did not open.
    struct Opened {
        var items: [Data] = []
        var failed = 0
    }

    static func openAll(_ priv: P256.KeyAgreement.PrivateKey, kid: String, _ recs: [SecRecord]) -> Opened {
        var bySeq: [Int64: Data] = [:]
        var out = Opened()
        for rec in recs {
            let seq = rec.jInt64("s", -1)
            if bySeq[seq] != nil { continue } // a line written twice: once
            do { bySeq[seq] = try open(priv, kid: kid, rec) } catch { out.failed += 1 }
        }
        out.items = bySeq.keys.sorted().compactMap { bySeq[$0] }
        return out
    }
}
