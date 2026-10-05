// A message as the app shows and keeps it (android chat/ChatMessage.java): the
// decrypted payload plus how it arrived and where it is — 6.1 message kinds,
// recipients, expiry, the position, function outputs, delivery states; 6.2
// every state with its time (the timeline) and a hide in this view. A value
// type: the room session owns the list and hands copies to the UI.

import Foundation
import M5Core
import M5Crypto

public struct ChatMessage: Sendable, Equatable {
    public var id = ""
    public var roomKey = ""
    /// "text", "sys", "audio-status" (never kept); 6.10 "note" — a note to myself, never sent.
    public var kind = "text"
    public var senderId = ""
    public var senderName = ""
    public var text = ""
    public var createdAt: Int64 = 0
    public var mine = false
    /// Mine: sending → sent | queued, then stored / forwarded (relay), delivered / read (receipts); received: "received".
    public var status = "received"
    public var verified = false
    public var changed = false
    /// 6.12 review P09: the key id of the device the message came from ("" when unknown).
    public var senderKid = ""
    public var replyToId: String?, replyToSender: String?, replyToText: String?
    public var fileName: String?, fileMime: String?, fileDataUrl: String?
    public var fileSize: Int64 = 0
    /// The attachment is drawn as a picture (kind "image" with a safe image type).
    public var fileImage = false
    /// A file that came (or went) by chunked transfer: the vault id, and the transfer's progress 0–1 (−1 = done, −2 = failed).
    public var filePath: String?
    public var fileProgress: Double = -1
    public var fileVerified = false

    // 6.1 — the web's message kinds (flags) and addressing
    public var tap = false
    public var vanishSeconds = 0
    public var vanishedMs: Int64 = 0
    public var vanished = false
    /// flags.sealed: {salt, iv, v, it}; text holds the ciphertext until opened.
    public var sealed: JSONObject?
    /// The plain text once opened (never stored), and — for my own — the code.
    public var sealPlain: String?, sealCode: String?
    /// flags.fn: a command's result (keyword, name, model, chain, call, events, outputs; icon).
    public var fn: JSONObject?
    /// The result as this device keeps it (every output); drawn instead of `fn` when set.
    public var fnLocal: JSONObject?
    /// 6.11: a model's answer — the model's identity {keyword, name, icon}.
    public var model: JSONObject?
    /// The names of the recipients of a private message (informational).
    public var to: [String] = []
    public var forwardedFrom: String?
    public var ttlMinutes = 0
    public var expiresAt: Int64 = 0
    /// {lat, lon, acc, at} — the sender's position when it was written.
    public var loc: JSONObject?
    /// A transcript of a call's audio: the recording it came from.
    public var sourceAudio: String?
    /// Receipts per recipient (peer id → state) for my own messages.
    public var receipts = JSONObject()
    /// Came through the server relay.
    public var relayed = false
    /// A read receipt went for it (not stored).
    public var readSent = false

    // 6.2 — the timeline and a hide
    public struct Step: Sendable, Equatable {
        public let state: String
        public let at: Int64
        public let meta: String
        public init(_ state: String, _ at: Int64, _ meta: String?) { self.state = state; self.at = at; self.meta = meta ?? "" }
    }
    private var steps: [Step] = []
    public static let timelineMax = 200
    /// Hidden in this view until this time (ms); `untilSignIn` = until the app is unlocked again; 0 = shown.
    public var hiddenUntil: Int64 = 0
    public static let untilSignIn: Int64 = -1
    /// A hide until the next sign-in: the unlock it belongs to.
    public var hiddenFor: String?
    /// Deleted on this device (not stored).
    public var deleted = false

    public init() {}

    public static func system(roomKey: String, text: String, now: Int64) -> ChatMessage {
        var m = ChatMessage()
        m.id = "sys-" + String(UInt64.random(in: 0..<UInt64.max) >> 8, radix: 36)
        m.roomKey = roomKey
        m.kind = "sys"
        m.senderId = "system"
        m.text = text
        m.createdAt = now
        return m
    }

    public func expired(_ now: Int64) -> Bool { expiresAt > 0 && now >= expiresAt }

    /// What the bubble shows as text: the opened seal, else the text (a sealed one stays hidden).
    public var visibleText: String { sealed != nil ? (sealPlain ?? "") : text }

    /// What a notification may say of it (review P14: a changed identity's text never before it is accepted).
    public var notifyText: String {
        if changed { return "⚠" }
        if sealed != nil { return "🔒" }
        if tap { return "👁" }
        if let f = fn { return "/" + f.optString("keyword") + (text.isEmpty ? "" : " · " + text) }
        return text.isEmpty ? "📎 " + (fileName ?? "") : text
    }

    /// flags.fn to draw: the full local copy when this device has it, else what came on the wire.
    public var fnDraw: JSONObject? { fnLocal ?? fn }

