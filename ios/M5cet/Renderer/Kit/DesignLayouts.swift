// Android's layouts as SwiftUI Layouts — the measuring rules of LinearLayout
// (column, row, card, sheet, a scroll's content), FrameLayout (stack) and
// ui/look/FlowLayout (a row that wraps), so a design lays out as on the phone:
// MATCH_PARENT / WRAP_CONTENT / dp sizes, weights sharing the free space (or the
// children's own sizes when the box wraps), gravity on both axes, margins with the
// parent's gap, the uniform width of match_parent children in a wrapping box.
//
// The proposal protocol between these layouts and the nodes they hold:
//   nil in a dimension     — "how big would you be?" (WRAP_CONTENT, unbounded)
//   a finite value         — "you are this big" (EXACTLY)
// A layout asks a child for its ideal width (nil, nil), clamps it to the room it
// has (AT_MOST), then asks its height at that width (w, nil), and finally places it
// with both sizes exact. Every node view therefore fills a finite proposal (leaves
// sit in a flexible frame, layouts take the bounds they get) and reports its
// content size for nil.

import M5Design
import SwiftUI

/// A node's LayoutParams, read by the parent layout.
struct NodeLayoutKey: LayoutValueKey {
    static let defaultValue = LayoutParams(width: .fill, height: .fill)
}

/// What a layout measured of its children during one layout pass (child, proposal) → size.
struct DesignLayoutCache {
    struct Key: Hashable { let index: Int; let w: CGFloat?; let h: CGFloat? }
    var sizes: [Key: CGSize] = [:]
}

private func finite(_ v: CGFloat?) -> CGFloat? {
    guard let v, v.isFinite else { return nil }
    return v
}

private struct Arrangement {
    var size: CGSize
    var frames: [CGRect]
}

/// Measures through the pass's cache; a size that is not finite counts as 0.
private struct Measurer {
    let subviews: LayoutSubviews
    var cache: DesignLayoutCache

    mutating func size(_ i: Int, _ w: CGFloat?, _ h: CGFloat?) -> CGSize {
        let key = DesignLayoutCache.Key(index: i, w: w, h: h)
        if let s = cache.sizes[key] { return s }
        var s = subviews[i].sizeThatFits(ProposedViewSize(width: w, height: h))
        if !s.width.isFinite || s.width < 0 { s.width = 0 }
        if !s.height.isFinite || s.height < 0 { s.height = 0 }
        cache.sizes[key] = s
        return s
    }

    /// WRAP_CONTENT, unbounded.
    mutating func ideal(_ i: Int) -> CGSize { size(i, nil, nil) }

    /// The height at a width.
    mutating func height(_ i: Int, at w: CGFloat) -> CGFloat { size(i, w, nil).height }
}

private extension M5Design.Dimension {
    var isFill: Bool { if case .fill = self { return true } else { return false } }
}

private func place(_ a: Arrangement, in bounds: CGRect, _ subviews: LayoutSubviews) {
    for (i, f) in a.frames.enumerated() where i < subviews.count {
        subviews[i].place(at: CGPoint(x: bounds.minX + f.minX, y: bounds.minY + f.minY), anchor: .topLeading, proposal: ProposedViewSize(f.size))
    }
}

// MARK: - LinearLayout

/// LinearLayout VERTICAL / HORIZONTAL with its gravity (the design's justify start / center / end).
struct DesignLinearLayout: Layout {
    var vertical: Bool
    var justify: ContainerSpec.Justify = .start
    /// ScrollView.setFillViewport: the content is at least this long on its axis (0: no minimum).
    var minMain: CGFloat = 0

