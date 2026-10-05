// What typing a trigger character offers in the message box — a port of
// android fn/Suggestions.java (composerSuggestions() in App.tsx): "/"
// commands at the start of the text, "@" the people in the room and "#" tags
// at the start of a word (the characters are the operator's). Up to 8 items,
// each with the text it leaves when picked.
//
// 6.11: matching is loose (Fuzzy: the keyword's start, a word in the name,
// the summary, the letters in order; no case, no diacritics) and says where
// it matched (to highlight); the commands this person uses (Usage) come first
// ("recent"), then those whose keyword or name match ("commands"), then those
// found only by their summary ("others"); a command's item has its model's
// identity, name, summary, the arguments and who sees the answer. Cursors and
// hits are UTF-16 offsets (NSRange-compatible).

import M5Core

/// The message box's suggestions (android `fn/Suggestions.java`).
public enum Suggestions {
    public static let max = 8
    /// At most this many used commands lead the list.
    public static let recent = 3

    /// One argument of a command's signature.
    public struct Arg: Sendable, Equatable {
        public let name: String
        public let type: String
        /// Has to be given (<name>); else optional ([name]).
        public let required: Bool
        init(_ i: Command.Input) { name = i.name; type = i.type; required = i.mustGive }
    }

    /// One suggestion. A disabled one is a notice (key "off": commands are off; "none": no command fits).
    public struct Item: Sendable, Equatable {
        public let key: String
        /// "/keyword", "@name", "#tag" ("" for a notice: say it by its key).
        public let label: String
        /// A command's summary (or name).
        public let detail: String
        /// A command's inputs: "domain [port]".
        public let extra: String
        public let disabled: Bool
        /// The message box's text and cursor once this is picked (nil for a notice).
        public let text: String?
        public let cursor: Int
        /// 6.11: "recent", "commands", "others", "people", "tags" ("" for a notice).
        public let section: String
        /// 6.11, a command's: its name, summary, who sees its answer ("room" / "caller"), its own guide ("" otherwise).
        public let name: String
        public let summary: String
        public let visibility: String
        public let guide: String
        public let model: ModelIdentity?
        public let args: [Arg]
        /// 6.11: what matched, to highlight — [start, end) ranges in label, name and summary.
        public let labelHits: [Range<Int>]
        public let nameHits: [Range<Int>]
        public let summaryHits: [Range<Int>]

        init(key: String, label: String, detail: String, extra: String, disabled: Bool, text: String?, cursor: Int,
             section: String = "", command c: Command? = nil, model: ModelIdentity? = nil,
             labelHits: [Range<Int>] = [], nameHits: [Range<Int>] = [], summaryHits: [Range<Int>] = []) {
            self.key = key
            self.label = label
            self.detail = detail
            self.extra = extra
            self.disabled = disabled
            self.text = text
            self.cursor = cursor
            self.section = section
            name = c?.name ?? ""
            summary = c?.summary ?? ""
            visibility = c?.visibility ?? ""
            guide = c?.usage ?? ""
            self.model = model
            args = c?.inputs.map(Arg.init) ?? []
            self.labelHits = labelHits
            self.nameHits = nameHits
            self.summaryHits = summaryHits
        }
    }

    public struct Result: Sendable, Equatable {
        /// "functions", "mentions" or "tags" (what the list's title says).
        public let kind: String
        public let items: [Item]
    }

    /// [\p{L}\p{N}_.-].
    private static func wordChar(_ u: Unicode.Scalar) -> Bool { Js.isLetter(u) || Js.isNumber(u) || u == "_" || u == "." || u == "-" }

    /// [\p{L}\p{N}_].
    private static func tagStart(_ u: Unicode.Scalar) -> Bool { Js.isLetter(u) || Js.isNumber(u) || u == "_" }

    /// tagsIn(): a message's #tags as the chat shows and filters them — lower case, no trailing "." or "-".
    /// (?:^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_.-]{0,39}), as client/src/lib/linkify.tsx finds them.
    public static func tagsIn(_ text: String?) -> [String] {
        var out = [String]()
        guard let text, text.utf16.contains(0x23) else { return out }
        let u = Array(text.unicodeScalars)
        var pos = 0
        // Matcher.find() from pos: the leftmost start ("^" only at 0), then the tag greedily.
        while pos < u.count {
            var found: Range<Int>?
            var s = pos
            while s < u.count && found == nil {
                let hash = s == 0 && u[0] == "#" ? 0 : (Js.isWs(u[s]) || u[s] == "(") && s + 1 < u.count && u[s + 1] == "#" ? s + 1 : -1
                if hash >= 0 && hash + 1 < u.count && tagStart(u[hash + 1]) {
                    var e = hash + 2
                    while e < u.count && e - (hash + 2) < 39 && wordChar(u[e]) { e += 1 }
                    found = (hash + 1)..<e
                }
                s += 1
            }
            guard let f = found else { break }
            var tag = Array(u[f])
            while let l = tag.last, l == "." || l == "-" { tag.removeLast() }
            var view = String.UnicodeScalarView()
            view.append(contentsOf: tag)
            let t = Js.lowerRoot(String(view))
            if !t.isEmpty { out.append(t) }
            pos = f.upperBound
        }
        return out
    }

