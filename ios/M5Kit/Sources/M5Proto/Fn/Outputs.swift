// The outputs of a function run — a port of android fn/Outputs.java (itself
// client/src/lib/fn-outputs.ts, the rules the server and the web app share):
// what an output is (check, sanitize), what a room message may carry
// (shareable), its Markdown (the message's text for older apps, search and
// forwarding), a form's fields, masks and value checks. An output is a JSON
// object with a "type"; lists are JSON arrays, as they travel in a message's
// flags.fn. 6.6 adds formatted HTML, sanitized by FnHtml.
//
// Sizes are UTF-16 units of JavaScript's JSON.stringify (Js.stringify).

import M5Core

/// Function outputs: check, sanitize, share, Markdown, forms (android `fn/Outputs.java`).
public enum Outputs {
    /// How big one output may be (characters of text / base64).
    public static let outputMaxChars = 16 * 1024 * 1024
    /// What a peer's message may carry, all outputs together.
    public static let peerMaxTotal = 900_000
    /// What this app puts into a room message.
    public static let roomMaxTotal = 700_000

    public static let outputTypes = ["text", "markdown", "code", "table", "json", "image", "file", "flash", "window", "audio", "video", "button", "form", "js", "html"]
    public static let formFieldTypes = [
        "text", "textarea", "number", "range", "tel", "email", "url", "password",
        "date", "time", "datetime", "month", "color", "masked",
        "select", "multiselect", "radio", "checkbox", "switch",
        "hidden", "static", "separator",
    ]
    public static let buttonClasses = ["primary", "secondary", "success", "danger", "warning", "info", "ghost", "outline", "link", "small", "large", "block", "round"]
    static let flashLevels = ["info", "success", "warning", "error"]

    private static let imageMimes: Set<String> = ["png", "jpeg", "gif", "webp", "svg+xml"]
    private static let audioMimes: Set<String> = ["mpeg", "mp3", "wav", "x-wav", "wave", "ogg", "webm", "aac", "mp4", "flac", "x-m4a"]
    private static let videoMimes: Set<String> = ["mp4", "webm", "ogg"]
    private static let cssColor: FnPattern = {
        let s = Js.s
        let d = "[0-9.]"
        let n = s + "*" + d + "+%?" + s + "*"
        return FnPattern("#[0-9a-fA-F]{3,8}"
            + "|[rR][gG][bB][aA]?\\(" + n + "," + n + "," + n + "(," + n + ")?\\)"
            + "|[hH][sS][lL][aA]?\\(" + s + "*" + d + "+([dD][eE][gG])?" + s + "*," + s + "*" + d + "+%" + s + "*," + s + "*" + d + "+%" + s + "*(," + n + ")?\\)"
            + "|[a-zA-Z]{3,20}")
    }()
    private static let email = FnPattern("[^" + Js.wsChars + "@]+@[^" + Js.wsChars + "@]+\\.[^" + Js.wsChars + "@]+")

    /* ------------------------------------------------------------ helpers */

    /// str(): a string no longer than max, else nil.
    private static func str(_ v: JSON?, _ max: Int) -> String? {
        if case .string(let s)? = v, s.utf16.count <= max { return s }
        return nil
    }

    /// opt(): a non-empty string cut to max, else nil.
    private static func opt(_ v: JSON?, _ max: Int) -> String? {
        guard case .string(let s)? = v, !s.isEmpty else { return nil }
        return Js.cut(s, max)
    }

    /// num(): a finite number, or a string that is one; else nil.
    private static func num(_ v: JSON?) -> Double? {
        switch v {
        case .number(let n)?: return n.double.isFinite ? n.double : nil
        case .string(let s)? where !Js.trim(s).isEmpty:
            let d = Js.toNumber(v)
            return d.isFinite ? d : nil
        default: return nil
        }
    }

    private static func clampInt(_ v: JSON?, _ lo: Int, _ hi: Int) -> Int? {
        guard let n = num(v) else { return nil }
        return Swift.max(lo, Swift.min(hi, Js.round(n)))
    }

    /// A number as JSON keeps it: integral ones as integers.
    static func jsonNumber(_ d: Double) -> JSON {
        d == d.rounded() && abs(d) < 1e15 ? .int(Int64(d)) : .double(d)
    }

