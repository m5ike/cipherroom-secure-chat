// Port of A/account/EnrollLink.java: the console's enrolment link and its QR
// code (server/android/admin-routes.ts): m5cet://enroll?server=…&code=…&kid=…
// (the server URL-encoded, kid = the server's key id).
//
//   server   required; a bare host means https; http(s) only, no user, query
//            or fragment (a path is kept, for a server behind a prefix)
//   code     optional; letters, digits and dashes — anything else is ignored
//            (the user types it)
//   kid      optional; pins the server's signing key, so it must look like
//            one (16 base64url characters) — a link with a damaged kid is
//            refused rather than enrolling without the pin
//
// Unknown parameters are ignored; of repeated ones the first counts.

import Foundation

public struct EnrollLink: Sendable, Equatable {
    /// The server's base address: scheme://host[:port][/path], no trailing slash.
    public let server: String
    /// The enrolment code ("" when the link has none).
    public let code: String
    /// The server key id the link pins ("" when none).
    public let kid: String

    /// Is this an m5cet://enroll link at all (valid or not)?
    public static func isEnrollLink(_ link: String?) -> Bool {
        guard let link else { return false }
        let s = link.trimmingCharacters(in: .whitespacesAndNewlines)
        return s.range(of: "^m5cet://enroll/?(\\?[^#]*)?(#.*)?$", options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// The link's values, or nil when it is not an enrolment link or its server or kid is unusable.
    public static func parse(_ link: String?) -> EnrollLink? {
        guard let link, isEnrollLink(link) else { return nil }
        let s = link.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let q = s.firstIndex(of: "?") else { return nil }
        let hash = s.firstIndex(of: "#")
        if let hash, hash < q { return nil }
        let query = String(s[s.index(after: q)..<(hash ?? s.endIndex)])
        var server: String?, code: String?, kid: String?
        for pair in query.split(separator: "&", omittingEmptySubsequences: false) {
            let eq = pair.firstIndex(of: "=")
            guard let k = decode(String(eq.map { pair[..<$0] } ?? pair[...])),
                  let v = decode(eq.map { String(pair[pair.index(after: $0)...]) } ?? "") else { continue }
            switch k {
            case "server": if server == nil { server = v }
            case "code": if code == nil { code = v }
            case "kid": if kid == nil { kid = v }
            default: break
            }
        }
        guard let base = Self.server(server) else { return nil }
        let pin = (kid ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !pin.isEmpty, pin.range(of: "^[A-Za-z0-9_-]{16}$", options: .regularExpression) == nil { return nil }
        return EnrollLink(server: base, code: Self.code(code), kid: pin)
    }

    /// A server address as the app keeps it, or nil when it is not an http(s) server.
    public static func server(_ raw: String?) -> String? {
        guard let raw else { return nil }
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty || s.count > 300 { return nil }
        if !s.contains("://") { s = "https://" + s }
        // java.net.URI is strict about characters; URLComponents(string:) refuses the same broken input.
        guard let u = URLComponents(string: s) else { return nil }
        let scheme = (u.scheme ?? "").lowercased()
        guard scheme == "https" || scheme == "http" else { return nil }
        guard let host = u.host, !host.isEmpty, u.user == nil, u.password == nil, u.percentEncodedQuery == nil, u.percentEncodedFragment == nil else { return nil }
        if let port = u.port, port > 65535 || port < 0 { return nil }
        var path = u.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        // java.net.URI keeps an IPv6 literal in brackets; URLComponents drops them.
        let h = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        return scheme + "://" + h.lowercased() + (u.port.map { ":\($0)" } ?? "") + path
    }

    /// Do two addresses name the same server (case, a trailing slash and a missing https:// do not matter)?
    public static func sameServer(_ a: String?, _ b: String?) -> Bool {
        guard let x = server(a), let y = server(b) else { return false }
        return x == y
    }

    /// The same host, port and path whatever the scheme.
    public static func sameHost(_ a: String?, _ b: String?) -> Bool {
        guard let x = server(a), let y = server(b) else { return false }
        let strip = { (s: String) in s.replacingOccurrences(of: "^https?://", with: "", options: .regularExpression) }
        return strip(x) == strip(y)
    }

    /// The code as the server compares it (upper case, no spaces), or "" when it is not one.
    static func code(_ raw: String?) -> String {
        guard let raw else { return "" }
        let c = raw.replacingOccurrences(of: "\\s+", with: "", options: .regularExpression)
        return c.range(of: "^[A-Za-z0-9-]{1,40}$", options: .regularExpression) != nil ? c.uppercased() : ""
    }

    /// A query component, form-decoded as URLSearchParams wrote it ("+" is a space); nil when its escapes are broken.
    static func decode(_ s: String) -> String? {
        let plus = s.replacingOccurrences(of: "+", with: " ")
        // Every "%" must start a valid escape (java.net.URLDecoder refuses "%ZZ").
        let bytes = Array(plus.utf8)
        var i = 0
        while i < bytes.count {
            if bytes[i] == UInt8(ascii: "%") {
                guard i + 2 < bytes.count, isHex(bytes[i + 1]), isHex(bytes[i + 2]) else { return nil }
                i += 3
            } else {
                i += 1
            }
        }
        return plus.removingPercentEncoding
    }

    private static func isHex(_ c: UInt8) -> Bool {
        (0x30...0x39).contains(c) || (0x41...0x46).contains(c) || (0x61...0x66).contains(c)
    }
}