    /// The suggestions for the text before the cursor, or nil.
    ///
    /// - Parameters:
    ///   - cursor: the cursor (UTF-16 offset)
    ///   - state: the commands (Commands.unknown before the server answered)
    ///   - names: the people who may be mentioned (in the room, and away)
    ///   - recent: the texts of the room's messages (the last 300 are searched for tags)
    ///   - usage: the commands this person ran (nil: none known)
    ///   - now: the time, for how recent a use is
    public static func suggest(_ text: String?, _ cursor: Int, _ composer: Commands.Composer, _ state: Commands.State,
                               _ names: [String], _ recent: [String], usage: Usage? = nil, now: Int64 = 0) -> Result? {
        guard let text, !text.isEmpty else { return nil }
        let full = Array(text.utf16)
        let at = Swift.max(0, Swift.min(cursor, full.count))
        let inputUnits = Array(full[0..<at])
        let tail = Js.string(full[at...])
        if inputUnits.isEmpty { return nil }
        let input = Js.string(inputUnits)
        let first = Js.firstCodePoint(input)
        if composer.commandChars.contains(where: { Js.same($0, first) }) {
            let rest = inputUnits.dropFirst(first.utf16.count)
            if rest.allSatisfy(Commands.wordUnit) { return commands(first, Js.string(rest).lowercased(), tail, state, usage, now) }
        }
        // (^|\s)(\S)([\p{L}\p{N}_.-]*)\z: the word before the cursor — its first character and the rest.
        let lastWs = inputUnits.lastIndex(where: Js.isWs)
        let word = Js.string(inputUnits[(lastWs.map { $0 + 1 } ?? 0)...])
        guard let ch0 = word.unicodeScalars.first else { return nil }
        let rest = word.unicodeScalars.dropFirst()
        guard rest.allSatisfy(wordChar) else { return nil }
        let ch = String(Character(ch0))
        guard let trig = composer.triggers.first(where: { Js.same($0.ch, ch) && $0.action != "functions" }) else { return nil }
        var restView = String.UnicodeScalarView()
        restView.append(contentsOf: rest)
        let restText = String(restView)
        let q = Js.lowerRoot(restText)
        let before = Js.string(inputUnits[0..<(inputUnits.count - ch.utf16.count - restText.utf16.count)])
        if trig.action == "mentions" {
            var unique = [String]()
            var seen = Set<[UInt16]>()
            for n in names {
                if n.isEmpty { continue }
                let shown = underscored(n)
                if seen.insert(Array(shown.utf16)).inserted { unique.append(shown) }
            }
            var found = [Ranked]()
            for (idx, n) in unique.enumerated() {
                if let fm = loose(q, n, false) {
                    found.append(Ranked(item: pick(n, trig.ch + n, before + trig.ch + n, tail, "people", shift(fm.hits, trig.ch.utf16.count)), score: fm.score, used: 0, index: idx))
                }
            }
            let items = ranked(found)
            return items.isEmpty ? nil : Result(kind: "mentions", items: items)
        }
        var seen = [String]()
        var seenKeys = Set<[UInt16]>()
        func add(_ t: String) { if seenKeys.insert(Array(t.utf16)).inserted { seen.append(t) } }
        composer.tags.forEach(add)
        for t in recent.suffix(300) { tagsIn(t).forEach(add) }
        var found = [Ranked]()
        var idx = 0
        for tag in seen {
            idx += 1
            if Js.same(tag, q) { continue }
            guard let fm = loose(q, tag, false) else { continue }
            found.append(Ranked(item: pick(tag, trig.ch + tag, before + trig.ch + tag, tail, "tags", shift(fm.hits, trig.ch.utf16.count)), score: fm.score, used: 0, index: idx))
        }
        let items = ranked(found)
        return items.isEmpty ? nil : Result(kind: "tags", items: items)
    }

    /// Runs of JavaScript's white space as "_" (`.replaceAll(\s+, "_")`).
    private static func underscored(_ s: String) -> String {
        var out = [UInt16]()
        var inWs = false
        for c in s.utf16 {
            if Js.isWs(c) { if !inWs { out.append(0x5F) }; inWs = true } else { out.append(c); inWs = false }
        }
        return Js.string(out)
    }

