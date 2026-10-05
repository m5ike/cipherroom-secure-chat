// The checks of a decrypted payload (client/src/lib/validate.ts
// validatePayload; android chat/Payloads.java): bounded fields, the sender
// bound to the channel it came from, never "us" or a reserved id, a clock not
// far in the future, inline attachments only of safe types (their data URL
// relabelled with the safe type), and — 6.1 — the message kinds (flags),
// recipients, expiry, the position, and receipts.

import Foundation
import M5Core

public enum Payloads {
    public static let idMax = 96, textMax = 64_000, nameMax = 48, replyMax = 400, dataUrlMax = 1_000_000, recipientsMax = 50, maxTtlMinutes = 10_080
    public static let vanishMin = 4, vanishMax = 7200
    public static let futureSkew: Int64 = 5 * 60 * 1000

    private static let safeMimes: Set<String> = [
        "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp",
        "audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/webm", "audio/aac", "audio/flac",
        "video/mp4", "video/webm", "video/ogg", "text/plain", "application/pdf",
    ]
    private static let inlineImages: Set<String> = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]

    /// A string of at most `max` UTF-16 units (Java's length), else nil.
    static func str(_ v: JSON?, _ max: Int) -> String? {
        guard let s = v?.stringValue, s.utf16.count <= max else { return nil }
        return s
    }

    /// The first `max` UTF-16 units (never a split surrogate pair).
    static func prefixUTF16(_ s: String, _ max: Int) -> String {
        if s.utf16.count <= max { return s }
        var units = Array(s.utf16.prefix(max))
        if let last = units.last, (0xD800...0xDBFF).contains(last) { units.removeLast() }
        return String(decoding: units, as: UTF16.self)
    }

    private static func isControl(_ u: Unicode.Scalar) -> Bool {
        let v = u.value
        return v <= 0x08 || v == 0x0b || v == 0x0c || (0x0e...0x1f).contains(v) || v == 0x7f
    }

    /// Control characters (but tab, LF, CR) removed, at most `max` units, `fallback` when empty.
    static func clean(_ v: JSON?, _ max: Int, _ fallback: String?) -> String? {
        var s = ""
        if let raw = v?.stringValue { s.unicodeScalars.append(contentsOf: raw.unicodeScalars.filter { !isControl($0) }) }
        s = prefixUTF16(s, max)
        return s.isEmpty ? fallback : s
    }

    public static func safeMime(_ mime: String?) -> String {
        let m = (mime ?? "").javaTrimmed.lowercased().components(separatedBy: ";")[0]
        return safeMimes.contains(m) ? m : "application/octet-stream"
    }

    public static func inlineImage(_ mime: String?) -> Bool { mime.map { inlineImages.contains($0) } ?? false }

    private static func fileNameBad(_ u: Unicode.Scalar) -> Bool {
        let v = u.value
        return v <= 0x1f || v == 0x7f || "<>:\"/\\|?*".unicodeScalars.contains(u) || (0x202a...0x202e).contains(v) || (0x2066...0x2069).contains(v)
    }

    /// safeFileName (validate.ts:44-48).
    public static func safeFileName(_ v: JSON?) -> String {
        var s = ""
        if let raw = v?.stringValue { for u in raw.unicodeScalars { if fileNameBad(u) { s += "_" } else { s.unicodeScalars.append(u) } } }
        s = s.javaTrimmed
        var dots = 0
        for u in s.unicodeScalars { if u == "." { dots += 1 } else { break } }
        if dots > 0 { s = "_" + String(s.unicodeScalars.dropFirst(dots)) } // a run of leading dots → one "_"
        if s.isEmpty { s = "file" }
        return prefixUTF16(s, 200)
    }

    /// 6.1: a receipt payload {kind:"receipt", ids, state}.
    public struct Receipt: Sendable, Equatable {
        public let ids: [String]
        public let state: String
    }

    /// A receipt from `transportSender` (not ours), else nil.
    public static func receipt(_ p: JSONObject?, transportSender: String?, myId: String) -> Receipt? {
        guard let p, p.string("kind") == "receipt", let senderId = str(p["senderId"], idMax), senderId != myId else { return nil }
        if let t = transportSender, senderId != t { return nil }
        let state = p.optString("state")
        guard state == "delivered" || state == "read", let ids = p.array("ids") else { return nil }
        var out = [String]()
        for v in ids where out.count < 50 { if let id = str(v, 80), !id.isEmpty { out.append(id) } }
        return out.isEmpty ? nil : Receipt(ids: out, state: state)
    }

    /// org.json's optString(key, ""): a string as is, another value as its JSON text, "" when absent.
    static func orgString(_ v: JSON?) -> String {
        guard let v else { return "" }
        if let s = v.stringValue { return s }
        return v.isNull ? "null" : v.stringify()
    }

    /// The message of an acceptable payload; nil when it is not acceptable (it is then not shown).
    public static func validate(_ p: JSONObject?, transportSender: String?, myId: String, now: Int64) -> ChatMessage? {
        guard let p, let id = str(p["id"], idMax), !id.isEmpty, let senderId = str(p["senderId"], idMax), !senderId.isEmpty else { return nil }
        if ["system", "self", "server", "admin"].contains(senderId) { return nil }
        if ModelIdentity.reservedSender(senderId) { return nil }
        if senderId == myId { return nil }
        if let t = transportSender, senderId != t { return nil }
        var createdAt = now
        if let c = p["createdAt"]?.numberValue, c.double.isFinite { createdAt = min(c.int64 ?? Int64(c.double.rounded(.towardZero)), now + futureSkew) }
        let tail = String(decoding: senderId.utf16.suffix(4), as: UTF16.self)
        var m = ChatMessage()
        m.id = id
        m.senderId = senderId
        m.senderName = clean(p["senderName"], nameMax, "peer-" + tail) ?? ""
        m.createdAt = createdAt
        let kind = orgString(p["kind"])
        if kind == "audio-status" {
            let s = p.optString("status")
            guard ["off", "joining", "live", "muted"].contains(s) else { return nil }
            m.kind = "audio-status"
            m.text = s
            return m
        }
        if !kind.isEmpty && kind != "text" { return nil }
        let t = p["text"]
        let text: String? = t == nil || t == .null ? "" : str(t, textMax)
        guard let text else { return nil }
        m.text = text
        if let a = p.object("attachment") { attachment(a, &m) }
        if m.text.isEmpty && m.fileName == nil { return nil }
        if let ttl = p["ttlMinutes"]?.doubleValue, ttl > 0 {
            let minutes = min(Double(maxTtlMinutes), ttl)
            m.ttlMinutes = Int(minutes.rounded(.up))
            m.expiresAt = createdAt + javaRound(minutes * 60_000)
        }
        if let f = p.object("flags") { flags(f, &m) }
        if let to = p.array("to") {
            for v in to where m.to.count < recipientsMax { if v.stringValue != nil { m.to.append(clean(v, nameMax, "?") ?? "?") } }
        }
        if let r = p.object("replyTo"), str(r["id"], idMax) != nil {
            m.replyToId = r.optString("id")
            m.replyToSender = clean(r["senderName"], nameMax, "")
            m.replyToText = clean(r["text"], replyMax, "")
        }
        if p.string("forwardedFrom") != nil { m.forwardedFrom = clean(p["forwardedFrom"], nameMax, nil) }
        m.loc = location(p.object("loc"))
        return m
    }

    /// validateAttachment (validate.ts:58-81).
    static func attachment(_ a: JSONObject, _ m: inout ChatMessage) {
        guard var dataUrl = str(a["dataUrl"], dataUrlMax) else { return }
        let mime = safeMime(a.optString("mime"))
        if !dataUrl.isEmpty {
            // ^data:([^;,]*)(;base64)?,  (case-insensitive)
            guard dataUrl.utf8.count >= 5, dataUrl.prefix(5).lowercased() == "data:" else { return }
            let rest = dataUrl.dropFirst(5)
            guard let comma = rest.firstIndex(of: ",") else { return }
            let head = rest[..<comma]
            var base64 = false
            if let semi = head.firstIndex(of: ";") {
                if head[semi...].lowercased() != ";base64" { return }
                base64 = true
            }
            dataUrl = "data:" + mime + (base64 ? ";base64" : "") + "," + rest[rest.index(after: comma)...]
        }
        m.fileName = safeFileName(a["name"])
        m.fileMime = mime
        // Shown as a picture only when the sender said so and the type is a safe image (validate.ts:74).
        m.fileImage = a.optString("kind") == "image" && inlineImage(mime)
        if let size = a["size"]?.doubleValue, size >= 0 { m.fileSize = Int64(size.rounded(.down)) } else { m.fileSize = 0 }
        m.fileDataUrl = dataUrl.isEmpty ? nil : dataUrl
    }

    /// Java's Math.round (half up).
    static func javaRound(_ d: Double) -> Int64 { Int64((d + 0.5).rounded(.down)) }

    /// validateFlags (validate.ts:85-113).
    static func flags(_ f: JSONObject, _ m: inout ChatMessage) {
        if f["tap"] == .bool(true) { m.tap = true }
        if let v = f["vanishSeconds"]?.doubleValue, v > 0 { m.vanishSeconds = Int(max(Int64(vanishMin), min(Int64(vanishMax), javaRound(v)))) }
        if let s = f.object("sealed"), let salt = str(s["salt"], 64), let iv = str(s["iv"], 64), !salt.isEmpty, !iv.isEmpty {
            var meta = JSONObject([("salt", .string(salt)), ("iv", .string(iv))])
            if let v = s["v"]?.doubleValue { meta["v"] = .int(Int64(v.rounded(.towardZero))) }
            if let it = s["it"]?.numberValue {
                let n = it.int64 ?? Int64(it.double.rounded(.towardZero))
                if n >= 100_000 && n <= 5_000_000 && Double(n) == it.double { meta["it"] = .int(n) }
            }
            m.sealed = meta
        }
        if let fn = f.object("fn") { m.fn = fnMeta(fn) }
    }

    private static func matchesModel(_ s: String) -> Bool {
        let u = Array(s.utf8)
        guard !u.isEmpty, u.count <= 64 else { return false }
        func lowerDigit(_ c: UInt8) -> Bool { (97...122).contains(c) || (48...57).contains(c) }
        return lowerDigit(u[0]) && u.dropFirst().allSatisfy { lowerDigit($0) || $0 == 95 || $0 == 45 }
    }

    private static func matchesChain(_ s: String) -> Bool {
        guard s.hasPrefix("chn_") else { return false }
        let rest = Array(s.utf8.dropFirst(4))
        return rest.count >= 6 && rest.count <= 40 && rest.allSatisfy { (97...122).contains($0) || (48...57).contains($0) }
    }

    /// flags.fn (validate.ts:97-111); outputs are checked when they are drawn (FnOutputs).
    static func fnMeta(_ f: JSONObject) -> JSONObject? {
        guard let keyword = str(f["keyword"], 40), !keyword.isEmpty else { return nil }
        var o = JSONObject([("keyword", .string(keyword)), ("name", .string(clean(f["name"], 120, keyword) ?? keyword))])
        let model = f.optString("model")
        if matchesModel(model) { o["model"] = .string(model) }
        if let icon = ModelIdentity.safeIcon(f["icon"]) { o["icon"] = .string(icon) }
        let chain = f.optString("chain")
        if matchesChain(chain) { o["chain"] = .string(chain) }
        if let call = f["call"]?.doubleValue, call == call.rounded(.down), call >= 0, call <= 9999 { o["call"] = .int(Int64(call)) }
        if let ev = f.array("events") {
            var keep = [JSON]()
            var seen = Set<String>()
            for e in ev {
                let s = orgString(e)
                if ["response", "button", "form", "error"].contains(s) && seen.insert(s).inserted { keep.append(.string(s)) }
            }
            o["events"] = .array(keep)
        }
        if let outs = f.array("outputs"), JSON.array(outs).stringify().utf16.count <= 900_000 {
            o["outputs"] = .array(Array(outs.filter { $0.objectValue != nil }.prefix(50)))
        }
        if f.optString("origin") == "error" { o["origin"] = "error" }
        return o
    }

    /// 6.1 loc: {lat −90..90, lon −180..180, acc ≥ 0, at}, rounded to 5 decimals.
    static func location(_ l: JSONObject?) -> JSONObject? {
        guard let l, let lat = l["lat"]?.doubleValue, let lon = l["lon"]?.doubleValue, lat.isFinite, lon.isFinite,
              lat >= -90, lat <= 90, lon >= -180, lon <= 180 else { return nil }
        var o = JSONObject([("lat", .double(Double(javaRound(lat * 1e5)) / 1e5)), ("lon", .double(Double(javaRound(lon * 1e5)) / 1e5))])
        if let acc = l["acc"]?.doubleValue, acc >= 0, acc < 1e6 { o["acc"] = .int(javaRound(acc)) }
        if let at = l["at"]?.numberValue { o["at"] = .int(at.int64 ?? Int64(at.double.rounded(.towardZero))) }
        return o
    }
}
