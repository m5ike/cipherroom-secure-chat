// The symmetric primitives exactly as WebCrypto and node:crypto do them
// (android security/Crypto.java): AES-GCM (12-byte IV, 16-byte tag appended),
// HKDF-SHA256, HMAC-SHA256, PBKDF2-HMAC-SHA256 over the password's UTF-8
// bytes, SHA-256 / SHA-512, random bytes. CryptoKit and CommonCrypto.

import CommonCrypto
import CryptoKit
import Foundation
import M5Core
import Security

/// An AES-GCM or key-derivation failure (a wrong key, a changed ciphertext, bad parameters).
public struct CryptoError: Error, Sendable, Equatable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

public enum Crypto {
    /// `n` bytes from the system's CSPRNG.
    public static func random(_ n: Int) -> Bytes {
        var out = Bytes(repeating: 0, count: n)
        if n > 0 {
            let status = out.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, n, $0.baseAddress!) }
            precondition(status == errSecSuccess, "the system random generator failed")
        }
        return out
    }

    public static func utf8(_ s: String) -> Bytes { Array(s.utf8) }
    public static func str(_ b: Bytes) -> String { UTF8Text.lossy(b) }
    public static func b64(_ b: Bytes) -> String { B64.encode(b) }
    public static func unb64(_ s: String) throws -> Bytes {
        guard let b = B64.decode(s) else { throw CryptoError("bad base64") }
        return b
    }
    public static func b64url(_ b: Bytes) -> String { B64.url(b) }
    public static func unb64url(_ s: String) throws -> Bytes {
        guard let b = B64.decodeURL(s) else { throw CryptoError("bad base64url") }
        return b
    }
    public static func hex(_ b: Bytes) -> String { Hex.encode(b) }
    public static func unhex(_ s: String) -> Bytes { Hex.decode(s) ?? [] }

    public static func sha256(_ parts: Bytes...) -> Bytes {
        var h = SHA256()
        for p in parts { h.update(data: p) }
        return Array(h.finalize())
    }

    public static func sha512(_ data: Bytes) -> Bytes { Array(SHA512.hash(data: data)) }

    /// HMAC-SHA256; an empty key is the same as one zero byte (HMAC pads keys with zeros).
    public static func hmac256(_ key: Bytes, _ data: Bytes) -> Bytes {
        let k = SymmetricKey(data: key.isEmpty ? [0] : key)
        return Array(HMAC<SHA256>.authenticationCode(for: data, using: k))
    }

    /// RFC 5869 HKDF-SHA256. An empty salt is HashLen zeros (as WebCrypto).
    public static func hkdf(_ ikm: Bytes, _ salt: Bytes, _ info: Bytes, _ length: Int) -> Bytes {
        let prk = hmac256(salt.isEmpty ? Bytes(repeating: 0, count: 32) : salt, ikm)
        var out = Bytes()
        out.reserveCapacity(length)
        var t = Bytes()
        var i: UInt8 = 1
        while out.count < length {
            t = hmac256(prk, t + info + [i])
            out.append(contentsOf: t.prefix(length - out.count))
            i &+= 1
        }
        return out
    }

    /// PBKDF2-HMAC-SHA256 over the raw password bytes (WebCrypto's importKey("raw", utf8(password))).
    public static func pbkdf2(_ password: Bytes, _ salt: Bytes, _ iterations: Int, _ length: Int) -> Bytes {
        precondition(iterations >= 1 && length >= 1)
        if !password.isEmpty {
            var out = Bytes(repeating: 0, count: length)
            let status = password.withUnsafeBytes { pw in
                salt.withUnsafeBytes { s in
                    out.withUnsafeMutableBytes { o in
                        CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2),
                                             pw.baseAddress!.assumingMemoryBound(to: CChar.self), password.count,
                                             s.baseAddress?.assumingMemoryBound(to: UInt8.self) ?? UnsafePointer<UInt8>(bitPattern: 1)!, salt.count,
                                             CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(iterations),
                                             o.baseAddress!.assumingMemoryBound(to: UInt8.self), length)
                    }
                }
            }
            if status == kCCSuccess { return out }
        }
        // An empty password (CommonCrypto refuses it): the definition, with HMAC's empty key.
        var out = Bytes()
        var block: UInt32 = 1
        while out.count < length {
            var u = hmac256(password, salt + ByteOps.be32(block))
            var t = u
            for _ in 1..<iterations {
                u = hmac256(password, u)
                for j in 0..<t.count { t[j] ^= u[j] }
            }
            out.append(contentsOf: t.prefix(length - out.count))
            block += 1
        }
        return out
    }

    /// AES-GCM: ciphertext ‖ 16-byte tag. The key is 16, 24 or 32 bytes.
    public static func gcmSeal(_ key: Bytes, _ iv: Bytes, _ plain: Bytes, _ aad: Bytes?) throws -> Bytes {
        guard [16, 24, 32].contains(key.count) else { throw CryptoError("AES key size") }
        do {
            let nonce = try AES.GCM.Nonce(data: iv)
            let box = try AES.GCM.seal(plain, using: SymmetricKey(data: key), nonce: nonce, authenticating: aad ?? [])
            return Array(box.ciphertext) + Array(box.tag)
        } catch {
            throw CryptoError("AES-GCM seal failed")
        }
    }

    /// The inverse of `gcmSeal`; a wrong key, IV, AAD or a changed byte throws.
    public static func gcmOpen(_ key: Bytes, _ iv: Bytes, _ sealed: Bytes, _ aad: Bytes?) throws -> Bytes {
        guard [16, 24, 32].contains(key.count), sealed.count >= 16 else { throw CryptoError("does not decrypt") }
        do {
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: sealed.dropLast(16), tag: sealed.suffix(16))
            return Array(try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad ?? []))
        } catch {
            throw CryptoError("does not decrypt")
        }
    }

    public static func same(_ a: Bytes, _ b: Bytes) -> Bool { ByteOps.ctEqual(a, b) }
    public static func concat(_ parts: Bytes...) -> Bytes { ByteOps.concat(parts) }
    public static func wipe(_ b: inout Bytes) { ByteOps.wipe(&b) }
}
