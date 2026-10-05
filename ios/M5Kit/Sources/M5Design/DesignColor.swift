// Colours as the design writes them: "#rrggbb", "#aarrggbb" (Android's order,
// alpha first), a few CSS-like names (android.graphics.Color.parseColor), or a
// theme token "@primary" resolved by Design.color.

import Foundation

/// An sRGB colour, 0xAARRGGBB like Android's ints.
public struct DesignColor: Sendable, Hashable, CustomStringConvertible {
    public let argb: UInt32

    public init(argb: UInt32) { self.argb = argb }
    public init(rgb: UInt32) { argb = 0xFF00_0000 | (rgb & 0xFF_FFFF) }

    public var alpha: Double { Double(argb >> 24 & 0xFF) / 255 }
    public var red: Double { Double(argb >> 16 & 0xFF) / 255 }
    public var green: Double { Double(argb >> 8 & 0xFF) / 255 }
    public var blue: Double { Double(argb & 0xFF) / 255 }
    public var alpha8: Int { Int(argb >> 24 & 0xFF) }
    public var red8: Int { Int(argb >> 16 & 0xFF) }
    public var green8: Int { Int(argb >> 8 & 0xFF) }
    public var blue8: Int { Int(argb & 0xFF) }

    /// "#rrggbb" (opaque) or "#aarrggbb".
    public var hex: String { alpha8 == 255 ? String(format: "#%06x", argb & 0xFF_FFFF) : String(format: "#%08x", argb) }
    public var description: String { hex }

    /// Ui.alpha: the same colour with its alpha multiplied by `a`.
    public func withAlpha(_ a: Double) -> DesignColor {
        let na = UInt32(max(0, min(255, JavaSemantics.roundInt(Double(alpha8) * a))))
        return DesignColor(argb: na << 24 | (argb & 0xFF_FFFF))
    }

    public static let black = DesignColor(argb: 0xFF00_0000)
    public static let white = DesignColor(argb: 0xFFFF_FFFF)
    public static let transparent = DesignColor(argb: 0)
    public static let red = DesignColor(argb: 0xFFFF_0000)
    public static let blue = DesignColor(argb: 0xFF00_00FF)
    public static let gray = DesignColor(argb: 0xFF88_8888)
    public static let lightGray = DesignColor(argb: 0xFFCC_CCCC)
    public static let magenta = DesignColor(argb: 0xFFFF_00FF)

    private static let names: [String: UInt32] = [
        "black": 0xFF00_0000, "darkgray": 0xFF44_4444, "gray": 0xFF88_8888, "lightgray": 0xFFCC_CCCC, "white": 0xFFFF_FFFF,
        "red": 0xFFFF_0000, "green": 0xFF00_FF00, "blue": 0xFF00_00FF, "yellow": 0xFFFF_FF00, "cyan": 0xFF00_FFFF, "magenta": 0xFFFF_00FF,
        "aqua": 0xFF00_FFFF, "fuchsia": 0xFFFF_00FF, "darkgrey": 0xFF44_4444, "grey": 0xFF88_8888, "lightgrey": 0xFFCC_CCCC,
        "lime": 0xFF00_FF00, "maroon": 0xFF80_0000, "navy": 0xFF00_0080, "olive": 0xFF80_8000, "purple": 0xFF80_0080,
        "silver": 0xFFC0_C0C0, "teal": 0xFF00_8080,
    ]

    /// android.graphics.Color.parseColor: nil where Android throws.
    public static func parse(_ s: String) -> DesignColor? {
        if s.hasPrefix("#") {
            var body = Substring(s.dropFirst())
            var negative = false
            if body.first == "+" || body.first == "-" { negative = body.first == "-"; body = body.dropFirst() }
            guard !body.isEmpty, body.allSatisfy({ $0.isHexDigit && $0.isASCII }), body.count <= 16, var v = UInt64(body, radix: 16) else { return nil }
            if negative { v = UInt64(bitPattern: -Int64(bitPattern: v)) }
            let len = s.utf16.count
            if len == 7 { v |= 0xFF00_0000 } else if len != 9 { return nil }
            return DesignColor(argb: UInt32(truncatingIfNeeded: v))
        }
        guard let v = names[s.lowercased()] else { return nil }
        return DesignColor(argb: v)
    }

    /// WCAG relative luminance.
    public var luminance: Double {
        func lin(_ v: Int) -> Double { let c = Double(v) / 255; return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        return 0.2126 * lin(red8) + 0.7152 * lin(green8) + 0.0722 * lin(blue8)
    }

    /// Renderer.contrast: near-black on a light colour, white on a dark one (badges).
    public var badgeContrast: DesignColor {
        let l = (0.299 * Double(red8) + 0.587 * Double(green8) + 0.114 * Double(blue8)) / 255
        return l > 0.6 ? DesignColor(argb: 0xFF1C_2330) : .white
    }
}
