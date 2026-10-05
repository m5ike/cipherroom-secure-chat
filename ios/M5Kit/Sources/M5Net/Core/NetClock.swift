// The wire's time: milliseconds since 1970 and the clock the network layer
// reads. The byte helpers it uses (`Bytes.b64`, `Bytes.unb64`, `Bytes.hex`,
// `Bytes.same`, … for `Data`) are M5Core's; `Bytes.sha256` and `Bytes.random`
// are M5Crypto's.

import Foundation

/// Milliseconds since 1970, the wire's time unit.
public typealias Millis = Int64

/// The clock the network layer reads (tests replace it).
public struct NetClock: Sendable {
    public let now: @Sendable () -> Millis
    public init(now: @escaping @Sendable () -> Millis) { self.now = now }
    public static let system = NetClock { Millis((Date().timeIntervalSince1970 * 1000).rounded()) }
}
