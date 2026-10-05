// Markdown drawn natively — a port of android/…/fn/Markdown.java
// (components/Markdown.tsx): the tree of FnMarkdownTree as SwiftUI —
// headings, bold, italic, strike-through, inline code and code blocks, links
// (only https / http / mailto, opened by the app through its confirmation),
// lists with their markers in the margin, quotes, rules, and tables as
// monospace columns. For the assistant, function outputs and forms.

import M5Design
import SwiftUI

struct FnMarkdownView: View {
    let blocks: [FnMarkdownTree.Block]
    let ink: Color
    let muted: Color
    let panel: Color
    let border: Color
    let link: Color
    var size: CGFloat = 15
    /// A link someone tapped.
    var onLink: (String) -> Void = { _ in }

    init(text: String, look: ToolsLook, ink: Color? = nil, size: CGFloat = 15, onLink: @escaping (String) -> Void) {
        blocks = FnMarkdownTree.parse(text)
        self.ink = ink ?? look.color("@onSurface")
        muted = look.color("@muted")
        panel = look.color("@surfaceVariant")
        border = look.color("@border")
        link = look.color("@primary")
        self.size = size
        self.onLink = onLink
    }

    var body: some View {
        BlockList(blocks: blocks, tight: false, md: self)
            .environment(\.openURL, OpenURLAction { url in
                onLink(url.absoluteString)
                return .handled
            })
    }

    /// The inline nodes as attributed text (bold, italic, strike-through, code, links).
    func attributed(_ nodes: [FnMarkdownTree.Inline]) -> AttributedString {
        var out = AttributedString()
        append(nodes, into: &out, intent: [], href: nil)
        return out
    }

    private func append(_ nodes: [FnMarkdownTree.Inline], into out: inout AttributedString, intent: InlinePresentationIntent, href: String?) {
        for n in nodes {
            switch n.t {
            case "text", "code":
                var a = AttributedString(n.v)
                var i = intent
                if n.t == "code" { i.insert(.code); a.backgroundColor = panel }
                if !i.isEmpty { a.inlinePresentationIntent = i }
                if let href, let url = URL(string: href) {
                    a.link = url
                    a.foregroundColor = link
                    a.underlineStyle = .single
                }
                out += a
            case "br": out += AttributedString("\n")
            case "strong": append(n.c, into: &out, intent: intent.union(.stronglyEmphasized), href: href)
            case "em": append(n.c, into: &out, intent: intent.union(.emphasized), href: href)
            case "del": append(n.c, into: &out, intent: intent.union(.strikethrough), href: href)
            case "link": append(n.c, into: &out, intent: intent, href: n.href)
            default: break
            }
        }
    }

    // MARK: blocks

    private struct BlockList: View {
        let blocks: [FnMarkdownTree.Block]
        let tight: Bool
        let md: FnMarkdownView

        var body: some View {
            VStack(alignment: .leading, spacing: tight ? 2 : md.size * 0.5) {
                ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in BlockView(block: b, md: md) }
            }
        }
    }

    private struct BlockView: View {
        let block: FnMarkdownTree.Block
        let md: FnMarkdownView

        var body: some View {
            switch block.t {
            case "p":
                Text(md.attributed(block.inline))
                    .toolsFont(md.size)
                    .foregroundStyle(md.ink)
                    .tint(md.link)
                    .fixedSize(horizontal: false, vertical: true)
            case "h":
                Text(md.attributed(block.inline))
                    .toolsFont(md.size * (block.level <= 2 ? 1.2 : block.level == 3 ? 1.1 : 1), weight: .bold)
                    .foregroundStyle(md.ink)
                    .tint(md.link)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
            case "code":
                Text(verbatim: block.v.isEmpty ? " " : block.v)
                    .toolsFont(md.size * 0.9, design: .monospaced)
                    .foregroundStyle(md.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(md.panel)
            case "quote":
                HStack(alignment: .top, spacing: 8) {
                    Rectangle().fill(md.border).frame(width: 3)
                    BlockList(blocks: block.blocks, tight: false, md: md)
                }
                .fixedSize(horizontal: false, vertical: true)
            case "hr":
                Rectangle().fill(md.border).frame(height: 1).padding(.vertical, md.size * 0.4)
            case "list":
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(block.items.enumerated()), id: \.offset) { k, item in
                        HStack(alignment: .firstTextBaseline, spacing: 0) {
                            Text(verbatim: block.ordered ? "\(block.start + k)." : "•")
                                .toolsFont(md.size)
                                .foregroundStyle(md.muted)
                                .frame(width: 20, alignment: .leading)
                            if item.isEmpty { Text(verbatim: " ").toolsFont(md.size) } else { BlockList(blocks: item, tight: true, md: md) }
                        }
                    }
                }
            case "table":
                let lines = FnMarkdownTree.gridLines([block.head.map(FnMarkdownTree.plain)] + block.rows.map { $0.map(FnMarkdownTree.plain) })
                ScrollView(.horizontal, showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { i, line in
                            Text(verbatim: line)
                                .toolsFont(md.size * 0.9, weight: i == 0 ? .bold : .regular, design: .monospaced)
                                .foregroundStyle(md.ink)
                                .fixedSize()
                        }
                    }
                }
            default:
                EmptyView()
            }
        }
    }
}
