// Secret key material that is zeroed in place, and the byte helpers of the
// security code (Android: byte[] + Crypto.wipe / random / b64 / hex / same).
//
// A data key (DEK) lives in one SecretBytes: readers share the instance, so
// Vault.lock() zeroes it for everyone — as Android zeroes the one array it
// handed out (6.12, F-16). Swift's Data is copy-on-write and cannot be zeroed
// reliably; SecretBytes owns its buffer and memset_s-es it on wipe and deinit.

import CryptoKit
import Foundation
import Security

/// Why a security operation did not happen. Messages never carry secrets.
enum SecurityError: Error, Equatable, CustomStringConvertible {
    /// The user tier's data key is not in memory (the app is locked).
    case locked
    /// A key or record does not open (wrong key, changed, damaged).
    case damaged(String)
    /// The Keychain refused (OSStatus).
    case keychain(OSStatus)
    /// No key of that name.
    case noKey(String)
    /// The platform cannot do it here (no Secure Enclave, no biometrics…).
    case unavailable(String)
    /// A file could not be read or written.
    case io(String)
    /// The user cancelled (a biometric prompt).
    case cancelled

    var description: String {
        switch self {
        case .locked: "locked"
        case .damaged(let what): "damaged: \(what)"
        case .keychain(let status): "keychain status \(status)"
        case .noKey(let name): "no key \(name)"
        case .unavailable(let what): "unavailable: \(what)"
        case .io(let what): "io: \(what)"
        case .cancelled: "cancelled"
        }
    }
}

final class SecretBytes: @unchecked Sendable {
    private let lock = NSLock()
    private var buffer: UnsafeMutableRawBufferPointer?
    let count: Int

    /// Takes a copy of the bytes (the caller wipes its own copy).
    init(_ data: Data) {
        count = data.count
        let b = UnsafeMutableRawBufferPointer.allocate(byteCount: max(1, count), alignment: 16)
        b.initializeMemory(as: UInt8.self, repeating: 0)
        data.withUnsafeBytes { src in
            if let base = src.baseAddress, count > 0 { b.baseAddress!.copyMemory(from: base, byteCount: count) }
        }
        buffer = b
    }

    /// Fresh random key material.
    convenience init(random count: Int) {
        var d = Bytes.random(count)
        self.init(d)
        Bytes.wipe(&d)
    }

    deinit { wipe() }

    /// Zeroed: every operation with it fails from now on (SecurityError.locked).
    var isWiped: Bool { lock.withLock { buffer == nil } }

    /// Zeroes the bytes (idempotent).
    func wipe() {
        lock.withLock {
            guard let b = buffer else { return }
            if let base = b.baseAddress { _ = memset_s(base, b.count, 0, b.count) }
            b.deallocate()
            buffer = nil
        }
    }

    /// The bytes for the duration of the closure (under the lock, so a wipe waits for it).
    func withBytes<R>(_ body: (UnsafeRawBufferPointer) throws -> R) throws -> R {
        try lock.withLock {
            guard let b = buffer else { throw SecurityError.locked }
            return try body(UnsafeRawBufferPointer(start: b.baseAddress, count: count))
        }
    }

    /// A CryptoKit key of these bytes (CryptoKit keeps and zeroes its own copy).
    func symmetricKey() throws -> SymmetricKey {
        try withBytes { SymmetricKey(data: $0) }
    }

    /// An independent copy (a file writer keeps its own, zeroed when it is done — a lock meanwhile does not cut it).
    func copy() throws -> SecretBytes {
        try withBytes { raw in
            var d = Data(raw)
            defer { Bytes.wipe(&d) }
            return SecretBytes(d)
        }
    }

    /// The bytes as Data — only where an API needs Data (the caller wipes it).
    func data() throws -> Data { try withBytes { Data($0) } }

    /// Constant-time comparison with other bytes.
    func same(as other: Data) -> Bool {
        (try? withBytes { Bytes.same(Data($0), other) }) ?? false
    }
}

/// Byte helpers, as Android's Crypto (base64 with padding for binary fields,
/// base64url without padding for identifiers — docs/android-architecture.md § 1).
enum Bytes {
    static func random(_ n: Int) -> Data {
        var d = Data(count: n)
        let status = d.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, n, $0.baseAddress!) }
        precondition(status == errSecSuccess, "no system randomness")
        return d
    }

    /// Zeroes and empties a Data (its buffer, when this is its only owner).
    static func wipe(_ d: inout Data) {
        d.withUnsafeMutableBytes { raw in
            if let base = raw.baseAddress { _ = memset_s(base, raw.count, 0, raw.count) }
        }
        d = Data()
    }

    static func wipe(_ a: inout [UInt8]) {
        a.withUnsafeMutableBytes { raw in
            if let base = raw.baseAddress { _ = memset_s(base, raw.count, 0, raw.count) }
        }
        a.removeAll()
    }

    /// Constant time for equal lengths (Android MessageDigest.isEqual).
    static func same(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count { diff |= a[a.startIndex + i] ^ b[b.startIndex + i] }
        return diff == 0
    }

    /// A copy that starts at index 0 (a slice of a Data keeps its parent's indices).
    static func fresh(_ d: Data) -> Data { d.withUnsafeBytes { Data($0) } }

    static func utf8(_ s: String) -> Data { Data(s.utf8) }
    static func str(_ d: Data) -> String? { String(data: d, encoding: .utf8) }

    static func b64(_ d: Data) -> String { d.base64EncodedString() }

    /// Standard base64; padding optional (as Java's decoder), anything else outside the alphabet refused.
    static func unb64(_ s: String) -> Data? {
        var t = s
        if t.contains("-") || t.contains("_") { return nil }
        let rem = t.count % 4
        if rem == 1 { return nil }
        if rem > 0 && !t.hasSuffix("=") { t += String(repeating: "=", count: 4 - rem) }
        return Data(base64Encoded: t)
    }

    static func b64url(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func unb64url(_ s: String) -> Data? {
        if s.contains("+") || s.contains("/") { return nil }
        return unb64(s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/"))
    }

    static func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

    static func unhex(_ s: String) -> Data? {
        guard s.count % 2 == 0 else { return nil }
        var out = Data(capacity: s.count / 2)
        var i = s.startIndex
        while i < s.endIndex {
            let j = s.index(i, offsetBy: 2)
            guard let b = UInt8(s[i..<j], radix: 16) else { return nil }
            out.append(b)
            i = j
        }
        return out
    }

    static func u32be(_ v: UInt32) -> Data { Data([UInt8(v >> 24 & 0xff), UInt8(v >> 16 & 0xff), UInt8(v >> 8 & 0xff), UInt8(v & 0xff)]) }
}
