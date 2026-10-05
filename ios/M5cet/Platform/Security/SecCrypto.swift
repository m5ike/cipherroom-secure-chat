// The primitives of the device security code, exactly as Android's
// security/Crypto and security/Ec do them (and WebCrypto / node:crypto):
// AES-256-GCM (12-byte IV, 16-byte tag appended), HKDF-SHA256, HMAC-SHA256,
// PBKDF2-HMAC-SHA256 over the password's UTF-8 bytes, SHA-256; P-256 keys as
// SPKI (base64), ECDSA signatures in IEEE P1363 form (r‖s), raw ECDH
// x-coordinates. CryptoKit + CommonCrypto only.
//
// M5Kit/M5Crypto will carry the protocol's cryptography; this file is what the
// platform layer needs on its own (Vault, PIN, lock inbox, policy), so it does
// not wait for that module.

import CommonCrypto
import CryptoKit
import Foundation

enum SecCrypto {
    // MARK: AES-256-GCM

    /// ciphertext ‖ 16-byte tag (Android Crypto.gcmSeal).
    static func gcmSeal(_ key: SymmetricKey, iv: Data, _ plain: Data, aad: Data) throws -> Data {
        let box = try AES.GCM.seal(plain, using: key, nonce: AES.GCM.Nonce(data: iv), authenticating: aad)
        // A fresh Data from index 0 (box.ciphertext is a slice of the box's storage).
        var out = Data(capacity: box.ciphertext.count + 16)
        out.append(contentsOf: box.ciphertext)
        out.append(contentsOf: box.tag)
        return out
    }

    static func gcmSeal(_ key: SecretBytes, iv: Data, _ plain: Data, aad: Data) throws -> Data {
        try gcmSeal(key.symmetricKey(), iv: iv, plain, aad: aad)
    }

    /// Opens ciphertext ‖ tag; throws `.damaged` when it does not authenticate.
    static func gcmOpen(_ key: SymmetricKey, iv: Data, _ ctAndTag: Data, aad: Data) throws -> Data {
        guard iv.count == 12, ctAndTag.count >= 16 else { throw SecurityError.damaged("gcm") }
        do {
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: ctAndTag.dropLast(16), tag: ctAndTag.suffix(16))
            return try AES.GCM.open(box, using: key, authenticating: aad)
        } catch {
            throw SecurityError.damaged("gcm")
        }
    }

    static func gcmOpen(_ key: SecretBytes, iv: Data, _ ctAndTag: Data, aad: Data) throws -> Data {
        try gcmOpen(key.symmetricKey(), iv: iv, ctAndTag, aad: aad)
    }

    /// iv ‖ ciphertext ‖ tag with a fresh IV — the shape of the vault's records and wrapped keys.
    static func sealWithIV(_ key: SecretBytes, _ plain: Data, aad: Data) throws -> Data {
        let iv = Bytes.random(12)
        return iv + (try gcmSeal(key, iv: iv, plain, aad: aad))
    }

    static func openWithIV(_ key: SecretBytes, _ sealed: Data, aad: Data) throws -> Data {
        guard sealed.count >= 28 else { throw SecurityError.damaged("short") }
        return try gcmOpen(key, iv: sealed.prefix(12), sealed.dropFirst(12), aad: aad)
    }

    // MARK: hashes and MACs

    static func sha256(_ parts: Data...) -> Data {
        var h = SHA256()
        for p in parts { h.update(data: p) }
        return Data(h.finalize())
    }

    static func hmac(key: Data, _ parts: Data...) -> Data {
        // HMAC pads an empty key with zeros, the same as one zero byte (Android Crypto.hmac).
        var m = HMAC<SHA256>(key: SymmetricKey(data: key.isEmpty ? Data([0]) : key))
        for p in parts { m.update(data: p) }
        return Data(m.finalize())
    }

    /// RFC 5869; an empty salt is HashLen zeros (as WebCrypto).
    static func hkdf(_ ikm: Data, salt: Data, info: Data, length: Int) -> Data {
        let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: salt.isEmpty ? Data(count: 32) : salt,
                                         info: info, outputByteCount: length)
        return key.withUnsafeBytes { Data($0) }
    }

    /// PBKDF2-HMAC-SHA256 over the raw password bytes (WebCrypto's importKey("raw", utf8(password))).
    static func pbkdf2(_ password: Data, salt: Data, iterations: Int, length: Int) -> Data {
        var out = Data(count: length)
        let status = out.withUnsafeMutableBytes { o in
            password.withUnsafeBytes { p in
                salt.withUnsafeBytes { s in
                    CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2),
                                         p.baseAddress?.assumingMemoryBound(to: CChar.self), password.count,
                                         s.baseAddress?.assumingMemoryBound(to: UInt8.self), salt.count,
                                         CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(iterations),
                                         o.baseAddress!.assumingMemoryBound(to: UInt8.self), length)
                }
            }
        }
        precondition(status == kCCSuccess, "PBKDF2 failed")
        return out
    }
}

/// P-256 as the web client, the server and Android use it (Android security/Ec).
enum EcP256 {
    static func spki(_ key: P256.KeyAgreement.PublicKey) -> String { Bytes.b64(key.derRepresentation) }
    static func spki(_ key: P256.Signing.PublicKey) -> String { Bytes.b64(key.derRepresentation) }

