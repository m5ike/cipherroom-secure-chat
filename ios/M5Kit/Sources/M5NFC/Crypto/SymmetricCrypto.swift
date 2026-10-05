// The symmetric primitives the travel-document and tag formats need, inside
// M5NFC (M5Crypto is a separate target, ported in parallel):
//
//   DES / 3DES-CBC and the ISO 9797-1 retail MAC   A/nfc/Des.java (des.ts) — BAC, PACE-3DES
//   AES-ECB / AES-CBC (no padding) and AES-CMAC     A/nfc/Aes.java (aes.ts)  — PACE, AES secure messaging
//   SHA-1 / SHA-2, HKDF-SHA256, PBKDF2-SHA256, AES-GCM, random  — tag v2, M5Cet card, share invites
//
// DES, 3DES and the AES block modes come from CommonCrypto (CCCrypt, no padding);
// CMAC and the retail MAC are built on them here; hashes, HKDF and AES-GCM from
// CryptoKit. CommonCrypto exists on iOS, iPadOS, watchOS and macOS; the guard
// only keeps the target honest elsewhere.

import Foundation
import CryptoKit
#if canImport(CommonCrypto)
import CommonCrypto
#endif

/* ================================================================ CCCrypt */

enum CC {
    enum Algorithm { case des, tdes, aes }

    static func crypt(_ alg: Algorithm, encrypt: Bool, ecb: Bool, key: [UInt8], data: [UInt8], iv: [UInt8]?) throws -> [UInt8] {
        #if canImport(CommonCrypto)
        let block = alg == .aes ? kCCBlockSizeAES128 : kCCBlockSizeDES
        guard data.count % block == 0 else { throw NfcError.protocolError("\(alg == .aes ? "AES" : "DES") data must be a whole number of \(block)-byte blocks") }
        if data.isEmpty { return [] }
        let a: CCAlgorithm
        switch alg {
        case .des: a = CCAlgorithm(kCCAlgorithmDES)
        case .tdes: a = CCAlgorithm(kCCAlgorithm3DES)
        case .aes: a = CCAlgorithm(kCCAlgorithmAES)
        }
        var out = [UInt8](repeating: 0, count: data.count + block)
        var moved = 0
        let options = CCOptions(ecb ? kCCOptionECBMode : 0)
        let status: CCCryptorStatus = key.withUnsafeBytes { k in
            data.withUnsafeBytes { d in
                out.withUnsafeMutableBytes { o in
                    if let iv {
                        return iv.withUnsafeBytes { v in
                            CCCrypt(CCOperation(encrypt ? kCCEncrypt : kCCDecrypt), a, options, k.baseAddress, key.count, v.baseAddress,
                                    d.baseAddress, data.count, o.baseAddress, o.count, &moved)
                        }
                    }
                    return CCCrypt(CCOperation(encrypt ? kCCEncrypt : kCCDecrypt), a, options, k.baseAddress, key.count, nil,
                                   d.baseAddress, data.count, o.baseAddress, o.count, &moved)
                }
            }
        }
        guard status == CCCryptorStatus(kCCSuccess) else { throw NfcError.protocolError("CCCrypt failed (\(status))") }
        return Array(out[0..<moved])
        #else
        throw NfcError.unsupported("CommonCrypto is not available")
        #endif
    }
}

/* ================================================================ DES / 3DES */

/// DES / 3DES and the ISO 9797-1 retail MAC — A/nfc/Des.java. Pinned to the
/// ICAO 9303 worked example (BacDesTests).
public enum Des {
    /// Expands a DES / 2-key / 3-key key to the 24 bytes 3DES needs (8 → KKK, 16 → K1K2K1, 24 → as is).
    static func ede24(_ key: [UInt8]) throws -> [UInt8] {
        switch key.count {
        case 24: return key
        case 16: return key + Array(key[0..<8])
        case 8: return key + key + key
        default: throw NfcError(.invalidArgument, "DES key must be 8, 16 or 24 bytes")
        }
    }

    /// 3DES-EDE-CBC over whole 8-byte blocks with the given IV (zero by default).
    public static func tdesCbcEncrypt(_ key: [UInt8], _ data: [UInt8], iv: [UInt8] = [UInt8](repeating: 0, count: 8)) throws -> [UInt8] {
        try CC.crypt(.tdes, encrypt: true, ecb: false, key: ede24(key), data: data, iv: iv)
    }

    public static func tdesCbcDecrypt(_ key: [UInt8], _ data: [UInt8], iv: [UInt8] = [UInt8](repeating: 0, count: 8)) throws -> [UInt8] {
        try CC.crypt(.tdes, encrypt: false, ecb: false, key: ede24(key), data: data, iv: iv)
    }

    /// One raw DES block (ECB) with an 8-byte key.
    static func desBlock(_ key8: [UInt8], _ block: [UInt8], encrypt: Bool) throws -> [UInt8] {
        try CC.crypt(.des, encrypt: encrypt, ecb: true, key: key8, data: block, iv: nil)
    }

