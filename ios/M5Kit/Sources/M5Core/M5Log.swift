// A small log that never writes secrets (android core/Log.java's rule): what
// it is given goes through `redact` — long base64 / hex runs (keys,
// ciphertexts, tokens), passphrase-like assignments and e-mail addresses are
// replaced before anything is kept or printed. Messages are kept in a ring
// (the app's "diagnostics" view) and optionally forwarded to a sink (os.Logger
// in the app).

import Foundation
import Synchronization

public enum M5LogLevel: Int, Sendable, Comparable {
    case debug = 0, info, warn, error
    public static func < (a: M5LogLevel, b: M5LogLevel) -> Bool { a.rawValue < b.rawValue }
    public var tag: String { ["D", "I", "W", "E"][rawValue] }
}

public struct M5LogEntry: Sendable, Equatable {
    public let at: Int64
    public let level: M5LogLevel
    public let area: String
    public let message: String
}

public final class M5Log: Sendable {
    public static let shared = M5Log()

    private struct State {
        var ring: [M5LogEntry] = []
        var minimum: M5LogLevel = .info
        var sink: (@Sendable (M5LogEntry) -> Void)?
    }

    private let state = Mutex(State())
    private let capacity: Int
    private let clock: any Clock

    public init(capacity: Int = 500, clock: any Clock = SystemClock()) {
        self.capacity = max(1, capacity)
        self.clock = clock
    }

    public func setMinimum(_ level: M5LogLevel) { state.withLock { $0.minimum = level } }
    public func setSink(_ sink: (@Sendable (M5LogEntry) -> Void)?) { state.withLock { $0.sink = sink } }

    public func log(_ level: M5LogLevel, _ area: String, _ message: @autoclosure () -> String) {
        let keep = state.withLock { level >= $0.minimum }
        guard keep else { return }
        let entry = M5LogEntry(at: clock.now(), level: level, area: M5Log.redact(area), message: M5Log.redact(message()))
        let sink: (@Sendable (M5LogEntry) -> Void)? = state.withLock { s in
            s.ring.append(entry)
            if s.ring.count > capacity { s.ring.removeFirst(s.ring.count - capacity) }
            return s.sink
        }
        sink?(entry)
    }

    public func debug(_ area: String, _ m: @autoclosure () -> String) { log(.debug, area, m()) }
    public func info(_ area: String, _ m: @autoclosure () -> String) { log(.info, area, m()) }
    public func warn(_ area: String, _ m: @autoclosure () -> String) { log(.warn, area, m()) }
    public func error(_ area: String, _ m: @autoclosure () -> String) { log(.error, area, m()) }

    /// What was logged, oldest first.
    public func entries() -> [M5LogEntry] { state.withLock { $0.ring } }
    public func clear() { state.withLock { $0.ring.removeAll() } }

    /* ------------------------------------------------------------ redaction */

    private static let patterns: [(NSRegularExpression, String)] = {
        func re(_ p: String) -> NSRegularExpression { try! NSRegularExpression(pattern: p, options: [.caseInsensitive]) }
        return [
            // key=value / "key": "value" for anything secret-sounding
            (re(#"((?:pass(?:phrase|word)?|pin|secret|token|key|seed|code|sig|signature|ciphertext|ct|iv|chain|cookie|authorization)["']?\s*[:=]\s*["']?)[^"'\s,;}&]+"#), "$1[redacted]"),
            // e-mail addresses
            (re(#"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}"#), "[email]"),
            // long hex runs (keys, digests)
            (re(#"\b[0-9a-f]{24,}\b"#), "[hex]"),
            // long base64 / base64url runs (keys, ciphertexts, tokens)
            (re(#"[A-Za-z0-9+/_-]{24,}={0,2}"#), "[b64]"),
        ]
    }()

    /// The text with every secret-looking part replaced.
    public static func redact(_ text: String) -> String {
        var out = text
        for (re, template) in patterns {
            out = re.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out), withTemplate: template)
        }
        return out
    }
}
