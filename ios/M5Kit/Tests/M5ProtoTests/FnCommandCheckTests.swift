// 6.11: a command's usage line and the check of a call before it goes —
// android fn/CommandCheckTest, the vectors of system-messenger-vectors.json
// (test/android-fn-611.test.ts checks the TypeScript against the same).

import M5Core
import M5Proto
import Testing

@Suite("fn CommandCheck")
struct FnCommandCheckTests {
    private static func tr(_ key: String) -> String { "[" + key + "]" }

    static func vectors() throws -> JSONObject { try FnRepo.fnVectors("system-messenger-vectors.json") }

    /// A command as the server's JSON describes it (Command.from), keyword "x" when it has none.
    static func command(_ o: JSONObject?) throws -> Command {
        var c = o ?? JSONObject()
        if !c.has("keyword") { c["keyword"] = "x" }
        return try #require(Command.from(c))
    }

    private func problems(_ c: Command, _ values: JSONObject?) -> [String] {
        CommandCheck.check(c, values).map { $0.input + "|" + $0.label + "|" + $0.problem + "|" + $0.expected }
    }

    private func expected(_ a: [JSON]?) -> [String] {
        (a ?? []).compactMap(\.objectValue).map { p in
            p.optString("input") + "|" + p.optString("label") + "|" + p.optString("problem") + "|" + p.optString("expected")
        }
    }

    @Test func theUsageLine() throws {
        let v = try Self.vectors()
        let c = try Self.command(v.object("command"))
        #expect(CommandCheck.usage(c) == v.object("usage")?.string("/"))
        #expect(CommandCheck.usage(c, "!") == v.object("usage")?.string("!"))
        // A required input with a default is optional in the line.
        #expect(CommandCheck.arg(c.inputs[2]) == "[n]")
    }

    @Test func whatEachInputExpects() throws {
        let v = try Self.vectors()
        let c = try Self.command(v.object("command"))
        let exp = try #require(v.array("expectations"))
        for (i, input) in c.inputs.enumerated() { #expect(CommandCheck.expectation(input) == exp[i].stringValue, "\(input.name)") }
        for m in v.array("moreExpectations") ?? [] {
            let one = try Self.command(JSONObject([("inputs", .array([.object(m["input"]?.objectValue ?? JSONObject())]))]))
            #expect(CommandCheck.expectation(one.inputs[0]) == m["out"]?.stringValue)
        }
    }

    @Test func theChecksOfTheWeb() throws {
        let v = try Self.vectors()
        let c = try Self.command(v.object("command"))
        let cases = try #require(v.array("checks"))
        #expect(cases.count == 6)
        for k in cases {
            let values = k["values"]?.objectValue
            #expect(problems(c, values) == expected(k["out"]?.arrayValue), "\(values?.stringify() ?? "")")
        }
        let bad = try #require(v.object("badPattern"))
        #expect(problems(try Self.command(bad), bad.object("values")) == expected(bad.array("out")))
    }

    @Test func anEmptyCallOfAModelWithOnlyOptionalInputsGoes() throws {
        let c = try Self.command(JSONObject([("inputs", [["name": "to", "type": "email", "required": false], ["name": "n", "type": "integer", "required": true, "default": 2]])]))
        #expect(problems(c, JSONObject()) == [])
        // "/mail" without its required address: missing — the call never goes.
        let mail = try Self.command(JSONObject([("keyword", "mail"), ("inputs", [["name": "to", "type": "email", "required": true]])]))
        #expect(problems(mail, Commands.buildInputs(mail, "")) == ["to|to|missing|a email"])
        #expect(problems(mail, Commands.buildInputs(mail, "a@b.cz")) == [])
    }

    @Test func anOlderServerWithoutTheNewFields() throws {
        let c = try #require(Command.from(JSONObject([("keyword", "dns"), ("inputs", [["name": "name", "type": "hostname", "required": true]])])))
        #expect(c.icon == nil)
        #expect(c.usage == "")
        #expect(c.inputs[0].pattern == nil)
        #expect(c.inputs[0].min == nil)
        let n = try #require(Command.from(JSONObject([("keyword", "dns"), ("icon", "globe"), ("usage", "/dns example.org"),
                                                     ("inputs", [["name": "n", "type": "number", "min": 1, "max": "x"]])])))
        #expect(n.icon == "globe")
        #expect(n.usage == "/dns example.org")
        #expect(n.inputs[0].min == 1.0)
        #expect(n.inputs[0].max == nil)
    }

    @Test func translatedExpectations() throws {
        let c = try Self.command(try Self.vectors().object("command"))
        #expect(CommandCheck.expectation(c.inputs[0], Self.tr) == "[fnm.expect.phone]")
        #expect(CommandCheck.expectation(c.inputs[1], Self.tr) == "[fnm.expect.values]")
        #expect(CommandCheck.expectation(c.inputs[2], Self.tr) == "[fnm.expect.integer] 1–10")
        #expect(CommandCheck.expectation(c.inputs[5], Self.tr) == "[fnm.expect.number] 0.5–…")
        let cs: CommandCheck.Tr = { $0 == "fnm.expect.values" ? "jedna z: {values}" : $0 }
        #expect(CommandCheck.expectation(c.inputs[1], cs) == "jedna z: short, long")
    }

    @Test func theErrorCard() throws {
        let spec = try #require(try Self.vectors().object("command")).with("usage", "/hlr +420777123456")
        let c = try Self.command(spec)
        let card = CommandCheck.card(c, "/", CommandCheck.check(c, JSONObject()), nil, Self.tr)
        #expect(card[0]["type"] == "markdown")
        #expect(card[0]["text"]?.stringValue?.contains("**number**: [fnm.problem.missing]") == true)
        #expect(card[1]["type"] == "code")
        #expect(card[1]["text"] == "/hlr <number> [format] [n] [flag] [code] [x]")
        let table = try #require(card[2].objectValue)
        #expect(table["type"] == "table")
        #expect(table.array("rows")?.count == 6)
        #expect(table.array("rows")?[2][1]?.stringValue?.contains("[fnm.default]") == true)
        #expect(card[3]["text"]?.stringValue?.contains("/hlr +420777123456") == true)
        // The server's refusal instead of the problems.
        let refused = CommandCheck.card(c, "/", [], "input 'number' is required", Self.tr)
        #expect(refused[0]["text"] == "[fnm.error.server]")
        // Its Markdown is the message's text.
        #expect(Outputs.toMarkdown(card).contains("```\n/hlr <number>"))
    }
}
