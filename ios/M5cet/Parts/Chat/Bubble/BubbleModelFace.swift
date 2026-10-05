// ui/bubble/ModelFace (6.11 — the Tools part's FnModelFace) and ui/bubble/Runs (6.10).
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

/// The chat's name for the Tools part's FnModelFace (one implementation of ui/bubble/ModelFace in the app).
enum BubbleModelFace {
    static func of(_ m: ChatMessage?) -> ModelIdentity? { FnModelFace.of(m) }
    static func local(_ m: ChatMessage?) -> Bool { FnModelFace.local(m) }
    /// $msg.model for a model's answer (nil for anything else). `has`: whether this app draws that lucide icon.
    static func scope(_ m: ChatMessage, _ tr: (String) -> String, _ has: (String) -> Bool) -> JSONObject? { FnModelFace.scope(m, tr: tr, has: has) }
    static func glyph(_ id: ModelIdentity, _ has: (String) -> Bool) -> String { FnModelFace.glyph(id, has: has) }
    static func runKey(_ m: ChatMessage) -> String? { FnModelFace.runKey(m) }
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
