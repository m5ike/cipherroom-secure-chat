// One resolved element of the design drawn in SwiftUI — the port of
// android/…/ui/Renderer.java's Bound (create + bind) on top of M5Design's
// RenderNode: the element's content, its box (NodeChrome), its events (a tick
// under the finger, the long press), its accessibility (the node id is the
// identifier), its enter animation, and its LayoutParams for the parent layout.

import M5Design
import SwiftUI

struct NodeView: View {
    let node: RenderNode

    var body: some View {
        NodeBody(node: node)
            .layoutValue(key: NodeLayoutKey.self, value: Self.layout(node))
    }

    /// A repeated group (`each`) is as big as its copies. Deliberate difference: Android gives the group's box
    /// the template's own fixed width / height (Bound.params of the `each` node) and clips every copy but the
    /// first — the template and colour pickers of Settings › Appearance showed one item; the console's preview
    /// (and the format) draws one element per item. Margins, weight and alignment stay the template's.
    static func layout(_ node: RenderNode) -> LayoutParams {
        guard node.isRepeat else { return node.layout }
        var l = node.layout
        if case .points = l.width { l.width = .wrap }
        if case .points = l.height { l.height = .wrap }
        return l
    }
}

private struct NodeBody: View {
    let node: RenderNode
    @Environment(DesignHost.self) private var host
    @Environment(\.designNodeActions) private var actions
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        decorated
            .modifier(EnterModifier(node.enter))
    }

    /// The box with the events: clickable elements are buttons (the chrome follows the press).
    @ViewBuilder private var decorated: some View {
        let click = node.events["click"], long = node.events["longClick"]
        if ownsTaps {
            NodeCore(node: node)
                .modifier(NodeChrome(box: chromeBox, highlight: highlight, reduceMotion: reduceMotion))
                .accessibilityIdentifier(node.id)
                .designMenuAnchor(node.id)
        } else if let click, let long {
            PressAndHold(box: chromeBox, highlight: highlight, reduceMotion: reduceMotion, disabled: disabled,
                         tap: { fire(click) }, hold: { fire(long) }) {
                NodeCore(node: node)
            }
            .accessibilityIdentifier(node.id)
            .modifier(LabelIfAny(label: node.accessibilityLabel))
            .designMenuAnchor(node.id)
        } else if let click {
            Button { fire(click) } label: { NodeCore(node: node) }
                .buttonStyle(NodeButtonStyle(box: chromeBox, highlight: highlight, reduceMotion: reduceMotion))
                .disabled(disabled)
                .accessibilityIdentifier(node.id)
                .modifier(LabelIfAny(label: node.accessibilityLabel))
                .designMenuAnchor(node.id)
        } else if let long {
            NodeCore(node: node)
                .modifier(NodeChrome(box: chromeBox, highlight: highlight, reduceMotion: reduceMotion))
                .contentShape(Rectangle())
                .onLongPressGesture(minimumDuration: 0.5) { fire(long) }
                .accessibilityIdentifier(node.id)
                .designMenuAnchor(node.id)
        } else {
            NodeCore(node: node)
                .modifier(NodeChrome(box: chromeBox, reduceMotion: reduceMotion))
                .modifier(ContainerA11y(isContainer: node.container != nil))
                .accessibilityIdentifier(node.id)
        }
    }

    /// Elements that take their own taps (a switch's click is its toggle, a field, a choice, a slider, a swipe row).
    private var ownsTaps: Bool {
        switch node.content {
        case .toggle, .input, .select, .slider, .segmented, .swipe: return true
        default: return false
        }
    }

    private var disabled: Bool {
        if case .button(let b) = node.content { return b.disabled }
        return false
    }

    /// An icon button's shape is its own (the look's style), over the whole element.
    private var chromeBox: BoxStyle {
        guard case .iconButton(let c) = node.content else { return node.box }
        var b = node.box
        b.fill = c.fill
        b.border = c.border
        b.radius = c.fill != nil || c.border != nil ? c.radius : 0
        b.press = c.press
        return b
    }

    private var highlight: Color { host.isDark ? .white.opacity(0.18) : .black.opacity(0.1) }

    private func fire(_ event: RenderEvent) {
        let haptics = Look(settings: host.settings).haptics
        switch event.haptic {
        case .tick: DesignHaptics.tick(haptics)
        case .long: DesignHaptics.long(haptics)
        case .none: break
        }
        actions.willRun?()
        host.runner.fire(event, source: ActionSource(node.id))
    }
}

private struct LabelIfAny: ViewModifier {
    let label: String?
    func body(content: Content) -> some View {
        if let label, !label.isEmpty { content.accessibilityLabel(Text(verbatim: label)).help(Text(verbatim: label)) } else { content }
    }
}

private struct ContainerA11y: ViewModifier {
    let isContainer: Bool
    func body(content: Content) -> some View {
        if isContainer { content.accessibilityElement(children: .contain) } else { content }
    }
}

/// A click and a long press on one element (Android's OnClickListener + OnLongClickListener).
private struct PressAndHold<Label: View>: View {
    let box: BoxStyle
    let highlight: Color
    let reduceMotion: Bool
    let disabled: Bool
    let tap: () -> Void
    let hold: () -> Void
    @ViewBuilder let label: () -> Label
    @State private var pressing = false

