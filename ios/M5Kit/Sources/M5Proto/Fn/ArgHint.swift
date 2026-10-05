// 6.11: the hint over the message box while a command's arguments are typed
// ("/hlr +420… ") — a port of android fn/ArgHint.java: the command's usage
// line with the argument the cursor is in highlighted, that argument's label,
// help, type and — for a choice or a switch — its values to tap. Which
// argument it is follows Commands.buildInputs: "name=value" names one, bare
// words fill the chat-typeable inputs in order, and a trailing text input
// takes the rest. Offsets (cursor, spans) are UTF-16 units (NSRange-compatible).

import M5Core

/// The argument hint of the message box (android `fn/ArgHint.java`).
public struct ArgHint: Sendable {
    public let command: Command
    public let model: ModelIdentity
    /// "/hlr <number> [format]".
    public let usage: String
    /// Where each input stands in the usage line: [start, end) per input, in the command's order (UTF-16).
    public let spans: [Range<Int>]
    /// The input the cursor is in (its index in command.inputs), −1 when all are given.
    public let current: Int
    /// What is typed for it so far.
    public let typed: String
    /// Values to offer for it (a choice's values, true / false for a switch) that start with what is typed.
    public let values: [String]
    /// The text, where the typed value starts in it (for pick) and the cursor.
    private let text: [UInt16]
    private let valueStart: Int
    private let caret: Int

    private init(_ command: Command, _ trigger: String, _ current: Int, _ typed: String, _ text: [UInt16], _ valueStart: Int, _ caret: Int) {
        self.command = command
        model = ModelIdentity.of(command)
        var sb = trigger + command.keyword
        var spans = [Range<Int>]()
        for i in command.inputs {
            sb += " "
            let s = sb.utf16.count
            sb += CommandCheck.arg(i)
            spans.append(s..<sb.utf16.count)
        }
        usage = sb
        self.spans = spans
        self.current = current
        self.typed = typed
        self.text = text
        self.valueStart = valueStart
        self.caret = caret
        var v = [String]()
        if current >= 0 && current < command.inputs.count {
            let input = command.inputs[current]
            let all = !input.values.isEmpty ? input.values : input.type == "boolean" ? ["true", "false"] : []
            let t = Array(Js.lowerRoot(typed).utf16)
            for x in all where Array(Js.lowerRoot(x).utf16).starts(with: t) && !Js.same(x, typed) { v.append(x) }
        }
        values = v
    }

    /// The input the cursor is in (nil when all are given).
    public var input: Command.Input? { current >= 0 && current < command.inputs.count ? command.inputs[current] : nil }

    /// The text and cursor once a value is picked: it replaces what is typed for the input, a space after it.
    public func pick(_ value: String) -> (text: String, cursor: Int) {
        let after = text[caret...]
        let end = after.firstIndex(where: Js.isWs) ?? after.endIndex
        var rest = text[end...]
        if let f = rest.first, Js.isWs(f) { rest = rest.dropFirst() }
        let q = ArgHint.hasSpace(value) ? "\"" + value + "\"" : value
        let head = Array(text[0..<valueStart]) + Array((q + " ").utf16)
        return (Js.string(head + rest), head.count)
    }

    /// value.matches(".*\s.*") as Java reads it: "." takes no line terminator, so at most one may be in it — as the \s.
    static func hasSpace(_ value: String) -> Bool {
        let u = Array(value.utf16)
        let terminators = u.indices.filter { u[$0] == 0x0A || u[$0] == 0x0D || u[$0] == 0x85 || u[$0] == 0x2028 || u[$0] == 0x2029 }
        if terminators.count > 1 { return false }
        if let k = terminators.first { return Js.isWs(u[k]) }
        return u.contains(where: Js.isWs)
    }

