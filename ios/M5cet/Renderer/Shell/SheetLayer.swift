// ui/look/Sheets: a screen of the design over the current one (Parts.showSheet) —
// a card from the bottom over the scrim ("sheet", at most 560 pt wide), or the
// Tools dock: a compact card floating just above the composer, no scrim, closed by
// a tap outside it that still reaches what it hit ("dock", at most 440 pt). A
// sheet whose root says dismissOnAction closes before any action its elements run.
// Back (the edge swipe) and a tap on the scrim close it.

import M5Design
import SwiftUI

/// The composer's place on screen (the dock floats above it).
struct DockAnchorKey: PreferenceKey {
    static let defaultValue: Anchor<CGRect>? = nil
    static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) { value = value ?? nextValue() }
}

struct SheetLayer: View {
    let size: CGSize
    let composerTop: CGFloat?
    @Environment(DesignHost.self) private var host

    var body: some View {
        ZStack(alignment: .bottom) {
            if let sheet = host.sheet {
                SheetCard(sheet: sheet, size: size, composerTop: composerTop)
                    .transition(.opacity.combined(with: .offset(y: 24 * CGFloat(Look(settings: host.settings).travel))))
            }
        }
        .frame(width: size.width, height: size.height, alignment: .bottom)
    }
}

private struct SheetCard: View {
    let sheet: SheetState
    let size: CGSize
    let composerTop: CGFloat?
    @Environment(DesignHost.self) private var host

    /// How the sheet shows: its root's props (Sheets.dock / dismissOnAction) and the card's measures.
    private struct Shape {
        var dock = false, dismiss = false, painted = false
        var margin: CGFloat { dock ? 12 : 8 }
        var maxWidth: CGFloat { dock ? 440 : 560 }
        var radius: CGFloat { dock ? 22 : 24 }
        var shadow: CGFloat { dock ? 9 : 11 }
    }

    var body: some View {
        let _ = host.revision
        let ctx = host.renderContext()
        let node = host.resolve(sheet.screen, scope: host.scope(for: sheet.screen), context: ctx)
        let shape = Self.shape(node)
        ZStack(alignment: .bottom) {
            if !shape.dock { scrim(ctx) }
            if let node { card(node, shape, ctx) }
        }
        .frame(width: size.width, height: size.height, alignment: .bottom)
    }

    private static func shape(_ node: RenderNode?) -> Shape {
        var s = Shape()
        if case .sheet(let c)? = node?.content { s.dock = c.dock; s.dismiss = c.dismissOnAction }
        s.painted = node?.box.fill != nil
        return s
    }

    private func scrim(_ ctx: RenderContext) -> some View {
        ctx.swiftColor("@scrim", DesignColor(argb: 0x9900_0000))
            .ignoresSafeArea()
            .contentShape(Rectangle())
            .onTapGesture { host.closeOverlay() }
            .accessibilityAddTraits(.isButton)
            .accessibilityAction(.escape) { host.closeOverlay() }
    }

    private func bottom(_ shape: Shape) -> CGFloat {
        guard shape.dock else { return shape.margin }
        if let top = composerTop { return max(0, size.height - top) + 8 }
        return 16
    }

    private func card(_ node: RenderNode, _ shape: Shape, _ ctx: RenderContext) -> some View {
        let bottom = bottom(shape)
        let width = max(0, min(size.width - 2 * shape.margin, shape.maxWidth))
        var close: (@MainActor () -> Void)?
        if shape.dismiss {
            let h = host
            close = { @MainActor in h.closeOverlay() }
        }
        let surface = shape.painted ? Color.clear : ctx.swiftColor("@surface", .white)
        return AtMostHeight(maxHeight: max(0, size.height - bottom - shape.margin)) {
            NodeView(node: node)
                .environment(\.designRenderContext, ctx)
                .environment(\.designNodeActions, NodeActions(willRun: close))
        }
        .frame(width: width)
        .background(surface)
        .clipShape(RoundedRectangle(cornerRadius: shape.radius, style: .circular))
        .shadow(color: .black.opacity(0.25), radius: shape.shadow, y: shape.shadow / 2)
        .padding(.bottom, bottom)
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(DesignShell.space)) } action: { frame in
            host.dockFrame = shape.dock ? frame : nil
        }
        .onDisappear { host.dockFrame = nil }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sheet/" + sheet.screen)
        .accessibilityAddTraits(.isModal)
    }
}

/// WRAP_CONTENT in a bounded box (AT_MOST): the content's height, at most `maxHeight`.
struct AtMostHeight: Layout {
    var maxHeight: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let s = subviews.first else { return .zero }
        let w = proposal.width.flatMap { $0.isFinite ? $0 : nil }
        let ideal = s.sizeThatFits(ProposedViewSize(width: w, height: nil))
        return CGSize(width: w ?? ideal.width, height: min(ideal.height, maxHeight))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, anchor: .topLeading, proposal: ProposedViewSize(bounds.size))
    }
}
