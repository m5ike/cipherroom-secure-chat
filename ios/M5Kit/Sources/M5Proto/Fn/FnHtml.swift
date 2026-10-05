// A function's HTML output (6.6: m5.out.html) made safe — a port of android
// fn/FnHtml.java (itself client/src/lib/fn-html.ts, the one parser the
// server, the web chat and the apps share). It keeps document markup only:
// headings, paragraphs, lists, tables, details, figures, links to http(s) /
// mailto, and pictures that are data: URIs of an image type. Scripts, styles,
// forms, frames, media, event handlers and every other attribute are dropped;
// class keeps only the report classes (m5h-…), style only harmless
// properties without url().
//
// The grammar is read by hand over UTF-16 units (JavaScript's white space,
// ASCII-only case folding), linear in time, so the result is byte-identical
// to sanitizeFnHtml() and to the Android port.

import M5Core

/// The safe subset of a function's HTML output (android `fn/FnHtml.java`).
public enum FnHtml {
    /// FN_HTML_MAX: the longest HTML an output may carry (UTF-16 units).
    public static let max = 2_000_000
    static let maxNodes = 20_000
    static let maxDepth = 48

    static let allowed: Set<String> = [
        "div", "span", "p", "br", "hr", "b", "strong", "i", "em", "u", "s", "small", "mark", "code", "kbd", "samp", "var", "pre", "sub", "sup", "abbr", "time", "q", "cite", "del", "ins",
        "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "dl", "dt", "dd", "blockquote", "section", "article", "header", "footer", "aside", "figure", "figcaption",
        "details", "summary", "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td", "colgroup", "col", "a", "img",
    ]
    static let void: Set<String> = ["br", "hr", "img", "col", "wbr"]
    /// Dropped with everything inside them.
    static let drop: Set<String> = [
        "script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "math", "textarea", "select", "option", "form", "input", "button",
        "link", "meta", "base", "frame", "frameset", "audio", "video", "source", "track", "canvas", "title", "head", "dialog", "portal", "applet",
    ]
    private static let global: Set<String> = ["class", "style", "title", "lang", "dir"]
    private static let tagAttrs: [String: Set<String>] = [
        "a": ["href"], "img": ["src", "alt", "width", "height"], "td": ["colspan", "rowspan"], "th": ["colspan", "rowspan", "scope"],
        "col": ["span"], "colgroup": ["span"], "ol": ["start", "reversed"], "time": ["datetime"], "details": ["open"],
    ]
    private static let styleProps: Set<String> = [
        "color", "background-color", "font-size", "font-weight", "font-style", "font-family", "text-align", "text-decoration", "text-transform", "letter-spacing",
        "line-height", "white-space", "word-break", "vertical-align", "margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "padding", "padding-top",
        "padding-right", "padding-bottom", "padding-left", "border", "border-top", "border-bottom", "border-left", "border-right", "border-color", "border-width",
        "border-style", "border-radius", "border-collapse", "display", "gap", "align-items", "justify-content", "flex", "flex-wrap", "flex-direction", "width", "max-width",
        "min-width", "height", "max-height", "min-height", "opacity", "overflow", "overflow-x", "text-overflow",
    ]
    private static let display: Set<String> = ["inline", "inline-block", "block", "flex", "inline-flex", "grid", "table", "table-row", "table-cell", "none"]
    private static let numeric: Set<String> = ["width", "height", "colspan", "rowspan", "span", "start"]
    private static let scope: Set<String> = ["row", "col", "rowgroup", "colgroup"]
    private static let blocks: Set<String> = [
        "p", "div", "section", "article", "header", "footer", "aside", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "dt", "dd", "pre",
        "blockquote", "figure", "figcaption", "details", "summary", "table", "caption",
    ]
    private static let imageTypes: Set<String> = ["png", "jpeg", "gif", "webp", "bmp"]
    private static let entities: [String: [UInt16]] = {
        let e = ["amp", "&", "lt", "<", "gt", ">", "quot", "\"", "apos", "'", "nbsp", "\u{00A0}", "middot", "·", "bull", "•", "ndash", "–", "mdash", "—",
                 "hellip", "…", "times", "×", "euro", "€", "copy", "©", "deg", "°"]
        var m = [String: [UInt16]]()
        var i = 0
        while i < e.count { m[e[i]] = Array(e[i + 1].utf16); i += 2 }
        return m
    }()

