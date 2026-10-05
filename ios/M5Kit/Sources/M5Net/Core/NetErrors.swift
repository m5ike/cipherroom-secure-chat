// What can go wrong on the wire, as the app needs to tell it apart:
// the server answered with an error (status, its code and message — Android's
// Server.HttpError), there was no usable answer (network), or a check of the
// answer failed (a signature, a pin, a hash — never retried blindly).

import Foundation

/// The server answered with a non-2xx status. `code` and `message` come from its JSON body
/// ({ ok:false, code, message }); `body` is the whole answer (6.4: a form's per-field `errors`).
public struct HTTPError: Error, Sendable, CustomStringConvertible {
    public let status: Int
    public let code: String
    public let message: String
    public let body: NetJSON
    /// Retry-After (seconds) when the server sent one (429).
    public let retryAfter: Int?

    public init(status: Int, code: String = "", message: String = "", body: NetJSON = .object([:]), retryAfter: Int? = nil) {
        self.status = status
        self.code = code
        self.message = message.isEmpty ? "HTTP \(status)" : message
        self.body = body
        self.retryAfter = retryAfter
    }

    public var description: String { "HTTP \(status)\(code.isEmpty ? "" : " \(code)"): \(message)" }
}

public enum NetError: Error, Sendable, Equatable, CustomStringConvertible {
    /// No answer at all (DNS, TLS, timeout, connection lost) — the server may or may not have acted.
    case network(String)
    /// An answer that is not what the API returns (not JSON, a field missing).
    case badAnswer(String)
    /// The answer is larger than allowed for this call.
    case tooLarge(Int)
    /// A security check failed: a signature, a pin, a hash, a key that changed — the operation stops.
    case security(String)
    /// The call cannot be made in this state (not enrolled, not signed in, no socket).
    case unavailable(String)
    /// A malformed argument (a server address, a frame field).
    case invalid(String)

    public var description: String {
        switch self {
        case .network(let m): return "network: \(m)"
        case .badAnswer(let m): return "bad answer: \(m)"
        case .tooLarge(let n): return "the answer is too large (\(n) bytes)"
        case .security(let m): return m
        case .unavailable(let m): return m
        case .invalid(let m): return m
        }
    }
}
