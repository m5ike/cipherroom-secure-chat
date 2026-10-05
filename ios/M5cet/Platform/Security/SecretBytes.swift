// Secret key material that is zeroed in place, and the few byte helpers the
// platform layer adds to M5Core's (`Bytes` = [UInt8] and its `Bytes.b64 / unb64 /
// hex / same / random …` for Data are M5Core's and M5Crypto's — one owner per name).
//
// A data key (DEK) lives in one SecretBytes: readers share the instance, so
// Vault.lock() zeroes it for everyone — as Android zeroes the one array it
// handed out (6.12, F-16). Swift's Data is copy-on-write and cannot be zeroed
// reliably; SecretBytes owns its buffer and memset_s-es it on wipe and deinit.

import CryptoKit
import Foundation
import M5Core
import M5Crypto
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

    /// Takes a copy of M5Kit's bytes (the caller wipes its own copy: `ByteOps.wipe`).
    convenience init(bytes: Bytes) {
        var d = Data(bytes)
        self.init(d)
        SecData.wipe(&d)
    }

    /// Fresh random key material.
    convenience init(random count: Int) {
        var d = Bytes.random(count)
        self.init(d)
        SecData.wipe(&d)
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
            defer { SecData.wipe(&d) }
            return SecretBytes(d)
        }
    }

    /// The bytes as Data — only where an API needs Data (the caller wipes it).
    func data() throws -> Data { try withBytes { Data($0) } }

    /// The bytes as M5Kit's `Bytes`, for M5Crypto's formats (PinWrap, LockBox) — the caller wipes them
    /// (`ByteOps.wipe`; a Swift array is a value, so this is best effort, as M5Crypto's own keys).
    func bytes() throws -> Bytes { try withBytes { Array($0) } }

    /// Constant-time comparison with other bytes.
    func same(as other: Data) -> Bool {
        (try? withBytes { Bytes.same(Data($0), other) }) ?? false
    }
}

/// What the platform layer adds to M5Core's byte helpers: zeroing `Data`, a zero-based copy,
/// UTF-8 as `Data` (M5Core's `Bytes.utf8` gives `[UInt8]`), a big-endian u32 as `Data`.
enum SecData {
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

    /// A copy that starts at index 0 (a slice of a Data keeps its parent's indices).
    static func fresh(_ d: Data) -> Data { d.withUnsafeBytes { Data($0) } }

    static func utf8(_ s: String) -> Data { Data(s.utf8) }
    static func str(_ d: Data) -> String? { String(data: d, encoding: .utf8) }

    static func u32be(_ v: UInt32) -> Data { Data(ByteOps.be32(v)) }

    /// A JSON object's text as Data (M5Core's `stringify`, JavaScript's JSON.stringify output).
    static func json(_ o: JSONObject) -> Data { Data(o.stringify().utf8) }

    /// A JSON object from Data; nil when it is not one.
    static func json(_ d: Data) -> JSONObject? { JSON.parseObject(String(decoding: d, as: UTF8.self)) }
}
