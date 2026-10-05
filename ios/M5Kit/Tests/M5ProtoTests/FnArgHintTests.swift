// 6.11: the hint over the message box while a command's arguments are typed,
// and the suggester's items for a command. android fn/ArgHintTest.

import M5Core
import M5Proto
import Testing

@Suite("fn ArgHint")
struct FnArgHintTests {
    private static let slash = ["/"]

    private static func input(_ name: String, _ type: String, _ required: Bool, _ values: String...) -> Command.Input {
        Command.Input(name: name, type: type, label: "", help: "", required: required, def: nil, values: values)
    }

    static let hlr = Command(keyword: "hlr", name: "Číslo a síť", summary: "Ověří číslo", runtime: "server", visibility: "room", mine: true,
                             inputs: [input("number", "phone", true), input("format", "enum", false, "short", "long"), input("note", "text", false)],
                             icon: "phone", usage: "/hlr +420777123456")
    private static let pair = Command(keyword: "pair", name: "Pair", summary: "", runtime: "server", visibility: "caller", mine: true,
                                      inputs: [input("on", "boolean", false), input("n", "integer", true)])
    static let state = Commands.State(true, [hlr, pair, Command(keyword: "ping", name: "Ping", summary: "", runtime: "server", visibility: "room", mine: true)])

    private func at(_ text: String) -> ArgHint? { ArgHint.of(text, text.utf16.count, Self.slash, Self.state) }

    @Test func onlyOnceTheArgumentsStart() {
        #expect(at("/hlr") == nil)
        #expect(at("/zzz ") == nil)
        #expect(at("hlr +420") == nil)
        #expect(at("/ping ") == nil) // no arguments to hint
        #expect(ArgHint.of("/hlr ", 5, Self.slash, Commands.unknown) == nil)
    }

    @Test func theUsageLineWithTheCurrentOne() throws {
        let h = try #require(at("/hlr "))
        #expect(h.usage == "/hlr <number> [format] [note]")
        #expect(h.spans[0] == 5..<13)
        #expect(h.spans[1] == 14..<22)
        #expect(h.spans[2] == 23..<29)
        #expect(h.current == 0)
        #expect(h.input?.name == "number")
        #expect(h.typed == "")
        #expect(h.values.isEmpty)
        #expect(h.model.icon == "phone")
        #expect(at("/hlr +42")?.current == 0) // still in the first one
        #expect(at("/hlr +42")?.typed == "+42")
    }

    @Test func aChoiceOffersItsValues() throws {
        let h = try #require(at("/hlr +420 "))
        #expect(h.current == 1)
        #expect(h.values == ["short", "long"])
        let s = try #require(at("/hlr +420 s"))
        #expect(s.values == ["short"])
        let p = s.pick("short")
        #expect(p.text == "/hlr +420 short ")
        #expect(p.cursor == 16)
        // The cursor inside a word: picking replaces all of it.
        let mid = try #require(ArgHint.of("/hlr +420 short", 11, Self.slash, Self.state))
        #expect(mid.typed == "s")
        #expect(mid.pick("long").text == "/hlr +420 long ")
        // A value with a space goes in quotes.
        #expect(s.pick("very short").text == "/hlr +420 \"very short\" ")
    }

    @Test func aTrailingTextTakesTheRest() throws {
        let h = try #require(at("/hlr +420 short some text here"))
        #expect(h.current == 2)
        #expect(h.input?.name == "note")
        #expect(h.typed == "here")
    }

    @Test func namedOnes() throws {
        let h = try #require(at("/hlr format=l"))
        #expect(h.current == 1)
        #expect(h.typed == "l")
        #expect(h.values == ["long"])
        #expect(h.pick("long").text == "/hlr format=long ")
        // A named one is given: the bare words fill the others.
        #expect(at("/hlr format=long ")?.current == 0)
        #expect(at("/hlr format=long +420 ")?.current == 2)
    }

    @Test func allGivenAndSwitches() throws {
        #expect(at("/pair ")?.values == ["true", "false"])
        #expect(at("/pair f")?.values == ["false"])
        let done = try #require(at("/pair true 3 "))
        #expect(done.current == -1)
        #expect(done.input == nil)
    }

    @Test func aCommandsItemCarriesItsModelArgumentsAndAudience() throws {
        let it = try #require(Suggestions.suggest("/hl", 3, Commands.defaultComposer, Self.state, [], [])?.items.first)
        #expect(it.label == "/hlr")
        #expect(it.name == "Číslo a síť")
        #expect(it.summary == "Ověří číslo")
        #expect(it.visibility == "room")
        #expect(it.guide == "/hlr +420777123456")
        #expect(it.model?.icon == "phone")
        #expect(it.model?.color == "#7bb234")
        #expect(it.args.count == 3)
        #expect(it.args[0].required)
        #expect(it.args[1].name == "format")
        #expect(it.labelHits == [1..<3]) // "hl" of "/hlr"
        #expect(it.section == "commands")
    }
}
