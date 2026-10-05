// Markdown as AI answers and functions write it — a port of
// android/…/fn/MarkdownTree.java (client/src/lib/markdown.ts): paragraphs,
// headings, lists (nested), code blocks, quotes, rules, tables; inline code,
// bold, italic, strike-through, links and bare web addresses. A tree, never
// markup; links keep only https / http / mailto. Half-written input (a stream)
// parses too. Indexes are UTF-16 (NSString), as in Java; the patterns are
// Java's with \w and \d written out as ASCII (ICU's are Unicode).

import Foundation
import M5Proto

enum FnMarkdownTree {
    static let maxInput = 200_000
    static let maxDepth = 4

    /// An inline node: text, code (v), strong, em, del (c), link (href, c) or br.
    struct Inline: Equatable, Sendable, CustomStringConvertible {
        let t: String
        var v = ""
        var href = ""
        var c: [Inline] = []

        static func text(_ v: String) -> Inline { Inline(t: "text", v: v) }

        var description: String {
            switch t {
            case "text", "code": return t + "(" + v + ")"
            case "br": return "br"
            case "link": return "link(" + href + ")" + FnMarkdownTree.list(c)
            default: return t + FnMarkdownTree.list(c)
            }
        }
    }

    /// A block: p or h (level, inline), code (lang, v), quote (blocks), hr, list (ordered, start, items) or table (head, rows).
    struct Block: Equatable, Sendable, CustomStringConvertible {
        let t: String
        var level = 0
        var lang = ""
        var v = ""
        var inline: [Inline] = []
        var blocks: [Block] = []
        var ordered = false
        var start = 1
        var items: [[Block]] = []
        var head: [[Inline]] = []
        var rows: [[[Inline]]] = []

        var description: String {
            switch t {
            case "p": return "p" + FnMarkdownTree.list(inline)
            case "h": return "h\(level)" + FnMarkdownTree.list(inline)
            case "code": return "code(" + lang + ")(" + v + ")"
            case "quote": return "quote" + FnMarkdownTree.list(blocks)
            case "list": return (ordered ? "ol\(start)" : "ul") + "[" + items.map { FnMarkdownTree.list($0) }.joined(separator: ", ") + "]"
            case "table":
                return "table[" + head.map { FnMarkdownTree.list($0) }.joined(separator: ", ") + "]["
                    + rows.map { "[" + $0.map { FnMarkdownTree.list($0) }.joined(separator: ", ") + "]" }.joined(separator: ", ") + "]"
            default: return t
            }
        }
    }

    /// Java's List.toString.
    static func list<T: CustomStringConvertible>(_ a: [T]) -> String { "[" + a.map(\.description).joined(separator: ", ") + "]" }

    // MARK: patterns

    private static func re(_ p: String, _ opts: NSRegularExpression.Options = []) -> NSRegularExpression {
        // swiftlint:disable:next force_try
        try! NSRegularExpression(pattern: p, options: opts)
    }

    /// The whole string (Java's matches()).
    private static func whole(_ p: String, _ opts: NSRegularExpression.Options = []) -> NSRegularExpression { re("\\A(?:" + p + ")\\z", opts) }

    nonisolated(unsafe) private static let href = whole("https?://[^" + Js.wsChars + "<>\"]+", .caseInsensitive)
    nonisolated(unsafe) private static let mailto = whole("mailto:[^" + Js.wsChars + "<>\"]+", .caseInsensitive)

    /// safeHref(): a link that may be followed, or nil.
    static func safeHref(_ raw: String) -> String? {
        let v = Js.trim(raw)
        return matches(href, v) || matches(mailto, v) ? v : nil
    }

    private static func matches(_ r: NSRegularExpression, _ s: String) -> Bool {
        let ns = s as NSString
        return r.firstMatch(in: s, options: [], range: NSRange(location: 0, length: ns.length)) != nil
    }

    private static func full(_ r: NSRegularExpression, _ s: String) -> NSTextCheckingResult? {
        r.firstMatch(in: s, options: [], range: NSRange(location: 0, length: (s as NSString).length))
    }

