// Everything this device knows of a message (6.2), behind the (i) of its bubble —
// the content of android/…/ui/parts/MsgDetails.java without its views: when and
// from whom, to whom, how large, what kind, every state with its time (the
// timeline in the web's vocabulary — 6.12 adds how a message for an away member
// was sealed: "relay-p4", sealed for each of their devices' protocol-4 mailboxes,
// or "relay-room", under the room key) and each recipient's receipts; the
// attachment; whether it can be hidden and deleted. Pure: tests read it.

import Foundation
import M5Core
import M5Design
import M5Proto

struct MsgDetailsContent: Equatable {
    /// A line: the label (muted, fixed width), the value, an optional detail under it.
    struct Row: Equatable {
        let label: String
        let value: String
        var detail = ""
    }

    /// A step of the timeline: its icon, its words (state · meta) and its time.
    struct Step: Equatable {
        let state: String
        let icon: String
        let label: String
        let time: String
    }

    var rows: [Row] = []
    /// The kinds' chips (with their detail: "vanishing · 60 s", "private · Alice").
    var kinds: [String] = []
    var timeline: [Step] = []
    /// Per recipient (mine only): the relay's and the receipts' states with their times.
    var receipts: [Row] = []
    var attachment: Row?
    /// The attachment can be opened, saved, shared, forwarded (it is here).
    var attachmentReady = false
    /// Hiding and deleting (not for a system line).
    var canHide = false
    var hidden = false
}

enum MsgDetailsModel {
    /// States with a recipient's name in meta: the "Recipients" part groups them.
    static let perRecipient = ["stored", "forwarded", "delivered", "read"]

    /// A word for a key when the design has one (6.12: or the app's English one), else the raw value.
    static func word(_ t: (String) -> String, _ prefix: String, _ value: String) -> String {
        let k = prefix + value
        let s = t(k)
        if s != k { return s }
        return P4Texts.en[k] ?? value
    }

    static func icon(_ state: String) -> String {
        switch state {
        case "created": "pencil-line"
        case "encrypted": "lock"
        case "decrypted": "lock-open"
        case "sent": "send-horizontal"
        case "queued": "clock"
        case "stored": "server"
        case "forwarded": "forward"
        case "received": "download"
        case "delivered": "check"
        case "read": "check-check"
        case "displayed": "eye"
        case "revealed": "hand"
        case "opened": "key-round"
        case "expired": "timer"
        case "hidden": "eye-off"
        case "unhidden": "eye"
        case "discarded": "trash"
        case "relay-p4": "shield-check" // 6.12 § 7.4: away members — sealed for their devices
        case "relay-room": "key-round" // … or under the room key
        default: "circle-dot"
        }
    }

    /// Ui.size: the design's size filter ("12.3 kB").
    static func size(_ bytes: Int64) -> String { Expr.sizeText(Double(bytes)) }

    static func content(_ m: ChatMessage, roomLabel: String, peerName: (String) -> String?, forwardVerified: Bool,
                        hidden: Bool, t: (String) -> String, lang: String, now: Int64, tz: TimeZone? = nil) -> MsgDetailsContent {
        var c = MsgDetailsContent()
        let full: (Int64) -> String = { Formats.full(lang, $0, tz: tz) } // 6.13: in the app's language
        c.rows.append(.init(label: t("msginfo.when"), value: full(m.createdAt)))
        // 6.12 (F-22): the name as shown everywhere; an operator's notice names the operator, not its frame's "from".
        let sender = m.id.hasPrefix(Names.noticeId) && m.kind == "sys" ? Names.operator(m.senderName, t("notice.operator")) : Names.normalize(m.senderName)
        c.rows.append(.init(label: t("msginfo.sender"), value: m.mine ? t("users.me") + " (" + sender + ")" : sender))
        c.rows.append(.init(label: t("msginfo.recipients"), value: !m.to.isEmpty ? m.to.joined(separator: ", ") : t("msginfo.everyone") + " · " + roomLabel))
        c.rows.append(.init(label: t("msginfo.size"), value: sizeText(m, t)))
        c.rows.append(.init(label: t("msginfo.verified"), value: m.verified ? "✓" : m.changed ? "⚠ " + t("msginfo.changed") : "—"))
        if m.expiresAt > 0 { c.rows.append(.init(label: t("msginfo.expires"), value: full(m.expiresAt))) }
        if m.hiddenUntil != 0 && hidden {
            c.rows.append(.init(label: t("msginfo.hidden"), value: m.hiddenUntil == ChatMessage.untilSignIn ? t("msginfo.hide.until-signin") : full(m.hiddenUntil)))
        }
        c.kinds = kinds(m, forwardVerified: forwardVerified, t: t)
        c.timeline = timeline(m, t: t, lang: lang, tz: tz)
        c.receipts = receipts(m, peerName: peerName, t: t, lang: lang, tz: tz)
        if let name = m.fileName {
            c.attachment = .init(label: name, value: size(m.fileSize) + ((m.fileMime ?? "").isEmpty ? "" : " · " + m.fileMime!))
            c.attachmentReady = m.fileDataUrl != nil || (m.filePath != nil && m.fileProgress < 0 && m.fileProgress > -2)
        }
        c.canHide = m.kind != "sys"
        c.hidden = m.hiddenUntil != 0 && hidden
        return c
    }

