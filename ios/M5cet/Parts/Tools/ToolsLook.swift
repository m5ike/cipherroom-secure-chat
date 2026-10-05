// How the tools look and speak (android fn/Theme + Words): the design's colour
// tokens (@primary, @onPrimary, @onSurface, @muted, @surfaceVariant, @border,
// @danger, @success, @warning…) in the window's tone and look, its texts in the
// app's language — and, for the web's i18n keys of the outputs (fnui.*,
// functions.*), Android's English when a design lacks one (Words.java).

import M5Design
import M5Proto
import SwiftUI

@MainActor
struct ToolsLook {
    let context: RenderContext

    init(_ context: RenderContext) { self.context = context }

    init(host: DesignHost) { context = host.renderContext() }

    var dark: Bool { context.dark }

    /// A design colour ("@primary", "#rrggbb") in the current tone and look.
    func color(_ token: String, _ fallback: DesignColor = .gray) -> Color { context.color(token, fallback).color }

    func design(_ token: String, _ fallback: DesignColor = .gray) -> DesignColor { context.color(token, fallback) }

    /// A text of the design.
    func t(_ key: String) -> String { context.translator.t(key) }

    /// Words.t: the design's text, else the web's English; {name} filled from pairs ("what", "buttons", …).
    func words(_ key: String, _ pairs: String...) -> String { ToolsLook.words(key, pairs, t) }

    nonisolated static func words(_ key: String, _ pairs: [String], _ t: (String) -> String) -> String {
        var s = t(key)
        if s.isEmpty || s == key { s = english[key] ?? key }
        var i = 0
        while i + 1 < pairs.count {
            s = s.replacingOccurrences(of: "{" + pairs[i] + "}", with: pairs[i + 1])
            i += 2
        }
        return s
    }

    /// The web's English (client/src/lib/i18n.ts) of the keys a design may lack (Words.EN).
    nonisolated static let english: [String: String] = [
        "fnui.submit": "Send", "fnui.sending": "Sending…", "fnui.sent": "Sent", "fnui.required": "Required",
        "fnui.invalid": "Not a valid value", "fnui.email": "Enter an e-mail address", "fnui.number": "Enter a number",
        "fnui.incomplete": "Fill in the whole value", "fnui.choose": "Choose…", "fnui.confirm": "Sure?",
        "fnui.noEvent": "This model does not answer {what}.", "fnui.what.button": "buttons", "fnui.what.form": "forms",
        "fnui.renderFailed": "This part of the result could not be shown ({message}).", "fnui.play": "Play",
        "fnui.download": "Download", "fnui.open": "Open", "fnui.webOnly": "Opens in the web app",
        "functions.send": "Send", "functions.cancel": "Cancel", "fnm.ask.required": "Fill in the required fields",
    ]
}

extension View {
    /// Text size in design points scaled like the app's sp (Dynamic Type, at most 2×) — DesignTextScale.
    func toolsFont(_ size: CGFloat, weight: Font.Weight = .regular, design: Font.Design = .default, italic: Bool = false) -> some View {
        modifier(ToolsFontModifier(size: size, weight: weight, design: design, italic: italic))
    }
}

private struct ToolsFontModifier: ViewModifier {
    let size: CGFloat
    let weight: Font.Weight
    let design: Font.Design
    let italic: Bool
    @ScaledMetric(relativeTo: .body) private var unit: CGFloat = 1

    func body(content: Content) -> some View {
        let f = Font.system(size: size * min(unit, 2), weight: weight, design: design)
        content.font(italic ? f.italic() : f)
    }
}
