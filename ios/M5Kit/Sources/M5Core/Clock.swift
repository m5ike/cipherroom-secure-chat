// Time as the protocol counts it: milliseconds since the Unix epoch (Int64),
// injectable so tests and replays run at a fixed time.

import Foundation
import Synchronization

public protocol Clock: Sendable {
    /// Milliseconds since 1970-01-01T00:00:00Z.
    func now() -> Int64
}

/// The device's wall clock.
public struct SystemClock: Clock {
    public init() {}
    public func now() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded(.down)) }
}

/// A clock that says what it is told (tests).
public final class ManualClock: Clock {
    private let value: Mutex<Int64>
    public init(_ at: Int64) { value = Mutex(at) }
    public func now() -> Int64 { value.withLock { $0 } }
    public func set(_ at: Int64) { value.withLock { $0 = at } }
    public func advance(_ ms: Int64) { value.withLock { $0 += ms } }
}

/// A clock given as a closure.
public struct ClosureClock: Clock {
    private let f: @Sendable () -> Int64
    public init(_ f: @escaping @Sendable () -> Int64) { self.f = f }
    public func now() -> Int64 { f() }
}
