// A button's CSS colour (what Outputs.sanitizeButton lets through: #hex,
// rgb(), rgba(), hsl(), hsla(), a name) as an ARGB value — or nil when it
// cannot be read (an unknown name): the button keeps the theme's colour.
// A port of android fn/CssColor.java (which returns a signed Java int; here
// the same 32 bits are a UInt32).

import M5Core

/// CSS colours of function buttons (android `fn/CssColor.java`).
public enum CssColor {
    private static let names: [String: UInt32] = {
        let pairs = [
            "black", "000000", "white", "ffffff", "red", "ff0000", "green", "008000", "blue", "0000ff", "yellow", "ffff00",
            "orange", "ffa500", "purple", "800080", "gray", "808080", "grey", "808080", "silver", "c0c0c0", "maroon", "800000",
            "olive", "808000", "lime", "00ff00", "aqua", "00ffff", "cyan", "00ffff", "teal", "008080", "navy", "000080",
            "fuchsia", "ff00ff", "magenta", "ff00ff", "pink", "ffc0cb", "brown", "a52a2a", "gold", "ffd700", "indigo", "4b0082",
            "violet", "ee82ee", "coral", "ff7f50", "crimson", "dc143c", "tomato", "ff6347", "salmon", "fa8072", "turquoise", "40e0d0",
            "skyblue", "87ceeb", "steelblue", "4682b4", "royalblue", "4169e1", "darkgreen", "006400", "darkred", "8b0000",
            "orangered", "ff4500", "lightgray", "d3d3d3", "lightgrey", "d3d3d3", "darkgray", "a9a9a9", "darkgrey", "a9a9a9",
            "beige", "f5f5dc", "ivory", "fffff0", "khaki", "f0e68c", "lavender", "e6e6fa", "chocolate", "d2691e", "tan", "d2b48c",
        ]
        var m = [String: UInt32]()
        var i = 0
        while i < pairs.count { m[pairs[i]] = 0xFF00_0000 | UInt32(pairs[i + 1], radix: 16)!; i += 2 }
        m["transparent"] = 0
        return m
    }()

    /// The colour as ARGB (0xAARRGGBB), nil when it cannot be read.
    public static func parse(_ css: String?) -> UInt32? {
        guard let css else { return nil }
        let v = Js.lowerRoot(Js.trim(css))
        if v.utf16.first == 0x23 { return hex(Js.string(Array(v.utf16.dropFirst()))) }
        if let inner = call(v, "rgb") {
            guard inner.count == 3 || inner.count == 4 else { return names[v] }
            var nums = [(String, String)]()
            for p in inner { guard let n = number(p, unit: "%") else { return names[v] }; nums.append(n) }
            // "1.2.3" passes the pattern, not a number.
            guard let r = channel(nums[0]), let g = channel(nums[1]), let b = channel(nums[2]) else { return nil }
            guard let a = nums.count == 4 ? alpha(nums[3]) : 255 else { return nil }
            return argb(a, r, g, b)
        }
        if let inner = call(v, "hsl") {
            guard inner.count == 3 || inner.count == 4, let h = number(inner[0], unit: "deg") else { return names[v] }
            var rest = [(String, String)]()
            for p in inner.dropFirst() { guard let n = number(p, unit: "%") else { return names[v] }; rest.append(n) }
            guard let hue = Double(h.0), let s = Double(rest[0].0), let l = Double(rest[1].0) else { return nil }
            guard let a = rest.count == 3 ? alpha(rest[2]) : 255 else { return nil }
            return hsl(hue, s / 100, l / 100, a)
        }
        return names[v]
    }

    /// The parts of "name(…)" / "namea(…)" split at ",", or nil when v is no such call.
    private static func call(_ v: String, _ name: String) -> [String]? {
        let u = Array(v.utf16)
        var p = name.utf16.count
        guard u.starts(with: name.utf16) else { return nil }
        if p < u.count && u[p] == 0x61 { p += 1 }
        guard p < u.count, u[p] == 0x28, u.last == 0x29, u.count >= p + 2 else { return nil }
        return Js.split(Array(u[(p + 1)..<(u.count - 1)]), 0x2C).map { Js.string($0) }
    }

    /// \s*([\d.]+)(unit)?\s* → the number's text and the unit ("" without one).
    private static func number(_ part: String, unit: String) -> (String, String)? {
        var t = Array(Js.trim(part).utf16)
        var found = ""
        if t.count > unit.utf16.count && t.suffix(unit.utf16.count).elementsEqual(unit.utf16) {
            t.removeLast(unit.utf16.count)
            found = unit
        }
        guard !t.isEmpty, t.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2E }) else { return nil }
        return (Js.string(t), found)
    }

    private static func hex(_ h: String) -> UInt32? {
        let u = Array(h.utf8)
        guard !u.isEmpty, u.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }) else { return nil }
        func byte(_ s: [UInt8]) -> UInt32 { UInt32(String(decoding: s, as: UTF8.self), radix: 16)! }
        switch u.count {
        case 3, 4:
            var c = [UInt32](repeating: 255, count: 4)
            for i in 0..<u.count { c[i] = byte([u[i], u[i]]) }
            return argb(c[3], c[0], c[1], c[2])
        case 6, 8:
            let a = u.count == 8 ? byte(Array(u[6..<8])) : 255
            return argb(a, byte(Array(u[0..<2])), byte(Array(u[2..<4])), byte(Array(u[4..<6])))
        default:
            return nil
        }
    }

    private static func channel(_ n: (String, String)) -> UInt32? {
        guard let d = Double(n.0) else { return nil }
        return clamp(n.1.isEmpty ? d : d * 2.55)
    }

    private static func alpha(_ n: (String, String)) -> UInt32? {
        guard let d = Double(n.0) else { return nil }
        return clamp(n.1.isEmpty ? d * 255 : d * 2.55)
    }

    private static func clamp(_ d: Double) -> UInt32 { UInt32(Js.round(Swift.max(0, Swift.min(255, d)))) }

    private static func argb(_ a: UInt32, _ r: UInt32, _ g: UInt32, _ b: UInt32) -> UInt32 { a << 24 | r << 16 | g << 8 | b }

    private static func hsl(_ h: Double, _ s0: Double, _ l0: Double, _ a: UInt32) -> UInt32 {
        let hue = ((h.truncatingRemainder(dividingBy: 360)) + 360).truncatingRemainder(dividingBy: 360) / 360
        let s = Swift.max(0, Swift.min(1, s0))
        let l = Swift.max(0, Swift.min(1, l0))
        let q = l < 0.5 ? l * (1 + s) : l + s - l * s
        let p = 2 * l - q
        return argb(a, clamp(255 * channelOf(p, q, hue + 1 / 3.0)), clamp(255 * channelOf(p, q, hue)), clamp(255 * channelOf(p, q, hue - 1 / 3.0)))
    }

    private static func channelOf(_ p: Double, _ q: Double, _ t0: Double) -> Double {
        var t = t0
        if t < 0 { t += 1 }
        if t > 1 { t -= 1 }
        if t < 1 / 6.0 { return p + (q - p) * 6 * t }
        if t < 1 / 2.0 { return q }
        if t < 2 / 3.0 { return p + (q - p) * (2 / 3.0 - t) * 6 }
        return p
    }
}