    /// Base64 characters, at most two "=" at the end (any length).
    private static func isBase64(_ s: String) -> Bool {
        let u = Array(s.utf16)
        let n = u.count
        var end = n
        while end > 0 && n - end < 2 && u[end - 1] == 0x3D { end -= 1 }
        for c in u[0..<end] {
            if !((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) || c == 0x2B || c == 0x2F) { return false }
        }
        return true
    }

    /// [A-Za-z0-9_.:-]{1,64}.
    private static func isName(_ v: JSON?) -> String? {
        guard case .string(let s)? = v else { return nil }
        let u = s.utf16
        guard !u.isEmpty, u.count <= 64 else { return nil }
        for c in u where !((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) || c == 0x5F || c == 0x2E || c == 0x3A || c == 0x2D) { return nil }
        return s
    }

    /// [\w.+-]+/[\w.+-]+ (ASCII \w).
    private static func isFileMime(_ s: String) -> Bool {
        let parts = Js.split(Array(s.utf16), 0x2F)
        guard parts.count == 2 else { return false }
        for p in parts {
            if p.isEmpty { return false }
            for c in p where !((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) || c == 0x5F || c == 0x2E || c == 0x2B || c == 0x2D) { return false }
        }
        return true
    }

    private static func mime(_ s: String, _ kind: String, _ subtypes: Set<String>) -> Bool {
        let prefix = kind + "/"
        guard s.utf16.starts(with: prefix.utf16) else { return false }
        let rest = Array(s.utf16.dropFirst(prefix.utf16.count))
        return subtypes.contains { Array($0.utf16) == rest }
    }

    /// An object of the pairs whose value is not nil (org.json put(k, null) adds nothing).
    private static func obj(_ kv: (String, JSON?)...) -> JSONObject {
        var o = JSONObject()
        for (k, v) in kv where v != nil { o[k] = v }
        return o
    }

    private static func isTrue(_ v: JSON?) -> Bool { if case .bool(true)? = v { return true } else { return false } }

    private static func json(_ s: String?) -> JSON? { s.map { .string($0) } }
    private static func json(_ i: Int?) -> JSON? { i.map { .int($0) } }

    /// "top" / "left", else nil.
    private static func labels(_ v: JSON?) -> JSON? {
        if case .string(let s)? = v, s == "top" || s == "left" { return v }
        return nil
    }

    /* ---------------------------------------------------- forms & buttons */

    private static func sanitizeOptions(_ raw: JSON?) -> [JSON] {
        var out = [JSON]()
        guard case .array(let a)? = raw else { return out }
        for o in a.prefix(200) {
            switch o {
            case .string, .number:
                let s = Js.cut(Js.str(o), 200)
                out.append(.object(obj(("value", .string(s)), ("label", .string(s)))))
            case .object(let x):
                let value = x.has("value") ? x["value"] : x["label"]
                guard let value, !value.isNull else { continue }
                let label = x["label"] == nil || x["label"]!.isNull ? value : x["label"]!
                out.append(.object(obj(("value", .string(Js.cut(Js.str(value), 200))), ("label", .string(Js.cut(Js.str(label), 200))), ("icon", json(opt(x["icon"], 16))))))
            default: continue
            }
        }
        return out
    }

    private static func sanitizeField(_ raw: JSON?) -> JSONObject? {
        guard case .object(let r)? = raw else { return nil }
        let t = Js.str(r["type"])
        let type = formFieldTypes.contains(t) ? t : "text"
        let name: String
        if let n = isName(r["name"]) { name = n } else if type == "static" || type == "separator" { name = "" } else { return nil }
        var f = obj(("name", .string(name)), ("type", .string(type)),
                    ("label", json(opt(r["label"], 200))), ("placeholder", json(opt(r["placeholder"], 200))), ("help", json(opt(r["help"], 500))))
        if r.has("default") { f["default"] = Js.plain(r["default"], 4000) }
        if isTrue(r["required"]) { f["required"] = true }
        if isTrue(r["readonly"]) { f["readonly"] = true }
        for k in ["min", "max", "step"] { if let d = num(r[k]) { f[k] = jsonNumber(d) } }
        // JavaScript and ICU regular expressions agree on what forms use; one ICU cannot read is left out.
        if let pattern = opt(r["pattern"], 300), FnPattern.compile(pattern) != nil { f["pattern"] = .string(pattern) }
        f["mask"] = json(opt(r["mask"], 60))
        if let rows = clampInt(r["rows"], 1, 30) { f["rows"] = .int(rows) }
        if let span = clampInt(r["span"], 1, 4) { f["span"] = .int(span) }
        if let l = labels(r["labels"]) { f["labels"] = l }
        if type == "select" || type == "multiselect" || type == "radio" { f["options"] = .array(sanitizeOptions(r["options"])) }
        f["text"] = json(opt(r["text"], 8000))
        return f
    }