    /// ISO 9797-1 padding method 2: 0x80 then 0x00 up to the next 8-byte block.
    public static func pad(_ data: [UInt8]) -> [UInt8] { pad(data, block: 8) }

    static func pad(_ data: [UInt8], block: Int) -> [UInt8] {
        var out = data
        out.append(0x80)
        while out.count % block != 0 { out.append(0) }
        return out
    }

    /// Drops ISO 9797-1 method-2 padding (the last 0x80 … 0x00); unpadded data comes back as it is.
    public static func unpad(_ data: [UInt8]) -> [UInt8] {
        var i = data.count - 1
        while i >= 0 && data[i] == 0x00 { i -= 1 }
        return i >= 0 && data[i] == 0x80 ? Array(data[0..<i]) : data
    }

    /// ISO 9797-1 MAC algorithm 3 (retail MAC) with DES and a 2-key 3DES final step — the passport's
    /// secure-messaging MAC. The data must already be padded: y_i = E(k1, x_i ⊕ y_{i−1}); MAC = E(k1, D(k2, y_n)).
    public static func retailMac(_ key: [UInt8], _ dataPadded: [UInt8]) throws -> [UInt8] {
        guard key.count >= 16 else { throw NfcError(.invalidArgument, "the retail MAC needs a 16-byte key") }
        let k1 = Array(key[0..<8]), k2 = Array(key[8..<16])
        var y = [UInt8](repeating: 0, count: 8)
        var i = 0
        while i + 8 <= dataPadded.count {
            var x = [UInt8](repeating: 0, count: 8)
            for j in 0..<8 { x[j] = dataPadded[i + j] ^ y[j] }
            y = try desBlock(k1, x, encrypt: true)
            i += 8
        }
        return try desBlock(k1, try desBlock(k2, y, encrypt: false), encrypt: true)
    }
}

/* ================================================================ AES */

/// AES blocks, AES-CBC without padding and AES-CMAC — A/nfc/Aes.java. Keys of 16, 24 or 32 bytes.
/// Pinned to FIPS-197, SP 800-38A and RFC 4493 (PaceTests).
public enum Aes {
    static func checkKey(_ key: [UInt8]) throws {
        guard [16, 24, 32].contains(key.count) else { throw NfcError(.invalidArgument, "AES key must be 16, 24 or 32 bytes") }
    }

    /// One block, AES-ECB.
    public static func encryptBlock(_ key: [UInt8], _ block: [UInt8]) throws -> [UInt8] {
        try checkKey(key)
        guard block.count == 16 else { throw NfcError(.invalidArgument, "AES block must be 16 bytes") }
        return try CC.crypt(.aes, encrypt: true, ecb: true, key: key, data: block, iv: nil)
    }

    public static func decryptBlock(_ key: [UInt8], _ block: [UInt8]) throws -> [UInt8] {
        try checkKey(key)
        guard block.count == 16 else { throw NfcError(.invalidArgument, "AES block must be 16 bytes") }
        return try CC.crypt(.aes, encrypt: false, ecb: true, key: key, data: block, iv: nil)
    }

    static func cbc(_ key: [UInt8], _ data: [UInt8], _ iv: [UInt8], encrypt: Bool) throws -> [UInt8] {
        try checkKey(key)
        guard data.count % 16 == 0 else { throw NfcError(.invalidArgument, "AES-CBC data must be a whole number of 16-byte blocks") }
        guard iv.count == 16 else { throw NfcError(.invalidArgument, "AES IV must be 16 bytes") }
        if data.isEmpty { return [] }
        return try CC.crypt(.aes, encrypt: encrypt, ecb: false, key: key, data: data, iv: iv)
    }

    /// AES-CBC over whole blocks, no padding (zero IV by default).
    public static func cbcEncrypt(_ key: [UInt8], _ data: [UInt8], iv: [UInt8] = [UInt8](repeating: 0, count: 16)) throws -> [UInt8] {
        try cbc(key, data, iv, encrypt: true)
    }

    public static func cbcDecrypt(_ key: [UInt8], _ data: [UInt8], iv: [UInt8] = [UInt8](repeating: 0, count: 16)) throws -> [UInt8] {
        try cbc(key, data, iv, encrypt: false)
    }

