// DEBUG only: the screens with the console's sample data (SampleScreenData) — for
// previews, screenshots and UI tests (`-M5Screen <id>`). It stands in for the real
// app state (contract 3) and, in sample mode, draws the list parts that are not
// ported yet with the design's own templates (rooms.item, message.*), so a screen
// shows what it would show. Never compiled into Release.

#if DEBUG
import M5Design
import Observation
import SwiftUI

@MainActor
@Observable
final class SampleScreenState: ScreenStateProvider {
    /// screen id → its sample variables.
    let samples: [String: [String: DesignValue]]
    var routeState = AppRouteState(enrolled: true, lockSetUp: true, locked: false, hasActiveRoom: false)

    init() {
        let all = (try? DesignValue.parse(SampleScreenData.json))?.objectValue ?? [:]
        samples = all.compactMapValues { $0.objectValue }
    }

    func variables(for screen: String, context: ScreenContext) -> [String: DesignValue] {
        var v = samples[screen] ?? [:]
        // The app's own $app (its version) and the live $settings (every key, the user's look).
        v["app"] = nil
        v["settings"] = nil
        return v
    }

    var define: DesignValue { .object([:]) }

    /// A signed-in account (Settings › User's sample).
    var account: DesignValue { samples["settings.user"]?["account"] ?? ["signedIn": false] }

    /// A template's sample item ("message.in" → its $msg).
    func item(_ screen: String, _ name: String) -> DesignValue { samples[screen]?[name] ?? .null }
}

/// The parts sample mode draws until the real ones are registered (never over a registered one).
@MainActor
enum SampleSlots {
    static func register(into registry: SlotRegistry, state: SampleScreenState) {
        if !registry.has("roomList") {
            registry.register("roomList") { ctx in AnyView(SampleRoomList(rooms: ctx.scope["rooms"].arrayValue ?? [])) }
        }
        if !registry.has("messages") {
            let msgs: [(String, DesignValue)] = ["message.sys", "message.in", "message.out"].map { ($0, state.item($0, "msg")) }
            registry.register("messages") { _ in AnyView(SampleMessages(messages: msgs)) }
        }
        if !registry.has("msgBody") {
            registry.register("msgBody") { ctx in
                AnyView(Text(verbatim: Expr.toText(ctx.scope["msg"]["text"]))
                    .font(.system(size: 15.5))
                    .foregroundStyle(ctx.foreground)
                    .fixedSize(horizontal: false, vertical: true))
            }
        }
    }
}

/// RoomList: each room the design's "rooms.item" with $room only.
private struct SampleRoomList: View {
    let rooms: [DesignValue]

    var body: some View {
        ScrollView(.vertical) {
            LazyVStack(spacing: 0) {
                ForEach(Array(rooms.enumerated()), id: \.offset) { _, room in
                    DesignTemplateView(screen: "rooms.item", scope: Scope(["room": room]))
                }
            }
        }
    }
}

/// MessageList: a system line, an incoming and an outgoing message.
private struct SampleMessages: View {
    let messages: [(String, DesignValue)]

    var body: some View {
        ScrollView(.vertical) {
            VStack(spacing: 0) {
                ForEach(Array(messages.enumerated()), id: \.offset) { _, m in
                    DesignTemplateView(screen: m.0, scope: Scope(["msg": m.1]))
                }
            }
            .padding(.vertical, 8)
        }
    }
}
#endif