    /// An item with its place: its section's order, how well it matched, how much it is used, its place in the server's list.
    private struct Ranked {
        let item: Item
        let score: Int
        let used: Double
        let index: Int
        var section: Int { item.section == "recent" ? 0 : item.section == "others" ? 2 : 1 }
    }

    private static func ranked(_ found: [Ranked]) -> [Item] {
        let sorted = found.sorted { x, y in
            if x.section != y.section { return x.section < y.section }
            if x.used != y.used { return x.used > y.used }
            if x.score != y.score { return x.score > y.score }
            return x.index < y.index
        }
        return sorted.prefix(max).map(\.item)
    }

    private static func commands(_ ch: String, _ q: String, _ tail: String, _ state: Commands.State, _ usage: Usage?, _ now: Int64) -> Result? {
        if state.enabled == false { return notice("off") }
        var found = [Ranked]()
        // The used ones lead — the most used (and lately) first, at most `recent`.
        var leaders = [String]()
        if let usage {
            let used = state.commands.enumerated().filter { usage.score($0.element.keyword, now) > 0 }.sorted { x, y in
                let a = usage.score(x.element.keyword, now), b = usage.score(y.element.keyword, now)
                return a != b ? a > b : x.offset < y.offset
            }
            for (_, c) in used where leaders.count < recent && (loose(q, c.keyword, true) != nil || !q.isEmpty && loose(q, c.name, false) != nil) {
                leaders.append(c.keyword)
            }
        }
        for (index, c) in state.commands.enumerated() {
            let mk = loose(q, c.keyword, true)
            let mn = q.isEmpty ? nil : loose(q, c.name, false)
            let ms = q.utf16.count < 2 ? nil : Fuzzy.match(q, c.summary, false)
            if mk == nil && mn == nil && ms == nil { continue }
            let section = leaders.contains(where: { Js.same($0, c.keyword) }) ? "recent" : mk != nil || mn != nil ? "commands" : "others"
            let score = Swift.max(mk?.score ?? 0, Swift.max((mn?.score ?? 0) * 8 / 10, (ms?.score ?? 0) / 2))
            let extra = c.inputs.map { $0.required ? $0.name : "[" + $0.name + "]" }.joined(separator: " ")
            let p = pick(c.keyword, ch + c.keyword, ch + c.keyword, tail, section, [])
            let item = Item(key: c.keyword, label: p.label, detail: c.summary.isEmpty ? c.name : c.summary, extra: extra, disabled: false, text: p.text, cursor: p.cursor,
                            section: section, command: c, model: ModelIdentity.of(c),
                            labelHits: mk.map { shift($0.hits, ch.utf16.count) } ?? [], nameHits: mn?.hits ?? [], summaryHits: ms?.hits ?? [])
            found.append(Ranked(item: item, score: score, used: section == "recent" ? usage?.score(c.keyword, now) ?? 0 : 0, index: index))
        }
        let items = ranked(found)
        if !items.isEmpty { return Result(kind: "functions", items: items) }
        return !q.isEmpty || state.enabled == nil ? nil : notice("none")
    }

    /// A match worth offering: one typed letter finds only a start (of the text or a word in it); two or more find anything.
    private static func loose(_ q: String, _ text: String, _ spread: Bool) -> Fuzzy.Match? {
        guard let m = Fuzzy.match(q, text, spread) else { return nil }
        return q.utf16.count == 1 && m.score < Fuzzy.word - 100 ? nil : m
    }

    private static func shift(_ hits: [Range<Int>], _ by: Int) -> [Range<Int>] {
        by == 0 ? hits : hits.map { ($0.lowerBound + by)..<($0.upperBound + by) }
    }

    private static func notice(_ key: String) -> Result {
        Result(kind: "functions", items: [Item(key: key, label: "", detail: "", extra: "", disabled: true, text: nil, cursor: 0)])
    }

    /// Picking replaces the word being typed with "<token> " — the rest of
    /// that word after the cursor goes too, and a space already there is not doubled.
    private static func pick(_ key: String, _ label: String, _ replaced: String, _ tail: String, _ section: String, _ hits: [Range<Int>]) -> Item {
        let t = Array(tail.unicodeScalars)
        var k = 0
        while k < t.count && wordChar(t[k]) { k += 1 }
        var after = String.UnicodeScalarView()
        after.append(contentsOf: t[k...])
        var rest = String(after)
        if let f = rest.utf16.first, Js.isWs(f) { rest = Js.string(Array(rest.utf16.dropFirst())) }
        let head = replaced + " "
        return Item(key: key, label: label, detail: "", extra: "", disabled: false, text: head + rest, cursor: head.utf16.count, section: section, labelHits: hits)
    }
}
