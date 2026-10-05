// Port of android/app/src/test/java/cz/m5cet/app/ui/bubble/ReplyQuoteTest.java (6.10):
// the quote card on top of a reply ($msg.replyTo), and runs of one person's messages ($msg.cont).

import M5Core
import M5Proto
import XCTest
@testable import M5cet

@MainActor
final class ReplyQuoteTests: XCTestCase {
    private let tr: (String) -> String = { "[" + $0 + "]" }

    private func msg(_ id: String, _ sender: String, _ text: String) -> ChatMessage {
        var m = ChatMessage()
        m.id = id
        m.roomKey = "r"
        m.senderId = "peer-" + sender
        m.senderName = sender
        m.text = text
        m.createdAt = 1_000_000
        return m
    }

    private func reply(_ to: ChatMessage?, _ quoted: String) -> ChatMessage {
        var r = msg("r1", "Bob", "ok")
        r.replyToId = to?.id ?? "gone-1"
        r.replyToSender = to?.senderName ?? "Alice"
        r.replyToText = quoted
        return r
    }

    func testAMessageThatIsNoReplyHasNoQuote() {
        XCTAssertNil(BubbleReplyQuote.of(msg("a", "Alice", "hi"), nil, tr))
        XCTAssertNil(BubbleReplyQuote.of(nil, nil, tr))
    }

    func testTheOriginalHereGivesTheLatestTextAndItsSender() throws {
        let o = msg("o1", "Alice", "Ahoj,\n\njak   to jde?")
        let q = try XCTUnwrap(BubbleReplyQuote.of(reply(o, "Ahoj, jak to jde?"), o, tr))
        XCTAssertEqual(q.optString("id"), "o1")
        XCTAssertEqual(q.optString("sender"), "Alice")
        XCTAssertEqual(q.optString("text"), "Ahoj, jak to jde?") // folded into one paragraph
        XCTAssertEqual(q.optString("icon"), "")
        XCTAssertEqual(q.optString("kind"), "text")
        XCTAssertEqual(q.bool("found"), true)
        let color = q.optString("color"), tint = q.optString("tint")
        XCTAssertNotNil(color.range(of: "^#ff[0-9a-f]{6}$", options: .regularExpression))
        XCTAssertNotNil(tint.range(of: "^#24[0-9a-f]{6}$", options: .regularExpression))
        XCTAssertEqual(color.dropFirst(3), tint.dropFirst(3)) // the same hue, faint
    }

    func testMineSaysYou() throws {
        var o = msg("o1", "Mike", "hello")
        o.mine = true
        let q = try XCTUnwrap(BubbleReplyQuote.of(reply(o, "hello"), o, tr))
        XCTAssertEqual(q.optString("sender"), "[quote.you]")
        XCTAssertEqual(q.bool("mine"), true)
    }

    func testNotHereItUsesWhatTheReplyCarried() throws {
        let q = try XCTUnwrap(BubbleReplyQuote.of(reply(nil, "Old news"), nil, tr))
        XCTAssertEqual(q.optString("id"), "gone-1")
        XCTAssertEqual(q.optString("sender"), "Alice")
        XCTAssertEqual(q.optString("text"), "Old news")
        XCTAssertEqual(q.bool("found"), false)
        // A file quoted by the web or another phone: "📎 name" → the paperclip and the name.
        let f = try XCTUnwrap(BubbleReplyQuote.of(reply(nil, "📎 report.pdf"), nil, tr))
        XCTAssertEqual(f.optString("kind"), "file")
        XCTAssertEqual(f.optString("icon"), "paperclip")
        XCTAssertEqual(f.optString("text"), "report.pdf")
        // A sealed one: the lock, never the code's ciphertext.
        let s = try XCTUnwrap(BubbleReplyQuote.of(reply(nil, "🔒"), nil, tr))
        XCTAssertEqual(s.optString("icon"), "lock")
        XCTAssertEqual(s.optString("text"), "[quote.sealed]")
    }

    func testMediaShowsItsIconAndSaysWhatItIs() throws {
        var photo = msg("p", "Alice", "")
        photo.fileName = "IMG_1.jpg"; photo.fileMime = "image/jpeg"; photo.fileImage = true
        let q = try XCTUnwrap(BubbleReplyQuote.of(reply(photo, "📎 IMG_1.jpg"), photo, tr))
        XCTAssertEqual(q.optString("icon"), "image")
        XCTAssertEqual(q.optString("text"), "IMG_1.jpg")
        var voice = msg("v", "Alice", "")
        voice.fileName = "voice.m4a"; voice.fileMime = "audio/mp4"
        XCTAssertEqual(BubbleReplyQuote.of(reply(voice, ""), voice, tr)?.optString("icon"), "audio-lines")
        var clip = msg("c", "Alice", "look")
        clip.fileName = "a.mp4"; clip.fileMime = "video/mp4"
        let vq = try XCTUnwrap(BubbleReplyQuote.of(reply(clip, "look"), clip, tr))
        XCTAssertEqual(vq.optString("icon"), "video")
        XCTAssertEqual(vq.optString("text"), "look") // a caption wins over the file's name
        let pos = msg("l", "Alice", "📍 50.08804, 14.42076 (±12 m) https://www.openstreetmap.org/")
        XCTAssertEqual(BubbleReplyQuote.of(reply(pos, pos.text), pos, tr)?.optString("icon"), "map-pin")
    }

