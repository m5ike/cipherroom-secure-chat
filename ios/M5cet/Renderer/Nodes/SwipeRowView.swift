// The design's "swipe" element (6.7, ui/look/SwipeRow + Swipe): a row that slides
// sideways — dragged to the right it uncovers its "right" menu's actions at its left
// edge, to the left those of its "left" menu at its right edge; each an icon over a
// label, the one at the very edge filled with the side's colour, the others tonal.
// A tap on an action runs it and the row springs back; a tap on an open row closes
// it; one row is open at a time; vertical scrolling stays the list's (only a clearly
// sideways drag moves the row). VoiceOver finds the actions on the row.

import M5Design
import SwiftUI

struct SwipeRowView: View {
    let node: RenderNode
    let swipe: SwipeContent
    @Environment(DesignHost.self) private var host
    @Environment(\.designNodeActions) private var actions
    @Environment(\.designRenderContext) private var context
    @Environment(\.designTextScale) private var scale
    @State private var offset: CGFloat = 0
    @State private var start: CGFloat = 0
    @State private var claimed: Bool?
    @State private var pastOpen = false

    /// SwipeRow.tileW.
    static let tileWidth: CGFloat = 78

    private var rightWidth: CGFloat { CGFloat(swipe.right.count) * Self.tileWidth }
    private var leftWidth: CGFloat { CGFloat(swipe.left.count) * Self.tileWidth }
    private var signature: [String] { (swipe.right + swipe.left).map { $0.action + "=" + Expr.toText($0.value) } }

    var body: some View {
        DesignLinearLayout(vertical: true) {
            ForEach(node.children) { NodeView(node: $0) }
        }
        .background(swipe.surface.color)
        .overlay {
            // An open row: a touch on the row closes it (its own click does not run).
            if offset != 0 { Color.clear.contentShape(Rectangle()).onTapGesture { animate(to: 0) } }
        }
        .shadow(color: .black.opacity(offset == 0 ? 0 : 0.18), radius: offset == 0 ? 0 : 2, y: offset == 0 ? 0 : 1)
        .offset(x: offset)
        .background(alignment: .leading) { side(swipe.right, color: swipe.rightColor, atLeft: true).opacity(offset > 0 ? 1 : 0) }
        .background(alignment: .trailing) { side(swipe.left, color: swipe.leftColor, atLeft: false).opacity(offset < 0 ? 1 : 0) }
        .clipped()
        .simultaneousGesture(drag)
        .onChange(of: host.openSwipeRow) { _, open in if open != node.id && offset != 0 { animate(to: 0) } }
        .onChange(of: signature) { _, _ in offset = 0 }
        .accessibilityElement(children: .contain)
        .modifier(SwipeA11y(actions: swipe.right + swipe.left, run: run))
    }

    // MARK: the sides

    private func side(_ items: [SwipeAction], color: DesignColor, atLeft: Bool) -> some View {
        let n = items.count
        let progress = CGFloat(SwipeMath.progress(Double(atLeft ? max(0, offset) : min(0, offset)), width: Double(atLeft ? rightWidth : leftWidth)))
        return ZStack(alignment: atLeft ? .leading : .trailing) {
            // The tile next to the row continues under it.
            (n == 0 ? Color.clear : (n == 1 ? color : swipe.tonal).color)
            HStack(spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                    tile(item, edge: atLeft ? i == 0 : i == n - 1, color: color, reveal: progress)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func tile(_ item: SwipeAction, edge: Bool, color: DesignColor, reveal p: CGFloat) -> some View {
        let fg = edge ? Palette.onColor(color) : color
        let text = edge ? fg : swipe.onSurface
        let fontScale = min(1.15, CGFloat(context?.appearance.fontScale ?? 1))
        let family = context.map { $0.look.family($0.design) } ?? .sans
        return Button {
            DesignHaptics.tick(Look(settings: host.settings).haptics)
            animate(to: 0)
            run(item)
        } label: {
            VStack(spacing: 4) {
                DesignIcon(name: item.icon, size: 22, color: fg.color)
                    .frame(width: 24, height: 24)
                    .opacity(0.35 + 0.65 * p)
                    .scaleEffect(0.7 + 0.3 * p)
                Text(verbatim: item.label)
                    .font(DesignFonts.label(size: 12 * fontScale * scale, family: family))
                    .foregroundStyle(text.color)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .padding(.horizontal, 4)
            .frame(width: Self.tileWidth)
            .frame(maxHeight: .infinity)
            .background((edge ? color : swipe.tonal).color)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHidden(true)
    }

    // MARK: the drag (SwipeRow's touch handling with ui/look/Swipe's arithmetic)

    private var drag: some Gesture {
        DragGesture(minimumDistance: 8, coordinateSpace: .local)
            .onChanged { v in
                let dx = Double(v.translation.width), dy = Double(v.translation.height)
                if claimed == nil {
                    start = offset
                    if SwipeMath.claims(dx: dx, dy: dy, slop: 8, offset: Double(start), rightWidth: Double(rightWidth), leftWidth: Double(leftWidth)) {
                        claimed = true
                        host.openSwipeRow = node.id
                    } else if abs(dy) > 8 {
                        claimed = false
                    }
                }
                guard claimed == true else { return }
                let to = CGFloat(SwipeMath.clamp(Double(start) + dx, rightWidth: Double(rightWidth), leftWidth: Double(leftWidth)))
                let past = SwipeMath.pastOpen(Double(to), rightWidth: Double(rightWidth), leftWidth: Double(leftWidth))
                if past != pastOpen { pastOpen = past; if past { DesignHaptics.tick(Look(settings: host.settings).haptics) } }
                offset = to
            }
            .onEnded { v in
                defer { claimed = nil }
                guard claimed == true else { return }
                let fling = SwipeMath.flingDp
                animate(to: CGFloat(SwipeMath.settle(Double(offset), velocity: Double(v.velocity.width), fling: fling,
                                                     rightWidth: Double(rightWidth), leftWidth: Double(leftWidth))))
            }
    }

    private func animate(to target: CGFloat) {
        if target != 0 { host.openSwipeRow = node.id } else if host.openSwipeRow == node.id { host.openSwipeRow = nil }
        pastOpen = SwipeMath.pastOpen(Double(target), rightWidth: Double(rightWidth), leftWidth: Double(leftWidth))
        let look = Look(settings: host.settings, reducedMotion: host.reducedMotion)
        let ms = look.ms(240)
        if ms <= 0 || look.still { offset = target; return }
        withAnimation(look.easing("decelerate").animation(ms / 1000)) { offset = target }
    }

    private func run(_ item: SwipeAction) {
        actions.willRun?()
        host.runner.fire(item, source: ActionSource(node.id))
    }
}

/// The swipe's actions as the row's own (TalkBack › Actions → VoiceOver's actions rotor).
private struct SwipeA11y: ViewModifier {
    let actions: [SwipeAction]
    let run: (SwipeAction) -> Void

    func body(content: Content) -> some View {
        actions.reduce(AnyView(content)) { view, item in
            AnyView(view.accessibilityAction(named: Text(verbatim: item.label)) { run(item) })
        }
    }
}
