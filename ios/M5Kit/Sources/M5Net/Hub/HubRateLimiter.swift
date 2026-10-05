// The hub's rate limits, mirrored on the client (server/signaling/limits.ts).
//
// Every frame type belongs to a class with its own token bucket per socket;
// a socket that keeps hitting its limits is closed (20 violations a minute).
// The client keeps the same buckets so it never earns a refusal: a frame over
// its class's budget is not sent (HubSendResult.throttled with the wait), and
// a `rate-limited` answer from the server blocks that class until its
// `retryAfterMs` has passed.

import Foundation

public enum HubLimitClass: String, Sendable, CaseIterable {
    case signaling, relay, receipt, presence, storage, proxy, heartbeat, command, directory, other

    /// limits.ts limitClassOf.
    public static func of(_ type: String) -> HubLimitClass {
        switch type {
        case "join", "leave", "signal", "auth": return .signaling
        case "relay", "relay-ack": return .relay
        case "receipt": return .receipt
        case "presence": return .presence
        case "storage": return .storage
        case "ping": return .heartbeat
        case "command-poll", "command-ack": return .command
        case "key-bundles", "kt-lookup": return .directory
        default: return type.hasPrefix("proxy-") ? .proxy : .other
        }
    }

    /// capacity = burst, refill = tokens per second (limits.ts LIMITS).
    public var limit: (capacity: Double, refillPerSec: Double) {
        switch self {
        case .signaling: return (120, 10)
        case .relay: return (60, 2)
        case .receipt: return (30, 1)
        case .presence: return (10, 0.2)
        case .storage: return (120, 10)
        case .proxy: return (400, 60)
        case .heartbeat: return (6, 0.5)
        case .command: return (20, 0.5)
        case .directory: return (60, 2)
        case .other: return (30, 1)
        }
    }
}

/// Token buckets per class (and the proxy's byte budget), and the server's blocks.
public struct HubRateLimiter: Sendable {
    /// Bytes per second through the file proxy (limits.ts PROXY_BYTES).
    public static let proxyBytes = (capacity: 8.0 * 1024 * 1024, refillPerSec: 2.0 * 1024 * 1024)

    private var tokens: [HubLimitClass: (tokens: Double, at: Millis)] = [:]
    private var proxyBudget: (tokens: Double, at: Millis)?
    private var blocked: [HubLimitClass: Millis] = [:]

    public init() {}

    /// Takes a token (and `bytes` of the proxy budget); nil when allowed, else the wait in ms.
    public mutating func allow(_ cls: HubLimitClass, bytes: Int = 0, now: Millis) -> Millis? {
        if let until = blocked[cls], until > now { return until - now }
        let (cap, rate) = cls.limit
        var b = tokens[cls] ?? (cap, now)
        b.tokens = min(cap, b.tokens + Double(max(0, now - b.at)) / 1000 * rate)
        b.at = now
        guard b.tokens >= 1 else {
            tokens[cls] = b
            return Millis(((1 - b.tokens) / rate * 1000).rounded(.up))
        }
        if cls == .proxy, bytes > 0 {
            let (bcap, brate) = Self.proxyBytes
            var p = proxyBudget ?? (bcap, now)
            p.tokens = min(bcap, p.tokens + Double(max(0, now - p.at)) / 1000 * brate)
            p.at = now
            guard p.tokens >= Double(bytes) else {
                proxyBudget = p
                tokens[cls] = b
                return Millis(((Double(bytes) - p.tokens) / brate * 1000).rounded(.up))
            }
            p.tokens -= Double(bytes)
            proxyBudget = p
        }
        b.tokens -= 1
        tokens[cls] = b
        return nil
    }

    /// The server said `rate-limited` for a frame of this class: nothing of it until `until`.
    public mutating func block(_ cls: HubLimitClass, until: Millis) {
        blocked[cls] = max(blocked[cls] ?? 0, until)
    }

    /// A fresh socket: fresh buckets (the server's are per socket).
    public mutating func reset() {
        tokens = [:]
        proxyBudget = nil
        blocked = [:]
    }
}
