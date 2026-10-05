// Card numbers and track data out of sight (6.10, G-19) — client/src/lib/nfc/
// pan-mask.ts and A/nfc/TemplateViews.java (SENSITIVE, panOf, maskDigits,
// maskValue, Mask): the same rules on every platform, so a masked view reads the
// same. A payment card's number (PAN) and its tracks are in more than one place:
//
//   5A          the PAN, BCD                         5413330089020011
//   57, 9F6B    Track 2 (equivalent) data, BCD       5413330089020011D2812…
//   56          Track 1 data, ASCII                  B5413330089020011^NOVAK/JAN^2812…
//   9F1F, 9F20  Track 1 / Track 2 discretionary data
//
// Masking keeps a PAN's first six and last four digits and hides the rest with
// "X" — in BCD hex, in ASCII hex (the digits' codes) and in text; the track data
// after the PAN (57 / 9F6B after the "D", the rest of 56, all of 9F1F / 9F20) is
// "X" throughout. Hex keeps its length, so JSON stays valid. Pure. Never weaken.

import Foundation
import M5Core

public enum PanMask {
    /// The elements that carry the card number or track data.
    public static let panTags: [String] = ["5A", "57", "9F6B", "56", "9F1F", "9F20"]
    public static let sensitive: Set<String> = Set(panTags)

    static func xs(_ n: Int) -> String { String(repeating: "X", count: max(0, n)) }

    static let track1 = "^(%?B?)(\\d{12,19})\\^"

    /// "5413330089020011" → "541333XXXXXX0011" (`ch` "•" for display: "541333••••••0011").
    public static func maskPanDigits(_ pan: String, _ ch: String = "X") -> String {
        pan.count >= 10 ? String(pan.prefix(6)) + String(repeating: ch, count: pan.count - 10) + String(pan.suffix(4)) : pan
    }

    /// BCD digits (a trailing F kept): the first six and the last four, X between (fewer than ten: all X).
    public static func maskDigits(_ digits: String) -> String {
        let core = digits.replacingRegex("F+$", with: "")
        let pad = String(digits.dropFirst(core.count))
        if core.count < 10 { return xs(core.count) + pad }
        return String(core.prefix(6)) + xs(core.count - 10) + String(core.suffix(4)) + pad
    }

    /// "54…" → "3534…": text as ASCII, in hex.
    public static func asciiHex(_ s: String) -> String { Hex.upper(Bytes.latin1(s)) }

    static func maskedAsciiHex(_ pan: String) -> String { asciiHex(String(pan.prefix(6))) + xs((pan.count - 10) * 2) + asciiHex(String(pan.suffix(4))) }

    /// Every BER-TLV element of `b` and where its value lies — (tag, start, length), nested ones too; a malformed tail ends the walk.
    public static func tlvNodes(_ b: [UInt8]) -> [(tag: Int, start: Int, length: Int)] {
        var out = [(tag: Int, start: Int, length: Int)]()
        func walk(_ from: Int, _ to: Int, _ depth: Int) {
            var off = from
            while off < to && depth < 16 {
                let first = Int(b[off])
                if first == 0x00 || first == 0xff { off += 1; continue }
                var i = off + 1, tag = first
                if first & 0x1f == 0x1f {
                    var guardCount = 0
                    while true {
                        if i >= to || guardCount > 3 { return }
                        guardCount += 1
                        let c = Int(b[i]); i += 1
                        tag = BerTlv.appendTagByte(tag, UInt8(c))
                        if c & 0x80 == 0 { break }
                    }
                }
                if i >= to { return }
                var len = Int(b[i]); i += 1
                if len > 0x80 {
                    let k = len & 0x7f
                    if k > 3 || i + k > to { return }
                    len = 0
                    for j in 0..<k { len = (len << 8) | Int(b[i + j]) }
                    i += k
                } else if len == 0x80 { return }
                if i + len > to { return }
                out.append((tag, i, len))
                if first & 0x20 != 0 { walk(i, i + len, depth + 1) }
                off = i + len
            }
        }
        walk(0, b.count, 0)
        return out
    }

    /// Whether the whole buffer is BER-TLV (every object complete, constructed ones too).
    public static func isTlv(_ b: [UInt8]) -> Bool {
        var off = 0, objects = 0
        let n = b.count
        while off < n {
            let first = Int(b[off])
            if first == 0x00 || first == 0xff { off += 1; continue }
            var i = off + 1
            if first & 0x1f == 0x1f {
                var guardCount = 0
                repeat {
                    if i >= n || guardCount > 3 { return false }
                    guardCount += 1
                    i += 1
                } while b[i - 1] & 0x80 != 0
            }
            if i >= n { return false }
            var len = Int(b[i]); i += 1
            if len > 0x80 {
                let k = len & 0x7f
                if k > 3 || i + k > n { return false }
                len = 0
                for j in 0..<k { len = (len << 8) | Int(b[i + j]) }
                i += k
            } else if len == 0x80 { return false }
            if i + len > n { return false }
            if first & 0x20 != 0 && len > 0 && !isTlv(Array(b[i..<(i + len)])) { return false }
            off = i + len
            objects += 1
        }
        return objects > 0
    }