    /// The hint for the text before the cursor, or nil (not a known command's arguments).
    public static func of(_ text: String?, _ cursor: Int, _ chars: [String], _ state: Commands.State?) -> ArgHint? {
        guard let text, !text.isEmpty, let state else { return nil }
        let full = Array(text.utf16)
        let at = Swift.max(0, Swift.min(cursor, full.count))
        let before = Array(full[0..<at])
        let first = Js.firstCodePoint(Js.string(before))
        if first.isEmpty || !chars.contains(where: { Js.same($0, first) }) { return nil }
        // ([a-z0-9_-]{1,40})\s+ right after the trigger, case-insensitive.
        let p = first.utf16.count
        var k = p
        while k < before.count && Commands.wordUnit(before[k]) { k += 1 }
        if k == p || k - p > 40 || k >= before.count || !Js.isWs(before[k]) { return nil }
        let keyword = Js.string(before[p..<k]).lowercased()
        var argsAt = k
        while argsAt < before.count && Js.isWs(before[argsAt]) { argsAt += 1 }
        guard let cmd = state.find(keyword), !cmd.inputs.isEmpty else { return nil }
        // The words typed so far; the last one is the one being typed unless a space follows it.
        var words = [Range<Int>]()
        var i = argsAt
        while i < before.count {
            while i < before.count && Js.isWs(before[i]) { i += 1 }
            if i >= before.count { break }
            let s = i
            let c = before[i]
            if c == 0x22 || c == 0x27 {
                i = before[(i + 1)...].firstIndex(of: c).map { $0 + 1 } ?? before.count
            }
            while i < before.count && !Js.isWs(before[i]) { i += 1 }
            words.append(s..<i)
        }
        let inWord = !words.isEmpty && words[words.count - 1].upperBound == before.count && !Js.isWs(before[before.count - 1])
        let done = inWord ? Array(words.dropLast()) : words
        var named = [String]()
        var bare = [String]()
        for w in done {
            let tok = Array(before[w])
            if let eq = tok.firstIndex(of: 0x3D), eq > 0, index(cmd, Js.string(tok[0..<eq])) >= 0 { named.append(Js.string(tok[0..<eq])) } else { bare.append(Js.string(tok)) }
        }
        let valueStart = inWord ? words[words.count - 1].lowerBound : before.count
        let typed = inWord ? Array(before[valueStart...]) : []
        // "name=value" being typed: that input.
        if let eq = typed.firstIndex(of: 0x3D), eq > 0 {
            let n = index(cmd, Js.string(typed[0..<eq]))
            if n >= 0 { return ArgHint(cmd, first, n, unquote(Array(typed[(eq + 1)...])), full, valueStart + eq + 1, at) }
        }
        // Else the next chat-typeable input not named yet; a trailing text input takes everything left.
        let positional = cmd.inputs.enumerated().filter { e in Commands.chatTypeable(e.element) && !named.contains { Js.same($0, e.element.name) } }
        let count = bare.count
        if let last = positional.last {
            let rest = last.element.type == "text" || last.element.type == "string"
            if rest && count >= positional.count - 1 { return ArgHint(cmd, first, last.offset, unquote(typed), full, valueStart, at) }
            if count < positional.count { return ArgHint(cmd, first, positional[count].offset, unquote(typed), full, valueStart, at) }
        }
        return ArgHint(cmd, first, -1, "", full, valueStart, at)
    }

    private static func index(_ c: Command, _ name: String) -> Int {
        c.inputs.firstIndex { Js.same($0.name, name) } ?? -1
    }

    /// Without the opening quote and a closing one (`.replaceFirst("[\"']$", "")`, Java's $: before a final line terminator too).
    private static func unquote(_ s: [UInt16]) -> String {
        guard let f = s.first, f == 0x22 || f == 0x27 else { return Js.string(s) }
        var r = Array(s.dropFirst())
        let n = r.count
        func quote(_ i: Int) -> Bool { i >= 0 && i < n && (r[i] == 0x22 || r[i] == 0x27) }
        func terminator(_ c: UInt16) -> Bool { c == 0x0A || c == 0x0D || c == 0x85 || c == 0x2028 || c == 0x2029 }
        // The leftmost quote followed by where $ matches: "\r\n" at the end, one final terminator (not the \n of \r\n), or the end.
        if n >= 3 && r[n - 2] == 0x0D && r[n - 1] == 0x0A && quote(n - 3) { r.remove(at: n - 3) }
        else if n >= 2 && terminator(r[n - 1]) && !(r[n - 1] == 0x0A && r[n - 2] == 0x0D) && quote(n - 2) { r.remove(at: n - 2) }
        else if quote(n - 1) { r.remove(at: n - 1) }
        return Js.string(r)
    }
}
