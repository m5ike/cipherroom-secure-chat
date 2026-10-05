// The SVG path language (M L H V C S Q T A Z, absolute and relative) into a
// geometry model the UI layer strokes — a port of android/…/ui/SvgPath.java
// (enough for every Lucide icon); arcs become cubic Béziers of at most 90°
// each, as the SVG spec's conversion describes. And the Lucide shapes
// (path, circle, ellipse, rect, line, polyline, polygon) of icons.json.

import Foundation

public struct IconPoint: Sendable, Hashable {
    public var x: Double, y: Double
    public init(_ x: Double, _ y: Double) { self.x = x; self.y = y }
}

public struct IconRect: Sendable, Hashable {
    public var x: Double, y: Double, width: Double, height: Double
    public init(x: Double, y: Double, width: Double, height: Double) { self.x = x; self.y = y; self.width = width; self.height = height }
}

/// One step of a path, in the icon's 24 × 24 view box.
public enum PathElement: Sendable, Hashable {
    case move(IconPoint)
    case line(IconPoint)
    case quad(control: IconPoint, to: IconPoint)
    case cubic(control1: IconPoint, control2: IconPoint, to: IconPoint)
    case close
    /// A circle or an ellipse (Path.addCircle / addOval).
    case ellipse(IconRect)
    /// A rectangle with rounded corners (Path.addRoundRect).
    case roundedRect(IconRect, rx: Double, ry: Double)
}

public enum SvgPath {
    private struct Reader {
        let s: [UInt16]
        var i = 0
        init(_ d: String) { s = Array(d.utf16) }
        mutating func skip() { while i < s.count && (JavaSemantics.isWhitespace(s[i]) || s[i] == 0x2C) { i += 1 } }
        mutating func more() -> Bool { skip(); return i < s.count }
        mutating func isCommand() -> Bool { skip(); return i < s.count && JavaSemantics.isLetter(s[i]) && s[i] != 0x65 && s[i] != 0x45 }
        mutating func command() -> UInt16 { skip(); defer { i += 1 }; return s[i] }
        mutating func number() -> Double {
            skip()
            let start = i
            if i < s.count && (s[i] == 0x2D || s[i] == 0x2B) { i += 1 }
            var dot = false, exp = false
            while i < s.count {
                let c = s[i]
                if c >= 0x30 && c <= 0x39 { i += 1 }
                else if c == 0x2E && !dot && !exp { dot = true; i += 1 }
                else if (c == 0x65 || c == 0x45) && !exp {
                    exp = true; i += 1
                    if i < s.count && (s[i] == 0x2D || s[i] == 0x2B) { i += 1 }
                } else { break }
            }
            if start == i { return 0 }
            return Double(Float(JavaSemantics.parseDouble(JavaSemantics.string(s[start..<i])) ?? 0))
        }
        /// Arc flags may be written without separators ("a1 1 0 01 1 1").
        mutating func flag() -> Bool { skip(); guard i < s.count else { return false }; defer { i += 1 }; return s[i] == 0x31 }
    }

    private static func lower(_ c: UInt16) -> Bool { c >= 0x61 && c <= 0x7A }
    private static func upper(_ c: UInt16) -> UInt16 { lower(c) ? c - 0x20 : c }

