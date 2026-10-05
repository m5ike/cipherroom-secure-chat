// 6.11: a command's signature and the check of a call before it goes to the
// server — a port of android fn/CommandCheck.java (commandUsage(),
// inputExpectation() and checkCommandInputs() of
// client/src/lib/system-messenger.ts; the same vectors test all three). A
// call that fails the check never runs: the model's answer is an error card
// with what is wrong, the usage line, the inputs and the model's own guide.

import M5Core

/// A command's usage line and the check of a call (android `fn/CommandCheck.java`).
public enum CommandCheck {
    /// What is wrong with one input: missing, type, pattern, range or values — and what it expects (English, as the web says it).
    public struct Problem: Sendable, Equatable, CustomStringConvertible {
        public let input: String
        public let label: String
        /// "missing", "type", "pattern", "range" or "values".
        public let problem: String
        public let expected: String
        /// The input it is about (for a translated line).
        public let spec: Command.Input

        init(_ spec: Command.Input, _ problem: String) {
            self.spec = spec
            input = spec.name
            label = spec.label.isEmpty ? spec.name : spec.label
            self.problem = problem
            expected = CommandCheck.expectation(spec)
        }

        public var description: String { input + ":" + problem + ":" + expected }
    }

    /// The app's words for the translated lines (fnm.expect.*, fnm.problem.*): key → text.
    public typealias Tr = (String) -> String

    private static let e164Source = "^\\+[1-9]\\d{1,14}$"

    /// commandUsage(): "/hlr <number> [format]" — required inputs without a default in <>, the others in [].
    public static func usage(_ cmd: Command, _ trigger: String? = "/") -> String {
        var sb = (trigger ?? "/") + cmd.keyword
        for i in cmd.inputs { sb += " " + arg(i) }
        return sb
    }

    /// One input in the usage line.
    public static func arg(_ i: Command.Input) -> String { i.mustGive ? "<" + i.name + ">" : "[" + i.name + "]" }

    private static func numeric(_ i: Command.Input) -> Bool { i.type == "number" || i.type == "integer" }

    /// inputExpectation(): what an input expects, for an error line ("one of: a, b", "a number 1–10"…).
    public static func expectation(_ i: Command.Input) -> String {
        if !i.values.isEmpty { return "one of: " + i.values.joined(separator: ", ") }
        if numeric(i) { return "a " + i.type + (i.min != nil || i.max != nil ? " " + num(i.min) + "–" + num(i.max) : "") }
        if i.type == "phone" || i.pattern == e164Source { return "a phone number in international form (+420…)" }
        if i.type == "boolean" { return "true / false" }
        if let p = i.pattern { return "text matching " + p }
        return !i.type.isEmpty ? "a " + i.type : "a value"
    }

    /// The same in the app's language (fnm.expect.*).
    public static func expectation(_ i: Command.Input, _ tr: Tr) -> String {
        if !i.values.isEmpty { return tr("fnm.expect.values").fnReplace("{values}", with: i.values.joined(separator: ", ")) }
        if numeric(i) {
            let what = tr(i.type == "integer" ? "fnm.expect.integer" : "fnm.expect.number")
            return i.min != nil || i.max != nil ? what + " " + num(i.min) + "–" + num(i.max) : what
        }
        if i.type == "phone" || i.pattern == e164Source { return tr("fnm.expect.phone") }
        if i.type == "boolean" { return tr("fnm.expect.boolean") }
        if let p = i.pattern { return tr("fnm.expect.pattern").fnReplace("{pattern}", with: p) }
        if i.type == "email" { return tr("fnm.expect.email") }
        return !i.type.isEmpty ? tr("fnm.expect.type").fnReplace("{type}", with: i.type) : tr("fnm.expect.value")
    }

    /// "Missing", "Wrong type"… in the app's language (fnm.problem.*).
    public static func problem(_ p: Problem, _ tr: Tr) -> String { tr("fnm.problem." + p.problem) }

    private static func num(_ d: Double?) -> String { d.map(Js.numberToString) ?? "…" }

