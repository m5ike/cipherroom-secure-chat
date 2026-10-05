// Colours, fonts and easings of the design in SwiftUI — what android/…/ui/Ui.java
// gives the renderer and the parts: Ui.color / alpha (DesignColor is already
// resolved), Ui.typeface / labelFace (the font families), Ui.easing.

import M5Design
import SwiftUI
import UIKit

extension DesignColor {
    /// sRGB, as Android's ints.
    var color: Color { Color(.sRGB, red: red, green: green, blue: blue, opacity: alpha) }
    var uiColor: UIColor { UIColor(red: red, green: green, blue: blue, alpha: alpha) }
}

extension RenderContext {
    /// A design colour as SwiftUI draws it.
    func swiftColor(_ token: String, _ fallback: DesignColor = .magenta) -> Color { color(token, fallback).color }
}

/// The design's text sizes are sp on Android (they follow the system's font size): here they follow
/// Dynamic Type — the body style's factor at the environment's size, at most 2× (Android 14's cap).
enum DesignTextScale {
    static func factor(_ size: DynamicTypeSize) -> CGFloat {
        let category = UIContentSizeCategory(size)
        let traits = UITraitCollection(preferredContentSizeCategory: category)
        let f = UIFontMetrics(forTextStyle: .body).scaledValue(for: 100, compatibleWith: traits) / 100
        return min(2, max(0.8, f))
    }
}

private struct DesignTextScaleKey: EnvironmentKey { static let defaultValue: CGFloat = 1 }

extension EnvironmentValues {
    /// Dynamic Type's factor for the design's sizes (set by the shell).
    var designTextScale: CGFloat {
        get { self[DesignTextScaleKey.self] }
        set { self[DesignTextScaleKey.self] = newValue }
    }
}

extension UIContentSizeCategory {
    init(_ size: DynamicTypeSize) {
        switch size {
        case .xSmall: self = .extraSmall
        case .small: self = .small
        case .medium: self = .medium
        case .large: self = .large
        case .xLarge: self = .extraLarge
        case .xxLarge: self = .extraExtraLarge
        case .xxxLarge: self = .extraExtraExtraLarge
        case .accessibility1: self = .accessibilityMedium
        case .accessibility2: self = .accessibilityLarge
        case .accessibility3: self = .accessibilityExtraLarge
        case .accessibility4: self = .accessibilityExtraExtraLarge
        case .accessibility5: self = .accessibilityExtraExtraExtraLarge
        @unknown default: self = .large
        }
    }
}

enum DesignFonts {
    /// Ui.typeface / Look.familyName: the design's family at a size (points, Dynamic Type applied).
    static func font(size: CGFloat, weight: FontWeightKind, italic: Bool, family: FontFamily) -> Font {
        var w: Font.Weight
        switch weight {
        case .regular: w = .regular
        case .medium: w = .medium
        case .bold: w = .bold
        }
        var f: Font
        switch family {
        case .sans: f = .system(size: size, weight: w, design: .default)
        case .serif: f = .system(size: size, weight: w, design: .serif)
        case .mono: f = .system(size: size, weight: w, design: .monospaced)
        case .condensed: f = .system(size: size, weight: w, design: .default).width(.condensed)
        case .medium:
            // sans-serif-medium: one step heavier.
            f = .system(size: size, weight: w == .regular ? .medium : .bold, design: .default)
        case .light:
            f = .system(size: size, weight: w == .regular ? .light : w == .medium ? .regular : .semibold, design: .default)
        case .casual: f = .system(size: size, weight: w, design: .rounded)
        case .cursive: f = .custom(w == .bold ? "SnellRoundhand-Bold" : "SnellRoundhand", fixedSize: size)
        }
        return italic ? f.italic() : f
    }

    static func font(_ style: TextStyle, scale: CGFloat) -> Font {
        font(size: CGFloat(style.size) * scale, weight: style.weight, italic: style.italic, family: style.family)
    }

    /// Ui.labelFace: labels in the medium weight where the family has one.
    static func label(size: CGFloat, family: FontFamily) -> Font {
        font(size: size, weight: family == .sans ? .medium : .bold, italic: false, family: family)
    }
}

extension Easing {
    /// Ui.easing as a SwiftUI animation of a duration (seconds).
    func animation(_ seconds: Double) -> Animation {
        switch self {
        case .standard: .timingCurve(0.4, 0, 0.2, 1, duration: seconds)
        // DecelerateInterpolator(1.6): 1 − (1 − t)^3.2
        case .decelerate: .timingCurve(0.15, 0.6, 0.3, 1, duration: seconds)
        // AccelerateInterpolator(1.4): t^2.8
        case .accelerate: .timingCurve(0.55, 0, 0.85, 0.4, duration: seconds)
        case .linear: .linear(duration: seconds)
        // OvershootInterpolator(1.6)
        case .overshoot: .timingCurve(0.3, 1.5, 0.6, 1, duration: seconds)
        case .bounce: .bouncy(duration: seconds, extraBounce: 0.25)
        }
    }
}

extension TextAlign {
    var horizontal: HorizontalAlignment { self == .center ? .center : self == .end ? .trailing : .leading }
    var textAlignment: TextAlignment { self == .center ? .center : self == .end ? .trailing : .leading }
}

/// Short ticks under the finger (Look.haptic; Settings › Appearance › Haptics decides).
@MainActor
enum DesignHaptics {
    static func tick(_ on: Bool) { if on { UIImpactFeedbackGenerator(style: .light).impactOccurred() } }
    static func long(_ on: Bool) { if on { UIImpactFeedbackGenerator(style: .medium).impactOccurred() } }
}
