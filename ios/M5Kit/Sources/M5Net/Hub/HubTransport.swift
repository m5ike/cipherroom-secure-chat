// The WebSocket under the hub client. A protocol, so tests run the hub logic
// against an in-memory server and the watch can use another channel; the
// implementation is URLSessionWebSocketTask (Android wrote its own RFC 6455
// client, net/WebSocket — URLSession does TLS, SNI, hostname checks, ping
// answers and fragmentation itself). No Origin header is sent: the hub
// admits native clients without one (hub.ts originAllowed).

import Foundation
import Synchronization

public enum HubMessage: Sendable, Equatable {
    case text(String)
    case binary(Data)
}

/// The connection ended: the close code the peer sent (1006 when it dropped without one) and its reason.
public struct HubSocketClosed: Error, Sendable, Equatable {
    public let code: Int
    public let reason: String
    public init(code: Int, reason: String) {
        self.code = code
        self.reason = reason
    }
}

public protocol HubSocket: AnyObject, Sendable {
    func send(_ message: HubMessage) async throws
    /// The next message; throws HubSocketClosed when the connection ended.
    func receive() async throws -> HubMessage
    /// A close frame with this code; receive() ends after it.
    func close(code: Int, reason: String)
    /// Drops the connection at once (a dead connection the keepalive found).
    func abort()
}

public protocol HubTransport: Sendable {
    /// Opens a socket to `url` (wss://host/ws); returns once the WebSocket handshake is done.
    func connect(to url: URL, headers: [String: String], timeout: Duration) async throws -> any HubSocket
}

/* ------------------------------------------------------------ URLSession */

public final class URLSessionHubTransport: HubTransport {
    public init() {}

    public func connect(to url: URL, headers: [String: String], timeout: Duration) async throws -> any HubSocket {
        let socket = URLSessionHubSocket(url: url, headers: headers)
        try await socket.open(timeout: timeout)
        return socket
    }
}

final class URLSessionHubSocket: NSObject, HubSocket, URLSessionWebSocketDelegate, @unchecked Sendable {
    private struct State {
        var opened: CheckedContinuation<Void, any Error>?
        var openDone = false
        var closeCode: Int?
        var closeReason = ""
        var finished = false
    }

    private let state = Mutex(State())
    private let request: URLRequest
    private var session: URLSession!
    private var task: URLSessionWebSocketTask!

    init(url: URL, headers: [String: String]) {
        var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
        request = r
        super.init()
        let c = URLSessionConfiguration.ephemeral
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.urlCache = nil
        session = URLSession(configuration: c, delegate: self, delegateQueue: nil)
        task = session.webSocketTask(with: request)
        // The hub's frames are at most 256 KiB; a little room for a future one.
        task.maximumMessageSize = 1 << 20
    }

    func open(timeout: Duration) async throws {
        let timer = Task { [weak self] in
            try? await Task.sleep(for: timeout)
            self?.finishOpen(NetError.network("the WebSocket did not open in time"))
        }
        defer { timer.cancel() }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, any Error>) in
                state.withLock { $0.opened = c }
                task.resume()
            }
        } onCancel: { [weak self] in
            self?.finishOpen(CancellationError())
        }
    }

    private func finishOpen(_ error: (any Error)?) {
        let c: CheckedContinuation<Void, any Error>? = state.withLock { s in
            guard !s.openDone else { return nil }
            s.openDone = true
            defer { s.opened = nil }
            return s.opened
        }
        guard let c else { return }
        if let error {
            task.cancel()
            session.invalidateAndCancel()
            c.resume(throwing: error)
        } else {
            c.resume()
        }
    }

    func send(_ message: HubMessage) async throws {
        switch message {
        case .text(let t): try await task.send(.string(t))
        case .binary(let d): try await task.send(.data(d))
        }
    }

    func receive() async throws -> HubMessage {
        do {
            switch try await task.receive() {
            case .string(let s): return .text(s)
            case .data(let d): return .binary(d)
            @unknown default: return .binary(Data())
            }
        } catch {
            throw closed()
        }
    }

    private func closed() -> HubSocketClosed {
        let (code, reason) = state.withLock { ($0.closeCode, $0.closeReason) }
        if let code { return HubSocketClosed(code: code, reason: reason) }
        let raw = task.closeCode.rawValue
        let why = task.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        return HubSocketClosed(code: raw == 0 ? 1006 : raw, reason: why)
    }

    func close(code: Int, reason: String) {
        let c = URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure
        task.cancel(with: c, reason: Data(reason.utf8.prefix(120)))
        session.finishTasksAndInvalidate()
    }

    func abort() {
        task.cancel()
        session.invalidateAndCancel()
    }

    /* ------------------------------------------------------- delegate */

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        finishOpen(nil)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        state.withLock {
            $0.closeCode = closeCode.rawValue == 0 ? 1005 : closeCode.rawValue
            $0.closeReason = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        if let http = task.response as? HTTPURLResponse, http.statusCode != 101 {
            finishOpen(NetError.network("the server refused the WebSocket: HTTP \(http.statusCode)"))
        } else {
            finishOpen(error.map { NetError.network("\($0.localizedDescription)") } ?? NetError.network("the WebSocket closed during the handshake"))
        }
        session.finishTasksAndInvalidate()
    }
}
