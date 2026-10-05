// ui/parts/BubbleRow (6.10): one row of the message list — the design's message
// tree on top, and under it the two icons a sideways drag uncovers: reply under the
// reading direction's start edge (the bubble moves toward the end to reply),
// forward under its end edge (BubbleSwipe has the rule). The row follows the drag,
// the icon grows in and fills with the primary colour once letting go counts, and
// the row springs back. It also flashes when a quote's tap brought the list here.
// VoiceOver finds reply, forward, the sender's profile and "go to the original" as
// the row's own actions; a long press (or a secondary click on iPad) opens the menu.

import M5Design
import M5Proto
import SwiftUI
import UIKit

struct BubbleRowAction {
    let label: String
    let run: @MainActor () -> Void
}

struct BubbleRowView: View {
    let message: ChatMessage
    let screen: String
    let scope: Scope
    let animate: Bool
    /// A hidden one while "Hidden (n)" shows it.
    let dimmed: Bool
    /// Bumped when the row should flash (the quote's jump).
    let flashToken: Int
    let canReply: Bool
    let canForward: Bool
    let actions: [BubbleRowAction]
    let onReply: @MainActor () -> Void
    let onForward: @MainActor () -> Void
    let onMenu: @MainActor (String) -> Void
    /// The bubble took the touch (true) or let it go: the list's room fling waits for it.
    let onBubbleDrag: @MainActor (Bool) -> Void

    nonisolated static let space = "m5.bubbleRow"

    @Environment(DesignHost.self) private var host
    @Environment(\.layoutDirection) private var direction
    @State private var swipe: BubbleSwipe?
    @State private var offset: CGFloat = 0
    @State private var showing: BubbleSwipe.Act = .none
    @State private var progress: CGFloat = 0
    @State private var armed = false
    @State private var frames = BubbleFrames()
    @State private var origin: CGPoint = .zero
    @State private var flash: Double = 0
    @GestureState private var touching = false

    private var anchor: String { "msg/" + message.id }

    var body: some View {
        DesignTemplateView(screen: screen, scope: scope, animateEnter: animate)
            .coordinateSpace(.named(Self.space))
            .onPreferenceChange(BubbleFramesKey.self) { frames = $0 }
            .onGeometryChange(for: CGPoint.self) { $0.frame(in: .global).origin } action: { origin = $0 }
            .overlay { host.renderContext().swiftColor("@primary", .blue).opacity(0.22 * flash).allowsHitTesting(false) }
            .offset(x: offset)
            .background { under }
            .opacity(dimmed ? 0.55 : 1)
            .contentShape(.contextMenuPreview, Rectangle())
            .simultaneousGesture(drag, including: message.kind == "sys" ? .subviews : .all)
            .simultaneousGesture(LongPressGesture(minimumDuration: 0.5, maximumDistance: 10).onEnded { _ in longPress() }, including: .all)
            .gesture(SecondaryClick { onMenu(anchor) })
            .designMenuAnchor(anchor)
            .onChange(of: touching) { _, on in if !on { lifted(cancelled: true) } }
            .onChange(of: flashToken) { _, _ in startFlash() }
            .onAppear { if flashToken > 0 && flash == 0 { startFlash() } }
            .modifier(RowA11y(actions: actions))
    }

    // MARK: the icons under the row

    private var under: some View {
        let ctx = host.renderContext()
        let primary = ctx.swiftColor("@primary", .blue), variant = ctx.swiftColor("@surfaceVariant", .white), onPrimary = ctx.swiftColor("@onPrimary", .white)
        return HStack(spacing: 0) {
            icon("reply", on: showing == .reply, primary: primary, variant: variant, onPrimary: onPrimary)
            Spacer(minLength: 0)
            icon("forward", on: showing == .forward, primary: primary, variant: variant, onPrimary: onPrimary)
        }
        .padding(.horizontal, 16)
        .opacity(offset == 0 ? 0 : 1)
        .accessibilityHidden(true)
    }

    private func icon(_ name: String, on: Bool, primary: Color, variant: Color, onPrimary: Color) -> some View {
        let lit = armed && on
        let p = on ? progress : 0
        return DesignIcon(name: name, size: 20, color: lit ? onPrimary : primary)
            .frame(width: 36, height: 36)
            .background(Circle().fill(lit ? primary : variant))
            .opacity(Double(p))
            .scaleEffect(lit ? 1.08 : 0.6 + 0.4 * p)
    }

    // MARK: the sideways drag (MessageList.Swiper)