    private static func sanitizeFields(_ raw: JSON?, _ budget: inout Int) -> [JSON] {
        var out = [JSON]()
        guard case .array(let a)? = raw else { return out }
        var seen = Set<String>()
        for x in a {
            if budget <= 0 { break }
            guard let f = sanitizeField(x) else { continue }
            let name = f.optString("name")
            if !name.isEmpty && seen.contains(name) { continue }
            if !name.isEmpty { seen.insert(name) }
            out.append(.object(f))
            budget -= 1
        }
        return out
    }

    /// A form as the app may render it (without "type"), or nil.
    static func sanitizeForm(_ raw: JSONObject) -> JSONObject? {
        var form = obj(("name", .string(isName(raw["name"]) ?? "form")),
                       ("title", json(opt(raw["title"], 300))), ("text", json(opt(raw["text"], 4000))), ("submit", json(opt(raw["submit"], 60))))
        var budget = 120
        if let l = labels(raw["labels"]) { form["labels"] = l }
        if let columns = clampInt(raw["columns"], 1, 4) { form["columns"] = .int(columns) }
        if isTrue(raw["once"]) { form["once"] = true }
        let fields = sanitizeFields(raw["fields"], &budget)
        if !fields.isEmpty { form["fields"] = .array(fields) }
        if case .array(let ps)? = raw["panels"] {
            var panels = [JSON]()
            for x in ps.prefix(16) {
                guard case .object(let p) = x else { continue }
                var panel = obj(("fields", .array(sanitizeFields(p["fields"], &budget))), ("title", json(opt(p["title"], 200))), ("text", json(opt(p["text"], 2000))))
                if case .string(let layout)? = p["layout"], layout == "rows" || layout == "columns" { panel["layout"] = .string(layout) }
                if let pc = clampInt(p["columns"], 1, 4) { panel["columns"] = .int(pc) }
                if let l = labels(p["labels"]) { panel["labels"] = l }
                if isTrue(p["collapsed"]) { panel["collapsed"] = true }
                panels.append(.object(panel))
            }
            if !panels.isEmpty { form["panels"] = .array(panels) }
        }
        return form.has("fields") || form.has("panels") ? form : nil
    }

    /// A button as the app may render it (without "type"), or nil.
    static func sanitizeButton(_ raw: JSONObject) -> JSONObject? {
        guard let name = isName(raw["name"]), let title = opt(firstDefined(raw["title"], raw["label"], raw["text"]), 120) else { return nil }
        var b = obj(("name", .string(name)), ("title", .string(title)))
        if raw.has("data") { b["data"] = Js.plain(raw["data"], 16_000) }
        if case .string(let css)? = raw["css"] {
            var cls = [String]()
            for part in Js.splitWs(css) where buttonClasses.contains(part) && !cls.contains(part) { cls.append(part) }
            if !cls.isEmpty { b["css"] = .string(cls.joined(separator: " ")) }
        }
        if case .object(let style)? = raw["style"] {
            var st = JSONObject()
            for k in ["color", "background", "border"] {
                if case .string(let v)? = style[k], cssColor.matches(Js.trim(v)) { st[k] = .string(Js.trim(v)) }
            }
            if !st.isEmpty { b["style"] = .object(st) }
        }
        b["icon"] = json(opt(raw["icon"], 16))
        b["confirm"] = json(opt(raw["confirm"], 300))
        if isTrue(raw["once"]) { b["once"] = true }
        if isTrue(raw["disabled"]) { b["disabled"] = true }
        return b
    }

    /// a ?? b ?? c.
    private static func firstDefined(_ vs: JSON?...) -> JSON? {
        for v in vs { if let v, !v.isNull { return v } }
        return nil
    }