    /* -------------------------------------------------------------- tree */

    /// One kept attribute.
    public struct Attr: Sendable, Equatable {
        public let name: String
        public let value: String
    }

    /// One node of the safe tree: an element (tag, attributes in order, children) or a text (tag nil).
    public struct SafeNode: Sendable, Equatable {
        /// The element's name (lower case); nil for a text.
        public let tag: String?
        /// The kept attributes, in the order the source first gave them.
        public let attrs: [Attr]
        public let children: [SafeNode]
        /// A text node's characters ("" for an element).
        public let text: String

        public var isText: Bool { tag == nil }

        /// An attribute's value (nil: not kept).
        public func attr(_ name: String) -> String? { attrs.first { $0.name == name }?.value }
    }

    /// The tree while it is built (texts grow, attributes keep their first place).
    private final class Building {
        let tag: String?
        var attrNames: [String] = []
        var attrValues: [String: String] = [:]
        var children: [Building] = []
        var buf: [UInt16] = []

        init(tag: String) { self.tag = tag }
        init(text: [UInt16]) { tag = nil; buf = text }

        func put(_ name: String, _ value: String) {
            if attrValues.updateValue(value, forKey: name) == nil { attrNames.append(name) }
        }

        func has(_ name: String) -> Bool { attrValues[name] != nil }

        func frozen() -> SafeNode {
            if tag == nil { return SafeNode(tag: nil, attrs: [], children: [], text: Js.string(buf)) }
            return SafeNode(tag: tag, attrs: attrNames.map { Attr(name: $0, value: attrValues[$0]!) }, children: children.map { $0.frozen() }, text: "")
        }
    }

    /* ---------------------------------------------------------- entities */

