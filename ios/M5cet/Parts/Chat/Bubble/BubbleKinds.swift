// ui/bubble/Kinds (6.2): what a message is, in the words the web and the audit
// journal share (server/message-audit.ts KINDS) — text, file, image, audio,
// video, location, tap, vanish, sealed, fn, private, forwarded, reply,
// transcript — and where a position message points. Pure.

import Foundation
import M5Core
import M5Proto

enum BubbleKinds {
    /// The web's and this app's position message: "📍 50.08804, 14.42076 (±12 m) https://…" ("📍 live …" while sharing).
    /// Java's \s and \d (ASCII) — spelled out, ICU's would take more.
    nonisolated(unsafe) private static let position = try! NSRegularExpression(
        pattern: "^[ \\t\\n\\x{0B}\\f\\r]*📍[ \\t\\n\\x{0B}\\f\\r]*(?:live[ \\t\\n\\x{0B}\\f\\r]+)?(-?[0-9]{1,2}(?:\\.[0-9]+)?),[ \\t\\n\\x{0B}\\f\\r]*(-?[0-9]{1,3}(?:\\.[0-9]+)?)(?:[ \\t\\n\\x{0B}\\f\\r]*\\(±[ \\t\\n\\x{0B}\\f\\r]*([0-9]+)[ \\t\\n\\x{0B}\\f\\r]*m\\))?")

    static func of(_ m: ChatMessage) -> [String] {
        var k = [String]()
        let mime = (m.fileMime ?? "").lowercased()
        if !m.text.isEmpty && !isPositionMessage(m) { k.append("text") }
        if m.fileName != nil {
            k.append(m.fileImage || mime.hasPrefix("image/") ? "image" : mime.hasPrefix("audio/") ? "audio" : mime.hasPrefix("video/") ? "video" : "file")
        }
        if position(m) != nil { k.append("location") }
        if m.tap { k.append("tap") }
        if m.vanishSeconds > 0 { k.append("vanish") }
        if m.sealed != nil { k.append("sealed") }
        if m.fn != nil || m.fnLocal != nil { k.append("fn") }
        if !m.to.isEmpty { k.append("private") }
        if m.forwardedFrom != nil { k.append("forwarded") }
        if m.replyToId != nil { k.append("reply") }
        if m.sourceAudio != nil { k.append("transcript") }
        return k
    }

    /// A message whose point is the position (Tools › send position), not one that only carries it in the header.
    static func isPositionMessage(_ m: ChatMessage) -> Bool {
        m.sealed == nil && match(m.text) != nil
    }

    /// Where the message points: {lat, lon, acc, at} from loc, else from a position message's text; nil when nowhere.
    static func position(_ m: ChatMessage) -> JSONObject? {
        if let loc = m.loc, let la = loc["lat"]?.numberValue, let lo = loc["lon"]?.numberValue {
            if abs(la.double) <= 90 && abs(lo.double) <= 180 { return loc }
        }
        if m.sealed != nil { return nil }
        guard let g = match(m.text), let a = g[0], let b = g[1], let lat = Double(a), let lon = Double(b) else { return nil }
        if abs(lat) > 90 || abs(lon) > 180 { return nil }
        var o = JSONObject([("lat", .double(lat)), ("lon", .double(lon))])
        if let acc = g[2], let a = Int64(acc) { o["acc"] = .int(a) }
        return o
    }

    /// Only the header's position (location.inHeader): the small corner pin, not a map in the bubble.
    static func headerPosition(_ m: ChatMessage) -> Bool { m.loc != nil && !isPositionMessage(m) }

    /// lat, lon, acc (or nil) of a position message's text.
    private static func match(_ text: String) -> [String?]? {
        let ns = text as NSString
        guard let r = position.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
        func group(_ i: Int) -> String? {
            let g = r.range(at: i)
            return g.location == NSNotFound ? nil : ns.substring(with: g)
        }
        return [group(1), group(2), group(3)]
    }
}

extension JSONObject {
    /// Java's optDouble for a number (NaN otherwise) — the position's lat / lon.
    func chatDouble(_ key: String) -> Double { self[key]?.numberValue?.double ?? .nan }
}