    /// Doubling in GF(2^128) — the CMAC subkey step.
    static func dbl(_ b: [UInt8]) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: 16)
        for i in 0..<16 { out[i] = (b[i] << 1) | (i < 15 ? b[i + 1] >> 7 : 0) }
        if b[0] & 0x80 != 0 { out[15] ^= 0x87 }
        return out
    }

    /// AES-CMAC (RFC 4493): the full 16-byte tag (PACE and its secure messaging use the first 8).
    public static func cmac(_ key: [UInt8], _ data: [UInt8]) throws -> [UInt8] {
        let k1 = dbl(try encryptBlock(key, [UInt8](repeating: 0, count: 16)))
        let k2 = dbl(k1)
        let n = max(1, (data.count + 15) / 16)
        let complete = !data.isEmpty && data.count % 16 == 0
        // The last block: ⊕ K1 when complete, else 10* padding and ⊕ K2.
        var last = [UInt8](repeating: 0, count: 16)
        let tail = data.count - (n - 1) * 16
        for j in 0..<tail { last[j] = data[(n - 1) * 16 + j] }
        if !complete { last[tail] = 0x80 }
        let sub = complete ? k1 : k2
        for j in 0..<16 { last[j] ^= sub[j] }
        var x = [UInt8](repeating: 0, count: 16)
        for i in 0..<(n - 1) {
            for j in 0..<16 { x[j] ^= data[i * 16 + j] }
            x = try encryptBlock(key, x)
        }
        for j in 0..<16 { x[j] ^= last[j] }
        return try encryptBlock(key, x)
    }
}

/* ================================================================ hashes, KDFs, AEAD */

/// SHA-1 / SHA-2 (CryptoKit).
public enum NfcHash {
    public static func sha1(_ d: [UInt8]) -> [UInt8] { Array(Insecure.SHA1.hash(data: d)) }
    public static func sha256(_ d: [UInt8]) -> [UInt8] { Array(SHA256.hash(data: d)) }
    public static func sha384(_ d: [UInt8]) -> [UInt8] { Array(SHA384.hash(data: d)) }
    public static func sha512(_ d: [UInt8]) -> [UInt8] { Array(SHA512.hash(data: d)) }

    /// By the names EF.SOD uses ("SHA-1", "SHA-256", "SHA-384", "SHA-512"); nil for another algorithm.
    public static func digest(_ algorithm: String, _ d: [UInt8]) -> [UInt8]? {
        switch algorithm {
        case "SHA-1": return sha1(d)
        case "SHA-256": return sha256(d)
        case "SHA-384": return sha384(d)
        case "SHA-512": return sha512(d)
        default: return nil
        }
    }
}

/// HKDF-SHA256, PBKDF2-HMAC-SHA256, AES-256-GCM and randomness — the Crypto.java calls the tag formats make.
public enum NfcCrypto {
    /// HKDF-SHA256 (RFC 5869).
    public static func hkdfSha256(ikm: [UInt8], salt: [UInt8], info: [UInt8], length: Int) -> [UInt8] {
        let k = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: info, outputByteCount: length)
        return k.withUnsafeBytes { Array($0) }
    }

    /// PBKDF2-HMAC-SHA256.
    public static func pbkdf2Sha256(password: [UInt8], salt: [UInt8], rounds: Int, length: Int) throws -> [UInt8] {
        #if canImport(CommonCrypto)
        var out = [UInt8](repeating: 0, count: length)
        let status = password.withUnsafeBytes { p in
            salt.withUnsafeBytes { s in
                out.withUnsafeMutableBytes { o in
                    CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), p.baseAddress?.assumingMemoryBound(to: CChar.self), password.count,
                                         s.baseAddress?.assumingMemoryBound(to: UInt8.self), salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                                         UInt32(rounds), o.baseAddress?.assumingMemoryBound(to: UInt8.self), length)
                }
            }
        }
        guard status == Int32(kCCSuccess) else { throw NfcError.io("PBKDF2 failed (\(status))") }
        return out
        #else
        throw NfcError.unsupported("CommonCrypto is not available")
        #endif
    }

    /// AES-GCM with a 12-byte IV: ciphertext ‖ 16-byte tag (Crypto.gcmSeal).
    public static func gcmSeal(key: [UInt8], iv: [UInt8], plaintext: [UInt8], aad: [UInt8]) throws -> [UInt8] {
        let box = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: iv), authenticating: aad)
        return Array(box.ciphertext) + Array(box.tag)
    }

    /// Opens ciphertext ‖ tag; a wrong key or a changed byte throws `authFailed`.
    public static func gcmOpen(key: [UInt8], iv: [UInt8], sealed: [UInt8], aad: [UInt8]) throws -> [UInt8] {
        guard sealed.count >= 16 else { throw NfcError(.authFailed, "the sealed data is too short") }
        do {
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: sealed[0..<(sealed.count - 16)], tag: sealed[(sealed.count - 16)...])
            return Array(try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad))
        } catch {
            throw NfcError(.authFailed, "the sealed data did not open")
        }
    }

    /// `n` cryptographically random bytes.
    public static func random(_ n: Int) -> [UInt8] {
        var g = SystemRandomNumberGenerator()
        return (0..<n).map { _ in UInt8.random(in: 0...255, using: &g) }
    }

    /// Overwrites a key in memory (Crypto.wipe).
    public static func wipe(_ b: inout [UInt8]) { for i in b.indices { b[i] = 0 } }
}