    /* ------------------------------------------------------------- check */

    /// One output checked: the output (ok), or why it is not one.
    public struct Check: Sendable, Equatable {
        public let output: JSONObject?
        public let reason: String?
        public var ok: Bool { output != nil }
    }

    private static func good(_ o: JSONObject) -> Check { Check(output: o, reason: nil) }
    private static func bad(_ type: String, _ why: String) -> Check { Check(output: nil, reason: type + ": " + why) }

    /// checkFnOutput(): one output, field by field.
    public static func check(_ v: JSON?, maxChars: Int = outputMaxChars) -> Check {
        guard case .object(let o)? = v else { return Check(output: nil, reason: "not an object") }
        let t = o["type"]
        guard case .string(let type)? = t, outputTypes.contains(type) else {
            let shown = Js.stringify(.string(t == nil || t!.isNull ? "" : Js.str(t)))
            return Check(output: nil, reason: "unknown output type " + Js.cut(shown, 40))
        }
        switch type {
        case "text", "markdown":
            guard let text = str(o["text"], maxChars) else { return bad(type, "text must be a string") }
            return good(obj(("type", .string(type)), ("text", .string(text))))
        case "code":
            let l = o["lang"]
            guard let text = str(o["text"], maxChars), let lang = str(l == nil || l!.isNull ? JSON.string("") : l, 40) else { return bad(type, "text must be a string") }
            return good(obj(("type", "code"), ("text", .string(text)), ("lang", .string(lang))))
        case "table":
            guard case .array(let cols0)? = o["columns"], case .array(let rows0)? = o["rows"] else { return bad(type, "columns and rows must be lists") }
            for r in rows0 { guard case .array = r else { return bad(type, "columns and rows must be lists") } }
            let title = opt(o["title"], 500)
            guard let rows = Js.plain(.array(rows0), maxChars) else { return bad(type, "the rows are not plain data") }
            let columns = cols0.map { JSON.string(Js.cut(Js.str($0), 200)) }
            return good(obj(("type", "table"), ("columns", .array(columns)), ("rows", rows), ("title", json(title))))
        case "json":
            let title = opt(o["title"], 500)
            guard let value = o.has("value") ? Js.plain(o["value"], maxChars) : JSON.null else { return bad(type, "the value is not plain data") }
            return good(obj(("type", "json"), ("value", value), ("title", json(title))))
        case "image":
            let mime = str(o["mime"], 100)
            let data = str(o["data"], maxChars)
            guard let mime, !mime.isEmpty, Outputs.mime(mime, "image", imageMimes) else { return bad(type, "mime must be image/png, jpeg, gif, webp or svg+xml") }
            guard let data, isBase64(data) else { return bad(type, "data must be base64 (m5.out.image takes bytes)") }
            return good(obj(("type", "image"), ("mime", .string(mime)), ("data", .string(data)), ("alt", json(opt(o["alt"], 500)))))
        case "file":
            let name = str(o["name"], 200)
            let mime = str(o["mime"], 100)
            let data = str(o["data"], maxChars)
            guard let name, !name.isEmpty, let mime, !mime.isEmpty, isFileMime(mime) else { return bad(type, "a file needs a name and a mime type") }
            guard let data, isBase64(data) else { return bad(type, "data must be base64") }
            let safe = Js.string(name.utf16.map { $0 == 0x5C || $0 == 0x2F || $0 == 0 ? 0x5F : $0 })
            return good(obj(("type", "file"), ("name", .string(safe)), ("mime", .string(mime)), ("data", .string(data))))
        case "flash":
            guard let text = str(o["text"], 2000) else { return bad(type, "text must be a string (up to 2000 characters)") }
            var level = "info"
            if case .string(let l)? = o["level"], flashLevels.contains(l) { level = l }
            return good(obj(("type", "flash"), ("text", .string(text)), ("level", .string(level))))
        case "window":
            guard let id = str(o["id"], 100), !id.isEmpty else { return bad(type, "id must be a string") }
            let args = Js.plain(o["args"], 16_000)
            return good(obj(("type", "window"), ("id", .string(id)), ("args", args ?? .null)))
        case "audio", "video":
            let mime = str(o["mime"], 100)
            let data = str(o["data"], maxChars)
            let audio = type == "audio"
            guard let mime, !mime.isEmpty, Outputs.mime(mime, type, audio ? audioMimes : videoMimes) else {
                return bad(type, audio ? "mime must be audio/mpeg, wav, ogg, webm, aac, mp4 or flac" : "mime must be video/mp4, webm or ogg")
            }
            guard let data, !data.isEmpty, isBase64(data) else { return bad(type, "data must be base64 bytes (m5.out.audio / m5.out.video take bytes)") }
            return good(obj(("type", .string(type)), ("mime", .string(mime)), ("data", .string(data)), ("title", json(opt(o["title"], 300))),
                            ("autoplay", isTrue(o["autoplay"]) ? true : nil), ("loop", isTrue(o["loop"]) ? true : nil)))
        case "button":
            guard let b = sanitizeButton(o) else { return bad(type, "a button needs a name (letters, digits, _ . : -) and a title") }
            return good(typed("button", b))
        case "form":
            guard let f = sanitizeForm(o) else { return bad(type, "a form needs fields (or panels with fields)") }
            return good(typed("form", f))
        case "js":
            guard let code = str(o["code"], 200_000), !Js.trim(code).isEmpty else { return bad(type, "code must be a string (up to 200 000 characters)") }
            let height = clampInt(o["height"], 0, 2000)
            return good(obj(("type", "js"), ("code", .string(code)), ("args", Js.plain(o["args"], 64_000)), ("title", json(opt(o["title"], 200))),
                            ("height", json(height)), ("hidden", isTrue(o["hidden"]) ? true : nil)))
        case "html":
            // 6.6: formatted HTML — document markup only (FnHtml), sanitized here and again where it is drawn.
            guard let html = str(o["html"], Swift.min(maxChars, FnHtml.max)) else { return bad(type, "html must be a string (up to \(FnHtml.max) characters)") }
            return good(obj(("type", "html"), ("html", .string(FnHtml.sanitize(html))), ("title", json(opt(o["title"], 300)))))
        default:
            return bad(type, "unknown")
        }
    }