    /// The card number an element carries: 5A, Track 2 before its "D" (57, 9F6B), Track 1 between "B" and "^" (56).
    public static func panOfElement(_ tag: String, _ v: [UInt8]) -> String? {
        switch JSText.upperASCII(tag) {
        case "5A":
            let h = Hex.upper(v).replacingRegex("F+$", with: "")
            return h.fullMatch("\\d{12,19}") ? h : nil
        case "57", "9F6B":
            let h = Hex.upper(v)
            guard let d = h.firstIndex(of: "D"), d > h.startIndex else { return nil }
            let p = String(h[..<d])
            return p.fullMatch("\\d{12,19}") ? p : nil
        case "56":
            return Bytes.latin1String(v).firstMatch(track1)?[2] ?? nil
        default: return nil
        }
    }

    /// The card numbers in an answer (hex): every 5A / 57 / 9F6B / 56 it holds.
    public static func pansInHex(_ dataHex: String?) -> [String] {
        let h = JSText.upperASCII(dataHex ?? "")
        guard Hex.isUpperHexBytes(h) else { return [] }
        let b = Hex.decodeLenient(h)
        var out = [String]()
        for n in tlvNodes(b) {
            if let p = panOfElement(BerTlv.tagHex(n.tag), Array(b[n.start..<(n.start + n.length)])), !out.contains(p) { out.append(p) }
        }
        return out
    }

    /// Whether an answer holds a card number or track data (masking would hide something).
    public static func answerMasks(_ dataHex: String?) -> Bool {
        let h = JSText.upperASCII(dataHex ?? "")
        guard Hex.isUpperHexBytes(h) else { return false }
        return tlvNodes(Hex.decodeLenient(h)).contains { sensitive.contains(BerTlv.tagHex($0.tag)) }
    }

    /// Every card number an EMV read holds: each application's PAN, and any in its elements or records.
    public static func pansOfEmv(_ d: NfcJSONObject?) -> [String] {
        var out = [String]()
        func add(_ p: String) { if !out.contains(p) { out.append(p) } }
        for a in (d?.optArray("apps") ?? []).compactMap(\.objectValue) {
            let pan = a.optString("pan")
            if pan.fullMatch("\\d{12,19}") { add(pan) }
            for list in ["tags", "getData"] {
                for t in (a.optArray(list) ?? []).compactMap(\.objectValue) {
                    let tag = t.optString("tag")
                    guard sensitive.contains(tag) else { continue }
                    let hx = JSText.upperASCII(t.optString("hex"))
                    guard Hex.isUpperHexBytes(hx), let p = panOfElement(tag, Hex.decodeLenient(hx)) else { continue }
                    add(p)
                }
            }
            for r in (a.optArray("records") ?? []).compactMap(\.objectValue) { pansInHex(r.optString("hex")).forEach(add) }
        }
        return out
    }

    /// A sensitive element's value (hex) as a masked view shows it.
    public static func maskValue(_ tag: String, _ valueHex: String) -> String {
        let h = JSText.upperASCII(valueHex)
        switch JSText.upperASCII(tag) {
        case "5A": return maskDigits(h)
        case "57", "9F6B":
            guard let dIdx = h.firstIndex(of: "D"), dIdx > h.startIndex else { return h.count <= 6 ? xs(h.count) : String(h.prefix(6)) + xs(h.count - 6) }
            let d = h.distance(from: h.startIndex, to: dIdx)
            return maskDigits(String(h.prefix(d))) + "D" + xs(h.count - d - 1)
        case "56":
            guard Hex.isUpperHexBytes(h), let m = Bytes.latin1String(Hex.decodeLenient(h)).firstMatch(track1), let pan = m[2] ?? nil, pan.count >= 10 else { return xs(h.count) }
            let head = asciiHex(m[1] ?? "") + maskedAsciiHex(pan)
            return head + xs(h.count - head.count)
        default: return xs(h.count)
        }
    }

    /// Text or hex with every given card number masked — as digits (BCD hex, text) and as their ASCII codes (ASCII hex).
    public static func maskPans(_ s: String, _ pans: [String]) -> String {
        var out = s
        for p in pans where p.fullMatch("\\d{12,19}") {
            out = out.replacingOccurrences(of: p, with: maskDigits(p))
            out = out.replacingOccurrences(of: asciiHex(p), with: maskedAsciiHex(p), options: .caseInsensitive)
        }
        return out
    }

    /// An answer (hex): its sensitive elements masked (when it is BER-TLV), then every PAN in BCD or ASCII hex.
    public static func maskAnswer(_ dataHex: String, _ pans: [String]) -> String {
        if dataHex.isEmpty { return dataHex }
        let h = JSText.upperASCII(dataHex)
        var s = h
        if Hex.isUpperHexBytes(h) {
            let b = Hex.decodeLenient(h)
            if isTlv(b) {
                let original = Array(h)
                var out = original
                for n in tlvNodes(b) {
                    let t = BerTlv.tagHex(n.tag)
                    guard sensitive.contains(t) else { continue }
                    let v = Array(maskValue(t, String(original[(n.start * 2)..<((n.start + n.length) * 2)])))
                    for i in 0..<v.count { out[n.start * 2 + i] = v[i] }
                }
                s = String(out)
            }
        }
        return maskPans(s, pans)
    }
}