    func makeCache(subviews: Subviews) -> DesignLayoutCache { DesignLayoutCache() }
    func updateCache(_ cache: inout DesignLayoutCache, subviews: Subviews) { cache = DesignLayoutCache() }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout DesignLayoutCache) -> CGSize {
        arrange(finite(proposal.width), finite(proposal.height), subviews, &cache).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout DesignLayoutCache) {
        place(arrange(bounds.width, bounds.height, subviews, &cache), in: bounds, subviews)
    }

    private func arrange(_ W: CGFloat?, _ H: CGFloat?, _ subviews: Subviews, _ cache: inout DesignLayoutCache) -> Arrangement {
        var m = Measurer(subviews: subviews, cache: cache)
        defer { cache = m.cache }
        if vertical {
            var a = Self.vertical(W, H, justify, &m)
            if H == nil, minMain > 0, a.size.height < minMain { a = Self.vertical(W, minMain, justify, &m) }
            return a
        }
        var a = Self.horizontal(W, H, justify, &m)
        if W == nil, minMain > 0, a.size.width < minMain { a = Self.horizontal(minMain, H, justify, &m) }
        return a
    }

    /// LinearLayout.measureVertical + layoutVertical.
    private static func vertical(_ W: CGFloat?, _ H: CGFloat?, _ justify: ContainerSpec.Justify, _ m: inout Measurer) -> Arrangement {
        let n = m.subviews.count
        let lps = m.subviews.map { $0[NodeLayoutKey.self] }
        var widths = [CGFloat](repeating: 0, count: n), heights = [CGFloat](repeating: 0, count: n)

        // The cross axis first (a text's height depends on its width).
        var maxW: CGFloat = 0, altMaxW: CGFloat = 0, allFill = true
        var fillLater: [Int] = []
        for i in 0..<n {
            let lp = lps[i], mh = lp.margin.left + lp.margin.right
            switch lp.width {
            case .points(let x): widths[i] = x
            case .fill:
                if let W { widths[i] = max(0, W - mh) } else { widths[i] = m.ideal(i).width; fillLater.append(i) }
            case .wrap:
                var w = m.ideal(i).width
                if let W { w = min(w, max(0, W - mh)) }
                widths[i] = w
            }
            if !lp.width.isFill { allFill = false }
            maxW = max(maxW, widths[i] + mh)
            // A match_parent child of a wrapping box counts with its margins only (alternativeMaxWidth).
            altMaxW = max(altMaxW, (lp.width.isFill && W == nil ? 0 : widths[i]) + mh)
        }
        let width = W ?? (allFill ? maxW : altMaxW)
        for i in fillLater { widths[i] = max(0, width - lps[i].margin.left - lps[i].margin.right) }

        // The main axis.
        var used: CGFloat = 0, totalWeight: CGFloat = 0, consumed: CGFloat = 0
        var weighted: [Int] = []
        for i in 0..<n {
            let lp = lps[i], mv = lp.margin.top + lp.margin.bottom
            if lp.weight > 0 {
                totalWeight += lp.weight
                weighted.append(i)
                if H != nil { used += mv } else {
                    let h = m.height(i, at: widths[i])
                    heights[i] = h; consumed += h; used += h + mv
                }
                continue
            }
            let before = totalWeight == 0 ? used : 0
            switch lp.height {
            case .points(let x): heights[i] = x
            case .fill: heights[i] = H.map { max(0, $0 - before - mv) } ?? m.height(i, at: widths[i])
            case .wrap:
                var h = m.height(i, at: widths[i])
                if let H { h = min(h, max(0, H - before - mv)) }
                heights[i] = h
            }
            used += heights[i] + mv
        }
        share(&heights, weighted, lps, remaining: (H ?? used) - used + (H == nil ? consumed : 0), totalWeight)

        var total: CGFloat = 0
        for i in 0..<n { total += heights[i] + lps[i].margin.top + lps[i].margin.bottom }
        let height = H ?? total
        var y: CGFloat = justify == .center ? (height - total) / 2 : justify == .end ? height - total : 0
        var frames: [CGRect] = []
        frames.reserveCapacity(n)
        for i in 0..<n {
            let mg = lps[i].margin
            y += mg.top
            let x: CGFloat
            switch lps[i].crossAlign {
            case .center: x = (width - widths[i]) / 2 + mg.left - mg.right
            case .end: x = width - widths[i] - mg.right
            case .none, .start: x = mg.left
            }
            frames.append(CGRect(x: x, y: y, width: widths[i], height: heights[i]))
            y += heights[i] + mg.bottom
        }
        return Arrangement(size: CGSize(width: width, height: height), frames: frames)
    }

    /// LinearLayout.measureHorizontal + layoutHorizontal (no baseline alignment).
    private static func horizontal(_ W: CGFloat?, _ H: CGFloat?, _ justify: ContainerSpec.Justify, _ m: inout Measurer) -> Arrangement {
        let n = m.subviews.count
        let lps = m.subviews.map { $0[NodeLayoutKey.self] }
        var widths = [CGFloat](repeating: 0, count: n), heights = [CGFloat](repeating: 0, count: n)

        // The main axis.
        var used: CGFloat = 0, totalWeight: CGFloat = 0, consumed: CGFloat = 0
        var weighted: [Int] = []
        for i in 0..<n {
            let lp = lps[i], mh = lp.margin.left + lp.margin.right
            if lp.weight > 0 {
                totalWeight += lp.weight
                weighted.append(i)
                if W != nil { used += mh } else {
                    let w = m.ideal(i).width
                    widths[i] = w; consumed += w; used += w + mh
                }
                continue
            }
            let before = totalWeight == 0 ? used : 0
            switch lp.width {
            case .points(let x): widths[i] = x
            case .fill: widths[i] = W.map { max(0, $0 - before - mh) } ?? m.ideal(i).width
            case .wrap:
                var w = m.ideal(i).width
                if let W { w = min(w, max(0, W - before - mh)) }
                widths[i] = w
            }
            used += widths[i] + mh
        }
        share(&widths, weighted, lps, remaining: (W ?? used) - used + (W == nil ? consumed : 0), totalWeight)
        var total: CGFloat = 0
        for i in 0..<n { total += widths[i] + lps[i].margin.left + lps[i].margin.right }
        let width = W ?? total

        // The cross axis.
        var maxH: CGFloat = 0, altMaxH: CGFloat = 0, allFill = true
        var fillLater: [Int] = []
        for i in 0..<n {
            let lp = lps[i], mv = lp.margin.top + lp.margin.bottom
            switch lp.height {
            case .points(let x): heights[i] = x
            case .fill:
                if let H { heights[i] = max(0, H - mv) } else { heights[i] = m.height(i, at: widths[i]); fillLater.append(i) }
            case .wrap:
                var h = m.height(i, at: widths[i])
                if let H { h = min(h, max(0, H - mv)) }
                heights[i] = h
            }
            if !lp.height.isFill { allFill = false }
            maxH = max(maxH, heights[i] + mv)
            altMaxH = max(altMaxH, (lp.height.isFill && H == nil ? 0 : heights[i]) + mv)
        }
        let height = H ?? (allFill ? maxH : altMaxH)
        for i in fillLater { heights[i] = max(0, height - lps[i].margin.top - lps[i].margin.bottom) }

        var x: CGFloat = justify == .center ? (width - total) / 2 : justify == .end ? width - total : 0
        var frames: [CGRect] = []
        frames.reserveCapacity(n)
        for i in 0..<n {
            let mg = lps[i].margin
            x += mg.left
            let y: CGFloat
            switch lps[i].crossAlign {
            case .center: y = (height - heights[i]) / 2 + mg.top - mg.bottom
            case .end: y = height - heights[i] - mg.bottom
            case .none, .start: y = mg.top
            }
            frames.append(CGRect(x: x, y: y, width: widths[i], height: heights[i]))
            x += widths[i] + mg.right
        }
        return Arrangement(size: CGSize(width: width, height: height), frames: frames)
    }

    /// The weighted children's shares of the remaining space (LinearLayout: each takes weight / weights left).
    private static func share(_ sizes: inout [CGFloat], _ weighted: [Int], _ lps: [LayoutParams], remaining: CGFloat, _ totalWeight: CGFloat) {
        guard totalWeight > 0 else { return }
        var left = remaining, weightLeft = totalWeight
        for i in weighted {
            let w = lps[i].weight
            let s = weightLeft > 0 ? left * w / weightLeft : 0
            left -= s
            weightLeft -= w
            sizes[i] = max(0, s)
        }
    }
}