    /// { type, ...fields } in that order.
    private static func typed(_ type: String, _ fields: JSONObject) -> JSONObject {
        var o = obj(("type", .string(type)))
        for (k, v) in fields { o[k] = v }
        return o
    }

    /// sanitizeFnOutputs(): the valid outputs of a peer's message (at most 50), within maxTotal characters.
    public static func sanitize(_ raw: JSON?, maxTotal: Int = peerMaxTotal) -> [JSON] {
        var out = [JSON]()
        guard case .array(let a)? = raw else { return out }
        var used = 0
        for x in a.prefix(50) {
            let c = check(x, maxChars: maxTotal)
            guard let output = c.output else { continue }
            let size = Js.stringify(.object(output)).utf16.count
            if used + size > maxTotal { break }
            used += size
            out.append(.object(output))
        }
        return out
    }

    /// shareableOutputs(): what fits into a room message; a larger item becomes a note.
    public static func shareable(_ outputs: [JSON], maxTotal: Int = roomMaxTotal) -> [JSON] {
        var out = [JSON]()
        var used = 0
        for o in outputs {
            let size = Js.stringify(o).utf16.count
            if used + size <= maxTotal { out.append(o); used += size; continue }
            let type = o.objectValue.map { Js.str($0["type"]) } ?? "undefined"
            out.append(.object(obj(("type", "text"), ("text", .string("(" + type + " — too large to share in the room)")))))
            used += 80
        }
        return out
    }

    /* ---------------------------------------------------------- Markdown */