    // MARK: inline

    private static let escapable: Set<unichar> = Set("\\`*_~[]()#>!|-".utf16)
    private static let word = "[A-Za-z0-9_]"
    nonisolated(unsafe) private static let code = re("(`+)([\\s\\S]*?[^`])\\1(?!`)")
    nonisolated(unsafe) private static let strong = re("(\\*\\*|__)(?=" + Js.ns + ")([\\s\\S]*?" + Js.ns + ")\\1")
    nonisolated(unsafe) private static let del = re("~~(?=" + Js.ns + ")([\\s\\S]*?" + Js.ns + ")~~")
    nonisolated(unsafe) private static let emStar = re("\\*(?=" + Js.ns + ")([^*]*?" + Js.ns + ")\\*(?!\\*)")
    nonisolated(unsafe) private static let emUnder = re("_(?=" + Js.ns + ")([^_]*?" + Js.ns + ")_(?!" + word + ")")
    nonisolated(unsafe) private static let link = re("\\[([^\\]\\n]{1,500})\\]\\(" + Js.s + "*<?([^)" + Js.wsChars + ">]{1,2000})>?(?:" + Js.s + "+\"[^\"]*\")?" + Js.s + "*\\)")
    nonisolated(unsafe) private static let auto = re("<((?:https?://|mailto:)[^" + Js.wsChars + "<>]+)>", .caseInsensitive)
    nonisolated(unsafe) private static let bare = re("https?://[^" + Js.wsChars + "<>\"]+", .caseInsensitive)

    private static func isWord(_ c: unichar) -> Bool { (c >= 0x61 && c <= 0x7A) || (c >= 0x41 && c <= 0x5A) || (c >= 0x30 && c <= 0x39) || c == 0x5F }

    /// Matches p at i (like /^…/ on src.slice(i)); nil when it does not.
    private static func at(_ p: NSRegularExpression, _ src: String, _ len: Int, _ i: Int) -> NSTextCheckingResult? {
        p.firstMatch(in: src, options: [.anchored], range: NSRange(location: i, length: len - i))
    }

    private static func group(_ ns: NSString, _ m: NSTextCheckingResult, _ g: Int) -> String {
        let r = m.range(at: g)
        return r.location == NSNotFound ? "" : ns.substring(with: r)
    }

    static func parseInline(_ src: String) -> [Inline] { parseInline(src, 0) }

