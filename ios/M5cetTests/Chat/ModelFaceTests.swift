// Port of android/app/src/test/java/cz/m5cet/app/ui/bubble/ModelFaceTest.java (6.11): a model's
// answer drawn as an incoming message under the model's identity — here only, mine to the room,
// a peer's — and its runs.

import M5Core
import M5Proto
import XCTest
@testable import M5cet

@MainActor
final class ModelFaceTests: XCTestCase {
    private let tr: (String) -> String = { $0 == "fnm.via" ? "via {name}" : "[" + $0 + "]" }
    private let appIcons: Set<String> = ["mail", "phone", "phone-outgoing", "globe", "bot", "cloud", "hash", "circle-question-mark"]
    private var has: (String) -> Bool { { [appIcons] in appIcons.contains($0) } }

    private func msg(_ id: String, _ sender: String, _ at: Int64) -> ChatMessage {
        var m = ChatMessage()
        m.id = id
        m.roomKey = "r"
        m.senderId = sender
        m.senderName = sender
        m.text = "x"
        m.createdAt = at
        return m
    }

    /// A caller-only answer as RoomSession.addModelAnswer makes it.
    private func answer(_ id: String, _ keyword: String, _ at: Int64) -> ChatMessage {
        var m = msg(id, ModelIdentity.systemMessengerId, at)
        m.model = ModelIdentity.of(keyword, keyword.uppercased(), nil).toJson()
        m.senderName = keyword.uppercased()
        return m
    }

    private func call(_ id: String, _ at: Int64) -> ChatMessage {
        var m = msg(id, "me", at)
        m.mine = true
        m.fnLocal = JSONObject([("keyword", "mail"), ("name", "Mail"), ("query", "/mail"), ("pending", true)])
        return m
    }

    func testWhichMessagesAreAModelsAnswer() {
        let here = answer("a1", "mail", 1)
        XCTAssertEqual(BubbleModelFace.of(here)?.keyword, "mail")
        XCTAssertTrue(BubbleModelFace.local(here))
        // My room answer: mine, flags.fn without a query.
        var mine = msg("m1", "me", 1)
        mine.mine = true
        mine.fn = JSONObject([("keyword", "hlr"), ("name", "HLR"), ("icon", "phone")])
        XCTAssertEqual(BubbleModelFace.of(mine)?.icon, "phone")
        XCTAssertFalse(BubbleModelFace.local(mine))
        // A peer's room answer.
        var peer = msg("p1", "peer-1", 1)
        peer.senderName = "Alice"
        peer.fn = JSONObject([("keyword", "hlr"), ("name", "HLR")])
        XCTAssertEqual(BubbleModelFace.of(peer)?.name, "HLR")
        // An older caller-only answer (6.5 "function:<keyword>").
        var old = msg("o1", "function:dns", 1)
        old.senderName = "DNS"
        XCTAssertEqual(BubbleModelFace.of(old)?.keyword, "dns")
        // A command's own bubble, a person's message, a notice: no.
        XCTAssertNil(BubbleModelFace.of(call("c1", 1)))
        XCTAssertNil(BubbleModelFace.of(msg("t1", "peer-1", 1)))
        XCTAssertNil(BubbleModelFace.of(ChatMessage.system(roomKey: "r", text: "hello", now: 1)))
    }

