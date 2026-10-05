// The design's icons (android/…/ui/Icons.java + SvgPath.java): a Lucide name drawn as
// its SF Symbol (M5Design Icons.sfSymbol) when the running system has it, else the
// Lucide geometry of m5/icons.json stroked natively — 24 × 24 view box, 2 pt round
// strokes, `fill` shapes filled — tinted with one colour.

import M5Design
import SwiftUI
import UIKit

@MainActor
enum DesignIconCatalog {
    private static var symbolCache: [String: String?] = [:]

    /// The SF Symbol for a Lucide name when this system draws it.
    static func symbol(_ name: String) -> String? {
        if let cached = symbolCache[name] { return cached }
        let s = Icons.sfSymbol(name).flatMap { UIImage(systemName: $0) != nil ? $0 : nil }
        symbolCache[name] = s
        return s
    }

    static func shapes(_ name: String) -> [IconShape] { DesignAssets.icons.shapes(name) }
}

/// One icon, `size` points square.
struct DesignIcon: View {
    let name: String
    let size: CGFloat
    let color: Color

    var body: some View {
        Group {
            if let symbol = DesignIconCatalog.symbol(name) {
                Image(systemName: symbol)
                    .font(.system(size: size * 0.78, weight: .medium))
                    .foregroundStyle(color)
            } else {
                LucideIcon(shapes: DesignIconCatalog.shapes(name), color: color)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The Lucide geometry stroked (and filled where the icon says so), scaled to the frame.
struct LucideIcon: View {
    let shapes: [IconShape]
    let color: Color

    var body: some View {
        Canvas { ctx, size in
            let k = min(size.width, size.height) / Icons.viewBox
            let dx = (size.width - Icons.viewBox * k) / 2, dy = (size.height - Icons.viewBox * k) / 2
            for shape in shapes {
                let path = LucidePath.path(shape.elements, scale: k, dx: dx, dy: dy)
                if shape.fill {
                    ctx.fill(path, with: .color(color))
                } else {
                    ctx.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: Icons.strokeWidth * k, lineCap: .round, lineJoin: .round))
                }
            }
        }
    }
}

enum LucidePath {
    static func path(_ elements: [PathElement], scale k: CGFloat, dx: CGFloat, dy: CGFloat) -> Path {
        func p(_ q: IconPoint) -> CGPoint { CGPoint(x: dx + q.x * k, y: dy + q.y * k) }
        func r(_ q: IconRect) -> CGRect { CGRect(x: dx + q.x * k, y: dy + q.y * k, width: q.width * k, height: q.height * k) }
        var path = Path()
        for e in elements {
            switch e {
            case .move(let a): path.move(to: p(a))
            case .line(let a): if path.isEmpty { path.move(to: p(a)) } else { path.addLine(to: p(a)) }
            case .quad(let c, let to): path.addQuadCurve(to: p(to), control: p(c))
            case .cubic(let c1, let c2, let to): path.addCurve(to: p(to), control1: p(c1), control2: p(c2))
            case .close: path.closeSubpath()
            case .ellipse(let rect): path.addEllipse(in: r(rect))
            case .roundedRect(let rect, let rx, let ry):
                path.addRoundedRect(in: r(rect), cornerSize: CGSize(width: rx * k, height: ry * k), style: .circular)
            }
        }
        return path
    }
}
