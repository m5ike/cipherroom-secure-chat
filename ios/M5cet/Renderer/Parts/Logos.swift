// The slots "logo" and "splashLogo" — android/…/ui/parts/Logos.java: the M5cet mark
// drawn in code (crisp at any size, coloured by the theme's primary / onPrimary) and
// its animated splash variant — orbiting dots, a pulse or a reveal, as the design's
// animations.splash chooses and times it (still when the system asks for less motion).

import M5Design
import SwiftUI

enum M5Mark {
    /// Logos.drawMark: a rounded square with the "M" stroke.
    static func draw(_ c: inout GraphicsContext, cx: CGFloat, cy: CGFloat, size: CGFloat, color: Color, on: Color) {
        let h = size / 2
        let square = Path(roundedRect: CGRect(x: cx - h, y: cy - h, width: size, height: size), cornerRadius: size * 0.28, style: .circular)
        c.fill(square, with: .color(color))
        var m = Path()
        let l = cx - size * 0.28, r = cx + size * 0.28, top = cy - size * 0.2, bot = cy + size * 0.22
        m.move(to: CGPoint(x: l, y: bot))
        m.addLine(to: CGPoint(x: l, y: top))
        m.addLine(to: CGPoint(x: cx, y: cy + size * 0.04))
        m.addLine(to: CGPoint(x: r, y: top))
        m.addLine(to: CGPoint(x: r, y: bot))
        c.stroke(m, with: .color(on), style: StrokeStyle(lineWidth: size * 0.085, lineCap: .round, lineJoin: .round))
    }
}

/// Logos.Mark: the mark, 56 pt unless the design sizes it.
struct M5MarkView: View {
    let primary: Color
    let onPrimary: Color

    var body: some View {
        Canvas { c, size in
            M5Mark.draw(&c, cx: size.width / 2, cy: size.height / 2, size: min(size.width, size.height), color: primary, on: onPrimary)
        }
        .frame(idealWidth: 56, idealHeight: 56)
        .accessibilityHidden(true)
    }
}

/// Logos.Splash: 168 pt, the design's style (orbit | pulse | reveal | none) and period (animations.splash.ms, ≥ 300 ms).
struct M5SplashLogo: View {
    let style: String
    let period: Double
    let still: Bool
    let primary: Color
    let onPrimary: Color

    var body: some View {
        TimelineView(.animation(paused: still || style == "none")) { tl in
            let t = still || style == "none" ? 0 : tl.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period) / period
            Canvas { c, size in draw(&c, size, CGFloat(t)) }
        }
        .frame(idealWidth: 168, idealHeight: 168)
        .accessibilityHidden(true)
    }

    private func draw(_ c: inout GraphicsContext, _ size: CGSize, _ t: CGFloat) {
        let cx = size.width / 2, cy = size.height / 2, s = min(size.width, size.height)
        let mark = s * 0.42
        let ring = StrokeStyle(lineWidth: 2)
        func circle(_ r: CGFloat) -> Path { Path(ellipseIn: CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r)) }
        switch style {
        case "pulse":
            for i in 0..<3 {
                let p = (t + CGFloat(i) / 3).truncatingRemainder(dividingBy: 1)
                c.stroke(circle(mark * 0.55 + p * s * 0.32), with: .color(primary.opacity(1 - p)), style: ring)
            }
            M5Mark.draw(&c, cx: cx, cy: cy, size: mark * (1 + 0.04 * sin(t * .pi * 2)), color: primary, on: onPrimary)
        case "reveal":
            let p = min(1, t * 1.4)
            var clipped = c
            clipped.clip(to: Path(CGRect(x: cx - s / 2, y: cy + s / 2 - s * p, width: s, height: s * p)))
            M5Mark.draw(&clipped, cx: cx, cy: cy, size: mark, color: primary, on: onPrimary)
            var arc = Path()
            arc.addArc(center: CGPoint(x: cx, y: cy), radius: s * 0.4, startAngle: .degrees(-90), endAngle: .degrees(-90 + 360 * Double(t)), clockwise: false)
            c.stroke(arc, with: .color(primary.opacity(0.35)), style: ring)
        default:
            // Orbit: three dots circling the mark on two rings.
            let r1 = s * 0.40, r2 = s * 0.31
            c.stroke(circle(r1), with: .color(primary.opacity(0.18)), style: ring)
            c.stroke(circle(r2), with: .color(primary.opacity(0.18)), style: ring)
            for i in 0..<3 {
                let a = (t + CGFloat(i) / 3) * .pi * 2 * (i % 2 == 0 ? 1 : -1)
                let r = i == 1 ? r2 : r1
                let dot: CGFloat = i == 0 ? 6 : 4.5
                let x = cx + cos(a) * r, y = cy + sin(a) * r
                c.fill(Path(ellipseIn: CGRect(x: x - dot, y: y - dot, width: 2 * dot, height: 2 * dot)),
                       with: .color(primary.opacity(0.55 + 0.45 * (i == 0 ? 1 : 0.6))))
            }
            M5Mark.draw(&c, cx: cx, cy: cy, size: mark * (0.96 + 0.04 * sin(t * .pi * 4)), color: primary, on: onPrimary)
        }
    }
}
