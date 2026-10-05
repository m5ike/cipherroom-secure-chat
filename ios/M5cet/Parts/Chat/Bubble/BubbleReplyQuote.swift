// ui/bubble/ReplyQuote (6.10): the message a reply answers, as the quote card on
// top of the reply bubble draws it ($msg.replyTo, design message.in / message.out "quote"):
//
//   id      the original's id (a tap scrolls there: msg.quote)
//   sender  who wrote it — "You" when it is mine
//   text    one or two lines of it; a picture, a recording… without text says what it is
//   icon    the kind's icon (image, audio-lines, video, paperclip, map-pin, lock), "" for a plain text
//   color   the sender's colour (the web's monogram hue) for the bar and the name; tint the same, faint
//   found   the original is in this room's history on this device
//
// What the reply carried (replyTo.sender / text, ≤ 200 characters) is used when the
// original is not here; the original — when it is — tells the kind and the latest
// state (opened, vanished). Pure.

import Foundation
import M5Core
import M5Proto

enum BubbleReplyQuote {
    /// At most this many characters of the quoted text (two lines of a bubble).
    static let chars = 140

    /// $msg.replyTo for a reply (nil when `reply` answers nothing); `original` nil when it is not in the history here.
    /// `held`: the original is held behind a changed identity (6.12 review P14) — the quote says so instead of any text.
    static func of(_ reply: ChatMessage?, _ original: ChatMessage?, held: Bool = false, _ tr: (String) -> String) -> JSONObject? {
        guard let reply, let replyTo = reply.replyToId, !replyTo.isEmpty else { return nil }
        var original = original
        var held = held
        if let o = original, o.changed, !o.mine { original = nil; held = true }
        if held {
            let name = (reply.replyToSender ?? "").isEmpty ? "?" : reply.replyToSender!
            let c = MonogramHue.hsl(Float(MonogramHue.hue(name)), 0.70, 0.42, 1)
            return JSONObject([("id", .string(replyTo)), ("sender", .string(name)), ("text", .string(tr("quote.held"))), ("kind", "held"),
                               ("icon", "shield-alert"), ("color", .string(MonogramHue.hex(c))), ("tint", .string(MonogramHue.hex((0x24 << 24) | (c & 0xFF_FFFF)))),
                               ("found", false), ("mine", false)])
        }
        let k = kind(original, reply.replyToText)
        let mine = original?.mine ?? false
        let name = original.map { !$0.senderName.isEmpty ? $0.senderName : (reply.replyToSender ?? "") } ?? (reply.replyToSender ?? "")
        let sender = mine ? tr("quote.you") : name.isEmpty ? "?" : name
        var text = line(original != nil && k != "sealed" && k != "vanished" ? original!.visibleText : quoted(reply.replyToText))
        if text.isEmpty, let o = original, let f = o.fileName, k != "position" { text = line(f) }
        if text.isEmpty || k == "sealed" || k == "vanished" { text = tr("quote." + label(k)) }
        let c = MonogramHue.hsl(Float(MonogramHue.hue(name.isEmpty ? "?" : name)), 0.70, 0.42, 1)
        return JSONObject([("id", .string(replyTo)), ("sender", .string(sender)), ("text", .string(text)), ("kind", .string(k)), ("icon", .string(icon(k))),
                           ("color", .string(MonogramHue.hex(c))), ("tint", .string(MonogramHue.hex((0x24 << 24) | (c & 0xFF_FFFF)))),
                           ("found", .bool(original != nil)), ("mine", .bool(mine))])
    }

    /// text, image, audio, video, file, position, sealed (not opened here) or vanished — from the original when it is
    /// here, else from what the reply quoted ("📎 name" for a file, "🔒" for a sealed one).
    static func kind(_ o: ChatMessage?, _ quotedText: String?) -> String {
        if let o {
            if o.vanished { return "vanished" }
            if o.sealed != nil && o.sealPlain == nil { return "sealed" }
            if BubbleKinds.isPositionMessage(o) { return "position" }
            if o.fileName != nil {
                let mime = (o.fileMime ?? "").lowercased()
                if o.fileImage || mime.hasPrefix("image/") { return "image" }
                if mime.hasPrefix("audio/") { return "audio" }
                if mime.hasPrefix("video/") { return "video" }
                return "file"
            }
            return "text"
        }
        let q = javaTrim(quotedText ?? "")
        if q == "🔒" { return "sealed" }
        if q.hasPrefix("📎") { return "file" }
        return "text"
    }

