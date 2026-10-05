// The message box's suggestions (composerSuggestions() in App.tsx; tagsIn()
// of linkify.tsx) — android fn/SuggestionsTest.

import M5Core
import M5Proto
import Testing

@Suite("fn Suggestions")
struct FnSuggestionsTests {
    private let composer = Commands.defaultComposer

    private func state(_ enabled: Bool?, _ commands: Command...) -> Commands.State { Commands.State(enabled, commands) }

    private func cmd(_ keyword: String, _ summary: String, _ inputs: Command.Input...) -> Command {
        Command(keyword: keyword, name: keyword.uppercased(), summary: summary, runtime: "server", visibility: "room", mine: true, inputs: inputs)
    }

    private func labels(_ r: Suggestions.Result?) -> [String] { r?.items.map(\.label) ?? [] }

    private func at(_ text: String, _ s: Commands.State) -> Suggestions.Result? {
        Suggestions.suggest(text, text.utf16.count, composer, s, [], [])
    }

    @Test func commandsByPrefix() throws {
        let s = state(true, cmd("dns", "Looks up a name", fnInput("name", "hostname", true), fnInput("type", "enum", false)), cmd("dice", ""), cmd("help", "Help"))
        let r = try #require(at("/d", s))
        #expect(r.kind == "functions")
        #expect(labels(r) == ["/dns", "/dice"])
        let dns = r.items[0]
        #expect(dns.detail == "Looks up a name")
        #expect(dns.extra == "name [type]")
        #expect(dns.text == "/dns ")
        #expect(dns.cursor == 5)
        #expect(r.items[1].detail == "DICE")
        #expect(at("/", s)?.items.count == 3)
        #expect(labels(at("/HE", s)) == ["/help"])
        // Arguments started: no command list (the words are for the command).
        #expect(at("/dns exa", s) == nil)
        #expect(at("hello", s) == nil)
    }

    @Test func noticesWhenOffOrNothingFits() throws {
        let off = try #require(at("/x", state(false)))
        #expect(off.items[0].disabled)
        #expect(off.items[0].key == "off")
        #expect(at("/", state(true))?.items[0].key == "none")
        #expect(at("/zz", state(true, cmd("dns", ""))) == nil)
        // Not known yet: nothing to say.
        #expect(at("/", Commands.unknown) == nil)
    }

    @Test func atMostEight() {
        let many = (0..<12).map { cmd("c\($0)", "") }
        #expect(at("/c", Commands.State(true, many))?.items.count == 8)
    }

    @Test func mentions() throws {
        let names = ["Anna Kovářová", "anton", "Bob", "", "Anna  Kovářová"]
        let r = try #require(Suggestions.suggest("hi @an", 6, composer, Commands.unknown, names, []))
        #expect(r.kind == "mentions")
        #expect(labels(r) == ["@Anna_Kovářová", "@anton"])
        #expect(r.items[0].text == "hi @Anna_Kovářová ")
        #expect(Suggestions.suggest("hi @zz", 6, composer, Commands.unknown, names, []) == nil)
        // The cursor inside the text: the word is replaced, what follows stays.
        let mid = try #require(Suggestions.suggest("hi @an and more", 6, composer, Commands.unknown, names, []))
        #expect(mid.items[0].text == "hi @Anna_Kovářová and more")
        #expect(mid.items[0].cursor == "hi @Anna_Kovářová ".utf16.count)
        let inWord = try #require(Suggestions.suggest("hi @anXYZ!", 6, composer, Commands.unknown, names, []))
        #expect(inWord.items[1].text == "hi @anton !")
    }

    @Test func tags() throws {
        let c = Commands.Composer(composer.triggers, ["urgent", "release"])
        let recent = ["Hotovo #Release. A #release-notes", "#ops", "nic"]
        let r = try #require(Suggestions.suggest("see #re", 7, c, Commands.unknown, [], recent))
        #expect(r.kind == "tags")
        #expect(labels(r) == ["#release", "#release-notes"])
        // The tag already typed in full is not offered again.
        #expect(labels(Suggestions.suggest("#release", 8, c, Commands.unknown, [], recent)) == ["#release-notes"])
        #expect(labels(Suggestions.suggest("#", 1, c, Commands.unknown, [], recent)) == ["#urgent", "#release", "#release-notes", "#ops"])
        // Only at the start of a word; an unknown character offers nothing.
        #expect(Suggestions.suggest("a#re", 4, c, Commands.unknown, [], recent) == nil)
        #expect(Suggestions.suggest("~re", 3, c, Commands.unknown, [], recent) == nil)
    }

    @Test func tagsOfAMessage() {
        #expect(Suggestions.tagsIn("Hotovo #Release. A #release-notes a #v5.2 — http://x.test/#frag, (#ops)") == ["release", "release-notes", "v5.2", "ops"])
        #expect(!Suggestions.tagsIn("#foo-bar").contains("foo"))
        #expect(Suggestions.tagsIn("no tags # here") == [])
    }

    @Test func theOperatorsCharacters() {
        let bang = Commands.Composer([Commands.Trigger("!", "functions"), Commands.Trigger("+", "mentions")], [])
        let s = state(true, cmd("dns", ""))
        #expect(labels(Suggestions.suggest("!d", 2, bang, s, [], [])) == ["!dns"])
        #expect(Suggestions.suggest("!d", 2, bang, s, [], [])?.items[0].text == "!dns ")
        #expect(Suggestions.suggest("/d", 2, bang, s, [], []) == nil)
        #expect(labels(Suggestions.suggest("x +e", 4, bang, s, ["eva"], [])) == ["+eva"])
        #expect(Suggestions.suggest("x @e", 4, bang, s, ["eva"], []) == nil)
    }
}