    /// A command's own bubble (the call: its query, loading, then a status).
    public var fnCall: Bool { fnLocal?.has("query") ?? false }

    func callState() -> JSONObject? {
        guard fnCall, let l = fnLocal else { return nil }
        var c = JSONObject()
        for k in ["keyword", "name", "icon", "query", "status"] where l.has(k) { c[k] = l[k] }
        if l.bool("pending") == true { c["pending"] = true }
        return c
    }

    /// A command's bubble from the history; one still loading when the app stopped says it was interrupted.
    static func callFrom(_ c: JSONObject?) -> JSONObject? {
        guard let c, c.has("query") else { return nil }
        var out = JSONObject()
        for k in ["keyword", "name", "icon", "query", "status"] where c.has(k) { out[k] = c[k] }
        out["pending"] = false
        if c.bool("pending") == true { out["status"] = .object(JSONObject([("kind", "error"), ("code", "interrupted"), ("label", "")])) }
        return out
    }

    public static let order = ["sending", "queued", "sent", "stored", "forwarded", "delivered", "read"]

    public static func rank(_ s: String) -> Int { order.firstIndex(of: s) ?? -1 }

    /// Moves the status up (never down); each move is a step of the timeline.
    @discardableResult
    public mutating func raise(_ s: String, at: Int64 = SystemClock().now()) -> Bool {
        if !up(s) { return false }
        mark(s, "", at: at)
        return true
    }

    /// A state for one recipient: always a step naming them; the status only moves up.
    @discardableResult
    public mutating func raise(_ s: String, who: String, at: Int64 = SystemClock().now()) -> Bool {
        mark(s, who, at: at)
        return up(s)
    }

    private mutating func up(_ s: String) -> Bool {
        if ChatMessage.rank(s) > ChatMessage.rank(status) || (status == "queued" && ChatMessage.rank(s) >= ChatMessage.rank("sent")) { status = s; return true }
        return false
    }

    /* ---------------------------------------------------------- timeline */

    /// Adds a step; the same state with the same meta counts once (only hidden / unhidden repeat).
    @discardableResult
    public mutating func mark(_ state: String, _ meta: String? = "", at: Int64 = SystemClock().now()) -> Bool {
        let mt = meta ?? ""
        let repeats = state == "hidden" || state == "unhidden"
        if !repeats && steps.contains(where: { $0.state == state && $0.meta == mt }) { return false }
        steps.append(Step(state, at, mt))
        while steps.count > ChatMessage.timelineMax { steps.remove(at: 1) } // the first ("created") stays
        return true
    }

    public func has(_ state: String) -> Bool { steps.contains { $0.state == state } }

    /// The steps in the order they happened (stable for equal times).
    public var timeline: [Step] { steps.enumerated().sorted { ($0.element.at, $0.offset) < ($1.element.at, $1.offset) }.map(\.element) }

    private var timelineJson: [JSON] {
        steps.map { st in
            var o = JSONObject([("state", .string(st.state)), ("at", .int(st.at))])
            if !st.meta.isEmpty { o["meta"] = .string(st.meta) }
            return .object(o)
        }
    }

    /// The scope the message layouts see as $msg.
    public var scope: JSONObject {
        var o = JSONObject()
        o["id"] = .string(id)
        o["text"] = .string(vanished ? "" : visibleText)
        o["sender"] = .string(senderName)
        o["time"] = .int(createdAt)
        o["mine"] = .bool(mine)
        o["status"] = .string(status)
        o["verified"] = .bool(verified)
        o["changed"] = .bool(changed)
        if let r = replyToId {
            o["replyTo"] = .object(JSONObject([("id", .string(r)), ("sender", .string(replyToSender ?? "")), ("text", .string(replyToText ?? ""))]))
        } else { o["replyTo"] = .null }
        if let name = fileName {
            let mime = fileMime ?? ""
            o["attachment"] = .object(JSONObject([("name", .string(name)), ("size", .int(fileSize)), ("mime", .string(mime)), ("image", .bool(fileImage)),
                                                  ("audio", .bool(mime.hasPrefix("audio/"))), ("video", .bool(mime.hasPrefix("video/"))),
                                                  ("progress", .double(fileProgress)), ("done", .bool(fileProgress < 0)), ("verified", .bool(fileVerified))]))
        } else { o["attachment"] = .null }
        o["tap"] = .bool(tap)
        o["vanish"] = .int(vanishSeconds)
        o["vanished"] = .bool(vanished)
        o["vanishLeft"] = .double(vanishSeconds > 0 ? max(0, Double(vanishSeconds) - Double(vanishedMs) / 1000.0) : 0)
        o["sealed"] = .bool(sealed != nil)
        o["opened"] = .bool(sealed == nil || sealPlain != nil)
        o["code"] = .string(sealCode ?? "")
        o["private"] = .bool(!to.isEmpty)
        o["to"] = .string(to.joined(separator: ", "))
        o["forwarded"] = .string(forwardedFrom ?? "")
        o["expires"] = .int(expiresAt)
        o["loc"] = loc.map { .object($0) } ?? .null
        o["fn"] = fn.map { .object(JSONObject([("keyword", .string($0.optString("keyword"))), ("name", .string($0.optString("name")))])) } ?? .null
        o["source"] = .bool(sourceAudio != nil)
        o["kind"] = .string(kind)
        return o
    }

