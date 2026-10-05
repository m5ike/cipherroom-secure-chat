// ui/bubble/MapPolicy + ui/bubble/Http (6.2): the operator's map preview —
// GET /api/client-config › config.map, checked like sanitizeMapPreview() in
// client/src/lib/client-config.ts. Asked for once and again every 10 minutes (a
// minute after a failure); until the server answered — or when it cannot be
// reached, or a server without map previews answers — a message shows the pin.
// Requests go only to the app's own server (CoreModels.server): no account, no
// cookies, no cache, no redirects.

import Foundation
import M5Core
import os

struct ChatMapPolicy: Equatable, Sendable {
    let enabled: Bool
    let tiles: String, subdomains: String, attribution: String
    let zoom: Int, width: Int, height: Int
    /// ARGB; accent 0 = the theme's primary colour.
    let pinColor: UInt32, accent: UInt32
    let label: Bool, showCoords: Bool, grayscale: Bool
    let cacheHours: Int

    private init(_ r: JSONObject) {
        enabled = r["enabled"]?.boolValue ?? true
        let t = BubbleReplyQuote.javaTrim(r["tiles"]?.stringValue ?? "")
        tiles = t.isEmpty ? "https://tile.openstreetmap.org/{z}/{x}/{y}.png" : t
        let s = r["subdomains"]?.stringValue ?? ""
        subdomains = s.utf16.count <= 8 && s.unicodeScalars.allSatisfy({ $0.isASCII && CharacterSet.alphanumerics.contains($0) }) ? s : ""
        attribution = r["attribution"]?.stringValue.map { Self.clean($0, 120) } ?? "© OpenStreetMap"
        zoom = Self.num(r["zoom"], 3, 19, 16)
        width = Self.num(r["width"], 160, 640, 280)
        height = Self.num(r["height"], 100, 480, 160)
        pinColor = Self.color(r["pinColor"], 0xFFE1_1D48)
        accent = Self.color(r["accent"], 0)
        label = r["label"]?.boolValue ?? true
        showCoords = r["showCoords"]?.boolValue ?? true
        grayscale = r["grayscale"]?.boolValue ?? false
        cacheHours = Self.num(r["cacheHours"], 1, 720, 168)
    }

    /// config.map as the server sent it; a server without it (before 6.2) has no tiles to give: off.
    static func parse(_ config: JSONObject?) -> ChatMapPolicy {
        guard let map = config?.object("map") else { return ChatMapPolicy(JSONObject([("enabled", false)])) }
        return ChatMapPolicy(map)
    }

    static func num(_ v: JSON?, _ lo: Int, _ hi: Int, _ dflt: Int) -> Int {
        guard let d = v?.numberValue?.double, d.isFinite else { return dflt }
        // Math.round: half up.
        return Int(max(Double(lo), min(Double(hi), (d + 0.5).rounded(.down))))
    }

    static func color(_ v: JSON?, _ dflt: UInt32) -> UInt32 {
        guard let raw = v?.stringValue else { return dflt }
        let s = BubbleReplyQuote.javaTrim(raw).lowercased()
        guard s.utf16.count == 7, s.hasPrefix("#"), let rgb = UInt32(s.dropFirst(), radix: 16),
              s.dropFirst().allSatisfy({ $0.isHexDigit && ($0.isNumber || ("a"..."f").contains($0)) }) else { return dflt }
        return 0xFF00_0000 | rgb
    }

    static func clean(_ s: String, _ max: Int) -> String {
        var kept = String.UnicodeScalarView()
        for u in s.unicodeScalars where !(u.value <= 0x1F || u.value == 0x7F || u == "<" || u == ">") { kept.append(u) }
        let t = BubbleReplyQuote.javaTrim(String(kept))
        let units = Array(t.utf16)
        return units.count > max ? String(utf16CodeUnits: units, count: max) : t
    }

    /// What a rendered preview depends on (part of its cache key).
    var signature: String {
        "\(zoom)|\(width)x\(height)|\(String(pinColor, radix: 16))|\(String(accent, radix: 16))|\(label)\(showCoords)\(grayscale)|\(attribution)|\(tiles)\(subdomains)"
    }
}