    /// A P-256 public key from its SPKI (anything else throws).
    static func publicKey(spki: String) throws -> P256.KeyAgreement.PublicKey {
        guard let der = Bytes.unb64(spki.trimmingCharacters(in: .whitespacesAndNewlines)) else { throw SecurityError.damaged("not base64") }
        return try publicKey(der: der)
    }

    static func publicKey(der: Data) throws -> P256.KeyAgreement.PublicKey {
        do { return try P256.KeyAgreement.PublicKey(derRepresentation: der) } catch { throw SecurityError.damaged("not a P-256 key") }
    }

    /// base64url(SHA-256(SPKI))[0..16] — identity.ts keyId, the server's kid (Android Ec.kid).
    static func kid(spki: String) -> String? {
        guard let der = Bytes.unb64(spki.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        return kid(der: der)
    }

    static func kid(der: Data) -> String { String(Bytes.b64url(SecCrypto.sha256(der)).prefix(16)) }

    /// Grouped hex of the first 16 bytes of SHA-256(SPKI), upper case ("ABCD EF01 …").
    static func fingerprint(spki: String) -> String? {
        guard let der = Bytes.unb64(spki.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        let h = Bytes.hex(SecCrypto.sha256(der).prefix(16)).uppercased()
        var out = ""
        for (i, c) in h.enumerated() {
            if i > 0 && i % 4 == 0 { out.append(" ") }
            out.append(c)
        }
        return out
    }

    /// The raw 32-byte x-coordinate (Android Ec.ecdh, WebCrypto deriveBits).
    static func ecdh(_ mine: P256.KeyAgreement.PrivateKey, _ theirs: P256.KeyAgreement.PublicKey) throws -> Data {
        try mine.sharedSecretFromKeyAgreement(with: theirs).withUnsafeBytes { Data($0) }
    }

    /// ECDSA P-256 / SHA-256 verification of a P1363 signature (base64) by an SPKI key (base64).
    static func verify(spki: String, data: Data, signature: String) -> Bool {
        guard let der = Bytes.unb64(spki.trimmingCharacters(in: .whitespacesAndNewlines)),
              let key = try? P256.Signing.PublicKey(derRepresentation: der),
              let raw = Bytes.unb64(signature), raw.count == 64,
              let sig = try? P256.Signing.ECDSASignature(rawRepresentation: raw) else { return false }
        return key.isValidSignature(sig, for: data)
    }

    // MARK: DER ⇄ P1363 (SecKeyCreateSignature and Java speak DER, the server P1363)

    /// SEQUENCE { INTEGER r, INTEGER s } → r ‖ s (32 + 32 bytes).
    static func derToP1363(_ der: Data) throws -> Data {
        let b = [UInt8](der)
        var at = 0
        func byte() throws -> UInt8 {
            guard at < b.count else { throw SecurityError.damaged("DER signature") }
            defer { at += 1 }
            return b[at]
        }
        guard try byte() == 0x30 else { throw SecurityError.damaged("DER signature") }
        let len = try byte()
        if len > 0x80 { at += Int(len - 0x80) }
        var out = [UInt8](repeating: 0, count: 64)
        for k in 0..<2 {
            guard try byte() == 0x02 else { throw SecurityError.damaged("DER signature") }
            let n = Int(try byte())
            guard n > 0, at + n <= b.count else { throw SecurityError.damaged("DER signature") }
            var v = Array(b[at..<(at + n)])
            at += n
            while v.count > 1 && v[0] == 0 { v.removeFirst() }
            guard v.count <= 32 else { throw SecurityError.damaged("DER signature") }
            for (i, x) in v.enumerated() { out[k * 32 + (32 - v.count) + i] = x }
        }
        return Data(out)
    }

    static func p1363ToDer(_ sig: Data) throws -> Data {
        guard sig.count == 64 else { throw SecurityError.damaged("P1363 signature") }
        func integer(_ unsigned: Data) -> [UInt8] {
            var v = [UInt8](unsigned)
            while v.count > 1 && v[0] == 0 { v.removeFirst() }
            if v[0] & 0x80 != 0 { v.insert(0, at: 0) }
            return [0x02, UInt8(v.count)] + v
        }
        let r = integer(sig.prefix(32)), s = integer(sig.suffix(32))
        return Data([0x30, UInt8(r.count + s.count)] + r + s)
    }

    // MARK: hashing to the curve (the Secure Enclave as a PRF — README "PIN key")

    /// A P-256 point whose discrete logarithm nobody knows, from the input: try-and-increment
    /// over x = SHA-256("m5/ios/h2c/1|" ‖ u32 counter ‖ input), decompressed by CryptoKit
    /// (an x not on the curve is refused and the next counter tried; ~2 tries on average).
    static func hashToCurve(_ input: Data) -> P256.KeyAgreement.PublicKey {
        let label = Bytes.utf8("m5/ios/h2c/1|")
        var counter: UInt32 = 0
        while true {
            let x = SecCrypto.sha256(label, Bytes.u32be(counter), input)
            if let point = try? P256.KeyAgreement.PublicKey(compressedRepresentation: Data([0x02]) + x) { return point }
            counter += 1
        }
    }
}
