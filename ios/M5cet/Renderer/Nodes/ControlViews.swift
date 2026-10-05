// The elements that take input (Renderer.Bound: EditText, Switch / CheckBox, the
// select's menu, SeekBar, the segmented row): each writes through ActionRunner —
// a bound value with commit (a setting or $form, then its change event), a typed
// text with inputChanged (no redraw), Enter with the submit event.

import M5Design
import SwiftUI
import UIKit

/// Fires and commits for an element, with the sheet's dismissal and the haptics the look asks for.
@MainActor
struct NodeRunner {
    let host: DesignHost
    let node: RenderNode
    let actions: NodeActions

    var haptics: Bool { Look(settings: host.settings).haptics }

    func fire(_ name: String) {
        guard let e = node.events[name] else { return }
        if e.haptic == .tick { DesignHaptics.tick(haptics) }
        actions.willRun?()
        host.runner.fire(e, source: ActionSource(node.id))
    }

    func commit(_ value: DesignValue) {
        guard let binding = node.binding else { return }
        if binding.change != nil { actions.willRun?() }
        host.runner.commit(binding, value: value, source: ActionSource(node.id))
    }
}

// MARK: input

/// An EditText of the design: its text is $form[bind] (written on every change, no redraw); a value set
/// elsewhere (6.8: a button that makes up a code) shows in the field; Enter runs the submit event.
struct DesignInputView: View {
    let node: RenderNode
    let content: InputContent
    @Environment(DesignHost.self) private var host
    @Environment(\.designNodeActions) private var actions
    @Environment(\.designTextScale) private var scale
    @State private var text: String
    @FocusState private var focused: Bool

    init(node: RenderNode, content: InputContent) {
        self.node = node
        self.content = content
        _text = State(initialValue: content.value)
    }

    var body: some View {
        let st = TextLook(node.textStyle)
        field
            .font(st.font(scale))
            .foregroundStyle(st.color.color)
            .tint(host.renderContext().swiftColor("@primary", .blue))
            .focused($focused)
            .onChange(of: text) { _, new in
                if let bind = content.bind { host.runner.inputChanged(bind: bind, text: new) }
            }
            .onChange(of: content.value) { _, new in
                if new != text { text = new }
            }
            .onSubmit { if content.submits { NodeRunner(host: host, node: node, actions: actions).fire("submit") } }
            .submitLabel(content.submits ? .done : .return)
            .modifier(Keyboard(kind: content.kind))
            .accessibilityLabel(Text(verbatim: content.hint))
    }

    @ViewBuilder private var field: some View {
        let prompt = Text(verbatim: content.hint).foregroundStyle((node.textStyle?.hintColor ?? .gray).color)
        switch content.kind {
        case .password: SecureField(text: $text, prompt: prompt) { Text(verbatim: content.hint) }
        case .multiline: TextField(text: $text, prompt: prompt, axis: .vertical) { Text(verbatim: content.hint) }.lineLimit(1...8)
        default: TextField(text: $text, prompt: prompt) { Text(verbatim: content.hint) }
        }
    }

    private struct Keyboard: ViewModifier {
        let kind: InputKind
        func body(content: Content) -> some View {
            switch kind {
            case .number: content.keyboardType(.numberPad)
            case .email: content.keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
            case .phone: content.keyboardType(.phonePad)
            case .url: content.keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
            case .password: content.textInputAutocapitalization(.never).autocorrectionDisabled()
            case .text, .multiline: content.textInputAutocapitalization(.sentences)
            }
        }
    }
}

// MARK: switch, checkbox

/// Switch / CheckBox: bound and without a click event, a tap commits the new state; else the click event runs.
struct DesignToggleView: View {
    let node: RenderNode
    let content: ToggleContent
    @Environment(DesignHost.self) private var host
    @Environment(\.designNodeActions) private var actions
    @Environment(\.designTextScale) private var scale

    var body: some View {
        let runner = NodeRunner(host: host, node: node, actions: actions)
        let isOn = Binding(get: { content.checked }, set: { on in
            if content.commitsOnTap { runner.commit(.bool(on)) } else { runner.fire("click") }
        })
        let st = TextLook(node.textStyle)
        let label = Text(verbatim: content.text).font(st.font(scale)).foregroundStyle(node.foreground.color)
        Group {
            if content.style == .toggle {
                Toggle(isOn: isOn) { label }
                    .toggleStyle(.switch)
                    .tint(content.tint.color)
                    .labelsHidden(content.text.isEmpty)
            } else {
                Toggle(isOn: isOn) { label }
                    .toggleStyle(DesignCheckboxStyle(tint: content.tint, border: node.foreground.withAlpha(0.6).color, hasLabel: !content.text.isEmpty))
            }
        }
    }
}

private extension View {
    @ViewBuilder func labelsHidden(_ hidden: Bool) -> some View {
        if hidden { self.labelsHidden() } else { self }
    }
}