    private static func letter(_ c: UInt16) -> Bool { (c >= 0x61 && c <= 0x7A) || (c >= 0x41 && c <= 0x5A) }
    private static func digit(_ c: UInt16) -> Bool { c >= 0x30 && c <= 0x39 }
    private static func hex(_ c: UInt16) -> Bool { digit(c) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46) }

    /// decodeHtmlEntities(): &name; (the few above), &#n; and &#xh; — anything else stays as it is.
    public static func decodeEntities(_ s: String) -> String {
        let u = Array(s.utf16)
        guard u.contains(0x26) else { return s }
        var out = [UInt16]()
        decode(u[...], into: &out)
        return Js.string(out)
    }

    private static func decode(_ s: ArraySlice<UInt16>, into out: inout [UInt16]) {
        var i = s.startIndex
        let n = s.endIndex
        out.reserveCapacity(out.count + s.count)
        while i < n {
            let c = s[i]
            if c != 0x26 { out.append(c); i += 1; continue }
            let end = entityEnd(s, i)
            if end < 0 { out.append(0x26); i += 1; continue }
            if s[i + 1] == 0x23 {
                let x = s[i + 2] == 0x78 || s[i + 2] == 0x58
                var code = 0
                for k in (x ? i + 3 : i + 2)..<(end - 1) {
                    let d = s[k]
                    let v = d <= 0x39 ? Int(d) - 0x30 : (Int(d) | 0x20) - 0x57
                    code = code * (x ? 16 : 10) + v
                }
                if code > 0 && code < 0x110000 && !(code >= 0xD800 && code < 0xE000), let scalar = Unicode.Scalar(UInt32(code)) {
                    out.append(contentsOf: String(Character(scalar)).utf16)
                }
            } else {
                let name = Js.asciiLower(Js.string(s[(i + 1)..<(end - 1)]))
                if let v = entities[name] { out.append(contentsOf: v) } else { out.append(contentsOf: s[i..<end]) }
            }
            i = end
        }
    }

    /// Where /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/i matching at i ends (after the ";"), or -1.
    private static func entityEnd(_ s: ArraySlice<UInt16>, _ i: Int) -> Int {
        let n = s.endIndex
        let j = i + 1
        if j >= n { return -1 }
        var start: Int, max: Int, k: Int
        if s[j] == 0x23 {
            if j + 1 < n && (s[j + 1] == 0x78 || s[j + 1] == 0x58) {
                start = j + 2; k = start; max = 6
                while k < n && hex(s[k]) { k += 1 }
                if k - start < 1 { return -1 }
            } else {
                start = j + 1; k = start; max = 7
                while k < n && digit(s[k]) { k += 1 }
                if k - start < 1 { return -1 }
            }
        } else {
            start = j; k = j; max = 8
            while k < n && letter(s[k]) { k += 1 }
            if k - start < 2 { return -1 }
        }
        // The run is followed by ";" only when it is whole: a longer one cannot match.
        if k - start > max || k >= n || s[k] != 0x3B { return -1 }
        return k + 1
    }

    /* ---------------------------------------------------------- attributes */

    /// A name character of the tag grammar: [^\s"'<>/=].
    private static func nameChar(_ c: UInt16) -> Bool { !Js.isWs(c) && c != 0x22 && c != 0x27 && c != 0x3C && c != 0x3E && c != 0x2F && c != 0x3D }

    /// An unquoted value's character: [^\s"'=<>`].
    private static func valueChar(_ c: UInt16) -> Bool { !Js.isWs(c) && c != 0x22 && c != 0x27 && c != 0x3D && c != 0x3C && c != 0x3E && c != 0x60 }

    /// /word\s*\(/ somewhere in s (lower case).
    private static func call(_ s: [UInt16], _ word: String) -> Bool {
        let w = Array(word.utf16)
        var i = Js.index(of: w, in: s, from: 0)
        while i >= 0 {
            var j = i + w.count
            while j < s.count && Js.isWs(s[j]) { j += 1 }
            if j < s.count && s[j] == 0x28 { return true }
            i = Js.index(of: w, in: s, from: i + 1)
        }
        return false
    }

    /// /url\s*\(|expression|javascript:|@import|\\|[<>{}]|behavior|var\s*\(|attr\s*\(/i.
    private static func dangerous(_ value: String) -> Bool {
        let v = Array(Js.asciiLower(value).utf16)
        for c in v where c == 0x5C || c == 0x3C || c == 0x3E || c == 0x7B || c == 0x7D { return true }
        for w in ["expression", "javascript:", "@import", "behavior"] where Js.index(of: Array(w.utf16), in: v, from: 0) >= 0 { return true }
        return call(v, "url") || call(v, "var") || call(v, "attr")
    }

    /// safeStyle(): only harmless properties, no url() and the like.
    public static func safeStyle(_ style: String) -> String {
        var out = ""
        for decl in Js.split(Array(style.utf16), 0x3B) {
            guard let i = decl.firstIndex(of: 0x3A) else { continue }
            let prop = Js.lowerRoot(Js.trim(Js.string(decl[decl.startIndex..<i])))
            let value = Js.trim(Js.string(decl[(i + 1)...]))
            if !styleProps.contains(prop) || value.isEmpty || value.utf16.count > 160 { continue }
            if dangerous(value) { continue }
            if prop == "display" && !display.contains(value) { continue }
            if !out.isEmpty { out += "; " }
            out += prop + ": " + value
        }
        return out
    }

    /// At least one character, none of them \s " ' < >.
    private static func urlRest(_ s: [UInt16], _ from: Int) -> Bool {
        if from >= s.count { return false }
        for c in s[from...] where Js.isWs(c) || c == 0x22 || c == 0x27 || c == 0x3C || c == 0x3E { return false }
        return true
    }

    /// safeHref(): http(s):// or mailto: and no spaces, quotes or angle brackets; nil otherwise.
    public static func safeHref(_ v: String) -> String? {
        let s = Js.trim(v)
        let u = Array(s.utf16)
        let head = Array(Js.asciiLower(Js.string(u.prefix(8))).utf16)
        let ok = head.starts(with: "https://".utf16) ? urlRest(u, 8)
            : head.starts(with: "http://".utf16) ? urlRest(u, 7)
            : head.starts(with: "mailto:".utf16) && urlRest(u, 7)
        return ok ? s : nil
    }

    /// /^data:image\/(png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/]+={0,2}$/.
    public static func imageSrc(_ v: String) -> Bool {
        let u = Array(v.utf16)
        guard u.starts(with: "data:image/".utf16) else { return false }
        guard let semi = u[11...].firstIndex(of: 0x3B), imageTypes.contains(Js.string(u[11..<semi])),
              u[semi...].starts(with: ";base64,".utf16) else { return false }
        var i = semi + 8
        let start = i, n = u.count
        while i < n {
            let c = u[i]
            if !(letter(c) || digit(c) || c == 0x2B || c == 0x2F) { break }
            i += 1
        }
        if i == start { return false }
        if n - i > 2 { return false }
        while i < n { if u[i] != 0x3D { return false }; i += 1 }
        return true
    }

    /// Number(v) for a numeric attribute (exact for what is kept: an integer
    /// up to 4000). A huge 0x/0o/0b number is infinity here — out of range
    /// either way — so no big number is ever built from a long value.
    public static func attrNumber(_ v: String) -> Double {
        let t = Array(Js.trim(v).utf16)
        let n = t.count
        if n == 0 { return 0 }
        if t.elementsEqual("Infinity".utf16) || t.elementsEqual("+Infinity".utf16) { return .infinity }
        if t.elementsEqual("-Infinity".utf16) { return -.infinity }
        if n > 2 && t[0] == 0x30, let r = [UInt16(0x78): 16, 0x58: 16, 0x6F: 8, 0x4F: 8, 0x62: 2, 0x42: 2][t[1]] {
            for k in 2..<n {
                let c = t[k]
                let d: Int
                switch c {
                case 0x30...0x39: d = Int(c) - 0x30
                case 0x61...0x66: d = Int(c) - 0x57
                case 0x41...0x46: d = Int(c) - 0x37
                default: return .nan
                }
                if d >= r { return .nan }
            }
            var i = 2
            while i < n - 1 && t[i] == 0x30 { i += 1 }
            if n - i > 12 { return .infinity }
            return Double(Int(Js.string(t[i...]), radix: r) ?? 0)
        }
        // [+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?
        let ascii = t.map { $0 < 0x80 ? UInt8($0) : 0 }
        return Js.isDecimal(ascii) ? (Double(Js.string(t)) ?? .nan) : .nan
    }

    /// The class tokens kept: m5h-… only, at most 8.
    private static func classes(_ value: String) -> String {
        let u = Array(value.utf16)
        var out = [UInt16]()
        var kept = 0, i = 0
        let n = u.count
        while i < n && kept < 8 {
            while i < n && Js.isWs(u[i]) { i += 1 }
            let start = i
            while i < n && !Js.isWs(u[i]) { i += 1 }
            if i > start && reportClass(u, start, i) {
                if kept > 0 { out.append(0x20) }
                kept += 1
                out.append(contentsOf: u[start..<i])
            }
        }
        return Js.string(out)
    }

    /// /^m5h-[a-z0-9-]{1,40}$/.
    private static func reportClass(_ s: [UInt16], _ start: Int, _ end: Int) -> Bool {
        if !s[start...].starts(with: "m5h-".utf16) || end - start - 4 < 1 || end - start - 4 > 40 { return false }
        for c in s[(start + 4)..<end] where !((c >= 0x61 && c <= 0x7A) || digit(c) || c == 0x2D) { return false }
        return true
    }

    /* -------------------------------------------------------------- tags */

    /// An open tag as /<([a-zA-Z][a-zA-Z0-9]*)(attributes)\s*(\/?)>/y matches it.
    private struct OpenTag {
        var name: String = ""
        /// name, raw value (empty when it has none) — in the order written.
        var attrs: [(ArraySlice<UInt16>, ArraySlice<UInt16>)] = []
        var selfClosing = false
        var end = 0
    }

    /// The open tag at lt, or nil. Names and values are delimited by white
    /// space, quotes, "=", "/" and ">", so the greedy reading below is the
    /// only one that can end in ">" — where it fails, no shorter one succeeds.
    private static func openTag(_ s: [UInt16], _ lt: Int) -> OpenTag? {
        let n = s.count
        var p = lt + 1
        if p >= n || !letter(s[p]) { return nil }
        var nameEnd = p + 1
        while nameEnd < n && (letter(s[nameEnd]) || digit(s[nameEnd])) { nameEnd += 1 }
        var t = OpenTag()
        t.name = Js.string(s[p..<nameEnd])
        p = nameEnd
        let empty = s[0..<0]
        while true {
            var w = p
            while w < n && Js.isWs(s[w]) { w += 1 }
            if w == p || w >= n || !nameChar(s[w]) { break }
            var r = w
            while r < n && nameChar(s[r]) { r += 1 }
            let name = s[w..<r]
            var v = r
            while v < n && Js.isWs(s[v]) { v += 1 }
            if v < n && s[v] == 0x3D {
                v += 1
                while v < n && Js.isWs(s[v]) { v += 1 }
                if v >= n { return nil }
                let q = s[v]
                if q == 0x22 || q == 0x27 {
                    guard let close = s[(v + 1)...].firstIndex(of: q) else { return nil }
                    t.attrs.append((name, s[(v + 1)..<close]))
                    p = close + 1
                } else {
                    if !valueChar(q) { return nil }
                    var e = v
                    while e < n && valueChar(s[e]) { e += 1 }
                    t.attrs.append((name, s[v..<e]))
                    p = e
                }
                continue
            }
            t.attrs.append((name, empty))
            p = r
        }
        var w = p
        while w < n && Js.isWs(s[w]) { w += 1 }
        if w < n && s[w] == 0x3E { t.end = w + 1; return t }
        if w + 1 < n && s[w] == 0x2F && s[w + 1] == 0x3E { t.selfClosing = true; t.end = w + 2; return t }
        return nil
    }

    /// /<\/([a-zA-Z][a-zA-Z0-9]*)\s*>/y at lt: the end of the tag and the name; nil when it is not one.
    private static func closeTag(_ s: [UInt16], _ lt: Int) -> (end: Int, name: String)? {
        let n = s.count
        let p = lt + 2
        if p >= n || !letter(s[p]) { return nil }
        var e = p + 1
        while e < n && (letter(s[e]) || digit(s[e])) { e += 1 }
        var w = e
        while w < n && Js.isWs(s[w]) { w += 1 }
        if w >= n || s[w] != 0x3E { return nil }
        return (w + 1, Js.string(s[p..<e]))
    }

    /* -------------------------------------------------------------- parse */

    private final class Parser {
        let root = Building(tag: "#root")
        var stack: [Building]
        var dropDepth = 0
        var dropTag = ""
        var nodes = 0

        init() { stack = [root] }

        var top: Building { stack[stack.count - 1] }

        func text(_ s: ArraySlice<UInt16>) {
            if dropDepth > 0 || s.isEmpty { return }
            let p = top
            if let last = p.children.last, last.tag == nil {
                FnHtml.decode(s, into: &last.buf)
            } else {
                var d = [UInt16]()
                FnHtml.decode(s, into: &d)
                p.children.append(Building(text: d))
                nodes += 1
            }
        }

        func open(_ m: OpenTag) {
            let tag = Js.asciiLower(m.name)
            if dropDepth > 0 {
                if tag == dropTag && !FnHtml.void.contains(tag) && !m.selfClosing { dropDepth += 1 }
                return
            }
            if FnHtml.drop.contains(tag) {
                if !m.selfClosing && !FnHtml.void.contains(tag) { dropDepth = 1; dropTag = tag }
                return
            }
            if !FnHtml.allowed.contains(tag) { return }
            let el = Building(tag: tag)
            let own = FnHtml.tagAttrs[tag]
            for (rawName, rawValue) in m.attrs {
                let name = Js.lowerRoot(Js.string(rawName))
                if name.utf16.starts(with: "on".utf16) || (!FnHtml.global.contains(name) && !(own?.contains(name) ?? false)) { continue }
                var dv = [UInt16]()
                FnHtml.decode(rawValue, into: &dv)
                let value = Js.string(dv)
                switch name {
                case "class": let cls = FnHtml.classes(value); if !cls.isEmpty { el.put("class", cls) }; continue
                case "style": let st = FnHtml.safeStyle(value); if !st.isEmpty { el.put("style", st) }; continue
                case "href": if let u = FnHtml.safeHref(value) { el.put("href", u) }; continue
                case "src": let v = Js.noSpace(value); if FnHtml.imageSrc(v) { el.put("src", v) }; continue
                default: break
                }
                if FnHtml.numeric.contains(name) {
                    let d = FnHtml.attrNumber(value)
                    let max: Double = name == "width" || name == "height" ? 4000 : 1000
                    if d.isFinite && d == d.rounded(.down) && d >= 0 && d <= max { el.put(name, String(Int64(d))) }
                    continue
                }
                if name == "dir" { if value == "ltr" || value == "rtl" || value == "auto" { el.put("dir", value) }; continue }
                if name == "scope" { if FnHtml.scope.contains(value) { el.put("scope", value) }; continue }
                if name == "open" || name == "reversed" { el.put(name, ""); continue }
                el.put(name, dv.count > 300 ? Js.string(dv[0..<300]) : value)
            }
            if tag == "img" && !el.has("src") { return } // no picture, no element
            top.children.append(el)
            nodes += 1
            if !FnHtml.void.contains(tag) && !m.selfClosing && stack.count < FnHtml.maxDepth { stack.append(el) }
        }

        func close(_ name: String) {
            let tag = Js.asciiLower(name)
            if dropDepth > 0 {
                if tag == dropTag { dropDepth -= 1; if dropDepth == 0 { dropTag = "" } }
                return
            }
            var k = stack.count - 1
            while k > 0 {
                if stack[k].tag == tag { stack.removeSubrange(k...); break }
                k -= 1
            }
        }

        func run(_ src: [UInt16]) -> [SafeNode] {
            let n = src.count
            var i = 0
            while i < n && nodes < FnHtml.maxNodes {
                guard let lt = src[i...].firstIndex(of: 0x3C) else { text(src[i...]); break }
                text(src[i..<lt])
                if src[lt...].starts(with: "<!--".utf16) {
                    let end = Js.index(of: Array("-->".utf16), in: src, from: lt + 4)
                    i = end < 0 ? n : end + 3
                    continue
                }
                if src[lt...].starts(with: "<!".utf16) || src[lt...].starts(with: "<?".utf16) {
                    let end = src[lt...].firstIndex(of: 0x3E)
                    i = end.map { $0 + 1 } ?? n
                    continue
                }
                if lt + 1 < n && src[lt + 1] == 0x2F {
                    guard let c = FnHtml.closeTag(src, lt) else { text(src[lt...lt]); i = lt + 1; continue }
                    i = c.end
                    close(c.name)
                    continue
                }
                guard let m = FnHtml.openTag(src, lt) else { text(src[lt...lt]); i = lt + 1; continue }
                i = m.end
                open(m)
            }
            return root.children.map { $0.frozen() }
        }
    }

    /// parseFnHtml(): the safe tree of html (see the header).
    public static func parse(_ html: String?) -> [SafeNode] {
        var src = Array((html ?? "").utf16)
        if src.count > max { src = Array(src[0..<max]) }
        return Parser().run(src)
    }

    /* ---------------------------------------------------------- serialize */

    private static func esc(_ sb: inout [UInt16], _ s: String) {
        for c in s.utf16 {
            switch c {
            case 0x26: sb.append(contentsOf: "&amp;".utf16)
            case 0x3C: sb.append(contentsOf: "&lt;".utf16)
            case 0x3E: sb.append(contentsOf: "&gt;".utf16)
            case 0x22: sb.append(contentsOf: "&quot;".utf16)
            default: sb.append(c)
            }
        }
    }

    private static func serialize(_ sb: inout [UInt16], _ nodes: [SafeNode]) {
        for n in nodes {
            guard let tag = n.tag else { esc(&sb, n.text); continue }
            sb.append(0x3C)
            sb.append(contentsOf: tag.utf16)
            for a in n.attrs {
                sb.append(0x20)
                sb.append(contentsOf: a.name.utf16)
                if !(a.value.isEmpty && (a.name == "open" || a.name == "reversed")) {
                    sb.append(contentsOf: "=\"".utf16)
                    esc(&sb, a.value)
                    sb.append(0x22)
                }
            }
            sb.append(0x3E)
            if void.contains(tag) { continue }
            serialize(&sb, n.children)
            sb.append(contentsOf: "</".utf16)
            sb.append(contentsOf: tag.utf16)
            sb.append(0x3E)
        }
    }

    /// serializeFnHtml(): a safe tree back to HTML text.
    public static func serialize(_ nodes: [SafeNode]) -> String {
        var sb = [UInt16]()
        serialize(&sb, nodes)
        return Js.string(sb)
    }

    /// sanitizeFnHtml(): parse, keep what is safe, serialize.
    public static func sanitize(_ html: String?) -> String { serialize(parse(html)) }

    /* --------------------------------------------------------------- text */

    private static func walk(_ sb: inout [UInt16], _ nodes: [SafeNode]) {
        for n in nodes {
            guard let tag = n.tag else { sb.append(contentsOf: n.text.utf16); continue }
            switch tag {
            case "br": sb.append(0x0A)
            case "img":
                if let alt = n.attr("alt"), !alt.isEmpty { sb.append(0x5B); sb.append(contentsOf: alt.utf16); sb.append(0x5D) }
            case "td", "th": walk(&sb, n.children); sb.append(0x09)
            default:
                if blocks.contains(tag) { sb.append(0x0A); walk(&sb, n.children); sb.append(0x0A) } else { walk(&sb, n.children) }
            }
        }
    }

    /// fnHtmlText(): the text of a safe tree (search, forwarding, older apps).
    public static func text(_ nodes: [SafeNode]) -> String {
        var raw = [UInt16]()
        walk(&raw, nodes)
        // .replace(/[ \t]+\n/g, "\n")
        var a = [UInt16]()
        a.reserveCapacity(raw.count)
        var i = 0
        let n = raw.count
        while i < n {
            let c = raw[i]
            if c == 0x20 || c == 0x09 {
                var j = i
                while j < n && (raw[j] == 0x20 || raw[j] == 0x09) { j += 1 }
                if j < n && raw[j] == 0x0A { a.append(0x0A); i = j + 1 } else { a.append(contentsOf: raw[i..<j]); i = j }
                continue
            }
            a.append(c)
            i += 1
        }
        // .replace(/\n{3,}/g, "\n\n")
        var b = [UInt16]()
        b.reserveCapacity(a.count)
        i = 0
        while i < a.count {
            if a[i] == 0x0A {
                var j = i
                while j < a.count && a[j] == 0x0A { j += 1 }
                if j - i >= 3 { b.append(0x0A); b.append(0x0A) } else { b.append(contentsOf: a[i..<j]) }
                i = j
                continue
            }
            b.append(a[i])
            i += 1
        }
        return Js.trim(Js.string(b))
    }
}

extension Js {
    /// indexOf(needle, from) over UTF-16 units; -1 when absent.
    static func index(of needle: [UInt16], in hay: [UInt16], from: Int) -> Int {
        let m = needle.count, n = hay.count
        if m == 0 { return Swift.min(Swift.max(from, 0), n) }
        guard let first = needle.first else { return -1 }
        var i = Swift.max(from, 0)
        while i + m <= n {
            if hay[i] == first {
                var k = 1
                while k < m && hay[i + k] == needle[k] { k += 1 }
                if k == m { return i }
            }
            i += 1
        }
        return -1
    }

    /// s.split(String.valueOf(sep), -1): every part, empty ones included.
    static func split(_ s: [UInt16], _ sep: UInt16) -> [ArraySlice<UInt16>] {
        var out = [ArraySlice<UInt16>]()
        var start = 0
        for (i, c) in s.enumerated() where c == sep {
            out.append(s[start..<i])
            start = i + 1
        }
        out.append(s[start...])
        return out
    }
}
