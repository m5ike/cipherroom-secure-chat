// The NFC screens' building blocks — Android ToolPanels.label / button, the
// workbench's cardBox / field / iconButton / sectionTitle / mono / collapsible /
// table, in SwiftUI with the design's colours (Ui.color "@onSurface", "@muted",
// "@primary"…), its font family and Dynamic Type. Every word comes from the
// design (`NfcWords`); the few format names (HTML, CSV) are not words.

import M5Design
import M5NFC
import SwiftUI

/// The design's texts for the NFC screens (Android app.t / ConnTagUi.t): the key's text in the app's language.
struct NfcWords: Sendable {
    private let lookup: @Sendable (String) -> String
    /// The app's language (numbers "1,5 s").
    let lang: String

    init(_ translator: Translator) {
        lookup = { translator.t($0) }
        lang = translator.lang ?? "en"
    }

    init(lang: String = "en", _ lookup: @escaping @Sendable (String) -> String) {
        self.lookup = lookup
        self.lang = lang
    }

    func callAsFunction(_ key: String) -> String { lookup(key) }

    /// The design has the key (the translator answers a missing key with the key itself).
    func has(_ key: String) -> Bool { let s = lookup(key); return !s.isEmpty && s != key }

    /// The key's text, or — when this design has no such key — the text of a key it has.
    func or(_ key: String, _ fallbackKey: String) -> String { has(key) ? lookup(key) : lookup(fallbackKey) }

    /// "{0}", "{1}" … filled.
    func f(_ key: String, _ args: String...) -> String {
        var s = lookup(key)
        for (i, a) in args.enumerated() { s = s.replacingOccurrences(of: "{\(i)}", with: a) }
        return s
    }

    /// TemplateViews' labels: nil when the design has no text for the key (English then).
    var labels: TemplateViews.Labels { { k in has(k) ? lookup(k) : nil } }

    /// The built-in design in English (tests, previews).
    @MainActor static var builtIn: NfcWords { NfcWords(Translator(design: DesignAssets.builtIn, lang: "en")) }
}

/// The design's colours and font for the NFC screens (Android Ui.color(a, "@…")).
struct NfcPalette {
    let fg, muted, primary, onPrimary, danger, success, warning, surface, surfaceVariant, border: Color
    let family: FontFamily
    let reducedMotion: Bool

    @MainActor
    init(_ ctx: RenderContext, reducedMotion: Bool = false) {
        func c(_ token: String, _ fallback: DesignColor) -> Color { ctx.color(token, fallback).color }
        fg = c("@onSurface", .black)
        muted = c("@muted", .gray)
        primary = c("@primary", .blue)
        onPrimary = c("@onPrimary", .white)
        danger = c("@danger", DesignColor(argb: 0xFFDC2626))
        success = c("@success", DesignColor(argb: 0xFF2E7D32))
        warning = c("@warning", DesignColor(argb: 0xFFB45309))
        surface = c("@surface", .white)
        surfaceVariant = c("@surfaceVariant", .lightGray)
        border = c("@border", .lightGray)
        family = ctx.look.family(ctx.design)
        self.reducedMotion = reducedMotion
    }

    @MainActor
    init(host: DesignHost) { self.init(host.renderContext(), reducedMotion: host.reducedMotion) }
}

/// A label (Android ToolPanels.label): a size in sp, a colour, bold or not, monospaced or the design's family.
struct NfcText: View {
    let text: String
    var size: CGFloat = 14
    var color: Color
    var bold = false
    var mono = false
    var family: FontFamily = .sans
    var selectable = false
    @Environment(\.designTextScale) private var scale

    var body: some View {
        let t = Text(verbatim: text)
            .font(DesignFonts.font(size: size * scale, weight: bold ? .bold : .regular, italic: false, family: mono ? .mono : family))
            .foregroundStyle(color)
            .fixedSize(horizontal: false, vertical: true)
        if selectable { t.textSelection(.enabled) } else { t }
    }
}

/// A pill button with an icon (Android ToolPanels.button): primary = filled, else a tinted outline-less pill.
struct NfcPillButton: View {
    let label: String
    let icon: String
    var primary = false
    var enabled = true
    var fill = false
    let palette: NfcPalette
    var id: String = ""
    let action: @MainActor () -> Void
    @Environment(\.designTextScale) private var scale

    var body: some View {
        let fg = primary ? palette.onPrimary : palette.primary
        let bg = primary ? palette.primary : palette.primary.opacity(0.12)
        Button(action: action) {
            HStack(spacing: 8) {
                DesignIcon(name: icon, size: 18, color: fg)
                Text(verbatim: label)
                    .font(DesignFonts.font(size: 14.5 * scale, weight: .bold, italic: false, family: palette.family))
                    .foregroundStyle(fg)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 11)
            .frame(maxWidth: fill ? .infinity : nil)
            .background(Capsule().fill(bg))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
        .accessibilityIdentifier(id.isEmpty ? label : id)
    }
}

/// A round icon button that acts on an output (Android NfcWorkbench.iconButton): its name is the label.
struct NfcRoundIcon: View {
    let icon: String
    let label: String
    let palette: NfcPalette
    var id: String = ""
    let action: @MainActor () -> Void

    var body: some View {
        Button(action: action) {
            DesignIcon(name: icon, size: 22, color: palette.primary)
                .frame(width: 42, height: 42)
                .background(Circle().fill(palette.primary.opacity(0.12)))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: label))
        .accessibilityIdentifier(id.isEmpty ? label : id)
        .help(Text(verbatim: label))
    }
}

