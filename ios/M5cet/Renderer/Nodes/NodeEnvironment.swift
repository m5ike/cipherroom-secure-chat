// What every node of a tree shares besides the host: the context the tree was
// resolved against (colours, look, texts) and how its actions run — a sheet that
// closes before an action (ui/look/Sheets.dismissing) wraps them.

import M5Design
import SwiftUI

private struct DesignRenderContextKey: EnvironmentKey {
    static let defaultValue: RenderContext? = nil
}

/// How the nodes of a tree run their actions.
struct NodeActions {
    /// Runs before an action of the design leaves the tree (a sheet with dismissOnAction closes).
    var willRun: (@MainActor () -> Void)?
}

private struct NodeActionsKey: EnvironmentKey {
    static let defaultValue = NodeActions()
}

extension EnvironmentValues {
    /// The context the tree on screen was resolved against.
    var designRenderContext: RenderContext? {
        get { self[DesignRenderContextKey.self] }
        set { self[DesignRenderContextKey.self] = newValue }
    }

    var designNodeActions: NodeActions {
        get { self[NodeActionsKey.self] }
        set { self[NodeActionsKey.self] = newValue }
    }
}

/// A design menu (or a select's choices) hangs from this element: the popover with ui/look/Menus' card.
struct MenuAnchorModifier: ViewModifier {
    @Environment(DesignHost.self) private var host
    let id: String

    func body(content: Content) -> some View {
        content.popover(isPresented: host.menuBinding(id), attachmentAnchor: .rect(.bounds)) {
            if let menu = host.menu, menu.anchor == id {
                DesignMenuView(entries: menu.entries) { host.pick($0) }
                    .presentationCompactAdaptation(.popover)
            }
        }
    }
}

extension View {
    /// Lets `host.showMenu(_:anchor:)` show a menu at this view (parts use their own anchor ids).
    func designMenuAnchor(_ id: String) -> some View { modifier(MenuAnchorModifier(id: id)) }
}

/// Renderer.animate: an element's enter animation of the design, once, as the user likes motion
/// (the resolver leaves it out when motion is off or the system asks for less).
struct EnterModifier: ViewModifier {
    @State private var spec: EnterAnimation?
    @State private var shown: Bool

    init(_ spec: EnterAnimation?) {
        _spec = State(initialValue: spec)
        _shown = State(initialValue: spec == nil)
    }

    func body(content: Content) -> some View {
        let hidden = !shown && spec != nil
        let d = CGFloat(spec?.distance ?? 0)
        var dx: CGFloat = 0, dy: CGFloat = 0, scale: CGFloat = 1
        if hidden, let s = spec {
            switch s.type {
            case "slide-up": dy = d
            case "slide-down": dy = -d
            case "slide-left": dx = d
            case "slide-right": dx = -d
            case "scale", "pop": scale = CGFloat(s.fromScale)
            default: break
            }
        }
        return content
            .opacity(hidden ? 0 : 1)
            .offset(x: dx, y: dy)
            .scaleEffect(scale)
            .onAppear {
                guard !shown, let s = spec else { return }
                withAnimation(s.easing.animation(max(0, s.duration) / 1000).delay(max(0, s.delay) / 1000)) { shown = true }
            }
    }
}
