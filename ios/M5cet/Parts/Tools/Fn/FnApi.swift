// The HTTP side of the server's app APIs (/api/functions, /api/ai, /api/speech,
// /api/client-config) — a port of android/…/fn/Api.java: JSON requests and
// Server-Sent Events over a POST. The caller's account is the Authorization
// header — "Bearer …", or nothing for a guest. No redirects are followed (a
// redirect would carry the account's token elsewhere), no cookies, no cache.
//
// The bytes come through `FnTransport` (URLSession in the app, a fake in the
// tests); a stream's events are parsed off the main actor and delivered on it
// in their order. A cancelled call delivers nothing more.

import Foundation
import M5Core
import M5Net
import M5Proto

/// Why a call failed: the HTTP status (0: no answer), the server's code ("" when it gave none) and its message (Api.Failure).
struct FnFailure: Error, Equatable, Sendable {
    let status: Int
    let code: String
    let message: String

    init(_ status: Int, _ code: String, _ message: String) {
        self.status = status
        self.code = code
        self.message = message
    }

    /// A connection that broke or never came up.
    static func network(_ message: String) -> FnFailure { FnFailure(0, "network", message) }
}

/// One request as the transport sends it.
struct FnRequest: Sendable, Equatable {
    var method: String
    var url: URL
    var headers: [String: String]
    var body: Data?
    /// Seconds of silence before the connection counts as dead (Android's read timeout).
    var timeout: TimeInterval
}

/// The head of an answer: its status and content type.
struct FnHead: Sendable, Equatable {
    let status: Int
    let contentType: String
}

/// An answer whose body is read as it comes.
struct FnOpened: Sendable {
    let head: FnHead
    /// The body in the pieces the network gave; ends (or throws) with the connection. Dropping it cancels the request.
    let body: AsyncThrowingStream<Data, any Error>
}

/// Where the bytes go: URLSession in the app, a fake in the tests.
protocol FnTransport: Sendable {
    /// Sends the request; returns once the answer's head is there (any status). Throws only when no answer came.
    func open(_ request: FnRequest) async throws -> FnOpened
}

/// A call in flight (Api.Call); cancel() closes its connection and nothing more is delivered.
final class FnCall: @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<Void, Never>?
    private var isCancelled = false

    init() {}

    func attach(_ t: Task<Void, Never>) {
        lock.lock()
        task = t
        let c = isCancelled
        lock.unlock()
        if c { t.cancel() }
    }

    func cancel() {
        lock.lock()
        isCancelled = true
        let t = task
        lock.unlock()
        t?.cancel()
    }

    var cancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return isCancelled
    }
}

/// What a stream delivers, on the main actor: events, then either the end or a failure (Api.Stream).
@MainActor
protocol FnStreamSink: AnyObject, Sendable {
    func event(_ name: String, _ data: JSONObject)
    func end()
    func fail(_ failure: FnFailure)
}

/// The server's app APIs at one origin (Api).
struct FnApi: Sendable {
    /// One answer may be this large (a run's outputs come in one piece).
    static let maxJSON = 64 << 20

    let base: String
    let transport: any FnTransport
    let userAgent: String

    init(base: String, transport: any FnTransport, userAgent: String = M5NetInfo.userAgent) {
        self.base = base
        self.transport = transport
        self.userAgent = userAgent
    }

    /// base + path (Api.url): white space and trailing slashes of the base dropped.
    static func url(_ base: String, _ path: String) -> String {
        var b = base.trimmingCharacters(in: .whitespacesAndNewlines)
        while b.hasSuffix("/") { b.removeLast() }
        return b + path
    }

    /// The Authorization header's value for what the account gives ("" = none): "Bearer …" as it is, a bare token prefixed.
    static func authorization(_ bearer: String) -> String? {
        let b = bearer.trimmingCharacters(in: .whitespaces)
        if b.isEmpty { return nil }
        return b.hasPrefix("Bearer ") ? b : "Bearer " + b
    }

