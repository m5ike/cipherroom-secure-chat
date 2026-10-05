// ui/bubble/Kinds (6.2): what a message is, in the words the web and the audit
// journal share (server/message-audit.ts KINDS) — text, file, image, audio,
// video, location, tap, vanish, sealed, fn, private, forwarded, reply,
// transcript — and where a position message points (the pattern itself is
// Platform/Location's Where: one implementation in the app). Pure.

import Foundation
import M5Core
import M5Proto

enum BubbleKinds {
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

    /// A message whose point is the position (Tools › send position), not one that only carries it in the header:
    /// "📍 50.08804, 14.42076 (±12 m) https://…" ("📍 live …" while sharing).
    static func isPositionMessage(_ m: ChatMessage) -> Bool { Where.isPositionMessage(text: m.text, sealed: m.sealed != nil) }

    /// Where the message points: {lat, lon, acc, at} from loc, else from a position message's text; nil when nowhere.
    static func position(_ m: ChatMessage) -> JSONObject? { Where.position(loc: m.loc, text: m.text, sealed: m.sealed != nil) }

    /// Only the header's position (location.inHeader): the small corner pin, not a map in the bubble.
    static func headerPosition(_ m: ChatMessage) -> Bool { m.loc != nil && !isPositionMessage(m) }
}

extension JSONObject {
    /// Java's optDouble for a number (NaN otherwise) — the position's lat / lon.
    func chatDouble(_ key: String) -> Double { self[key]?.numberValue?.double ?? .nan }
}