    /// outputsToMarkdown(): the text of the message.
    public static func toMarkdown(_ outputs: [JSON]) -> String {
        var parts = [String]()
        for x in outputs {
            guard case .object(let o) = x else { continue }
            switch o.orgString("type") {
            case "text", "markdown": parts.append(s(o, "text"))
            case "code": parts.append("```" + s(o, "lang") + "\n" + s(o, "text") + "\n```")
            case "json": parts.append((truthy(o, "title") ? "**" + s(o, "title") + "**\n" : "") + "```json\n" + Js.stringify(o["value"], indent: 2) + "\n```")
            case "table": parts.append(tableToMarkdown(o))
            case "flash": parts.append("> " + s(o, "text"))
            case "image": parts.append("_(image: " + (truthy(o, "alt") ? s(o, "alt") : s(o, "mime")) + ")_")
            case "file": parts.append("_(file: " + s(o, "name") + ")_")
            case "audio", "video": parts.append("_(" + s(o, "type") + (truthy(o, "title") ? ": " + s(o, "title") : "") + ")_")
            case "button": parts.append("[" + (truthy(o, "icon") ? s(o, "icon") + " " : "") + s(o, "title") + "]")
            case "form": parts.append("**" + (truthy(o, "title") ? s(o, "title") : "Form") + "**" + (truthy(o, "text") ? "\n" + s(o, "text") : ""))
            case "html": parts.append((truthy(o, "title") ? "**" + s(o, "title") + "**\n\n" : "") + FnHtml.text(FnHtml.parse(s(o, "html"))))
            default: break // window, js: nothing to read
            }
        }
        return Js.trim(parts.joined(separator: "\n\n"))
    }

    /// `${o.k}` of a present field ("" when it is missing).
    private static func s(_ o: JSONObject, _ k: String) -> String { o[k] == nil ? "" : Js.str(o[k]) }

    private static func truthy(_ o: JSONObject, _ k: String) -> Bool {
        guard let v = o[k] else { return false }
        switch v {
        case .null: return false
        case .string(let s): return !s.isEmpty
        case .bool(let b): return b
        case .number(let n): return !(n.double == 0 || n.double.isNaN)
        default: return true
        }
    }

    /// A table cell as text: objects as JSON.
    public static func cellText(_ v: JSON?) -> String {
        guard let v, !v.isNull else { return "" }
        switch v {
        case .object, .array: return Js.stringify(v)
        default: return Js.str(v)
        }
    }

    private static func tableToMarkdown(_ o: JSONObject) -> String {
        let columns = o.array("columns")
        let rows = o.array("rows")
        var head = "|", sep = "|"
        for (i, c) in (columns ?? []).enumerated() {
            head += (i == 0 ? " " : " | ") + mdCell(c)
            sep += (i == 0 ? " " : " | ") + "---"
        }
        head += " |"
        sep += " |"
        var body = [String]()
        for r in rows ?? [] {
            var line = "|"
            for (c, x) in (r.arrayValue ?? []).enumerated() { line += (c == 0 ? " " : " | ") + mdCell(x) }
            body.append(line + " |")
        }
        return (truthy(o, "title") ? "**" + s(o, "title") + "**\n\n" : "") + head + "\n" + sep + "\n" + body.joined(separator: "\n")
    }

    private static func mdCell(_ v: JSON) -> String {
        var out = [UInt16]()
        for c in cellText(v).utf16 {
            if c == 0x7C { out.append(0x5C); out.append(0x7C) } else if c == 0x0A { out.append(0x20) } else { out.append(c) }
        }
        return Js.string(out)
    }

    /* -------------------------------------------------------------- forms */

    /// formFields(): a form's fields, panels included, in order.
    public static func formFields(_ form: JSONObject) -> [JSONObject] {
        var out = (form.array("fields") ?? []).compactMap(\.objectValue)
        for p in form.array("panels") ?? [] {
            if let p = p.objectValue { out += (p.array("fields") ?? []).compactMap(\.objectValue) }
        }
        return out
    }

    /// One part of a mask: a slot ("0" a digit, "a" a letter, "*" either) or a literal character.
    public struct MaskToken: Sendable, Equatable {
        public let slot: Bool
        public let c: String
    }