    func request(_ method: String, _ path: String, bearer: String, body: Data?, contentType: String?, accept: String, timeout: TimeInterval) throws -> FnRequest {
        guard let url = URL(string: Self.url(base, path)), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http", url.host != nil else {
            throw FnFailure.network("not an address: " + Self.url(base, path))
        }
        var h = ["User-Agent": userAgent, "Accept": accept]
        if let auth = Self.authorization(bearer) { h["Authorization"] = auth }
        if body != nil, let contentType { h["Content-Type"] = contentType }
        return FnRequest(method: method, url: url, headers: h, body: body, timeout: timeout)
    }

    // MARK: JSON

    /// A JSON request (body nil: GET); a 2xx answer with ok: false is a failure too (Api.json).
    func json(_ path: String, bearer: String, body: JSONObject? = nil) async -> Result<JSONObject, FnFailure> {
        let raw = body.map { Data(JSON.object($0).stringify().utf8) }
        return await call(body == nil ? "GET" : "POST", path, bearer: bearer, body: raw, contentType: "application/json", timeout: 60)
    }

    /// Raw bytes up (audio), a JSON answer back (Api.request).
    func call(_ method: String, _ path: String, bearer: String, body: Data?, contentType: String, timeout: TimeInterval) async -> Result<JSONObject, FnFailure> {
        do {
            let req = try request(method, path, bearer: bearer, body: body, contentType: contentType, accept: "application/json", timeout: timeout)
            let opened = try await transport.open(req)
            let status = opened.head.status
            if status < 200 || status >= 300 { return .failure(await Self.refusal(opened, status)) }
            let data = try await Self.readAll(opened.body, max: Self.maxJSON)
            guard let text = String(data: data, encoding: .utf8), case .object(let o)? = try? Js.parse(text) else {
                return .failure(FnFailure(status, "bad-answer", "not a JSON answer"))
            }
            if case .bool(false)? = o["ok"] {
                return .failure(FnFailure(status, o.string("code") ?? "", o.string("message") ?? "HTTP \(status)"))
            }
            return .success(o)
        } catch let f as FnFailure {
            return .failure(f)
        } catch {
            return .failure(Self.network(error))
        }
    }

    // MARK: streams

    /// POSTs body as JSON asking for an event stream (Api.stream). An answer that is not 2xx or not
    /// text/event-stream is a failure with the server's code and message; a connection that breaks is "network".
    @MainActor
    func stream(_ path: String, bearer: String, body: JSONObject, sink: any FnStreamSink) -> FnCall {
        let call = FnCall()
        let raw = Data(JSON.object(body).stringify().utf8)
        let req: FnRequest
        do {
            // The server pings every 15 s: a minute of silence is a dead connection.
            req = try request("POST", path, bearer: bearer, body: raw, contentType: "application/json", accept: "text/event-stream", timeout: 60)
        } catch {
            let f = (error as? FnFailure) ?? Self.network(error)
            Task { @MainActor in if !call.cancelled { sink.fail(f) } }
            return call
        }
        let transport = self.transport
        let task = Task.detached(priority: .userInitiated) {
            func deliver(_ f: @escaping @MainActor @Sendable () -> Void) async {
                if call.cancelled || Task.isCancelled { return }
                await MainActor.run { if !call.cancelled { f() } }
            }
            do {
                let opened = try await transport.open(req)
                let status = opened.head.status
                if status < 200 || status >= 300 || !opened.head.contentType.contains("event-stream") {
                    let f = await Self.refusal(opened, status)
                    await deliver { sink.fail(f) }
                    return
                }
                var parser = FnSse()
                for try await chunk in opened.body {
                    if call.cancelled { return }
                    let events = try parser.feed(chunk)
                    for (name, data) in events { await deliver { sink.event(name, data) } }
                }
                if call.cancelled || Task.isCancelled { return }
                await deliver { sink.end() }
            } catch {
                if call.cancelled || Task.isCancelled { return }
                let f = (error as? FnFailure) ?? Self.network(error)
                await deliver { sink.fail(f) }
            }
        }
        call.attach(task)
        return call
    }

    // MARK: helpers

    static func readAll(_ body: AsyncThrowingStream<Data, any Error>, max: Int) async throws -> Data {
        var out = Data()
        for try await chunk in body {
            out.append(chunk)
            if out.count > max { throw FnFailure.network("the answer is too large") }
        }
        return out
    }

    /// The server's refusal: { ok: false, code, message } when it says so, else "HTTP <status>".
    static func refusal(_ opened: FnOpened, _ status: Int) async -> FnFailure {
        var code = ""
        var message = "HTTP \(status)"
        if let data = try? await readAll(opened.body, max: 1 << 20), let text = String(data: data, encoding: .utf8),
           case .object(let o)? = try? Js.parse(text) {
            if let c = o.string("code") { code = c }
            if let m = o.string("message"), !m.isEmpty { message = m }
        }
        return FnFailure(status, code, message)
    }

    static func network(_ error: any Error) -> FnFailure {
        if let f = error as? FnFailure { return f }
        if let u = error as? URLError { return .network(u.localizedDescription) }
        return .network(String(describing: error))
    }
}

