// Byte helpers the wire needs: base64 (standard, url-safe), hex, SHA-256,
// random bytes — the same encodings the server (Node Buffer) and the Android
// app (Crypto.b64 / b64url) write.

import CryptoKit
import Foundation
import Security

public enum Bytes {
    /// Standard base64 with padding (Buffer.toString("base64")).
    public static func b64(_ data: Data) -> String { data.base64EncodedString() }

    /// base64url without padding (Buffer.toString("base64url")).
    public static func b64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Standard base64 (padding optional); nil when it is not base64.
    public static func unb64(_ s: String) -> Data? {
        let t = s.trimmingCharacters(in: .whitespaces)
        guard t.range(of: "^[A-Za-z0-9+/]*={0,2}$", options: .regularExpression) != nil else { return nil }
        var padded = t
        while padded.count % 4 != 0 { padded += "=" }
        return Data(base64Encoded: padded)
    }

    /// base64url (padding tolerated); nil when it is not base64url.
    public static func unb64url(_ s: String) -> Data? {
        let t = s.replacingOccurrences(of: "=", with: "")
        guard t.range(of: "^[A-Za-z0-9_-]*$", options: .regularExpression) != nil, t.count % 4 != 1 else { return nil }
        var std = t.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while std.count % 4 != 0 { std += "=" }
        return Data(base64Encoded: std)
    }

    /// Either alphabet (what Buffer.from(x, "base64") accepts in practice).
    public static func unb64any(_ s: String) -> Data? { unb64(s) ?? unb64url(s) }

    public static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    public static func unhex(_ s: String) -> Data? {
        let t = Array(s.utf8)
        guard t.count % 2 == 0 else { return nil }
        var out = Data(capacity: t.count / 2)
        var i = 0
        while i < t.count {
            guard let hi = nibble(t[i]), let lo = nibble(t[i + 1]) else { return nil }
            out.append(hi << 4 | lo)
            i += 2
        }
        return out
    }

    private static func nibble(_ c: UInt8) -> UInt8? {
        switch c {
        case 0x30...0x39: return c - 0x30
        case 0x41...0x46: return c - 0x41 + 10
        case 0x61...0x66: return c - 0x61 + 10
        default: return nil
        }
    }

    public static func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }
    public static func sha256(_ text: String) -> Data { sha256(Data(text.utf8)) }

    /// Cryptographically random bytes (SecRandomCopyBytes).
    public static func random(_ count: Int) -> Data {
        var d = Data(count: count)
        let ok = d.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!) }
        precondition(ok == errSecSuccess, "no system randomness")
        return d
    }

    /// Constant-time equality.
    public static func same(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count { diff |= a[a.startIndex + i] ^ b[b.startIndex + i] }
        return diff == 0
    }

    public static func same(_ a: String, _ b: String) -> Bool { same(Data(a.utf8), Data(b.utf8)) }

    /// Big-endian u32 at `at` (nil when out of range).
    static func be32(_ d: Data, _ at: Int) -> UInt32? {
        guard at >= 0, at + 4 <= d.count else { return nil }
        let s = d.startIndex + at
        return UInt32(d[s]) << 24 | UInt32(d[s + 1]) << 16 | UInt32(d[s + 2]) << 8 | UInt32(d[s + 3])
    }
}

/// Milliseconds since 1970, the wire's time unit.
public typealias Millis = Int64

/// The clock the network layer reads (tests replace it).
public struct NetClock: Sendable {
    public let now: @Sendable () -> Millis
    public init(now: @escaping @Sendable () -> Millis) { self.now = now }
    public static let system = NetClock { Millis((Date().timeIntervalSince1970 * 1000).rounded()) }
}