    /// maskTokens(): what is in {braces} or after a backslash is literal ("+{420} 000 000 000").
    public static func maskTokens(_ mask: String) -> [MaskToken] {
        var out = [MaskToken]()
        let chars = codePoints(mask)
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if c == "\\" && i + 1 < chars.count { i += 1; out.append(MaskToken(slot: false, c: chars[i])); i += 1; continue }
            if c == "{", let close = chars[(i + 1)...].firstIndex(of: "}") {
                for x in chars[(i + 1)..<close] { out.append(MaskToken(slot: false, c: x)) }
                i = close + 1
                continue
            }
            out.append(MaskToken(slot: c == "0" || c == "a" || c == "*", c: c))
            i += 1
        }
        return out
    }

    /// maskPlaceholder(): "+420 ___ ___ ___".
    public static func maskPlaceholder(_ mask: String) -> String {
        maskTokens(mask).map { $0.slot ? "_" : $0.c }.joined()
    }

    /// applyMask(): "777123456" → "+420 777 123 456".
    public static func applyMask(_ mask: String, _ raw: String) -> String {
        let chars = Array(raw.unicodeScalars.filter { Js.isLetter($0) || Js.isNumber($0) })
        var out = String.UnicodeScalarView()
        var i = 0
        for tk in maskTokens(mask) {
            if i >= chars.count { break }
            if tk.slot {
                // Skip what does not fit this slot.
                while i < chars.count && !fits(tk.c, chars[i]) { i += 1 }
                if i >= chars.count { break }
                out.append(chars[i])
                i += 1
            } else {
                out.append(contentsOf: tk.c.unicodeScalars)
                if String(Character(chars[i])).unicodeScalars.elementsEqual(tk.c.unicodeScalars) { i += 1 }
            }
        }
        return String(out)
    }

    private static func fits(_ slot: String, _ u: Unicode.Scalar) -> Bool { slot == "0" ? Js.isNumber(u) : slot != "a" || Js.isLetter(u) }

    /// The code points of a string, each as a string.
    static func codePoints(_ s: String) -> [String] { s.unicodeScalars.map { String(Character($0)) } }

    /// What is wrong with a form's values, per field, in the order of the fields.
    public struct FormProblems: Sendable, Equatable {
        /// The fields with a problem, in order.
        public private(set) var names: [String] = []
        private var problems: [String: String] = [:]

        public init() {}

        /// "required", "number", "min 2", "max 9", "email", "incomplete" or "pattern".
        public subscript(name: String) -> String? { problems[name] }
        public var isEmpty: Bool { names.isEmpty }
        public var count: Int { names.count }
        /// name → problem.
        public var dictionary: [String: String] { problems }

        mutating func put(_ name: String, _ problem: String) {
            if problems.updateValue(problem, forKey: name) == nil { names.append(name) }
        }
    }

    /// checkFormValues(): what is wrong with a form's values, per field:
    /// "required", "number", "min 2", "max 9", "email", "incomplete", "pattern".
    public static func checkFormValues(_ form: JSONObject, _ values: JSONObject) -> FormProblems {
        var problems = FormProblems()
        for f in formFields(form) {
            let name = f.orgString("name")
            let type = f.orgString("type")
            if name.isEmpty || type == "static" || type == "separator" { continue }
            let v = values[name]
            let required = isTrue(f["required"])
            var empty = false
            switch v {
            case nil, .null?: empty = true
            case .string(let s)?: empty = s.isEmpty
            case .array(let a)?: empty = a.isEmpty
            default: break
            }
            if (type == "checkbox" || type == "switch") && !isTrue(v) && required { empty = true }
            if empty { if required { problems.put(name, "required") }; continue }
            if type == "number" || type == "range" {
                let n = Js.toNumber(v)
                if !n.isFinite { problems.put(name, "number") }
                else if case .number(let min)? = f["min"], n < min.double { problems.put(name, "min " + Js.str(f["min"])) }
                else if case .number(let max)? = f["max"], n > max.double { problems.put(name, "max " + Js.str(f["max"])) }
            }
            if type == "email" && !email.matches(Js.str(v)) { problems.put(name, "email") }
            // A masked value is complete when every part of the mask is filled.
            if type == "masked", case .string(let mask)? = f["mask"], !mask.isEmpty, codePoints(Js.str(v)).count < maskTokens(mask).count {
                problems.put(name, "incomplete")
            }
            if case .string(let pattern)? = f["pattern"], case .string(let s)? = v, let re = FnPattern.compile(pattern), !re.found(in: s) {
                problems.put(name, "pattern")
            }
        }
        return problems
    }
}

extension Js {
    /// s.split(/\s+/) without the empty parts.
    static func splitWs(_ s: String) -> [String] {
        var out = [String]()
        var cur = [UInt16]()
        for c in s.utf16 {
            if isWs(c) { if !cur.isEmpty { out.append(string(cur)); cur.removeAll() } } else { cur.append(c) }
        }
        if !cur.isEmpty { out.append(string(cur)) }
        return out
    }
}