    /// The path's elements. A command this parser does not know ends the path (as Android's).
    public static func parse(_ d: String) -> [PathElement] {
        var p: [PathElement] = []
        var r = Reader(d)
        var x = 0.0, y = 0.0, sx = 0.0, sy = 0.0, cx = 0.0, cy = 0.0, qx = 0.0, qy = 0.0
        var cmd: UInt16 = 0x4D, prev: UInt16 = 0x20
        while r.more() {
            let before = r.i, elementsBefore = p.count
            if r.isCommand() { cmd = r.command() }
            else if cmd == 0x4D { cmd = 0x4C }
            else if cmd == 0x6D { cmd = 0x6C }
            let rel = lower(cmd)
            switch upper(cmd) {
            case 0x4D: // M
                var nx = r.number(), ny = r.number()
                if rel { nx += x; ny += y }
                p.append(.move(IconPoint(nx, ny))); x = nx; sx = nx; y = ny; sy = ny
            case 0x4C: // L
                var nx = r.number(), ny = r.number()
                if rel { nx += x; ny += y }
                p.append(.line(IconPoint(nx, ny))); x = nx; y = ny
            case 0x48: // H
                var nx = r.number()
                if rel { nx += x }
                p.append(.line(IconPoint(nx, y))); x = nx
            case 0x56: // V
                var ny = r.number()
                if rel { ny += y }
                p.append(.line(IconPoint(x, ny))); y = ny
            case 0x43: // C
                var x1 = r.number(), y1 = r.number(), x2 = r.number(), y2 = r.number(), nx = r.number(), ny = r.number()
                if rel { x1 += x; y1 += y; x2 += x; y2 += y; nx += x; ny += y }
                p.append(.cubic(control1: IconPoint(x1, y1), control2: IconPoint(x2, y2), to: IconPoint(nx, ny))); cx = x2; cy = y2; x = nx; y = ny
            case 0x53: // S
                var x2 = r.number(), y2 = r.number(), nx = r.number(), ny = r.number()
                if rel { x2 += x; y2 += y; nx += x; ny += y }
                let pu = upper(prev)
                let smooth = pu == 0x43 || pu == 0x53
                let x1 = smooth ? 2 * x - cx : x, y1 = smooth ? 2 * y - cy : y
                p.append(.cubic(control1: IconPoint(x1, y1), control2: IconPoint(x2, y2), to: IconPoint(nx, ny))); cx = x2; cy = y2; x = nx; y = ny
            case 0x51: // Q
                var x1 = r.number(), y1 = r.number(), nx = r.number(), ny = r.number()
                if rel { x1 += x; y1 += y; nx += x; ny += y }
                p.append(.quad(control: IconPoint(x1, y1), to: IconPoint(nx, ny))); qx = x1; qy = y1; x = nx; y = ny
            case 0x54: // T
                var nx = r.number(), ny = r.number()
                if rel { nx += x; ny += y }
                let pu = upper(prev)
                let smooth = pu == 0x51 || pu == 0x54
                let x1 = smooth ? 2 * x - qx : x, y1 = smooth ? 2 * y - qy : y
                p.append(.quad(control: IconPoint(x1, y1), to: IconPoint(nx, ny))); qx = x1; qy = y1; x = nx; y = ny
            case 0x41: // A
                let rx = r.number(), ry = r.number(), rot = r.number()
                let large = r.flag(), sweep = r.flag()
                var nx = r.number(), ny = r.number()
                if rel { nx += x; ny += y }
                arc(&p, x, y, nx, ny, rx, ry, rot, large, sweep)
                x = nx; y = ny
            case 0x5A: // Z
                p.append(.close); x = sx; y = sy
            default:
                return p
            }
            prev = cmd
            // Android loops for ever on a stray character; here a step that read nothing ends the path.
            if r.i == before { p.removeLast(p.count - elementsBefore); break }
        }
        return p
    }

    /// SVG 1.1 F.6.5: endpoint to centre parameterisation, then ≤ 90° cubic pieces.
    static func arc(_ p: inout [PathElement], _ x0: Double, _ y0: Double, _ x: Double, _ y: Double, _ rx0: Double, _ ry0: Double, _ angle: Double, _ large: Bool, _ sweep: Bool) {
        if rx0 == 0 || ry0 == 0 { p.append(.line(IconPoint(x, y))); return }
        if x0 == x && y0 == y { return }
        var rx = abs(rx0), ry = abs(ry0)
        let phi = (angle.truncatingRemainder(dividingBy: 360)) * .pi / 180, cosv = cos(phi), sinv = sin(phi)
        let dx = (x0 - x) / 2, dy = (y0 - y) / 2
        let x1 = cosv * dx + sinv * dy, y1 = -sinv * dx + cosv * dy
        let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if lambda > 1 { let s = sqrt(lambda); rx *= s; ry *= s }
        let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
        let den = rx * rx * y1 * y1 + ry * ry * x1 * x1
        let coef = (large != sweep ? 1.0 : -1.0) * sqrt(max(0, num / den))
        let cx1 = coef * (rx * y1 / ry), cy1 = coef * -(ry * x1 / rx)
        let cx = cosv * cx1 - sinv * cy1 + (x0 + x) / 2, cy = sinv * cx1 + cosv * cy1 + (y0 + y) / 2
        let theta1 = angleBetween(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
        var delta = angleBetween((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
        if !sweep && delta > 0 { delta -= 2 * .pi } else if sweep && delta < 0 { delta += 2 * .pi }
        let segments = Int((abs(delta) / (.pi / 2)).rounded(.up))
        guard segments > 0 else { return }
        let step = delta / Double(segments)
        let t = 4.0 / 3.0 * tan(step / 4)
        var a = theta1
        for _ in 0..<segments {
            let c1 = cos(a), s1 = sin(a), c2 = cos(a + step), s2 = sin(a + step)
            let e1x = c1 - t * s1, e1y = s1 + t * c1, e2x = c2 + t * s2, e2y = s2 - t * c2
            p.append(.cubic(control1: IconPoint(cx + rx * e1x * cosv - ry * e1y * sinv, cy + rx * e1x * sinv + ry * e1y * cosv),
                            control2: IconPoint(cx + rx * e2x * cosv - ry * e2y * sinv, cy + rx * e2x * sinv + ry * e2y * cosv),
                            to: IconPoint(cx + rx * c2 * cosv - ry * s2 * sinv, cy + rx * c2 * sinv + ry * s2 * cosv)))
            a += step
        }
    }

    private static func angleBetween(_ ux: Double, _ uy: Double, _ vx: Double, _ vy: Double) -> Double { atan2(ux * vy - uy * vx, ux * vx + uy * vy) }
}