/// A card (Android cardBox): surface, 16 pt corners, a 1 pt border, 14 × 12 padding.
struct NfcCardBox<Content: View>: View {
    let palette: NfcPalette
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 4) { content }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 16).fill(palette.surface))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(palette.border, lineWidth: 1))
    }
}

/// A text field (Android field / EditText): surfaceVariant, 12 pt corners. `secret`: dots (the PIN).
struct NfcField: View {
    let hint: String
    @Binding var text: String
    var keyboard: UIKeyboardType = .default
    var secret = false
    var multiline = false
    var capitalize = false
    let palette: NfcPalette
    var id: String = ""
    @Environment(\.designTextScale) private var scale

    var body: some View {
        Group {
            if secret {
                SecureField(text: $text, prompt: Text(verbatim: hint).foregroundStyle(palette.muted)) { Text(verbatim: hint) }
            } else if multiline {
                TextField(text: $text, prompt: Text(verbatim: hint).foregroundStyle(palette.muted), axis: .vertical) { Text(verbatim: hint) }
                    .lineLimit(2...6)
            } else {
                TextField(text: $text, prompt: Text(verbatim: hint).foregroundStyle(palette.muted)) { Text(verbatim: hint) }
            }
        }
        .keyboardType(keyboard)
        .textInputAutocapitalization(capitalize ? .characters : .never)
        .autocorrectionDisabled()
        .textContentType(.none)
        .font(DesignFonts.font(size: 14 * scale, weight: .regular, italic: false, family: palette.family))
        .foregroundStyle(palette.fg)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 12).fill(palette.surfaceVariant))
        .accessibilityIdentifier(id.isEmpty ? hint : id)
    }
}

/// A small section title (Android sectionTitle): muted, bold, 12 sp.
struct NfcSectionTitle: View {
    let text: String
    let palette: NfcPalette

    var body: some View {
        NfcText(text: text, size: 12, color: palette.muted, bold: true, family: palette.family)
            .padding(.top, 10)
            .padding(.bottom, 3)
            .accessibilityAddTraits(.isHeader)
    }
}

/// "Label: value" — nothing when the value is empty (Android addField).
struct NfcField2: View {
    let label: String
    let value: String
    let color: Color
    let palette: NfcPalette

    var body: some View {
        if !value.isEmpty { NfcText(text: label + ": " + value, size: 14, color: color, family: palette.family) }
    }
}

/// A list behind a header that opens and closes it (Android collapsible: "▸ title" / "▾ title").
struct NfcCollapsible<Content: View>: View {
    let title: String
    let palette: NfcPalette
    @ViewBuilder let content: () -> Content
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button { open.toggle() } label: {
                NfcText(text: (open ? "▾ " : "▸ ") + title, size: 13, color: palette.primary, bold: true, family: palette.family)
                    .padding(.top, 10)
                    .padding(.bottom, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(.isHeader)
            if open { content() }
        }
    }
}

/// A small table (Android table): a header row, a rule, the rows; `endColumn` right-aligned (amounts).
struct NfcTable: View {
    let head: [String]
    let weights: [CGFloat]
    let rows: [[String]]
    var endColumn = -1
    let palette: NfcPalette

    var body: some View {
        VStack(spacing: 0) {
            row(head, color: palette.muted, bold: true)
            Rectangle().fill(palette.border).frame(height: 1)
            ForEach(Array(rows.enumerated()), id: \.offset) { _, r in row(r, color: palette.fg, bold: false) }
        }
    }

    private func row(_ cells: [String], color: Color, bold: Bool) -> some View {
        let total = weights.reduce(0, +)
        return GeometryReader { geo in
            HStack(spacing: 0) {
                ForEach(Array(cells.enumerated()), id: \.offset) { i, c in
                    NfcText(text: c, size: 12, color: color, bold: bold, family: palette.family)
                        .padding(.trailing, 6)
                        .frame(width: geo.size.width * (i < weights.count ? weights[i] : 1) / max(total, 1),
                               alignment: i == endColumn ? .trailing : .leading)
                }
            }
        }
        .frame(minHeight: 22)
        .padding(.vertical, 3)
    }
}

/// A segmented switch in the design's colours (Android viewSwitch).
struct NfcSegments: View {
    let items: [(id: String, label: String)]
    let selected: String
    let palette: NfcPalette
    let pick: @MainActor (String) -> Void
    @Environment(\.designTextScale) private var scale

    var body: some View {
        HStack(spacing: 0) {
            ForEach(items, id: \.id) { item in
                let on = item.id == selected
                Button { if !on { pick(item.id) } } label: {
                    Text(verbatim: item.label)
                        .font(DesignFonts.font(size: 13 * scale, weight: on ? .bold : .regular, italic: false, family: palette.family))
                        .foregroundStyle(on ? palette.onPrimary : palette.fg)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity)
                        .background(Capsule().fill(on ? palette.primary : Color.clear))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
                .accessibilityIdentifier("nfc.view." + item.id)
            }
        }
        .padding(3)
        .background(Capsule().fill(palette.surfaceVariant))
    }
}

/// An indeterminate spinner in the primary colour (Android ProgressBar).
struct NfcSpinner: View {
    let palette: NfcPalette
    var body: some View {
        ProgressView().progressViewStyle(.circular).tint(palette.primary).controlSize(.large)
            .frame(maxWidth: .infinity)
    }
}
