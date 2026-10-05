// An element's own box (Renderer.Bound.staticStyle + dynamicStyle): padding, the
// painted background with its corners and shadow (elevation), the border, the clip
// to the rounded outline, opacity, a minimum height — and how a press shows
// (ui/look/Look.pressable: a ripple of a colour behind the content, a slight
// shrink, the system's highlight, or nothing).

import M5Design
import SwiftUI

extension DesignInsets {
    /// Physical edges as Android's setPadding (the app's languages are all left-to-right).
    var edgeInsets: EdgeInsets { EdgeInsets(top: top, leading: left, bottom: bottom, trailing: right) }
}

/// The rounded outline a painted element is clipped to (no clip for an unpainted or square one).
struct NodeClipShape: Shape {
    var radius: CGFloat
    var enabled: Bool

    func path(in rect: CGRect) -> Path {
        guard enabled else { return Path(rect.insetBy(dx: -100_000, dy: -100_000)) }
        return RoundedRectangle(cornerRadius: radius, style: .circular).path(in: rect)
    }
}

private struct DesignPressedKey: EnvironmentKey { static let defaultValue = false }

extension EnvironmentValues {
    /// The element (a button, an icon button) is being pressed now.
    var designPressed: Bool {
        get { self[DesignPressedKey.self] }
        set { self[DesignPressedKey.self] = newValue }
    }
}

struct NodeChrome: ViewModifier {
    let box: BoxStyle
    var pressed = false
    /// The system's highlight (a clickable element without a background).
    var highlight: Color = .black.opacity(0.12)
    var reduceMotion = false

    func body(content: Content) -> some View {
        let r = CGFloat(box.radius)
        let shape = RoundedRectangle(cornerRadius: r, style: .circular)
        let fill = box.fill
        let painted = fill != nil || box.border != nil
        let elevation = CGFloat(box.elevation ?? 0)
        let shadowed = elevation > 0 && (fill?.alpha ?? 0) > 0
        var ripple = Color.clear
        if pressed, case .ripple(let c) = box.press { ripple = c.color }
        let scaled = pressed && box.press == .scale
        return content
            .padding(box.padding.edgeInsets)
            .frame(minHeight: box.minHeight.map { CGFloat($0) })
            .background { shape.fill(ripple) }
            .clipShape(NodeClipShape(radius: r, enabled: painted && r > 0))
            .background {
                shape.fill(fill?.color ?? .clear)
                    .shadow(color: .black.opacity(shadowed ? 0.2 : 0), radius: shadowed ? elevation * 0.9 : 0, x: 0, y: shadowed ? elevation * 0.45 : 0)
            }
            .overlay {
                if let b = box.border, b.width > 0 { shape.strokeBorder(b.color.color, lineWidth: b.width) }
            }
            .overlay { (pressed && box.press == .system ? highlight : Color.clear).clipShape(NodeClipShape(radius: r, enabled: r > 0)).allowsHitTesting(false) }
            .scaleEffect(scaled ? 0.94 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: scaled ? 0.07 : 0.14), value: scaled)
            .opacity(box.opacity ?? 1)
    }
}

/// A clickable element: the chrome follows the press.
struct NodeButtonStyle: ButtonStyle {
    let box: BoxStyle
    var highlight: Color = .black.opacity(0.12)
    var reduceMotion = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .environment(\.designPressed, configuration.isPressed)
            .modifier(NodeChrome(box: box, pressed: configuration.isPressed, highlight: highlight, reduceMotion: reduceMotion))
            .contentShape(Rectangle())
    }
}