// MARK: - FrameLayout

/// FrameLayout (the design's stack): children on top of each other, each at its gravity.
struct DesignFrameLayout: Layout {
    func makeCache(subviews: Subviews) -> DesignLayoutCache { DesignLayoutCache() }
    func updateCache(_ cache: inout DesignLayoutCache, subviews: Subviews) { cache = DesignLayoutCache() }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout DesignLayoutCache) -> CGSize {
        arrange(finite(proposal.width), finite(proposal.height), subviews, &cache).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout DesignLayoutCache) {
        place(arrange(bounds.width, bounds.height, subviews, &cache), in: bounds, subviews)
    }

    private func arrange(_ W: CGFloat?, _ H: CGFloat?, _ subviews: Subviews, _ cache: inout DesignLayoutCache) -> Arrangement {
        var m = Measurer(subviews: subviews, cache: cache)
        defer { cache = m.cache }
        let n = subviews.count
        let lps = subviews.map { $0[NodeLayoutKey.self] }
        var widths = [CGFloat](repeating: 0, count: n), heights = [CGFloat](repeating: 0, count: n)
        func measureHeights(_ i: Int, _ H: CGFloat?) {
            let lp = lps[i], mv = lp.margin.top + lp.margin.bottom
            switch lp.height {
            case .points(let x): heights[i] = x
            case .fill: heights[i] = H.map { max(0, $0 - mv) } ?? m.height(i, at: widths[i])
            case .wrap:
                var h = m.height(i, at: widths[i])
                if let H { h = min(h, max(0, H - mv)) }
                heights[i] = h
            }
        }
        for i in 0..<n {
            let lp = lps[i], mh = lp.margin.left + lp.margin.right
            switch lp.width {
            case .points(let x): widths[i] = x
            case .fill: widths[i] = W.map { max(0, $0 - mh) } ?? m.ideal(i).width
            case .wrap:
                var w = m.ideal(i).width
                if let W { w = min(w, max(0, W - mh)) }
                widths[i] = w
            }
            measureHeights(i, H)
        }
        var width = W ?? 0, height = H ?? 0
        if W == nil { for i in 0..<n { width = max(width, widths[i] + lps[i].margin.left + lps[i].margin.right) } }
        if H == nil { for i in 0..<n { height = max(height, heights[i] + lps[i].margin.top + lps[i].margin.bottom) } }
        // A wrapping frame: its match_parent children take its size (FrameLayout's second measure).
        if W == nil || H == nil {
            for i in 0..<n {
                let lp = lps[i]
                if W == nil, lp.width.isFill {
                    widths[i] = max(0, width - lp.margin.left - lp.margin.right)
                    if !lp.height.isFill { measureHeights(i, height) }
                }
                if H == nil, lp.height.isFill { heights[i] = max(0, height - lp.margin.top - lp.margin.bottom) }
            }
        }
        var frames: [CGRect] = []
        frames.reserveCapacity(n)
        for i in 0..<n {
            let mg = lps[i].margin
            let x: CGFloat, y: CGFloat
            switch lps[i].frameAlign {
            case .center:
                x = (width - widths[i]) / 2 + mg.left - mg.right
                y = (height - heights[i]) / 2 + mg.top - mg.bottom
            case .bottomEnd:
                x = width - widths[i] - mg.right
                y = height - heights[i] - mg.bottom
            case .none, .topStart, .fill:
                x = mg.left
                y = mg.top
            }
            frames.append(CGRect(x: x, y: y, width: widths[i], height: heights[i]))
        }
        return Arrangement(size: CGSize(width: width, height: height), frames: frames)
    }
}

