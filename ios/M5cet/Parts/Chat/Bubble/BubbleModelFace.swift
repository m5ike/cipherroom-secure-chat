// ui/bubble/ModelFace (6.11) and ui/bubble/Runs (6.10).
//
// A model's answer in the list is drawn as an INCOMING message under the model's
// identity (its name, its icon in its colour), wherever it came from:
//   here only     from system-messenger (a caller-only answer, an answer to a click
//                 or a form, the check of a wrong call) — and the older
//                 "function:<keyword>" ones; "only you see it"
//   my room one   the answer this device sent to the room for the model (flags.fn, mine): "via you"
//   a peer's      a room answer another member's app sent (flags.fn): "via <their name>"
// A command's own bubble (the call: fnLocal with its query) stays the person's own.
//
// Runs: a received message that follows one from the same person within a few
// minutes continues their run ($msg.cont) — the design leaves out its avatar and
// name. A notice, my own message, another person or a pause starts a new run;
// a model's answers are their own run. Pure.

import Foundation
import M5Core
import M5Proto

enum BubbleModelFace {
    /// The identity a message is drawn under; nil for a person's message (and a command's own bubble).
    static func of(_ m: ChatMessage?) -> ModelIdentity? {
        guard let m, m.kind != "sys", m.kind != "note" else { return nil }
        if let model = m.model { return ModelIdentity.fromJson(model) }
        if m.fnCall { return nil }
        guard let fn = m.fnDraw else {
            let sender = m.senderId
            return sender.hasPrefix("function:") ? ModelIdentity.of(String(sender.dropFirst("function:".count)), m.senderName, nil) : nil
        }
        return ModelIdentity.fromJson(fn)
    }

    /// Only here (never sent): system-messenger, or an older caller-only answer.
    static func local(_ m: ChatMessage?) -> Bool { m.map { ModelIdentity.reservedSender($0.senderId) } ?? false }

    /// $msg.model for a model's answer (nil for anything else). `has`: whether this app draws that lucide icon.
    static func scope(_ m: ChatMessage, _ tr: (String) -> String, _ has: (String) -> Bool) -> JSONObject? {
        guard let id = of(m) else { return nil }
        let isLocal = local(m)
        let via = isLocal ? "" : m.mine ? tr("quote.you") : m.senderName
        let whereText = isLocal ? tr("fnm.onlyYou") : m.mine ? tr("fnm.viaYou") : tr("fnm.via").replacingOccurrences(of: "{name}", with: via)
        let fd = m.fnDraw
        return JSONObject([("keyword", .string(id.keyword)), ("name", .string(id.name)), ("icon", .string(id.icon)), ("emoji", .bool(!id.lucide)),
                           ("glyph", .string(glyph(id, has))), ("color", .string(id.color)), ("line", .string("/" + id.keyword + " · " + whereText)),
                           ("via", .string(via)), ("mine", .bool(m.mine)), ("error", .bool(fd?.bool("problem") ?? false))])
    }

    /// The default icons this app's set lacks, by a near one it has.
    private static let near: [String: String] = [
        "phone-call": "phone-outgoing", "phone-forwarded": "phone-outgoing", "message-square-text": "message-square", "network": "server",
        "cloud-sun": "cloud", "calculator": "hash", "receipt": "file-text", "id-card": "contact-round", "circle-help": "circle-question-mark",
        "chart-bar": "chart-column",
    ]

    private static let bot = "bot"

    /// The lucide icon drawn for a model ("" for an emoji): its own when the app has it, else a near one, else its
    /// keyword's, else a shorter name ("cloud-sun" → "cloud"), else a bot.
    static func glyph(_ id: ModelIdentity, _ has: (String) -> Bool) -> String {
        if !id.lucide { return "" }
        var byKeyword: String? = ModelIdentity.of(id.keyword, id.name, nil).icon
        if byKeyword == bot { byKeyword = nil } // the fallback comes last
        for c in [id.icon, near[id.icon], byKeyword, byKeyword.flatMap { near[$0] }] {
            if let c, has(c) { return c }
        }
        var s = id.icon
        while let dash = s.lastIndex(of: "-"), dash > s.startIndex {
            s = String(s[..<dash])
            if has(s) { return s }
        }
        return bot
    }

    /// Who a run of messages belongs to: a model's answers continue only that model's (from the same sender).
    static func runKey(_ m: ChatMessage) -> String? {
        guard let id = of(m) else { return nil }
        return "model:" + id.keyword.lowercased() + ":" + (local(m) ? "" : m.mine ? "me" : m.senderId)
    }
}

enum BubbleRuns {
    /// A pause this long (ms) starts a new run.
    static let gapMs: Int64 = 5 * 60_000

    /// Does `cur` continue the run of `prev` (the message shown just above it)?
    static func continues(_ prev: ChatMessage?, _ cur: ChatMessage?) -> Bool {
        guard let prev, let cur else { return false }
        if prev.kind == "sys" || cur.kind == "sys" { return false }
        let pm = BubbleModelFace.runKey(prev), cm = BubbleModelFace.runKey(cur)
        let gap = cur.createdAt - prev.createdAt
        if pm != nil || cm != nil { return pm != nil && pm == cm && gap >= 0 && gap <= gapMs }
        if prev.mine != cur.mine { return false }
        if prev.senderId.isEmpty || prev.senderId != cur.senderId { return false }
        return gap >= 0 && gap <= gapMs
    }
}
