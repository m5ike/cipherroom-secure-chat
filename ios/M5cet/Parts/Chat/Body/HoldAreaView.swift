// ui/parts/HoldArea (6.7, slot "msgHold" in message.in / .out): the empty part of
// the row next to a hold-to-read ("tap") bubble reveals it while held — as holding
// its chip does — so a short text is not under the finger. A short hold first
// (BubbleHoldGesture.delayMs): a scroll or a swipe that starts here goes to the list
// and reveals nothing; once revealed, the message stays shown until the finger lifts.
// The design decides where it is and whether (the node's "if", by default $msg.tap)
// and how wide: its weight takes the free part of the row, its style.maxWidth caps it.
// The chip is the accessible way to reveal; this is only a larger target for a finger.

import M5Design
import M5Proto
import SwiftUI

struct HoldAreaView: View {
    let ctx: SlotContext
    @GestureState private var revealed = false
    @State private var held: ChatMessage?

    var body: some View {
        let m = ChatMessageScope.message(ctx.scope)
        let holdable = m.map(Self.holdable) ?? false
        let maxWidth = m.flatMap { Self.maxWidth(ctx, ChatMessageScope.screen($0)) }
        RoundedRectangle(cornerRadius: 16)
            .fill(ctx.color("@onSurface", .black).opacity(revealed ? 0.12 : 0))
            .contentShape(Rectangle())
            .frame(maxWidth: maxWidth ?? .infinity, maxHeight: .infinity)
            .frame(idealWidth: 0, idealHeight: 0)
            .background(GeometryReader { g in
                Color.clear.preference(key: BubbleFramesKey.self, value: BubbleFrames(hold: g.frame(in: .named(BubbleRowView.space))))
            })
            .gesture(reveal, including: holdable ? .all : .subviews)
            .onChange(of: revealed) { _, on in
                guard let m else { return }
                if on {
                    DesignHaptics.long(Look(settings: ctx.host.settings).haptics)
                    held = m
                    ChatBodyHold.hold(m, true)
                } else if let h = held {
                    ChatBodyHold.hold(h, false)
                    held = nil
                }
            }
            .onDisappear { if let h = held { ChatBodyHold.hold(h, false); held = nil } }
            .accessibilityHidden(true)
    }

    /// LongPress (the delay, within the slop) then a drag that lasts until the finger lifts: revealed meanwhile.
    private var reveal: some Gesture {
        LongPressGesture(minimumDuration: Double(BubbleHoldGesture.delayMs) / 1000, maximumDistance: 10)
            .sequenced(before: DragGesture(minimumDistance: 0))
            .updating($revealed) { value, state, _ in
                if case .second(true, _) = value { state = true }
            }
    }

    /// The node's style.maxWidth (pt) as the design wrote it (HoldArea reads bound.node's style).
    static func maxWidth(_ ctx: SlotContext, _ screen: String) -> CGFloat? {
        func find(_ n: DesignNode) -> DesignNode? {
            if n.id == ctx.node.nodeId { return n }
            for c in n.children ?? [] { if let f = find(c) { return f } }
            return nil
        }
        guard let root = ctx.context.design.screen(screen), let node = find(root), let v = node.style?["maxWidth"]?.numberValue, v > 0 else { return nil }
        return CGFloat(v)
    }

    /// A message this area can reveal now: hold-to-read, not gone, not sealed shut.
    static func holdable(_ m: ChatMessage) -> Bool {
        m.tap && !m.vanished && m.kind != "sys" && (m.sealed == nil || m.sealPlain != nil)
    }
}