    static func parseInline(_ src: String, _ depth: Int) -> [Inline] {
        let ns = src as NSString
        let len = ns.length
        var out = [Inline]()
        var text = [unichar]()
        func flush() {
            if !text.isEmpty { out.append(.text(String(utf16CodeUnits: text, count: text.count))); text.removeAll() }
        }
        var i = 0
        while i < len {
            let ch = ns.character(at: i)
            // A backslash escapes the next punctuation.
            if ch == 0x5C, i + 1 < len, escapable.contains(ns.character(at: i + 1)) { text.append(ns.character(at: i + 1)); i += 2; continue }
            if ch == 0x0A { flush(); out.append(Inline(t: "br")); i += 1; continue }
            if ch == 0x60, let m = at(code, src, len, i) {
                flush()
                var v = group(ns, m, 2)
                let vu = Array(v.utf16)
                if vu.count >= 2 && vu.first == 0x20 && vu.last == 0x20 { v = String(utf16CodeUnits: Array(vu[1..<(vu.count - 1)]), count: vu.count - 2) }
                out.append(Inline(t: "code", v: v))
                i = m.range.location + m.range.length
                continue
            }
            if depth < maxDepth {
                let mark = ch == 0x2A || ch == 0x5F
                if mark, let m = at(strong, src, len, i) {
                    flush(); out.append(Inline(t: "strong", c: parseInline(group(ns, m, 2), depth + 1))); i = NSMaxRange(m.range); continue
                }
                if ch == 0x7E, let m = at(del, src, len, i) {
                    flush(); out.append(Inline(t: "del", c: parseInline(group(ns, m, 1), depth + 1))); i = NSMaxRange(m.range); continue
                }
                // _italic_ only at a word's edge (snake_case stays as it is).
                let em: NSTextCheckingResult? = ch == 0x2A ? at(emStar, src, len, i)
                    : ch == 0x5F && (i == 0 || !isWord(ns.character(at: i - 1))) ? at(emUnder, src, len, i) : nil
                if let m = em { flush(); out.append(Inline(t: "em", c: parseInline(group(ns, m, 1), depth + 1))); i = NSMaxRange(m.range); continue }
                if ch == 0x5B, let m = at(link, src, len, i) {
                    flush()
                    let label = parseInline(group(ns, m, 1), depth + 1)
                    if let h = safeHref(group(ns, m, 2)) { out.append(Inline(t: "link", href: h, c: label)) } else { out.append(contentsOf: label) }
                    i = NSMaxRange(m.range)
                    continue
                }
            }
            if ch == 0x3C, let m = at(auto, src, len, i) {
                flush()
                let target = group(ns, m, 1)
                if let h = safeHref(target) { out.append(Inline(t: "link", href: h, c: [.text(target)])) } else { out.append(.text(ns.substring(with: m.range))) }
                i = NSMaxRange(m.range)
                continue
            }
            if ch == 0x68 || ch == 0x48, i == 0 || !(isWord(ns.character(at: i - 1)) || ns.character(at: i - 1) == 0x2F), let m = at(bare, src, len, i) {
                // Trailing punctuation belongs to the sentence, not to the address.
                var url = Array(ns.substring(with: m.range).utf16)
                while let last = url.last, ".,;:!?'\"".utf16.contains(last) { url.removeLast() }
                while url.last == 0x29 && url.filter({ $0 == 0x28 }).count < url.filter({ $0 == 0x29 }).count { url.removeLast() }
                flush()
                let s = String(utf16CodeUnits: url, count: url.count)
                out.append(Inline(t: "link", href: s, c: [.text(s)]))
                i += url.count
                continue
            }
            text.append(ch)
            i += 1
        }
        flush()
        return out
    }

    // MARK: blocks

    nonisolated(unsafe) private static let fence = whole(" {0,3}(`{3,}|~{3,})" + Js.s + "*([A-Za-z0-9_+#.-]*)[^\\n]*")
    nonisolated(unsafe) private static let heading = whole(" {0,3}(#{1,6})" + Js.s + "+(.*?)" + Js.s + "*#*" + Js.s + "*")
    nonisolated(unsafe) private static let quote = whole(" {0,3}>" + Js.s + "?(.*)")
    nonisolated(unsafe) private static let bullet = whole("( {0,6})([-*+])" + Js.s + "+(.*)")
    nonisolated(unsafe) private static let orderedRe = whole("( {0,6})([0-9]{1,9})[.)]" + Js.s + "+(.*)")

    /// ^ {0,3}([-*_])(\s*\1){2,}\s*$ — written out (a regex with a repeated group recurses on long lines).
    static func isRule(_ line: String) -> Bool {
        let u = Array(line.utf16)
        var i = 0
        while i < 3 && i < u.count && u[i] == 0x20 { i += 1 }
        guard i < u.count, u[i] == 0x2D || u[i] == 0x2A || u[i] == 0x5F else { return false }
        let c = u[i]
        var marks = 0
        for x in u[(i + 1)...] {
            if x == c { marks += 1 } else if !Js.isWs(x) { return false }
        }
        return marks >= 2
    }

    /// ^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$ — written out, likewise.
    static func isTableSeparator(_ line: String) -> Bool {
        let u = Array(line.utf16)
        let n = u.count
        func skip(_ j: Int) -> Int { var k = j; while k < n && Js.isWs(u[k]) { k += 1 }; return k }
        var i = skip(0)
        if i < n && u[i] == 0x7C { i += 1 }
        while true {
            i = skip(i)
            if i < n && u[i] == 0x3A { i += 1 }
            let dashes = i
            while i < n && u[i] == 0x2D { i += 1 }
            if i == dashes { return false }
            if i < n && u[i] == 0x3A { i += 1 }
            i = skip(i)
            if i == n { return true }
            if u[i] != 0x7C { return false }
            i += 1
            if skip(i) == n { return true }
        }
    }

