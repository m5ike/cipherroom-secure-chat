// Ports of android/app/src/test/java/cz/m5cet/app/fn/MarkdownTreeTest.java (the
// cases of test/markdown.test.tsx) and ui/bubble/ModelFaceTest.java (a model's
// answer drawn under the model's identity — here only, mine to the room, a peer's).

import M5Core
import M5Proto
import XCTest
@testable import M5cet

final class FnMarkdownTreeTests: XCTestCase {
    func testBlocks() {
        let md = ["# Nadpis", "", "Odstavec s **tučným**, *kurzívou* a `kódem`.", "Druhý řádek.", "",
                  "- jedna", "- dvě", "  - vnořená", "", "3. tři", "4. čtyři", "", "```ts", "const x = 1;", "```", "", "> citace", "", "---", "",
                  "| a | b |", "|---|:-:|", "| 1 | 2 |"].joined(separator: "\n")
        let blocks = FnMarkdownTree.parse(md)
        XCTAssertEqual(blocks.map(\.t), ["h", "p", "list", "list", "code", "quote", "hr", "table"])
        XCTAssertEqual(blocks[0].description, "h1[text(Nadpis)]")
        XCTAssertEqual(blocks[1].description, "p[text(Odstavec s ), strong[text(tučným)], text(, ), em[text(kurzívou)], text( a ), code(kódem), text(.), br, text(Druhý řádek.)]")
        XCTAssertEqual(blocks[2].description, "ul[[p[text(jedna)]], [p[text(dvě)], ul[[p[text(vnořená)]]]]]")
        XCTAssertEqual(blocks[3].description, "ol3[[p[text(tři)]], [p[text(čtyři)]]]")
        XCTAssertEqual(blocks[4].description, "code(ts)(const x = 1;)")
        XCTAssertEqual(blocks[5].description, "quote[p[text(citace)]]")
        XCTAssertEqual(blocks[7].description, "table[[text(a)], [text(b)]][[[text(1)], [text(2)]]]")
    }

    private func inline(_ src: String, _ expected: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(FnMarkdownTree.list(FnMarkdownTree.parseInline(src)), expected, src, file: file, line: line)
    }

    func testInlineMarks() {
        inline("a `**not bold**` b", "[text(a ), code(**not bold**), text( b)]")
        inline("~~staré~~ __nové__ _jemně_", "[del[text(staré)], text( ), strong[text(nové)], text( ), em[text(jemně)]]")
        inline("some_snake_case_name", "[text(some_snake_case_name)]")
        inline("viz https://example.org/a_(b). Konec", "[text(viz ), link(https://example.org/a_(b))[text(https://example.org/a_(b))], text(. Konec)]")
        inline("\\*ne\\*", "[text(*ne*)]")
        inline("[M5cet](https://chat.fir.ma \"titulek\")", "[link(https://chat.fir.ma)[text(M5cet)]]")
        inline("`` a`b ``", "[code(a`b)]")
        inline("<https://x.cz/a> a <b>", "[link(https://x.cz/a)[text(https://x.cz/a)], text( a <b>)]")
        inline("ahttps://x.cz", "[text(ahttps://x.cz)]")
    }

    func testHalfWrittenAnswers() {
        XCTAssertEqual(FnMarkdownTree.list(FnMarkdownTree.parse("Tady:\n```py\nprint(1)\nprint(2")), "[p[text(Tady:)], code(py)(print(1)\nprint(2)]")
        XCTAssertEqual(FnMarkdownTree.list(FnMarkdownTree.parse("**nedokonč")), "[p[text(**nedokonč)]]")
        XCTAssertEqual(FnMarkdownTree.list(FnMarkdownTree.parse("a\r\nb")), "[p[text(a), br, text(b)]]")
    }

    func testLinksOnlyToWebAndMail() {
        XCTAssertNil(FnMarkdownTree.safeHref("javascript:alert(1)"))
        XCTAssertNil(FnMarkdownTree.safeHref(" JAVASCRIPT:alert(1)"))
        XCTAssertNil(FnMarkdownTree.safeHref("data:text/html,<b>x</b>"))
        XCTAssertNil(FnMarkdownTree.safeHref("vbscript:x"))
        XCTAssertNil(FnMarkdownTree.safeHref("//evil.example"))
        XCTAssertEqual(FnMarkdownTree.safeHref("https://ok.example/a?b=1"), "https://ok.example/a?b=1")
        XCTAssertEqual(FnMarkdownTree.safeHref("mailto:a@b.cz"), "mailto:a@b.cz")
        inline("[klikni](javascript:alert(1))", "[text(klikni), text())]")
    }

