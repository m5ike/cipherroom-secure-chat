// 6.11: the suggester's matching, how good each kind of match is, where it
// matched — and the frequent / recent ranking. android fn/FuzzyTest.

import M5Core
import M5Proto
import Testing

@Suite("fn Fuzzy and Usage")
struct FnFuzzyTests {
    @Test func bestFirst() throws {
        #expect(Fuzzy.match("dns", "dns", true)?.score == Fuzzy.exact)
        #expect(Fuzzy.match("dn", "dns", true)?.score == Fuzzy.prefix)
        let look = try #require(Fuzzy.match("look", "phone-lookup", true))
        #expect(look.score < Fuzzy.prefix)
        #expect(look.score > Fuzzy.inside)
        #expect(try #require(Fuzzy.match("ook", "phone-lookup", true)).score <= Fuzzy.inside)
        let pl = try #require(Fuzzy.match("pl", "phone-lookup", true))
        #expect(pl.score <= Fuzzy.spread)
        #expect(pl.score > 0)
    }

    @Test func whereItMatched() {
        #expect(Fuzzy.match("DN", "dns", true)?.hits == [0..<2])
        #expect(Fuzzy.match("look", "phone-lookup", true)?.hits == [6..<10])
        #expect(Fuzzy.match("pl", "phone-lookup", true)?.hits == [0..<1, 6..<7])
        #expect(Fuzzy.match("phl", "phone-lookup", true)?.hits == [0..<2, 6..<7])
        #expect(Fuzzy.match("", "anything", false)?.hits.count == 0)
    }

    @Test func noCaseNoDiacritics() {
        #expect(Fuzzy.match("pocasi", "Počasí v Brně", false)?.score == Fuzzy.prefix)
        #expect(Fuzzy.match("brne", "Počasí v Brně", false)?.hits == [9..<13])
        #expect(Fuzzy.match("ŽLUŤ", "zlut", false)?.score == Fuzzy.exact)
    }

    @Test func lettersApartOnlyForKeywordsAndFromAWordStart() {
        #expect(Fuzzy.match("pl", "phone-lookup", false) == nil)
        #expect(Fuzzy.match("hl", "phone-lookup", true) == nil) // "h" starts no word
        #expect(Fuzzy.match("zz", "dns", true) == nil)
        #expect(Fuzzy.match("x", "", true) == nil)
    }

    @Test func theUsedOnesLeadTheMostAndTheLatestFirst() throws {
        let now = 100 * Usage.day
        let u = Usage()
        #expect(u.score("dns", now) == 0)
        u.used("dns", now - 40 * Usage.day)
        u.used("hlr", now - 10_000)
        #expect(u.score("hlr", now) > u.score("dns", now))
        for _ in 0..<30 { u.used("dns", now - 2 * Usage.day) }
        #expect(u.score("dns", now) > u.score("hlr", now))
        #expect(u.count("dns") == 31)
        // Through its JSON (the vault keeps it).
        let back = Usage.from(JSON.parseObject(u.toJson().stringify()))
        #expect(back.score("dns", now) == u.score("dns", now))
        #expect(back.count("hlr") == 1)
        // At most KEEP keywords — the latest stay.
        let many = Usage()
        for i in 0..<(Usage.keep + 10) { many.used("k\(i)", Int64(i + 1)) }
        #expect(many.toJson().count == Usage.keep)
        #expect(many.count("k0") == 0)
        #expect(many.count("k\(Usage.keep + 9)") == 1)
        #expect(Usage.from(JSONObject([("x", "junk")])).toJson().count == 0)
    }

    @Test func theListOrderedByUseThenMatch() throws {
        let now = 10 * Usage.day
        let u = Usage()
        u.used("dice", now - 1000)
        let dns = Command(keyword: "dns", name: "DNS lookup", summary: "Looks up a domain name", runtime: "server", visibility: "room", mine: true)
        let dice = Command(keyword: "dice", name: "Dice", summary: "Throws a die", runtime: "server", visibility: "caller", mine: true)
        let help = Command(keyword: "help", name: "Help", summary: "Every command and how to use it", runtime: "server", visibility: "caller", mine: true)
        let s = Commands.State(true, [dns, dice, help])
        let r = try #require(Suggestions.suggest("/d", 2, Commands.defaultComposer, s, [], [], usage: u, now: now))
        let items = r.items
        #expect(items[0].label == "/dice")
        #expect(items[0].section == "recent")
        #expect(items[1].label == "/dns")
        #expect(items[1].section == "commands")
        #expect(items.count == 2)
        // Found by its summary only: another section, after the keyword and name matches.
        let byText = try #require(Suggestions.suggest("/domain", 7, Commands.defaultComposer, s, [], [], usage: u, now: now))
        #expect(byText.items[0].label == "/dns")
        #expect(byText.items[0].section == "others")
        #expect(byText.items[0].summaryHits == [11..<17])
        // The name's words count too ("look" → "DNS lookup").
        let look = try #require(Suggestions.suggest("/look", 5, Commands.defaultComposer, s, [], [], usage: u, now: now)?.items.first)
        #expect(look.label == "/dns")
        #expect(look.nameHits == [4..<8])
        // With nothing typed: the used one first, then the server's order.
        let all = try #require(Suggestions.suggest("/", 1, Commands.defaultComposer, s, [], [], usage: u, now: now))
        #expect(all.items.prefix(3).map(\.label) == ["/dice", "/dns", "/help"])
    }
}