    private static func blank(_ s: String) -> Bool { Js.trim(s).isEmpty }

    private static func pipe(_ s: String) -> Bool { s.utf16.contains(0x7C) }

    /// The count of leading white space (UTF-16 units).
    private static func leadingWs(_ s: String) -> Int {
        var k = 0
        for c in s.utf16 { if Js.isWs(c) { k += 1 } else { break } }
        return k
    }

    private static func dropUnits(_ s: String, _ n: Int) -> String {
        let ns = s as NSString
        return n >= ns.length ? "" : ns.substring(from: n)
    }

    private static func cells(_ line: String) -> [String] {
        var u = Array(Js.trim(line).utf16)
        if u.first == 0x7C { u.removeFirst() }
        if u.last == 0x7C && !(u.count >= 2 && u[u.count - 2] == 0x5C) { u.removeLast() }
        var out = [String]()
        var cur = [UInt16]()
        var i = 0
        while i < u.count {
            if u[i] == 0x5C && i + 1 < u.count && u[i + 1] == 0x7C { cur.append(0x7C); i += 2; continue }
            if u[i] == 0x7C { out.append(Js.trim(String(utf16CodeUnits: cur, count: cur.count))); cur.removeAll(); i += 1; continue }
            cur.append(u[i])
            i += 1
        }
        out.append(Js.trim(String(utf16CodeUnits: cur, count: cur.count)))
        return out
    }

    private static func isBlockStart(_ l: String) -> Bool {
        matches(fence, l) || matches(heading, l) || isRule(l) || matches(quote, l) || matches(bullet, l) || matches(orderedRe, l)
    }

    static func parse(_ input: String) -> [Block] { parse(input, 0) }