    func testTheLineSaysHowItCame() throws {
        XCTAssertEqual(BubbleModelFace.scope(answer("a1", "mail", 1), tr, has)?.optString("line"), "/mail · [fnm.onlyYou]")
        var mine = msg("m1", "me", 1)
        mine.mine = true
        mine.fn = JSONObject([("keyword", "hlr"), ("name", "HLR")])
        let s = try XCTUnwrap(BubbleModelFace.scope(mine, tr, has))
        XCTAssertEqual(s.optString("line"), "/hlr · [fnm.viaYou]")
        XCTAssertEqual(s.bool("mine"), true)
        var peer = msg("p1", "peer-1", 1)
        peer.senderName = "Alice"
        peer.fn = JSONObject([("keyword", "hlr"), ("name", "HLR"), ("icon", "🦊")])
        let p = try XCTUnwrap(BubbleModelFace.scope(peer, tr, has))
        XCTAssertEqual(p.optString("line"), "/hlr · via Alice")
        XCTAssertEqual(p.optString("via"), "Alice")
        XCTAssertEqual(p.optString("name"), "HLR")
        XCTAssertEqual(p.bool("emoji"), true)
        XCTAssertEqual(p.optString("glyph"), "")
        XCTAssertEqual(p.optString("color"), "#7bb234")
        XCTAssertNil(BubbleModelFace.scope(msg("t1", "peer-1", 1), tr, has))
        // A wrong call's card.
        var card = answer("e1", "mail", 1)
        card.fn = JSONObject([("keyword", "mail"), ("problem", true)])
        XCTAssertEqual(BubbleModelFace.scope(card, tr, has)?.bool("error"), true)
    }

    func testTheIconTheAppDraws() {
        XCTAssertEqual(BubbleModelFace.glyph(ModelIdentity.of("mail", "", nil), has), "mail")
        // The default icons this app's set lacks: a near one.
        XCTAssertEqual(BubbleModelFace.glyph(ModelIdentity.of("call", "", nil), has), "phone-outgoing")
        XCTAssertEqual(BubbleModelFace.glyph(ModelIdentity.of("weather", "", nil), has), "cloud")
        XCTAssertEqual(BubbleModelFace.glyph(ModelIdentity.of("help", "", nil), has), "circle-question-mark")
        // The model's own icon unknown here: its keyword's; a shorter name; a bot.
        XCTAssertEqual(BubbleModelFace.glyph(ModelIdentity.of("mail", "", "envelope-open"), has), "mail")
        XCTAssertEqual(BubbleModelFace.glyph(ModelIdentity.of("zz", "", "globe-lock"), has), "globe")
        XCTAssertEqual(BubbleModelFace.glyph(ModelIdentity.of("zz", "", "rocket"), has), "bot")
        XCTAssertEqual(BubbleModelFace.glyph(ModelIdentity.of("zz", "", "🚀"), has), "")
    }

    func testAModelsAnswersAreTheirOwnRun() {
        let cmd = call("c1", 1_000)
        let a1 = answer("a1", "mail", 2_000)
        let a2 = answer("a2", "mail", 3_000)
        let other = answer("a3", "dns", 4_000)
        XCTAssertFalse(BubbleRuns.continues(cmd, a1)) // the answer starts its own run (its face shows)
        XCTAssertTrue(BubbleRuns.continues(a1, a2)) // the same model again
        XCTAssertFalse(BubbleRuns.continues(a2, other)) // another model
        var mine = msg("m1", "me", 5_000)
        mine.mine = true
        mine.fn = JSONObject([("keyword", "dns"), ("name", "DNS")])
        XCTAssertFalse(BubbleRuns.continues(other, mine)) // only you vs. via you
        var mine2 = msg("m2", "me", 6_000)
        mine2.mine = true
        XCTAssertFalse(BubbleRuns.continues(mine, mine2)) // my room answer, then my own message
        XCTAssertFalse(BubbleRuns.continues(a1, answer("late", "mail", 2_000 + BubbleRuns.gapMs + 1)))
    }

    /// A model's answer is drawn by the incoming template, also the one this device sent to the room.
    func testAModelsAnswerIsAnIncomingRow() {
        var mine = msg("m1", "me", 1)
        mine.mine = true
        mine.fn = JSONObject([("keyword", "hlr"), ("name", "HLR")])
        XCTAssertEqual(ChatMessageScope.screen(mine), "message.in")
        var plain = msg("m2", "me", 1)
        plain.mine = true
        XCTAssertEqual(ChatMessageScope.screen(plain), "message.out")
        XCTAssertEqual(ChatMessageScope.screen(ChatMessage.system(roomKey: "r", text: "x", now: 1)), "message.sys")
    }
}