// MARK: - FlowLayout

/// ui/look/FlowLayout: a row that wraps onto more lines; the gap between items and lines, justify per line.
struct DesignFlowLayout: Layout {
    var gap: CGFloat
    var justify: ContainerSpec.Justify = .start

    func makeCache(subviews: Subviews) -> DesignLayoutCache { DesignLayoutCache() }
    func updateCache(_ cache: inout DesignLayoutCache, subviews: Subviews) { cache = DesignLayoutCache() }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout DesignLayoutCache) -> CGSize {
        arrange(finite(proposal.width), finite(proposal.height), subviews, &cache).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout DesignLayoutCache) {
        place(arrange(bounds.width, bounds.height, subviews, &cache), in: bounds, subviews)
    }

    private func arrange(_ W: CGFloat?, _ H: CGFloat?, _ subviews: Subviews, _ cache: inout DesignLayoutCache) -> Arrangement {
        var m = Measurer(subviews: subviews, cache: cache)
        defer { cache = m.cache }
        let n = subviews.count
        let lps = subviews.map { $0[NodeLayoutKey.self] }
        let limit = W ?? .infinity
        var widths = [CGFloat](repeating: 0, count: n), heights = [CGFloat](repeating: 0, count: n)
        for i in 0..<n {
            let lp = lps[i], mh = lp.margin.left + lp.margin.right
            switch lp.width {
            case .points(let x): widths[i] = x
            case .fill: widths[i] = W.map { max(0, $0 - mh) } ?? m.ideal(i).width
            case .wrap: widths[i] = min(m.ideal(i).width, max(0, limit - mh))
            }
            if case .points(let y) = lp.height { heights[i] = y } else { heights[i] = m.height(i, at: widths[i]) }
        }
        // Lines: [first, end) with their width and height.
        var lines: [(first: Int, end: Int, width: CGFloat, height: CGFloat)] = []
        var x: CGFloat = 0, lineH: CGFloat = 0, first = 0, widest: CGFloat = 0, total: CGFloat = 0
        for i in 0..<n {
            let mg = lps[i].margin
            let w = widths[i] + mg.left + mg.right, h = heights[i] + mg.top + mg.bottom
            if x > 0 && x + gap + w > limit {
                lines.append((first, i, x, lineH))
                total += lineH + gap
                widest = max(widest, x)
                x = 0; lineH = 0; first = i
            }
            x += (x > 0 ? gap : 0) + w
            lineH = max(lineH, h)
        }
        if x > 0 || lineH > 0 {
            lines.append((first, n, x, lineH))
            total += lineH
            widest = max(widest, x)
        }
        let width = W ?? widest, height = H ?? total
        var frames = [CGRect](repeating: .zero, count: n)
        var y: CGFloat = 0
        for line in lines {
            let free = max(0, width - line.width)
            var cx: CGFloat = justify == .center ? free / 2 : justify == .end ? free : 0
            for i in line.first..<line.end {
                let mg = lps[i].margin
                let left = cx + mg.left
                let top = y + mg.top + (line.height - heights[i] - mg.top - mg.bottom) / 2
                frames[i] = CGRect(x: left, y: top, width: widths[i], height: heights[i])
                cx += widths[i] + mg.left + mg.right + gap
            }
            y += line.height + gap
        }
        return Arrangement(size: CGSize(width: width, height: height), frames: frames)
    }
}

// MARK: - a picture's ratio

/// Renderer.RatioImageView: the height follows the width (width / ratio).
struct DesignRatioLayout: Layout {
    var ratio: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        if let w = finite(proposal.width) {
            if let h = finite(proposal.height) { return CGSize(width: w, height: h) }
            return CGSize(width: w, height: ratio > 0 ? w / ratio : 0)
        }
        let ideal = subviews.first?.sizeThatFits(.unspecified) ?? .zero
        let w = ideal.width.isFinite ? ideal.width : 0
        return CGSize(width: w, height: ratio > 0 ? w / ratio : 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for s in subviews { s.place(at: bounds.origin, anchor: .topLeading, proposal: ProposedViewSize(bounds.size)) }
    }
}
