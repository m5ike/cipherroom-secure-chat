// Until the chat part registers its own (Parts: MessageList, MsgBody, Composer —
// another agent's), the room screen still works: the active room's messages as
// the design's message templates ("message.in", "message.out", "message.sys"
// with $msg), the message text, and a plain composer over ComposerModel. A part
// that registers the same slot later replaces these (SlotRegistry: the later
// registration wins).

import M5Core
import M5Design
import M5Proto
import SwiftUI

@MainActor
enum FallbackChatSlots {
    static func register(into registry: SlotRegistry, core: AppCore) {
        if !registry.has("messages") { registry.register("messages") { ctx in AnyView(FallbackMessages(ctx: ctx, rooms: core.rooms)) } }
        if !registry.has("msgBody") {
            registry.register("msgBody") { ctx in
                AnyView(Text(verbatim: Expr.toText(ctx.scope["msg"]["text"]))
                    .font(.system(size: 15.5)).foregroundStyle(ctx.foreground)
                    .fixedSize(horizontal: false, vertical: true))
            }
        }
        if !registry.has("composer") { registry.register("composer") { ctx in AnyView(FallbackComposer(ctx: ctx, model: core.models.composer(for: ctx.host))) } }
        // The people part's panel (closed until it is there).
        if !registry.has("userPanel") { registry.register("userPanel") { _ in AnyView(Color.clear.frame(idealWidth: 0, idealHeight: 0).allowsHitTesting(false)) } }
    }
}

private struct FallbackMessages: View {
    let ctx: SlotContext
    let rooms: RoomsController

    var body: some View {
        let room = rooms.activeController
        let list = (room?.messages ?? []).filter { $0.kind != "audio-status" && !$0.deleted }
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                LazyVStack(spacing: 0) {
                    ForEach(list, id: \.id) { m in
                        DesignTemplateView(screen: m.kind == "sys" ? "message.sys" : m.mine ? "message.out" : "message.in",
                                           scope: Scope(["msg": DesignValue(m.scope)]))
                            .id(m.id)
                    }
                }
                .padding(.vertical, 8)
            }
            .onChange(of: list.last?.id) { _, id in if let id { proxy.scrollTo(id, anchor: .bottom) } }
            .onAppear { if let id = list.last?.id { proxy.scrollTo(id, anchor: .bottom) } }
            .task(id: list.count) {
                // What is on screen is read.
                if let r = room { r.markRead(list.filter { !$0.mine }.map(\.id)) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("messages.list")
    }
}

private struct FallbackComposer: View {
    let ctx: SlotContext
    @Bindable var model: ComposerModel

    var body: some View {
        HStack(spacing: 8) {
            TextField("", text: $model.text, prompt: Text(ctx.t("room.typeMessage")).foregroundStyle(ctx.color("@muted")), axis: .vertical)
                .lineLimit(1...5)
                .font(.system(size: 16))
                .foregroundStyle(ctx.color("@onSurface"))
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Capsule().fill(ctx.color("@surfaceVariant")))
                .accessibilityIdentifier("composer.field")
            Button { model.send() } label: {
                DesignIcon(name: "send-horizontal", size: 22, color: ctx.color("@onPrimary"))
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(ctx.color("@primary")))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(ctx.t("room.send"))
            .accessibilityIdentifier("composer.send")
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(ctx.color("@surface"))
        .frame(idealHeight: 60)
    }
}
