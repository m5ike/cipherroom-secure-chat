// HTTP for the REST APIs (Android: net/Server.send). One request, one
// answer, a size cap, no redirects followed (a redirect is an answer the app
// sees — the device API is signed for one exact path), no cookies, no cache.
// The transport is a protocol so tests (and the watch, through a relay) can
// put their own under it.

import Foundation

public struct HTTPRequest: Sendable {
    public var method: String
    public var url: URL
    public var headers: [String: String]
    public var body: Data?
    /// Larger answers are refused (NetError.tooLarge).
    public var maxBytes: Int
    public var timeout: TimeInterval

    public init(method: String, url: URL, headers: [String: String] = [:], body: Data? = nil, maxBytes: Int = 1 << 20, timeout: TimeInterval = 60) {
        self.method = method
        self.url = url
        self.headers = headers
        self.body = body
        self.maxBytes = maxBytes
        self.timeout = timeout
    }
}

public struct HTTPResponse: Sendable {
    public let status: Int
    /// Header names in lower case.
    public let headers: [String: String]
    public let body: Data

    public init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
        self.status = status
        var h: [String: String] = [:]
        for (k, v) in headers { h[k.lowercased()] = v }
        self.headers = h
        self.body = body
    }
}

/// Download progress: bytes so far, total (-1 when unknown).
public typealias HTTPProgress = @Sendable (_ done: Int64, _ total: Int64) -> Void

public protocol HTTPTransport: Sendable {
    /// Sends the request; any status is an answer (only a failure to get one throws, as NetError.network / .tooLarge).
    func send(_ request: HTTPRequest, progress: HTTPProgress?) async throws -> HTTPResponse
}

/* ------------------------------------------------------------ URLSession */

/// URLSession under the REST calls: ephemeral (no cookies, no cache), redirects not followed.
public final class URLSessionHTTPTransport: HTTPTransport, @unchecked Sendable {
    private let session: URLSession
    private let delegate = NoRedirects()

    public init(configuration: URLSessionConfiguration = .ephemeral) {
        let c = configuration
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.urlCache = nil
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest = 60
        session = URLSession(configuration: c, delegate: delegate, delegateQueue: nil)
    }

    deinit { session.finishTasksAndInvalidate() }

    public func send(_ request: HTTPRequest, progress: HTTPProgress?) async throws -> HTTPResponse {
        var r = URLRequest(url: request.url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: request.timeout)
        r.httpMethod = request.method
        for (k, v) in request.headers { r.setValue(v, forHTTPHeaderField: k) }
        if let body = request.body, request.method != "GET" { r.httpBody = body }
        let (bytes, response): (URLSession.AsyncBytes, URLResponse)
        do {
            (bytes, response) = try await session.bytes(for: r)
        } catch {
            throw NetError.network((error as? URLError).map { "\($0.code.rawValue) \($0.localizedDescription)" } ?? "\(error)")
        }
        guard let http = response as? HTTPURLResponse else { throw NetError.badAnswer("not an HTTP answer") }
        let total = http.expectedContentLength
        // An error answer is read only as far as a message goes.
        let cap = (200..<300).contains(http.statusCode) ? request.maxBytes : 64 * 1024
        if total > 0, total > Int64(cap) {
            bytes.task.cancel()
            throw NetError.tooLarge(Int(total))
        }
        var body = Data()
        if total > 0 { body.reserveCapacity(Int(total)) }
        var lastReport: Int64 = 0
        do {
            for try await b in bytes {
                body.append(b)
                if body.count > cap {
                    bytes.task.cancel()
                    if (200..<300).contains(http.statusCode) { throw NetError.tooLarge(body.count) }
                    break
                }
                if let progress, Int64(body.count) - lastReport >= 64 * 1024 {
                    lastReport = Int64(body.count)
                    progress(lastReport, total)
                }
            }
        } catch let e as NetError {
            throw e
        } catch {
            throw NetError.network("\(error)")
        }
        progress?(Int64(body.count), total)
        var headers: [String: String] = [:]
        for (k, v) in http.allHeaderFields { headers[String(describing: k)] = String(describing: v) }
        return HTTPResponse(status: http.statusCode, headers: headers, body: body)
    }

    private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest) async -> URLRequest? { nil }
    }
}

/* ---------------------------------------------------------------- client */

/// The REST client every API of this module uses: a transport, the app's User-Agent and the
/// error mapping of the server's JSON answers ({ ok:false, code, message }).
public struct HTTPClient: Sendable {
    public let transport: any HTTPTransport
    /// "M5cet-iOS/6.14.0" — the server's logs and its client info read it.
    public let userAgent: String

    public init(transport: any HTTPTransport = URLSessionHTTPTransport(), userAgent: String = M5NetInfo.userAgent) {
        self.transport = transport
        self.userAgent = userAgent
    }

    /// Sends a request; the body of a 2xx answer, else HTTPError with the server's code and message.
    public func send(_ method: String, _ url: URL, body: Data? = nil, headers: [String: String] = [:], maxBytes: Int = 1 << 20,
                     progress: HTTPProgress? = nil) async throws -> Data {
        var h = ["User-Agent": userAgent, "Accept": "application/json"]
        if body != nil, method != "GET" { h["Content-Type"] = "application/json" }
        for (k, v) in headers { h[k] = v }
        let req = HTTPRequest(method: method, url: url, headers: h, body: method == "GET" ? nil : body, maxBytes: maxBytes)
        let res = try await transport.send(req, progress: progress)
        if (200..<300).contains(res.status) { return res.body }
        throw HTTPClient.error(from: res)
    }

    /// A JSON call: the answer parsed (an object), or HTTPError / NetError.
    public func json(_ method: String, _ url: URL, body: NetJSON? = nil, headers: [String: String] = [:], maxBytes: Int = 4 << 20) async throws -> NetJSON {
        let data = try await send(method, url, body: body?.data, headers: headers, maxBytes: maxBytes)
        return try HTTPClient.object(data)
    }

    /// The JSON object of an answer body.
    public static func object(_ data: Data) throws -> NetJSON {
        guard let v = try? NetJSON.parse(data), case .object = v else { throw NetError.badAnswer("not a JSON answer") }
        return v
    }

    /// HTTPError of a non-2xx answer: its JSON's code and message when it has them.
    public static func error(from res: HTTPResponse) -> HTTPError {
        let parsed = (try? NetJSON.parse(res.body)).flatMap { v -> NetJSON? in if case .object = v { return v }; return nil }
        let retry = res.headers["retry-after"].flatMap { Int($0.trimmingCharacters(in: .whitespaces)) }
        return HTTPError(status: res.status, code: parsed?.str("code") ?? "", message: parsed?.str("message") ?? "",
                         body: parsed ?? .object([:]), retryAfter: retry)
    }

    /// `base` + `path` (base already normalized: scheme://host[:port][/prefix], no trailing slash).
    public static func url(_ base: String, _ path: String) throws -> URL {
        guard let u = URL(string: base + path), u.scheme != nil, u.host != nil else { throw NetError.invalid("not a URL: \(base)\(path)") }
        return u
    }
}

/// A server address as the app keeps it (Android Server.normalize): https:// added when missing, no trailing "/".
public func normalizeServer(_ url: String) -> String {
    var u = url.trimmingCharacters(in: .whitespacesAndNewlines)
    if u.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) == nil { u = "https://" + u }
    while u.hasSuffix("/") { u.removeLast() }
    return u
}