    func testRulesAndTableRowsWrittenOut() {
        XCTAssertTrue(FnMarkdownTree.isRule("---"))
        XCTAssertTrue(FnMarkdownTree.isRule("   * * *  "))
        XCTAssertTrue(!FnMarkdownTree.isRule("    ---") && !FnMarkdownTree.isRule("--") && !FnMarkdownTree.isRule("-*-"))
        XCTAssertTrue(FnMarkdownTree.isTableSeparator("|---|:-:|"))
        XCTAssertTrue(FnMarkdownTree.isTableSeparator(" :--- | ---: "))
        XCTAssertTrue(FnMarkdownTree.isTableSeparator("|-|"))
        XCTAssertTrue(!FnMarkdownTree.isTableSeparator("|a|") && !FnMarkdownTree.isTableSeparator("| : - |") && !FnMarkdownTree.isTableSeparator("||"))
        XCTAssertTrue(FnMarkdownTree.isTableSeparator(String(repeating: "|-", count: 100_000)))
    }

    func testDeepNestingAndHugeInputEnd() {
        _ = FnMarkdownTree.parse(String(repeating: "> ", count: 200) + "x")
        let stars = String(repeating: "*", count: 20_000)
        let started = Date()
        _ = FnMarkdownTree.parse(stars + " x " + stars)
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
    }

    func testTablesAsMonospaceColumns() {
        XCTAssertEqual(FnMarkdownTree.gridLines([["a", "bb"], ["ccc", "d"], ["e"]]), ["a   │ bb", "────┼───", "ccc │ d", "e   │ "])
        XCTAssertEqual(FnMarkdownTree.Inline.text("a b").description, "text(a b)")
        XCTAssertEqual(FnMarkdownTree.plain(FnMarkdownTree.parseInline("a\nb")), "a b")
    }
}

final class FnModelFaceTests: XCTestCase {
    private static func tr(_ k: String) -> String { k == "fnm.via" ? "via {name}" : "[" + k + "]" }
    private static let appIcons: Set<String> = ["mail", "phone", "phone-outgoing", "globe", "bot", "cloud", "hash", "circle-question-mark"]
    private static func has(_ n: String) -> Bool { appIcons.contains(n) }

    private func msg(_ id: String, _ sender: String, _ at: Int64 = 1) -> ChatMessage {
        var m = ChatMessage()
        m.id = id
        m.roomKey = "r"
        m.senderId = sender
        m.senderName = sender
        m.text = "x"
        m.createdAt = at
        return m
    }

    /// A caller-only answer as the room's addModelAnswer makes it.
    private func answer(_ id: String, _ keyword: String) -> ChatMessage {
        var m = msg(id, ModelIdentity.systemMessengerId)
        m.model = ModelIdentity.of(keyword, keyword.uppercased(), nil).toJson()
        m.senderName = keyword.uppercased()
        return m
    }

    private func call(_ id: String) -> ChatMessage {
        var m = msg(id, "me")
        m.mine = true
        m.fnLocal = JSONObject([("keyword", "mail"), ("name", "Mail"), ("query", "/mail"), ("pending", true)])
        return m
    }

    func testWhichMessagesAreAModelsAnswer() {
        let here = answer("a1", "mail")
        XCTAssertEqual(FnModelFace.of(here)?.keyword, "mail")
        XCTAssertTrue(FnModelFace.local(here))
        var mine = msg("m1", "me")
        mine.mine = true
        mine.fn = JSONObject([("keyword", "hlr"), ("name", "HLR"), ("icon", "phone")])
        XCTAssertEqual(FnModelFace.of(mine)?.icon, "phone")
        XCTAssertFalse(FnModelFace.local(mine))
        var peer = msg("p1", "peer-1")
        peer.senderName = "Alice"
        peer.fn = JSONObject([("keyword", "hlr"), ("name", "HLR")])
        XCTAssertEqual(FnModelFace.of(peer)?.name, "HLR")
        var old = msg("o1", "function:dns")
        old.senderName = "DNS"
        XCTAssertEqual(FnModelFace.of(old)?.keyword, "dns")
        XCTAssertNil(FnModelFace.of(call("c1")))
        XCTAssertNil(FnModelFace.of(msg("t1", "peer-1")))
        XCTAssertNil(FnModelFace.of(ChatMessage.system(roomKey: "r", text: "hello", now: 1)))
    }