    var body: some View {
        label()
            .environment(\.designPressed, pressing)
            .modifier(NodeChrome(box: box, pressed: pressing, highlight: highlight, reduceMotion: reduceMotion))
            .contentShape(Rectangle())
            .onTapGesture { if !disabled { tap() } }
            .onLongPressGesture(minimumDuration: 0.5, maximumDistance: 12) {
                if !disabled { hold() }
            } onPressingChanged: { pressing = $0 }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { if !disabled { tap() } }
    }
}

// MARK: - the element's content (Bound.bindContent)

struct NodeCore: View {
    let node: RenderNode

    var body: some View {
        switch node.content {
        case .container, .sheet:
            NodeContainer(node: node)
        case .swipe(let s):
            SwipeRowView(node: node, swipe: s)
        case .text(let t):
            DesignTextView(content: t, style: node.textStyle)
                .leaf(alignment: Alignment(horizontal: node.textStyle?.align.horizontal ?? .leading, vertical: .top))
        case .button(let b):
            DesignButtonLabel(content: b, style: node.textStyle)
                .leaf(alignment: .center)
        case .iconButton(let c):
            DesignIconButtonView(content: c)
                .leaf(alignment: .center)
        case .icon(let c):
            DesignIcon(name: c.name, size: c.size, color: c.color.color)
                .leaf(alignment: .center)
        case .image(let c):
            DesignImageView(content: c)
        case .avatar(let c):
            DesignAvatar(content: c)
                .leaf(alignment: .topLeading)
        case .divider, .spacer, .flex, .unknown:
            Color.clear
                .frame(idealWidth: 0, idealHeight: 0)
                .leaf(alignment: .topLeading)
                .accessibilityHidden(true)
        case .progress(let value):
            DesignProgress(value: value)
                .leaf(alignment: .center)
        case .input(let c):
            DesignInputView(node: node, content: c)
                .leaf(alignment: .topLeading)
        case .toggle(let c):
            DesignToggleView(node: node, content: c)
                .leaf(alignment: .leading)
        case .select(let c):
            DesignSelectView(node: node, content: c)
                .leaf(alignment: .leading)
        case .slider(let c):
            DesignSliderView(node: node, content: c)
                .leaf(alignment: .center)
        case .segmented(let c):
            DesignSegmentedView(node: node, content: c)
                .leaf(alignment: .center)
        case .slot(let name):
            DesignSlotView(node: node, name: name)
                .leaf(alignment: .topLeading)
        }
    }
}

extension View {
    /// A leaf fills what its layout gives it (a finite proposal) and reports its content's size otherwise.
    func leaf(alignment: Alignment) -> some View {
        frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: alignment)
    }
}

/// column / row / stack / flow / card / sheet / scroll and repeated groups.
struct NodeContainer: View {
    let node: RenderNode

    var body: some View {
        let spec = node.container ?? ContainerSpec(kind: .vertical)
        if let axis = spec.scroll {
            DesignScrollView(axis: axis, justify: spec.justify) { children }
        } else {
            // ViewGroup's clipChildren / clipToPadding: what lies outside the box is not drawn (a repeated
            // group sized by its template shows only what fits, as on Android).
            Group {
                switch spec.kind {
                case .vertical: DesignLinearLayout(vertical: true, justify: spec.justify) { children }
                case .horizontal: DesignLinearLayout(vertical: false, justify: spec.justify) { children }
                case .overlay: DesignFrameLayout { children }
                case .flow: DesignFlowLayout(gap: spec.flowGap, justify: spec.justify) { children }
                }
            }
            .clipped()
        }
    }

    private var children: some View {
        ForEach(node.children) { NodeView(node: $0) }
    }
}

/// ScrollView + its inner LinearLayout (a vertical one fills the viewport: setFillViewport).
struct DesignScrollView<Content: View>: View {
    let axis: ContainerSpec.ScrollAxis
    let justify: ContainerSpec.Justify
    @ViewBuilder let content: () -> Content
    @State private var viewport: CGFloat = 0

    var body: some View {
        if axis == .vertical {
            ScrollView(.vertical) {
                DesignLinearLayout(vertical: true, justify: .start, minMain: viewport) { content() }
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewport = $0 }
        } else {
            ScrollView(.horizontal) {
                DesignLinearLayout(vertical: false, justify: .start) { content() }
            }
        }
    }
}

/// A slot: the part registered for its name (contract 1) with the node's scope.
private struct DesignSlotView: View {
    let node: RenderNode
    let name: String
    @Environment(DesignHost.self) private var host
    @Environment(\.designRenderContext) private var context
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        host.services.slots.view(SlotContext(name: name, node: node, context: context ?? host.renderContext(), horizontalSizeClass: sizeClass, host: host))
            // The Tools dock floats above the composer (ui/look/Sheets.above).
            .anchorPreference(key: DockAnchorKey.self, value: .bounds) { name == "composer" ? $0 : nil }
    }
}
