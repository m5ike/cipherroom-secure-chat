// The command line and the composer's characters — android fn/CommandsTest
// (the cases of test/functions-lib.test.ts and test/composer.test.tsx).

import M5Core
import M5Proto
import Testing

/// A command "check" with these inputs.
func fnCommand(_ inputs: Command.Input...) -> Command {
    Command(keyword: "check", name: "Check", summary: "", runtime: "server", visibility: "room", mine: true, inputs: inputs)
}

/// An input without label, help, default or values.
func fnInput(_ name: String, _ type: String, _ required: Bool) -> Command.Input {
    Command.Input(name: name, type: type, required: required)
}

@Suite("fn Commands")
struct FnCommandsTests {
    private let slash = ["/"]

    private func parsed(_ text: String, _ chars: [String], _ keyword: String, _ args: String, sourceLocation: SourceLocation = #_sourceLocation) {
        let p = Commands.parseCommandLine(text, chars)
        #expect(p?.keyword == keyword, "\(text)", sourceLocation: sourceLocation)
        #expect(p?.argText == args, "\(text)", sourceLocation: sourceLocation)
    }

    @Test func recognisesACommandAndItsArguments() {
        parsed("/pocasi Brno", slash, "pocasi", "Brno")
        parsed("  /ping  ", slash, "ping", "")
        parsed("/check a=1 b=2", slash, "check", "a=1 b=2")
        parsed("/DNS  example.com\n type=MX ", slash, "dns", "example.com\n type=MX")
        // JavaScript's white space: a no-break space separates too.
        parsed("/dns\u{00A0}example.com", slash, "dns", "example.com")
    }

    @Test func plainTextOrABareSlashIsNoCommand() {
        #expect(Commands.parseCommandLine("hello", slash) == nil)
        #expect(Commands.parseCommandLine("/", slash) == nil)
        #expect(Commands.parseCommandLine("http://x/y", slash) == nil)
        #expect(Commands.parseCommandLine("hello /dns", slash) == nil)
        #expect(Commands.parseCommandLine("/" + String(repeating: "a", count: 41), slash) == nil)
    }

    @Test func anyCommandCharacterStartsOne() {
        parsed("!dns example.com", ["/", "!"], "dns", "example.com")
        #expect(Commands.parseCommandLine("!dns example.com", slash) == nil)
    }

    @Test func keyValuePairsAndPositionalInputs() {
        let c = fnCommand(fnInput("domain", "hostname", true), fnInput("port", "integer", false), fnInput("depth", "enum", false))
        let a = Commands.buildInputs(c, "example.org depth=full")
        #expect(a.count == 2)
        #expect(a.optString("domain") == "example.org")
        #expect(a.optString("depth") == "full")
        let b = Commands.buildInputs(c, "example.org 8443")
        #expect(b.count == 2)
        #expect(b.optString("port") == "8443")
        // An unknown key=value is a bare token; a known one wins over its position.
        let d = Commands.buildInputs(c, "x=1 port=80 example.org")
        #expect(d.optString("domain") == "x=1")
        #expect(d.optString("port") == "80")
        #expect(d.optString("depth") == "example.org")
    }

    @Test func aTrailingTextFieldTakesTheRest() {
        let c = fnCommand(fnInput("to", "string", true), fnInput("message", "text", true))
        let a = Commands.buildInputs(c, "alice \"hello there\" friend")
        #expect(a.optString("to") == "alice")
        #expect(a.optString("message") == "hello there friend")
    }

    @Test func quotesAndChatTypeableInputs() {
        #expect(Commands.buildInputs(fnCommand(fnInput("title", "string", true)), "\"a b c\"").optString("title") == "a b c")
        #expect(Commands.buildInputs(fnCommand(fnInput("title", "string", true)), "'it''s'").optString("title") == "it s")
        #expect(Commands.tokenize("'a b' \"\" c") == ["a b", "", "c"])
        // A user, a file or a secret is never filled by position.
        let v = Commands.buildInputs(fnCommand(fnInput("who", "user", true), fnInput("note", "text", false)), "hello world")
        #expect(!v.has("who"))
        #expect(v.optString("note") == "hello world")
        #expect(Commands.buildInputs(fnCommand(fnInput("who", "user", true)), "who=bob").optString("who") == "bob")
    }

    @Test func composerDefaultsAndTheOperatorsCharacters() {
        #expect(Commands.composerFrom(nil) == Commands.defaultComposer)
        #expect(Commands.defaultComposer.commandChars == ["/"])
        let c = Commands.composerFrom(.object(fnObj("{\"triggers\":[{\"char\":\"!\",\"action\":\"functions\"},{\"char\":\"!\",\"action\":\"tags\"},"
            + "{\"char\":\"a\",\"action\":\"tags\"},{\"char\":\" \",\"action\":\"tags\"},{\"char\":\"@\",\"action\":\"mentions\"},{\"char\":\"~\",\"action\":\"nope\"}],"
            + "\"tags\":[\"#Urgent\",\"meeting\",\"bad tag!\",\"meeting\"]}")))
        #expect(c.triggers.map { $0.ch + $0.action } == ["!functions", "@mentions"])
        #expect(c.tags == ["urgent", "meeting"])
        // Triggers the operator removed stay removed.
        #expect(Commands.composerFrom(.object(fnObj("{\"triggers\":[]}"))).triggers.isEmpty)
        // (beyond the Android test) the client-config answer, with or without its "config" wrapper.
        #expect(Commands.composer(fromClientConfig: fnObj("{\"config\":{\"composer\":{\"triggers\":[{\"char\":\"!\",\"action\":\"functions\"}]}}}")).commandChars == ["!"])
        #expect(Commands.composer(fromClientConfig: fnObj("{\"composer\":[]}")).triggers.isEmpty)
        #expect(Commands.composer(fromClientConfig: fnObj("{}")) == Commands.defaultComposer)
    }

    @Test func whatAMessageAnswers() {
        #expect(!Commands.answers(fnObj("{\"keyword\":\"k\"}"), "button"))
        #expect(Commands.answers(fnObj("{\"chain\":\"chn_1\"}"), "button"))
        #expect(Commands.answers(fnObj("{\"chain\":\"chn_1\",\"events\":[\"form\"]}"), "form"))
        #expect(!Commands.answers(fnObj("{\"chain\":\"chn_1\",\"events\":[\"form\"]}"), "button"))
        let click = Commands.button("go", .object(fnObj("{\"n\":2}")))
        #expect(Js.stringify(.object(click)).utf16.count == "{\"type\":\"button\",\"name\":\"go\",\"data\":{\"n\":2}}".utf16.count)
        #expect(!Commands.button("go", nil).has("data"))
        #expect(Commands.response("hi", "quoted").object("message")?.string("text") == "quoted")
    }

    /// (beyond the Android test) the commands' answer as the state keeps it.
    @Test func theServersCommandList() {
        let on = Commands.State.from(fnObj("{\"enabled\":true,\"commands\":[{\"keyword\":\"dns\"},{\"name\":\"no keyword\"},5]}"))
        #expect(on.enabled == true)
        #expect(on.commands.map(\.keyword) == ["dns"])
        #expect(on.find("dns")?.visibility == "room")
        let off = Commands.State.from(fnObj("{\"enabled\":false,\"commands\":[{\"keyword\":\"dns\"}]}"))
        #expect(off == Commands.off)
    }
}