    /// The answer to a call that cannot run (6.11) — the model's own outputs, so
    /// the bubble draws them like any answer: what is wrong (each problem, or
    /// the server's refusal), the usage line, the parameters (what each
    /// expects, required or not, its help), and the model's guide.
    ///
    /// - Parameter problems: the check's (empty when the server refused: serverMessage says why)
    public static func card(_ cmd: Command, _ trigger: String?, _ problems: [Problem], _ serverMessage: String?, _ tr: Tr) -> [JSON] {
        var out = [JSON]()
        var md = ""
        for p in problems {
            md += "- **" + p.label + "**"
            if !Js.same(p.label, p.input) { md += " (`" + p.input + "`)" }
            md += ": " + problem(p, tr) + " — " + tr("fnm.error.expects").fnReplace("{expected}", with: expectation(p.spec, tr)) + "\n"
        }
        if let m = serverMessage, !m.isEmpty { md += tr("fnm.error.server").fnReplace("{message}", with: m) + "\n" }
        if !md.isEmpty { out.append(.object(JSONObject([("type", "markdown"), ("text", .string(md.javaTrimmed))]))) }
        out.append(.object(JSONObject([("type", "code"), ("text", .string(usage(cmd, trigger)))])))
        if !cmd.inputs.isEmpty {
            var rows = [JSON]()
            for i in cmd.inputs {
                var what = tr(i.mustGive ? "fnm.required" : "fnm.optional") + " · " + expectation(i, tr)
                if let d = i.def, !d.isNull { what += " · " + tr("fnm.default").fnReplace("{value}", with: Js.str(d)) }
                let name = i.name + (!i.label.isEmpty && !Js.same(i.label, i.name) ? " (" + i.label + ")" : "")
                rows.append(.array([.string(name), .string(what), .string(i.help)]))
            }
            out.append(.object(JSONObject([("type", "table"), ("title", .string(tr("fnm.inputs"))),
                                           ("columns", .array([.string(tr("fnm.col.name")), .string(tr("fnm.col.expect")), .string(tr("fnm.col.help"))])),
                                           ("rows", .array(rows))])))
        }
        if !Js.trim(cmd.usage).isEmpty {
            out.append(.object(JSONObject([("type", "markdown"), ("text", .string("**" + tr("fnm.guide") + "**\n\n" + cmd.usage))])))
        }
        return out
    }

    /// ^\+[1-9]\d{1,14}$ (ASCII digits).
    private static func isE164(_ s: [UInt16]) -> Bool {
        guard s.count >= 3, s.count <= 16, s[0] == 0x2B, s[1] >= 0x31, s[1] <= 0x39 else { return false }
        return s[2...].allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
    }

    /// ^(true|false|1|0|yes|no|ano|ne)$, case-insensitive (ASCII).
    private static func isBool(_ s: String) -> Bool {
        ["true", "false", "1", "0", "yes", "no", "ano", "ne"].contains { Js.same($0, Js.asciiLower(s)) }
    }

    /// checkCommandInputs(): the inputs of a call that cannot go to the server
    /// as they are — a required input without a value or default (a model
    /// whose inputs are all optional answers an empty call with its own form,
    /// so that is never one), a value of the wrong type, outside its range,
    /// not one of its values, not a phone number, not matching its pattern.
    ///
    /// - Parameter values: the call's inputs (Commands.buildInputs: name → text)
    public static func check(_ cmd: Command, _ values: JSONObject?) -> [Problem] {
        var out = [Problem]()
        let v0 = values ?? JSONObject()
        for i in cmd.inputs {
            let v = v0[i.name]
            var empty = false
            switch v {
            case nil, .null?: empty = true
            case .string(let s)?: empty = Js.trim(s).isEmpty
            default: break
            }
            if empty {
                if i.mustGive { out.append(Problem(i, "missing")) }
                continue
            }
            let s = Js.trim(Js.str(v))
            if numeric(i) {
                let n = Js.toNumber(.string(s))
                if !n.isFinite || (i.type == "integer" && n != n.rounded(.toNearestOrEven)) { out.append(Problem(i, "type")); continue }
                if let min = i.min, n < min { out.append(Problem(i, "range")); continue }
                if let max = i.max, n > max { out.append(Problem(i, "range")); continue }
            }
            if i.type == "boolean" && !isBool(s) { out.append(Problem(i, "type")); continue }
            if !i.values.isEmpty && !i.values.contains(where: { Js.same($0, s) }) { out.append(Problem(i, "values")); continue }
            if i.type == "phone" {
                // JavaScript's \s, brackets, dots and dashes do not count.
                let digits = s.utf16.filter { !(Js.isWs($0) || $0 == 0x28 || $0 == 0x29 || $0 == 0x2E || $0 == 0x2D) }
                if !isE164(digits) { out.append(Problem(i, "pattern")); continue }
            }
            if let p = i.pattern, p.utf16.count <= 200, let re = FnPattern.compile(p), !re.found(in: s) {
                out.append(Problem(i, "pattern"))
            }
        }
        return out
    }
}

extension String {
    /// Java's String.replace(CharSequence, CharSequence): every occurrence, UTF-16 exact.
    func fnReplace(_ target: String, with replacement: String) -> String {
        let t = Array(target.utf16)
        guard !t.isEmpty else { return self }
        let u = Array(utf16)
        var i = Js.index(of: t, in: u, from: 0)
        if i < 0 { return self }
        var out = [UInt16]()
        var from = 0
        while i >= 0 {
            out.append(contentsOf: u[from..<i])
            out.append(contentsOf: replacement.utf16)
            from = i + t.count
            i = Js.index(of: t, in: u, from: from)
        }
        out.append(contentsOf: u[from...])
        return Js.string(out)
    }
}