    static func icon(_ kind: String) -> String {
        switch kind {
        case "image": return "image"
        case "audio": return "audio-lines"
        case "video": return "video"
        case "file": return "paperclip"
        case "position": return "map-pin"
        case "sealed": return "lock"
        case "vanished": return "timer"
        default: return ""
        }
    }

    /// The quote.* key that names a kind when there is no text to show.
    static func label(_ kind: String) -> String {
        switch kind {
        case "image": return "photo"
        case "audio", "video", "file", "position", "sealed", "vanished": return kind
        default: return "empty"
        }
    }

    /// What the reply quoted, without the file's paperclip (the icon says it).
    static func quoted(_ q: String?) -> String {
        var s = javaTrim(q ?? "")
        if s == "🔒" { return "" }
        if s.hasPrefix("📎") { s = javaTrim(String(s.dropFirst())) }
        return s
    }

    /// One paragraph: the line breaks and runs of spaces folded, at most `chars` code points (an ellipsis when cut).
    static func line(_ s: String?) -> String {
        guard let s else { return "" }
        var kept = String.UnicodeScalarView()
        for u in s.unicodeScalars {
            let v = u.value
            if v <= 0x08 || (0x0B...0x1F).contains(v) || v == 0x7F || (0x202A...0x202E).contains(v) || (0x2066...0x2069).contains(v) { continue }
            kept.append(u)
        }
        // Java's \s+ → " " ([ \t\n\x0B\f\r]), then trim (≤ U+0020).
        var folded = String.UnicodeScalarView()
        var inSpace = false
        for u in kept {
            if [0x20, 0x09, 0x0A, 0x0B, 0x0C, 0x0D].contains(u.value) {
                if !inSpace { folded.append(" ") }
                inSpace = true
            } else {
                folded.append(u)
                inSpace = false
            }
        }
        let t = javaTrim(String(folded))
        let scalars = Array(t.unicodeScalars)
        if scalars.count <= chars { return t }
        var cut = String.UnicodeScalarView()
        cut.append(contentsOf: scalars.prefix(chars - 1))
        return javaTrim(String(cut)) + "…"
    }

    /// Java's String.trim: code units ≤ U+0020 off both ends.
    static func javaTrim(_ s: String) -> String {
        let u = Array(s.unicodeScalars)
        var a = 0, b = u.count
        while a < b && u[a].value <= 0x20 { a += 1 }
        while b > a && u[b - 1].value <= 0x20 { b -= 1 }
        var out = String.UnicodeScalarView()
        out.append(contentsOf: u[a..<b])
        return String(out)
    }
}

/// contacts/Avatars' hue (the web's UserBadge hueFor): h = (h·31 + UTF-16 unit) mod 360 over the lower-cased name,
/// and CSS hsl() → ARGB with Java's float rounding — the quote card's colour is the sender's colour on every platform.
enum MonogramHue {
    static func hue(_ name: String?) -> Int {
        let key = ((name ?? "").isEmpty ? "?" : name!).lowercased()
        var h = 0
        for u in key.utf16 { h = (h * 31 + Int(u)) % 360 }
        return h
    }

    static func hsl(_ h: Float, _ s: Float, _ l: Float, _ alpha: Float) -> UInt32 {
        let c = (1 - abs(2 * l - 1)) * s
        let hp = (h.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) / 60
        let x = c * (1 - abs(hp.truncatingRemainder(dividingBy: 2) - 1))
        var r: Float = 0, g: Float = 0, b: Float = 0
        if hp < 1 { r = c; g = x } else if hp < 2 { r = x; g = c } else if hp < 3 { g = c; b = x } else if hp < 4 { g = x; b = c } else if hp < 5 { r = x; b = c } else { r = c; b = x }
        let m = l - c / 2
        func round(_ v: Float) -> UInt32 { UInt32(max(0, (v + 0.5).rounded(.down))) }
        return round(alpha * 255) << 24 | round((r + m) * 255) << 16 | round((g + m) * 255) << 8 | round((b + m) * 255)
    }

    /// "#aarrggbb" — the form the design's colours take.
    static func hex(_ argb: UInt32) -> String { String(format: "#%08x", argb) }
}