    func testTheLineSaysHowItCame() {
        XCTAssertEqual(FnModelFace.scope(answer("a1", "mail"), tr: Self.tr, has: Self.has)?.optString("line"), "/mail · [fnm.onlyYou]")
        var mine = msg("m1", "me")
        mine.mine = true
        mine.fn = JSONObject([("keyword", "hlr"), ("name", "HLR")])
        let s = FnModelFace.scope(mine, tr: Self.tr, has: Self.has)
        XCTAssertEqual(s?.optString("line"), "/hlr · [fnm.viaYou]")
        XCTAssertEqual(s?["mine"], .bool(true))
        var peer = msg("p1", "peer-1")
        peer.senderName = "Alice"
        peer.fn = JSONObject([("keyword", "hlr"), ("name", "HLR"), ("icon", "🦊")])
        let p = FnModelFace.scope(peer, tr: Self.tr, has: Self.has)
        XCTAssertEqual(p?.optString("line"), "/hlr · via Alice")
        XCTAssertEqual(p?.optString("via"), "Alice")
        XCTAssertEqual(p?.optString("name"), "HLR")
        XCTAssertEqual(p?["emoji"], .bool(true))
        XCTAssertEqual(p?.optString("glyph"), "")
        XCTAssertEqual(p?.optString("color"), "#7bb234")
        XCTAssertNil(FnModelFace.scope(msg("t1", "peer-1"), tr: Self.tr, has: Self.has))
        var card = answer("e1", "mail")
        card.fn = JSONObject([("keyword", "mail"), ("problem", true)])
        XCTAssertEqual(FnModelFace.scope(card, tr: Self.tr, has: Self.has)?["error"], .bool(true))
    }

    func testTheIconTheAppDraws() {
        XCTAssertEqual(FnModelFace.glyph(ModelIdentity.of("mail", "", nil), has: Self.has), "mail")
        XCTAssertEqual(FnModelFace.glyph(ModelIdentity.of("call", "", nil), has: Self.has), "phone-outgoing")
        XCTAssertEqual(FnModelFace.glyph(ModelIdentity.of("weather", "", nil), has: Self.has), "cloud")
        XCTAssertEqual(FnModelFace.glyph(ModelIdentity.of("help", "", nil), has: Self.has), "circle-question-mark")
        XCTAssertEqual(FnModelFace.glyph(ModelIdentity.of("mail", "", "envelope-open"), has: Self.has), "mail")
        XCTAssertEqual(FnModelFace.glyph(ModelIdentity.of("zz", "", "globe-lock"), has: Self.has), "globe")
        XCTAssertEqual(FnModelFace.glyph(ModelIdentity.of("zz", "", "rocket"), has: Self.has), "bot")
        XCTAssertEqual(FnModelFace.glyph(ModelIdentity.of("zz", "", "🚀"), has: Self.has), "")
    }

    func testAModelsAnswersAreTheirOwnRun() {
        XCTAssertNil(FnModelFace.runKey(call("c1")))
        XCTAssertEqual(FnModelFace.runKey(answer("a1", "mail")), "model:mail:")
        var mine = msg("m1", "me")
        mine.mine = true
        mine.fn = JSONObject([("keyword", "DNS"), ("name", "DNS")])
        XCTAssertEqual(FnModelFace.runKey(mine), "model:dns:me")
        var peer = msg("p1", "peer-1")
        peer.fn = JSONObject([("keyword", "dns")])
        XCTAssertEqual(FnModelFace.runKey(peer), "model:dns:peer-1")
    }

    @MainActor
    func testTheAppsIconSet() {
        XCTAssertTrue(FnModelFace.appHas("bot"))
        XCTAssertTrue(FnModelFace.appHas("mail"))
        XCTAssertFalse(FnModelFace.appHas("no-such-icon-anywhere"))
    }
}