    static func parse(_ input: String, _ depth: Int) -> [Block] {
        let ins = input as NSString
        let src = ins.length > maxInput ? ins.substring(to: maxInput) : input
        let lines = src.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        var blocks = [Block]()
        var i = 0
        while i < lines.count {
            let line = lines[i]
            if blank(line) { i += 1; continue }
            if let f = full(fence, line) {
                let ns = line as NSString
                let marker = group(ns, f, 1)
                let close = whole(" {0,3}" + (marker.hasPrefix("`") ? "`" : "~") + "{\((marker as NSString).length),}" + Js.s + "*")
                var body = [String]()
                i += 1
                while i < lines.count && !matches(close, lines[i]) { body.append(lines[i]); i += 1 }
                i += 1 // the closing fence (or past the end)
                var b = Block(t: "code")
                b.lang = group(ns, f, 2).lowercased()
                b.v = body.joined(separator: "\n")
                blocks.append(b)
                continue
            }
            if let h = full(heading, line) {
                let ns = line as NSString
                var b = Block(t: "h")
                b.level = (group(ns, h, 1) as NSString).length
                b.inline = parseInline(group(ns, h, 2))
                blocks.append(b)
                i += 1
                continue
            }
            if isRule(line) { blocks.append(Block(t: "hr")); i += 1; continue }
            if matches(quote, line) && depth < maxDepth {
                var inner = [String]()
                while i < lines.count {
                    let q = full(quote, lines[i])
                    if q == nil && (blank(lines[i]) || isBlockStart(lines[i]) || inner.isEmpty) { break }
                    inner.append(q.map { group(lines[i] as NSString, $0, 1) } ?? lines[i])
                    i += 1
                }
                var b = Block(t: "quote")
                b.blocks = parse(inner.joined(separator: "\n"), depth + 1)
                blocks.append(b)
                continue
            }
            let bl = full(bullet, line)
            let ol = full(orderedRe, line)
            if (bl != nil || ol != nil) && depth < maxDepth {
                let isOrdered = ol != nil && bl == nil
                let indent = (group(line as NSString, (bl ?? ol)!, 1) as NSString).length
                var items = [[String]]()
                while i < lines.count {
                    let l = lines[i]
                    let b = full(bullet, l)
                    let o = full(orderedRe, l)
                    if let m = isOrdered ? o : b, (group(l as NSString, m, 1) as NSString).length <= indent + 1 {
                        items.append([group(l as NSString, m, 3)])
                        i += 1
                        continue
                    }
                    // A deeper item or a continuation line belongs to the last item.
                    if !items.isEmpty && !blank(l) && (leadingWs(l) >= 2 || (!isBlockStart(l) && b == nil && o == nil)) {
                        items[items.count - 1].append(dropUnits(l, min(8, leadingWs(l))))
                        i += 1
                        continue
                    }
                    if !items.isEmpty && blank(l) && i + 1 < lines.count && leadingWs(lines[i + 1]) >= 2 && leadingWs(lines[i + 1]) < (lines[i + 1] as NSString).length {
                        items[items.count - 1].append("")
                        i += 1
                        continue
                    }
                    break
                }
                var list = Block(t: "list")
                list.ordered = isOrdered
                list.start = isOrdered ? Int(group(line as NSString, ol!, 2)) ?? 1 : 1
                list.items = items.map { parse($0.joined(separator: "\n"), depth + 1) }
                blocks.append(list)
                continue
            }
            // A table: a row, then a delimiter row with pipes (a bare "---" under a line is a rule, not a table).
            if pipe(line) && i + 1 < lines.count && pipe(lines[i + 1]) && isTableSeparator(lines[i + 1]) {
                var t = Block(t: "table")
                t.head = cells(line).map { parseInline($0) }
                i += 2
                while i < lines.count && pipe(lines[i]) && !blank(lines[i]) {
                    t.rows.append(cells(lines[i]).map { parseInline($0) })
                    i += 1
                }
                blocks.append(t)
                continue
            }
            var para = [String]()
            while i < lines.count && !blank(lines[i]) && !(!para.isEmpty && isBlockStart(lines[i])) {
                if para.isEmpty && isBlockStart(lines[i]) { break }
                para.append(dropUnits(lines[i], min(3, leadingWs(lines[i]))))
                i += 1
            }
            if para.isEmpty { para.append(lines[i]); i += 1 }
            var p = Block(t: "p")
            p.inline = parseInline(para.joined(separator: "\n"))
            blocks.append(p)
        }
        return blocks
    }

    // MARK: plain text and tables

    /// The text of inline nodes (a table cell, an accessibility label).
    static func plain(_ nodes: [Inline]) -> String {
        var out = ""
        for n in nodes {
            if n.t == "text" || n.t == "code" { out += n.v } else if n.t == "br" { out += " " } else { out += plain(n.c) }
        }
        return out
    }

    /// A table as lines of monospace text (android fn/Grid): columns padded to their widest cell, a rule under the head.
    static func gridLines(_ rows: [[String]]) -> [String] {
        let cols = rows.map(\.count).max() ?? 0
        var width = [Int](repeating: 0, count: cols)
        func length(_ s: String) -> Int { s.unicodeScalars.count }
        for r in rows { for (c, cell) in r.enumerated() { width[c] = max(width[c], length(cell)) } }
        var out = [String]()
        for (i, r) in rows.enumerated() {
            var line = ""
            for c in 0..<cols {
                let cell = c < r.count ? r[c] : ""
                if c > 0 { line += " │ " }
                line += cell
                if c < cols - 1 { line += String(repeating: " ", count: max(0, width[c] - length(cell))) }
            }
            out.append(line)
            if i == 0 {
                var rule = ""
                for c in 0..<cols { rule += (c > 0 ? "─┼─" : "") + String(repeating: "─", count: width[c]) }
                out.append(rule)
            }
        }
        return out
    }
}