/// MapPolicy's loading: the policy to draw with, asked for in the background.
@MainActor
enum ChatMapPolicies {
    private static var current: ChatMapPolicy?
    private static var currentFor = ""
    private static var nextAsk: Int64 = 0
    private static var asking = false
    /// Tiles did not come (no network, the server is down): the pin until then.
    private static var unreachableUntil: Int64 = 0
    private static let log = Logger(subsystem: "cz.m5cet.app", category: "map")

    /// The policy to draw with, or nil: not known yet (asked now), switched off, or the server cannot be reached.
    static func usable() -> ChatMapPolicy? {
        let server = CoreModels.shared.server
        if server.isEmpty { return nil }
        let p = currentFor == server ? current : nil
        let now = Millis.now
        if now >= nextAsk || (p == nil && currentFor != server) { ask(server) }
        guard let p, p.enabled, now >= unreachableUntil else { return nil }
        return p
    }

    private static func ask(_ server: String) {
        if asking { return }
        asking = true
        nextAsk = Millis.now + 60_000
        Task { @MainActor in
            var got: ChatMapPolicy?
            do {
                let data = try await ChatHttp.get(server + "/api/client-config", max: 256 * 1024)
                if let o = JSON.parseObject(String(decoding: data, as: UTF8.self)) {
                    got = parse(o.object("config") ?? o)
                }
            } catch {
                log.notice("no map policy")
            }
            asking = false
            let changed = got != nil && (current == nil || currentFor != server || got!.signature != current!.signature || got!.enabled != current!.enabled)
            if let got { current = got; currentFor = server; nextAsk = Millis.now + 600_000 }
            if changed { ChatState.shared.mapPolicyChanged() }
        }
    }

    private static func parse(_ o: JSONObject) -> ChatMapPolicy { ChatMapPolicy.parse(o) }

    /// Tiles failed for want of the network or the server: the pin for a minute, then previews try again.
    static func unreachable() {
        let was = Millis.now < unreachableUntil
        unreachableUntil = Millis.now + 60_000
        if !was {
            ChatState.shared.mapPolicyChanged()
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(61))
                ChatState.shared.mapPolicyChanged()
            }
        }
    }

    /// A tile answered "map-off": the operator switched previews off since the policy came; asked again at once.
    static func switchedOff() {
        if current != nil { current = ChatMapPolicy.parse(nil) }
        nextAsk = 0
        _ = usable()
        ChatState.shared.mapPolicyChanged()
    }

    #if DEBUG
    /// Previews and tests: a policy as if the server had sent it.
    static func setForTesting(_ p: ChatMapPolicy?, server: String) {
        current = p
        currentFor = server
        nextAsk = Millis.now + 600_000
        unreachableUntil = 0
    }
    #endif
}

/// ui/bubble/Http: a plain GET to the app's own server — no account, no cookies, no cache, no redirects.
enum ChatHttp {
    /// An answer other than 2xx: its status and the server's code ("map-off"…).
    struct Refused: Error {
        let status: Int
        let code: String
    }

    struct TooLarge: Error {}

    private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest) async -> URLRequest? { nil }
    }

    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        c.urlCache = nil
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.timeoutIntervalForRequest = 12
        c.timeoutIntervalForResource = 20
        return URLSession(configuration: c, delegate: NoRedirects(), delegateQueue: nil)
    }()

    static func get(_ url: String, max: Int) async throws -> Data {
        guard let u = URL(string: url), u.scheme == "https" || u.scheme == "http" else { throw URLError(.badURL) }
        var r = URLRequest(url: u)
        r.setValue("M5cet-iOS/" + AppInfo.version, forHTTPHeaderField: "User-Agent")
        let (data, response) = try await session.data(for: r)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status < 200 || status >= 300 {
            let code = data.count <= 16 * 1024 ? (JSON.parseObject(String(decoding: data, as: UTF8.self))?.optString("code") ?? "") : ""
            throw Refused(status: status, code: code)
        }
        if data.count > max { throw TooLarge() }
        return data
    }
}