/* ------------------------------------------------------------ URLSession */

/// URLSession under the calls: ephemeral (no cookies, no cache, no credentials), redirects never followed,
/// the body handed on in the pieces it arrives in (a stream may stay open for minutes).
final class FnURLSessionTransport: NSObject, FnTransport, URLSessionDataDelegate, @unchecked Sendable {
    private struct Pending {
        var head: CheckedContinuation<FnHead, any Error>?
        let body: AsyncThrowingStream<Data, any Error>.Continuation
    }

    private let lock = NSLock()
    private var pending: [Int: Pending] = [:]
    private var session: URLSession!

    init(configuration: URLSessionConfiguration = .ephemeral) {
        super.init()
        let c = configuration
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.urlCredentialStorage = nil
        c.urlCache = nil
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest = 60
        session = URLSession(configuration: c, delegate: self, delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    func open(_ request: FnRequest) async throws -> FnOpened {
        var r = URLRequest(url: request.url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: request.timeout)
        r.httpMethod = request.method
        r.httpShouldHandleCookies = false
        for (k, v) in request.headers { r.setValue(v, forHTTPHeaderField: k) }
        if request.method != "GET" { r.httpBody = request.body }
        let (body, continuation) = AsyncThrowingStream<Data, any Error>.makeStream(bufferingPolicy: .unbounded)
        let task = session.dataTask(with: r)
        let id = task.taskIdentifier
        continuation.onTermination = { _ in task.cancel() }
        let head: FnHead = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<FnHead, any Error>) in
                lock.lock()
                pending[id] = Pending(head: c, body: continuation)
                lock.unlock()
                task.resume()
            }
        } onCancel: {
            task.cancel()
        }
        return FnOpened(head: head, body: body)
    }

    private func take(_ id: Int, _ f: (inout Pending) -> Void) {
        lock.lock()
        if var p = pending[id] { f(&p); pending[id] = p }
        lock.unlock()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
        let http = response as? HTTPURLResponse
        let head = FnHead(status: http?.statusCode ?? 0, contentType: http?.value(forHTTPHeaderField: "Content-Type") ?? "")
        var c: CheckedContinuation<FnHead, any Error>?
        take(dataTask.taskIdentifier) { p in c = p.head; p.head = nil }
        c?.resume(returning: head)
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        let p = pending[dataTask.taskIdentifier]
        lock.unlock()
        p?.body.yield(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        lock.lock()
        let p = pending.removeValue(forKey: task.taskIdentifier)
        lock.unlock()
        guard let p else { return }
        if let head = p.head {
            head.resume(throwing: FnApi.network(error ?? URLError(.badServerResponse)))
        }
        if let error { p.body.finish(throwing: FnApi.network(error)) } else { p.body.finish() }
    }

    /// A redirect is the answer itself (its 3xx status): the token never goes to another address.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