    public var json: JSONObject {
        var o = scope
        o["kind"] = .string(kind)
        o["senderId"] = .string(senderId)
        o["roomKey"] = .string(roomKey)
        o["text"] = .string(text) // a sealed message keeps its ciphertext
        if let d = fileDataUrl, d.utf16.count < 800_000 { o["dataUrl"] = .string(d) }
        if let p = filePath { o["filePath"] = .string(p) }
        if let s = sealed { o["sealedMeta"] = .object(s) }
        if let c = sealCode, mine { o["sealCode"] = .string(c) }
        if let f = fn { o["fnMeta"] = .object(f) }
        if let m = model { o["fnModel"] = .object(m) }
        if let call = callState() { o["fnCall"] = .object(call) }
        if !to.isEmpty { o["toList"] = .array(to.map { .string($0) }) }
        if ttlMinutes > 0 { o["ttlMinutes"] = .int(ttlMinutes) }
        if vanishedMs > 0 { o["vanishedMs"] = .int(vanishedMs) }
        if let s = sourceAudio { o["sourceAudio"] = .string(s) }
        o["receipts"] = .object(receipts)
        o["relayed"] = .bool(relayed)
        let tl = timelineJson
        if !tl.isEmpty { o["timeline"] = .array(tl) }
        if hiddenUntil != 0 { o["hiddenUntil"] = .int(hiddenUntil); o["hiddenFor"] = .string(hiddenFor ?? "") }
        return o
    }

    private static func optString(_ o: JSONObject, _ key: String) -> String? { o.string(key) }

    public static func from(_ o: JSONObject) -> ChatMessage {
        var m = ChatMessage()
        m.id = o.optString("id")
        m.roomKey = o.optString("roomKey")
        m.kind = o.string("kind") ?? "text"
        m.senderId = o.optString("senderId")
        m.senderName = o.optString("sender")
        m.text = o.optString("text")
        m.createdAt = o.optInt64("time")
        m.mine = o.bool("mine") ?? false
        m.status = o.string("status") ?? "received"
        if m.status == "sending" { m.status = "queued" }
        m.verified = o.bool("verified") ?? false
        m.changed = o.bool("changed") ?? false
        if let r = o.object("replyTo") { m.replyToId = r.optString("id"); m.replyToSender = r.optString("sender"); m.replyToText = r.optString("text") }
        if let a = o.object("attachment") {
            m.fileName = a.optString("name"); m.fileSize = a.optInt64("size"); m.fileMime = a.optString("mime"); m.fileDataUrl = o.string("dataUrl")
            m.fileVerified = a.bool("verified") ?? false; m.fileImage = a.bool("image") ?? false
        }
        m.filePath = o.string("filePath")
        m.tap = o.bool("tap") ?? false
        m.vanishSeconds = Int(clamping: o.optInt64("vanish"))
        m.vanishedMs = o.optInt64("vanishedMs")
        m.vanished = o.bool("vanished") ?? false
        m.sealed = o.object("sealedMeta")
        m.sealCode = o.string("sealCode")
        if m.sealCode?.isEmpty == true { m.sealCode = nil }
        m.fn = o.object("fnMeta")
        m.model = o.object("fnModel")
        m.fnLocal = callFrom(o.object("fnCall"))
        m.to = (o.array("toList") ?? []).map { $0.stringValue ?? "" }
        let fwd = o.optString("forwarded")
        m.forwardedFrom = fwd.isEmpty ? nil : fwd
        m.ttlMinutes = Int(clamping: o.optInt64("ttlMinutes"))
        m.expiresAt = o.optInt64("expires")
        m.loc = o.object("loc")
        m.sourceAudio = o.string("sourceAudio")
        if let rc = o.object("receipts") { m.receipts = rc }
        m.relayed = o.bool("relayed") ?? false
        for st in (o.array("timeline") ?? []).prefix(timelineMax) {
            if let s = st.objectValue, !s.optString("state").isEmpty { m.steps.append(Step(s.optString("state"), s.optInt64("at"), s.optString("meta"))) }
        }
        m.hiddenUntil = o.optInt64("hiddenUntil")
        let hf = o.optString("hiddenFor")
        m.hiddenFor = hf.isEmpty ? nil : hf
        return m
    }
}
