// Fixture builders for the M5NFC tests — the JVM tests' Tlvs.java helpers and
// the repository files they read (docs/ios-architecture.md § 6: relative to #filePath).

import Foundation
@testable import M5NFC
import M5Core

enum Repo {
    /// The repository root: Tests/M5NFCTests/Support.swift → ../../../../
    static let root: URL = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    static func data(_ path: String) throws -> Data { try Data(contentsOf: root.appendingPathComponent(path)) }
    static func json(_ path: String) throws -> NfcJSON { try NfcJSON.parse(try data(path)) }
    static func text(_ path: String) throws -> String { String(decoding: try data(path), as: UTF8.self) }
}

func b(_ h: String) -> [UInt8] { Hex.decodeLenient(h) }
func H(_ u: [UInt8]) -> String { Hex.upper(u) }
func ascii(_ s: String) -> [UInt8] { Bytes.latin1(s) }
func u8(_ v: Int...) -> [UInt8] { v.map { UInt8(truncatingIfNeeded: $0) } }
func fill(_ n: Int, _ v: Int) -> [UInt8] { [UInt8](repeating: UInt8(v), count: n) }

/// Tag (1–3 bytes) + DER length + the concatenated values (Tlvs.T).
func T(_ tag: Int, _ values: [UInt8]...) -> [UInt8] {
    let v = values.flatMap { $0 }
    var w = [UInt8]()
    if tag > 0xffff { w.append(UInt8((tag >> 16) & 0xff)) }
    if tag > 0xff { w.append(UInt8((tag >> 8) & 0xff)) }
    w.append(UInt8(tag & 0xff))
    let n = v.count
    if n < 0x80 { w.append(UInt8(n)) }
    else if n <= 0xff { w += [0x81, UInt8(n)] }
    else if n <= 0xffff { w += [0x82, UInt8(n >> 8), UInt8(n & 0xff)] }
    else { w += [0x83, UInt8(n >> 16), UInt8((n >> 8) & 0xff), UInt8(n & 0xff)] }
    return w + v
}

func oid(_ dotted: String) -> [UInt8] { T(0x06, Asn1.oidBytes(dotted)) }
func integer(_ n: Int) -> [UInt8] { T(0x02, [UInt8(n & 0xff)]) }
func ok(_ resp: [UInt8]) -> [UInt8] { resp + [0x90, 0x00] }
func sw(_ s: Int) -> [UInt8] { [UInt8((s >> 8) & 0xff), UInt8(s & 0xff)] }

/// A channel from a closure (the Java tests' lambda transceivers).
final class FnCard: ApduChannel {
    let fn: ([UInt8]) throws -> [UInt8]
    init(_ fn: @escaping ([UInt8]) throws -> [UInt8]) { self.fn = fn }
    func transmit(_ apdu: [UInt8]) async throws -> [UInt8] { try fn(apdu) }
}

/// Errors a simulated card throws (the JVM tests' IOException / AssertionError).
struct CardFailure: Error, LocalizedError { let message: String; var errorDescription: String? { message } }

/// A value shared with @Sendable callbacks (progress lists, the runner a callback cancels).
final class Locked<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T
    init(_ v: T) { value = v }
    func with<R>(_ f: (inout T) -> R) -> R { lock.lock(); defer { lock.unlock() }; return f(&value) }
}

/// Every key at any depth of a JSON value.
func keysOf(_ v: NfcJSON) -> [String] {
    switch v {
    case .object(let o): return o.entries.flatMap { [$0.key] + keysOf($0.value) }
    case .array(let a): return a.flatMap(keysOf)
    default: return []
    }
}