    private var drag: some Gesture {
        DragGesture(minimumDistance: 4, coordinateSpace: .global)
            .updating($touching) { _, s, _ in s = true }
            .onChanged { v in
                if swipe == nil { swipe = start(v.startLocation) }
                guard var g = swipe else { return }
                // A hold-to-read message held now stays held, never swiped.
                if !g.dragging && ChatState.shared.isHeld(message.id) { g.cancel(); swipe = g; return }
                if g.move(v.location.x, v.location.y) {
                    if !g.dragging { swipe = g; return }
                    onBubbleDrag(true)
                    offset = g.offset
                    showing = g.showing
                    progress = g.progress
                    armed = g.armed
                    if g.crossed { DesignHaptics.tick(Look(settings: host.settings).haptics) }
                }
                swipe = g
            }
            .onEnded { _ in lifted(cancelled: false) }
    }

    /// A finger went down here: on the bubble (not the face beside it, not the hold area), on a message that may be swiped.
    private func start(_ global: CGPoint) -> BubbleSwipe {
        let p = CGPoint(x: global.x - origin.x, y: global.y - origin.y)
        var onBubble = message.kind != "sys"
        if let hold = frames.hold, hold.contains(p) { onBubble = false }
        // A control that moves sideways itself (an audio player's seek bar) keeps its drag.
        if Date().timeIntervalSince(ChatState.shared.controlTouchAt) < 0.5 { onBubble = false }
        if screen == "message.in", let body = frames.body {
            // The avatar column (12 + 36 + 8) is beside the bubble, which starts its padding (12) before the body.
            let face = direction == .rightToLeft ? p.x > body.maxX + 14 : p.x < body.minX - 14
            if face { onBubble = false }
        }
        return BubbleSwipe(density: 1, slop: 8, onBubble: onBubble, canReply: canReply, canForward: canForward,
                           rtl: direction == .rightToLeft, x: global.x, y: global.y)
    }

    private func lifted(cancelled: Bool) {
        guard var g = swipe else { return }
        swipe = nil
        let was = g.dragging
        let act = cancelled ? .none : g.release()
        g.cancel()
        if was { springBack() }
        onBubbleDrag(false)
        switch act {
        case .reply: onReply()
        case .forward: onForward()
        case .none: break
        }
    }

    private func springBack() {
        let look = Look(settings: host.settings, reducedMotion: host.reducedMotion)
        let ms = look.ms(220)
        if ms <= 0 || look.still { rest(); return }
        withAnimation(look.easing("decelerate").animation(ms / 1000)) { rest() }
    }

    private func rest() {
        offset = 0
        progress = 0
        armed = false
        showing = .none
    }

    private func longPress() {
        if swipe?.dragging == true || ChatState.shared.isHeld(message.id) { return }
        DesignHaptics.long(Look(settings: host.settings).haptics)
        onMenu(anchor)
    }

    // MARK: the flash (a quote's tap brought the list here)

    private func startFlash() {
        let look = Look(settings: host.settings, reducedMotion: host.reducedMotion)
        let ms = look.ms(1400)
        if ms <= 0 || look.still {
            flash = 1
            Task { try? await Task.sleep(for: .milliseconds(1200)); flash = 0 }
            return
        }
        withAnimation(.easeOut(duration: ms / 3000)) { flash = 1 }
        Task {
            try? await Task.sleep(for: .milliseconds(Int(ms * 2 / 3)))
            withAnimation(.easeIn(duration: ms / 3000)) { flash = 0 }
        }
    }
}

/// The row's actions for VoiceOver (reply, forward, the original, the sender).
private struct RowA11y: ViewModifier {
    let actions: [BubbleRowAction]

    func body(content: Content) -> some View {
        actions.reduce(AnyView(content.accessibilityElement(children: .contain))) { view, a in
            AnyView(view.accessibilityAction(named: Text(verbatim: a.label)) { a.run() })
        }
    }
}

/// A secondary click (iPad with a pointer): the row's menu, as a long press on touch.
struct SecondaryClick: UIGestureRecognizerRepresentable {
    let action: @MainActor () -> Void

    func makeUIGestureRecognizer(context: Context) -> UITapGestureRecognizer {
        let g = UITapGestureRecognizer()
        g.buttonMaskRequired = .secondary
        g.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
        return g
    }

    func handleUIGestureRecognizerAction(_ recognizer: UITapGestureRecognizer, context: Context) {
        if recognizer.state == .ended { action() }
    }
}