    private static func sizeText(_ m: ChatMessage, _ t: (String) -> String) -> String {
        var parts = [String]()
        let text = m.sealed != nil && m.sealPlain == nil ? m.text : m.visibleText
        if !text.isEmpty { parts.append(t("msginfo.sizeText") + " " + size(Int64(text.utf8.count))) }
        if m.fileName != nil { parts.append(t("msginfo.sizeFile") + " " + size(m.fileSize)) }
        return parts.isEmpty ? "—" : parts.joined(separator: " · ")
    }

    // MARK: kinds (ui/bubble/Kinds)

    /// The web's and this app's position message: "📍 50.08804, 14.42076 (±12 m) https://…" ("📍 live …" while sharing).
    private static let position = try? NSRegularExpression(pattern: "^\\s*📍\\s*(?:live\\s+)?(-?\\d{1,2}(?:\\.\\d+)?),\\s*(-?\\d{1,3}(?:\\.\\d+)?)(?:\\s*\\(±\\s*(\\d+)\\s*m\\))?")

    static func isPositionMessage(_ m: ChatMessage) -> Bool {
        guard m.sealed == nil, let re = position else { return false }
        return re.firstMatch(in: m.text, range: NSRange(m.text.startIndex..., in: m.text)) != nil
    }

    static func hasPosition(_ m: ChatMessage) -> Bool {
        if let loc = m.loc, let lat = loc.double("lat"), let lon = loc.double("lon"), abs(lat) <= 90, abs(lon) <= 180 { return true }
        guard m.sealed == nil, let re = position,
              let mt = re.firstMatch(in: m.text, range: NSRange(m.text.startIndex..., in: m.text)),
              let la = Range(mt.range(at: 1), in: m.text), let lo = Range(mt.range(at: 2), in: m.text),
              let lat = Double(m.text[la]), let lon = Double(m.text[lo]) else { return false }
        return abs(lat) <= 90 && abs(lon) <= 180
    }

    /// Kinds.of: text, file, image, audio, video, location, tap, vanish, sealed, fn, private, forwarded, reply, transcript.
    static func kindsOf(_ m: ChatMessage) -> [String] {
        var k = [String]()
        let mime = (m.fileMime ?? "").lowercased()
        if !m.text.isEmpty && !isPositionMessage(m) { k.append("text") }
        if m.fileName != nil {
            k.append(m.fileImage || mime.hasPrefix("image/") ? "image" : mime.hasPrefix("audio/") ? "audio" : mime.hasPrefix("video/") ? "video" : "file")
        }
        if hasPosition(m) { k.append("location") }
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

    static func kinds(_ m: ChatMessage, forwardVerified: Bool, t: (String) -> String) -> [String] {
        kindsOf(m).map { k in
            var label = word(t, "msginfo.kind.", k)
            switch k {
            case "vanish": label += " · \(m.vanishSeconds) s"
            case "private": label += " · " + m.to.joined(separator: ", ")
            case "forwarded": label += " · " + (m.forwardedFrom ?? "") + (forwardVerified ? " ✓" : "") // 6.12 P09: by key
            case "reply": if let s = m.replyToSender, !s.isEmpty { label += " · " + s }
            case "fn": if let kw = m.fnDraw?.optString("keyword"), !kw.isEmpty { label += " · /" + kw }
            default: break
            }
            return label
        }
    }

    // MARK: timeline and receipts

    /// The time of a step: only the time on the message's day, else the short day and the time.
    static func when(_ at: Int64, createdAt: Int64, lang: String, tz: TimeZone?) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = tz ?? .current
        let a = Date(timeIntervalSince1970: Double(at) / 1000), b = Date(timeIntervalSince1970: Double(createdAt) / 1000)
        return cal.isDate(a, inSameDayAs: b) ? Formats.timeSeconds(lang, at, tz: tz) : Formats.shortFull(lang, at, tz: tz)
    }

    static func timeline(_ m: ChatMessage, t: (String) -> String, lang: String, tz: TimeZone?) -> [MsgDetailsContent.Step] {
        var steps = m.timeline
        if !m.has("created") { steps.insert(ChatMessage.Step("created", m.createdAt, ""), at: 0) } // a message from before 6.2
        return steps.map { st in
            let meta = st.meta.isEmpty ? "" : " · " + word(t, "msginfo.meta.", st.meta)
            return .init(state: st.state, icon: icon(st.state), label: word(t, "msginfo.state.", st.state) + meta,
                         time: when(st.at, createdAt: m.createdAt, lang: lang, tz: tz))
        }
    }

    /// Per recipient: the relay's and the receipts' states with their times (older messages: the state alone).
    static func receipts(_ m: ChatMessage, peerName: (String) -> String?, t: (String) -> String, lang: String, tz: TimeZone?) -> [MsgDetailsContent.Row] {
        guard m.mine else { return [] }
        var order = [String]()
        var by = [String: [ChatMessage.Step]]()
        for st in m.timeline where !st.meta.isEmpty && perRecipient.contains(st.state) {
            if by[st.meta] == nil { order.append(st.meta) }
            by[st.meta, default: []].append(st)
        }
        var out = [MsgDetailsContent.Row]()
        for who in order {
            let states = by[who]!.map { word(t, "msginfo.state.", $0.state) + " " + when($0.at, createdAt: m.createdAt, lang: lang, tz: tz) }
            out.append(.init(label: word(t, "msginfo.meta.", who), value: states.joined(separator: " · ")))
        }
        var plainSeen = Set<String>()
        for (k, v) in m.receipts {
            let name = peerName(k) ?? k
            if by[name] != nil || plainSeen.contains(name) { continue }
            plainSeen.insert(name)
            out.append(.init(label: name, value: word(t, "msginfo.state.", v.stringValue ?? "")))
        }
        return out
    }
}