    func testASealedOrVanishedOriginalIsNotQuoted() throws {
        var sealed = msg("s", "Alice", "ciphertext==")
        sealed.sealed = JSONObject()
        let q = try XCTUnwrap(BubbleReplyQuote.of(reply(sealed, "🔒"), sealed, tr))
        XCTAssertEqual(q.optString("kind"), "sealed")
        XCTAssertEqual(q.optString("text"), "[quote.sealed]")
        sealed.sealPlain = "the secret" // opened here: the reply quotes it as the bubble shows it
        XCTAssertEqual(BubbleReplyQuote.of(reply(sealed, "🔒"), sealed, tr)?.optString("text"), "the secret")
        var gone = msg("g", "Alice", "soon gone")
        gone.vanished = true
        let v = try XCTUnwrap(BubbleReplyQuote.of(reply(gone, "soon gone"), gone, tr))
        XCTAssertEqual(v.optString("text"), "[quote.vanished]")
        XCTAssertEqual(v.optString("icon"), "timer")
    }

    func testAHeldOriginalSaysSoAndNothingElse() throws {
        // 6.12 review P14: a changed identity's message is not quoted (neither what the reply claims).
        var o = msg("o1", "Alice", "secret plan")
        o.changed = true
        let q = try XCTUnwrap(BubbleReplyQuote.of(reply(o, "secret plan"), o, tr))
        XCTAssertEqual(q.optString("kind"), "held")
        XCTAssertEqual(q.optString("text"), "[quote.held]")
        XCTAssertEqual(q.optString("icon"), "shield-alert")
        XCTAssertEqual(q.bool("found"), false)
        let h = try XCTUnwrap(BubbleReplyQuote.of(reply(nil, "secret plan"), nil, held: true, tr))
        XCTAssertFalse(h.stringify().contains("secret"))
    }

    func testTwoLinesAtMost() {
        let line = BubbleReplyQuote.line(String(repeating: "slovo ", count: 60))
        XCTAssertLessThanOrEqual(line.unicodeScalars.count, BubbleReplyQuote.chars)
        XCTAssertTrue(line.hasSuffix("…"))
        XCTAssertEqual(BubbleReplyQuote.line(" a \u{202E}\n b "), "a b") // no bidi override, no line break
        XCTAssertEqual(BubbleReplyQuote.line(nil), "")
    }

    func testTheSameSenderHasTheSameColour() {
        let o = msg("o1", "Alice", "x")
        let c1 = BubbleReplyQuote.of(reply(o, "x"), o, tr)?.optString("color")
        let c2 = BubbleReplyQuote.of(reply(nil, "x"), nil, tr)?.optString("color")
        XCTAssertEqual(c1, c2)
        let p = msg("o2", "Bob", "x")
        XCTAssertNotEqual(c1, BubbleReplyQuote.of(reply(p, "x"), p, tr)?.optString("color"))
    }

    func testTheMonogramHueIsTheWebs() {
        // hueFor("alice") over UTF-16 units mod 360; hsl(h 70% 42%) as Java's float rounding gives it.
        var h = 0
        for u in "alice".utf16 { h = (h * 31 + Int(u)) % 360 }
        XCTAssertEqual(MonogramHue.hue("Alice"), h)
        XCTAssertEqual(MonogramHue.hex(MonogramHue.hsl(0, 1, 0.5, 1)), "#ffff0000")
        XCTAssertEqual(MonogramHue.hex(MonogramHue.hsl(120, 1, 0.5, 1)), "#ff00ff00")
        XCTAssertEqual(MonogramHue.hex(MonogramHue.hsl(240, 1, 0.25, 0.5)), "#80000080")
    }

    // MARK: runs

    func testOneSendersMessagesCloseInTimeAreARun() {
        let a = msg("1", "Alice", "a")
        var b = msg("2", "Alice", "b")
        b.createdAt = a.createdAt + 60_000
        XCTAssertTrue(BubbleRuns.continues(a, b))
        b.createdAt = a.createdAt + BubbleRuns.gapMs + 1
        XCTAssertFalse(BubbleRuns.continues(a, b)) // a pause starts a new run
        b.createdAt = a.createdAt + 1000
        XCTAssertFalse(BubbleRuns.continues(a, msg("3", "Bob", "c"))) // another person
        XCTAssertFalse(BubbleRuns.continues(nil, b)) // the first in the list
        let sys = ChatMessage.system(roomKey: "r", text: "Alice joined", now: 1_000_000)
        XCTAssertFalse(BubbleRuns.continues(sys, b))
        XCTAssertFalse(BubbleRuns.continues(a, sys))
        var mine = msg("4", "Alice", "d")
        mine.mine = true
        XCTAssertFalse(BubbleRuns.continues(a, mine))
        var early = msg("5", "Alice", "e")
        early.createdAt = a.createdAt - 1000 // out of order (history merged): its own run
        XCTAssertFalse(BubbleRuns.continues(a, early))
    }
}
