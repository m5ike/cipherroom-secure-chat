// ui/parts/ComposerSuggest (6.11): what typing "/", "@" or "#" offers, in sections
// ("Recently used", "Commands", "Other matches", "People", "Tags"), each row a 56 pt
// target: a command with its model's icon in its colour, the keyword and name with
// what matched highlighted, the summary, the arguments (required ones stand out)
// and who sees the answer; a person with their monogram; a tag. While a command's
// arguments are typed, a hint bar says which one is next — the usage line with it
// highlighted, what it expects, its help, and its values to tap. The suggestions and
// hints come from the commands engine (core.fn — the tools agent's FnEngine).

import M5Core
import M5Design
import M5Proto
import SwiftUI
import UIKit

/// The list above the field (at most 272 pt: it stays above the keyboard).
struct ComposerSuggestList: View {
    let result: Suggestions.Result
    let ctx: SlotContext
    let put: (String, Int) -> Void
    @Environment(\.designTextScale) private var scale

    var body: some View {
        let c = ctx.context
        let muted = c.swiftColor("@muted", .gray)
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(sections.enumerated()), id: \.offset) { _, part in
                    if let header = part.header {
                        Text(verbatim: ctx.t("fnm.sec." + header).uppercased(with: Locale(identifier: DesignLocales.tag(ctx.host.services.lang))))
                            .font(.system(size: 11 * scale, weight: .bold))
                            .kerning(0.66)
                            .foregroundStyle(muted)
                            .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 2)
                            .accessibilityAddTraits(.isHeader)
                    }
                    ForEach(Array(part.items.enumerated()), id: \.offset) { _, it in
                        if it.disabled {
                            Text(verbatim: it.key == "off" ? ctx.t("functions.off") : ctx.t("fnm.none"))
                                .font(.system(size: 13.5 * scale)).foregroundStyle(muted)
                                .padding(.horizontal, 16).padding(.vertical, 12)
                                .frame(minHeight: 48, alignment: .leading)
                        } else {
                            row(it)
                        }
                    }
                }
            }
            .padding(.vertical, 4)
        }
        .frame(maxHeight: 272)
        .fixedSize(horizontal: false, vertical: true)
    }

    /// Items grouped under their section's header (a notice has none).
    private var sections: [(header: String?, items: [Suggestions.Item])] {
        var out = [(header: String?, items: [Suggestions.Item])]()
        var section: String?
        for it in result.items {
            if !it.disabled && !it.section.isEmpty && it.section != section {
                section = it.section
                out.append((it.section, [it]))
            } else if out.isEmpty {
                out.append((nil, [it]))
            } else {
                out[out.count - 1].items.append(it)
            }
        }
        return out
    }

    private func row(_ it: Suggestions.Item) -> some View {
        let c = ctx.context
        let fg = c.swiftColor("@onSurface", .black), muted = c.swiftColor("@muted", .gray), primary = c.swiftColor("@primary", .blue)
        return Button {
            DesignHaptics.tick(Look(settings: ctx.host.settings).haptics)
            if let text = it.text { put(text, it.cursor) }
        } label: {
            HStack(spacing: 0) {
                face(it).frame(width: 36, height: 36)
                VStack(alignment: .leading, spacing: 1) {
                    Text(topLine(it, fg: fg, muted: muted, primary: primary)).font(.system(size: 15 * scale)).lineLimit(1)
                    if !it.summary.isEmpty {
                        Text(ComposerSuggestList.highlighted(it.summary, it.summaryHits, color: muted, accent: primary, bold: false))
                            .font(.system(size: 12.5 * scale)).lineLimit(1)
                    }
                    if !it.args.isEmpty { Text(signature(it.args, fg: fg, muted: muted)).font(.system(size: 12.5 * scale, design: .monospaced)) }
                }
                .padding(.leading, 12).padding(.trailing, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                if !it.visibility.isEmpty { badge(it.visibility) }
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
            .frame(minHeight: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: describe(it)))
        .accessibilityAddTraits(.isButton)
    }

    /// The keyword (or name, tag) and — for a command — its name beside it.
    private func topLine(_ it: Suggestions.Item, fg: Color, muted: Color, primary: Color) -> AttributedString {
        var top = ComposerSuggestList.highlighted(it.label, it.labelHits, color: fg, accent: primary, bold: true)
        if !it.name.isEmpty && it.name.lowercased() != it.key.lowercased() {
            top += AttributedString("  ")
            top += ComposerSuggestList.highlighted(it.name, it.nameHits, color: muted, accent: primary, bold: false)
        }
        return top
    }

    /// The command's model in its colour, a person's monogram, a tag's hash.
    @ViewBuilder
    private func face(_ it: Suggestions.Item) -> some View {
        if let model = it.model {
            ModelCircle(model: model, size: 36, icon: 20)
        } else if it.section == "people" {
            let name = it.key.isEmpty ? "?" : it.key
            Text(verbatim: String(name.prefix(1)).uppercased())
                .font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(Circle().fill(Color(uiColor: UIColor(chatArgb: MonogramHue.hsl(Float(MonogramHue.hue(name)), 0.55, 0.48, 1)))))
                .accessibilityHidden(true)
        } else {
            DesignIcon(name: "hash", size: 18, color: ctx.color("@primary", .blue))
                .frame(width: 36, height: 36)
                .background(Circle().fill(ctx.color("@primary", .blue).opacity(0.14)))
        }
    }

    /// "<number> [format]": required arguments in the text colour, optional ones muted.
    private func signature(_ args: [Suggestions.Arg], fg: Color, muted: Color) -> AttributedString {
        var out = AttributedString()
        for (i, x) in args.enumerated() {
            if i > 0 { out += AttributedString(" ") }
            var a = AttributedString(x.required ? "<" + x.name + ">" : "[" + x.name + "]")
            a.foregroundColor = x.required ? fg : muted
            if x.required { a.inlinePresentationIntent = .stronglyEmphasized }
            out += a
        }
        return out
    }

    /// Who sees the model's answer: the room, or only the one who runs it.
    private func badge(_ visibility: String) -> some View {
        let room = visibility == "room"
        let c = room ? ctx.color("@primary", .blue) : ctx.color("@muted", .gray)
        return HStack(spacing: 4) {
            DesignIcon(name: room ? "users" : "lock", size: 12, color: c)
            Text(verbatim: ctx.t(room ? "fnm.vis.room" : "fnm.vis.caller")).font(.system(size: 11 * scale)).foregroundStyle(c)
        }
        .padding(.leading, 6).padding(.trailing, 8).padding(.vertical, 2)
        .background(Capsule().fill(c.opacity(0.12)))
        .accessibilityHidden(true)
    }

    private func describe(_ it: Suggestions.Item) -> String {
        var s = ctx.t("fnm.pick").replacingOccurrences(of: "{label}", with: it.label)
        if !it.name.isEmpty && it.name.lowercased() != it.key.lowercased() { s += ". " + it.name }
        if !it.summary.isEmpty { s += ". " + it.summary }
        for x in it.args { s += ". " + x.name + ", " + ctx.t(x.required ? "fnm.required" : "fnm.optional") }
        if !it.visibility.isEmpty { s += ". " + ctx.t(it.visibility == "room" ? "fnm.vis.room" : "fnm.vis.caller") }
        return s
    }

    /// `text` with its matched parts (UTF-16 ranges) in the accent colour and bold.
    static func highlighted(_ text: String, _ hits: [Range<Int>], color: Color, accent: Color, bold: Bool) -> AttributedString {
        let ns = NSMutableAttributedString(string: text)
        let n = (text as NSString).length
        for h in hits {
            let s = max(0, min(h.lowerBound, n)), e = max(0, min(h.upperBound, n))
            if e > s { ns.addAttribute(.init("m5hit"), value: true, range: NSRange(location: s, length: e - s)) }
        }
        var out = AttributedString(text)
        out.foregroundColor = color
        if bold { out.inlinePresentationIntent = .stronglyEmphasized }
        ns.enumerateAttribute(.init("m5hit"), in: NSRange(location: 0, length: n)) { v, r, _ in
            guard v != nil, let range = Range(r, in: text), let lo = AttributedString.Index(range.lowerBound, within: out),
                  let hi = AttributedString.Index(range.upperBound, within: out) else { return }
            out[lo..<hi].foregroundColor = accent
            out[lo..<hi].inlinePresentationIntent = .stronglyEmphasized
        }
        return out
    }
}

/// A model's avatar: its icon (or emoji) in white on its colour.
struct ModelCircle: View {
    let model: ModelIdentity
    let size: CGFloat
    let icon: CGFloat

    var body: some View {
        ZStack {
            Circle().fill(Color(uiColor: UIColor(chatArgb: model.argb)))
            if model.lucide {
                DesignIcon(name: BubbleModelFace.glyph(model) { ChatIcons.has($0) }, size: icon, color: .white)
            } else {
                Text(verbatim: model.icon).font(.system(size: icon - 2))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The hint bar while a command's arguments are typed: the usage, what the next one expects, its values to tap.
struct ComposerArgHint: View {
    let hint: ArgHint
    let ctx: SlotContext
    let put: (String, Int) -> Void
    @Environment(\.designTextScale) private var scale

    var body: some View {
        let c = ctx.context
        let fg = c.swiftColor("@onSurface", .black), muted = c.swiftColor("@muted", .gray), primary = c.swiftColor("@primary", .blue)
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                ModelCircle(model: hint.model, size: 24, icon: 14)
                Text(usage(fg: fg, muted: muted, primary: primary)).font(.system(size: 13.5 * scale, design: .monospaced)).lineLimit(1)
            }
            Text(what(fg: fg, muted: muted))
                .font(.system(size: 12.5 * scale))
                .padding(.leading, 32).padding(.top, 3)
                .accessibilityAddTraits(.updatesFrequently)
            if !hint.values.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(hint.values, id: \.self) { v in
                            Button {
                                DesignHaptics.tick(Look(settings: ctx.host.settings).haptics)
                                let p = hint.pick(v)
                                put(p.text, p.cursor)
                            } label: {
                                Text(verbatim: v).font(.system(size: 13.5 * scale)).foregroundStyle(primary)
                                    .padding(.horizontal, 12).frame(minHeight: 36)
                                    .background(Capsule().fill(primary.opacity(0.12)))
                                    .overlay(Capsule().strokeBorder(primary.opacity(0.4), lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(Text(verbatim: ctx.t("fnm.hint.value").replacingOccurrences(of: "{value}", with: v)))
                        }
                    }
                    .padding(.leading, 28).padding(.top, 4)
                }
            }
        }
        .padding(.horizontal, 14).padding(.top, 8).padding(.bottom, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(primary.opacity(0.06))
    }

    /// The usage line, the argument being typed highlighted (white on the primary colour), the required ones in the text colour.
    private func usage(fg: Color, muted: Color, primary: Color) -> AttributedString {
        let text = hint.usage
        var out = AttributedString(text)
        out.foregroundColor = muted
        let n = (text as NSString).length
        for (k, span) in hint.spans.enumerated() {
            let s = max(0, min(span.lowerBound, n)), e = max(0, min(span.upperBound, n))
            guard e > s, let r = Range(NSRange(location: s, length: e - s), in: text),
                  let lo = AttributedString.Index(r.lowerBound, within: out), let hi = AttributedString.Index(r.upperBound, within: out) else { continue }
            if k == hint.current {
                out[lo..<hi].foregroundColor = .white
                out[lo..<hi].backgroundColor = primary
                out[lo..<hi].inlinePresentationIntent = .stronglyEmphasized
            } else if k < hint.command.inputs.count && hint.command.inputs[k].mustGive {
                out[lo..<hi].foregroundColor = fg
            }
        }
        return out
    }

    private func what(fg: Color, muted: Color) -> AttributedString {
        guard let input = hint.input else {
            var a = AttributedString(ctx.t("fnm.hint.done"))
            a.foregroundColor = muted
            return a
        }
        var name = AttributedString(!input.label.isEmpty ? input.label : input.name)
        name.foregroundColor = fg
        name.inlinePresentationIntent = .stronglyEmphasized
        var rest = AttributedString(" · " + ctx.t(input.mustGive ? "fnm.required" : "fnm.optional") + " · " + CommandCheck.expectation(input, ctx.t)
                                    + (input.help.isEmpty ? "" : "\n" + input.help))
        rest.foregroundColor = muted
        return name + rest
    }
}