/// The CheckBox: a square with a check before its text.
struct DesignCheckboxStyle: ToggleStyle {
    let tint: DesignColor
    let border: Color
    let hasLabel: Bool

    func makeBody(configuration: Configuration) -> some View {
        Button { configuration.isOn.toggle() } label: {
            HStack(spacing: hasLabel ? 10 : 0) {
                ZStack {
                    RoundedRectangle(cornerRadius: 4, style: .circular)
                        .fill(configuration.isOn ? tint.color : .clear)
                    RoundedRectangle(cornerRadius: 4, style: .circular)
                        .strokeBorder(configuration.isOn ? tint.color : border, lineWidth: 2)
                    if configuration.isOn {
                        Image(systemName: "checkmark")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(Palette.onColor(tint).color)
                    }
                }
                .frame(width: 20, height: 20)
                .padding(4)
                if hasLabel { configuration.label }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isToggle)
        .accessibilityValue(Text(verbatim: configuration.isOn ? "1" : "0"))
    }
}

// MARK: select

/// A drop-down choice: the current option's label (or the hint) with a chevron; a tap shows the options in the
/// design's menu card, the current one checked; a pick commits it.
struct DesignSelectView: View {
    let node: RenderNode
    let content: SelectContent
    @Environment(DesignHost.self) private var host
    @Environment(\.designNodeActions) private var actions
    @Environment(\.designTextScale) private var scale

    var body: some View {
        let st = TextLook(node.textStyle)
        Button(action: open) {
            HStack(spacing: CGFloat(content.chevron.gap)) {
                Text(verbatim: content.label)
                    .font(st.font(scale))
                    .foregroundStyle(node.foreground.color)
                    .lineLimit(st.lines ?? 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                DesignIcon(name: content.chevron.name, size: content.chevron.size, color: content.chevron.color.color)
            }
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(node.id + "/select")
        .accessibilityValue(Text(verbatim: content.label))
    }

    private func open() {
        let runner = NodeRunner(host: host, node: node, actions: actions)
        if node.events["click"] != nil { runner.fire("click"); return }
        guard !content.options.isEmpty else { return }
        let entries = content.options.enumerated().map { i, o in
            MenuEntry(id: i, icon: "", label: o.label, checked: o.value == content.current) { runner.commit(.string(o.value)) }
        }
        host.showMenu(entries, anchor: node.id)
    }
}

// MARK: slider

/// SeekBar: the thumb follows the finger; the value (stepped, 3 decimals) is committed on release.
struct DesignSliderView: View {
    let node: RenderNode
    let content: SliderContent
    @Environment(DesignHost.self) private var host
    @Environment(\.designNodeActions) private var actions
    @State private var fraction: Double
    @State private var dragging = false

    init(node: RenderNode, content: SliderContent) {
        self.node = node
        self.content = content
        _fraction = State(initialValue: content.fraction)
    }

    var body: some View {
        Slider(value: $fraction, in: 0...1) { editing in
            dragging = editing
            if !editing { NodeRunner(host: host, node: node, actions: actions).commit(.number(content.value(atFraction: fraction))) }
        }
        .tint(content.tint.color)
        .onChange(of: content.fraction) { _, new in if !dragging { fraction = new } }
        .accessibilityValue(Text(verbatim: Expr.toText(.number(content.value(atFraction: fraction)))))
        .frame(idealWidth: 200)
    }
}

// MARK: segmented

/// A few choices side by side: equal segments on the surface variant, the chosen one raised (tonal looks)
/// or filled with the accent (the filled look); a tap commits its value.
struct DesignSegmentedView: View {
    let node: RenderNode
    let content: SegmentedContent
    @Environment(DesignHost.self) private var host
    @Environment(\.designNodeActions) private var actions
    @Environment(\.designRenderContext) private var context
    @Environment(\.designTextScale) private var scale

    var body: some View {
        let family = context?.look.family(context?.design) ?? .sans
        HStack(spacing: 0) {
            ForEach(Array(content.options.enumerated()), id: \.offset) { i, o in
                let selected = content.selectedIndex == i
                Button {
                    let runner = NodeRunner(host: host, node: node, actions: actions)
                    DesignHaptics.tick(runner.haptics)
                    runner.commit(.string(o.value))
                } label: {
                    Text(verbatim: o.label)
                        .font(DesignFonts.font(size: CGFloat(content.textSize) * scale, weight: selected ? content.selectedWeight : .regular, italic: false, family: family))
                        .foregroundStyle((selected ? content.selectedText : content.text).color)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .frame(maxWidth: .infinity, minHeight: 38)
                        .background {
                            RoundedRectangle(cornerRadius: CGFloat(content.innerRadius), style: .circular)
                                .fill(selected ? content.selectedFill.color : .clear)
                                .shadow(color: .black.opacity(selected && content.selectedElevation > 0 ? 0.18 : 0), radius: 1, y: 0.5)
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
                .accessibilityIdentifier(node.id + "/" + o.value)
            }
        }
    }
}
