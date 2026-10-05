// The message details (MsgDetails.java): the rows, the kinds' chips, the timeline in
// the design's words (6.12's relay states from the protocol's English when the
// design lacks them), every recipient's states with their times, the attachment,
// hiding (until a time or the next sign-in) and deleting through DetailsHides.

import M5Core
import M5Design
import M5Proto
import XCTest
@testable import M5cet

@MainActor
final class MsgDetailsTests: XCTestCase {
    private let utc = TimeZone(identifier: "UTC")!
    private let t0: Int64 = 1_760_000_000_000 // 2025-10-09 08:53:20 UTC

    private func mine() -> ChatMessage {
        var m = ChatMessage()
        m.id = "m8"; m.roomKey = "team"; m.text = "Jen pro tebe."; m.createdAt = t0; m.mine = true; m.senderName = "Mike"; m.senderId = "peer-me"
        m.verified = true; m.to = ["Alice", "Bob"]; m.status = "read"
        m.mark("created", "", at: t0)
        m.mark("encrypted", "", at: t0 + 10)
        m.mark("sent", "p2p", at: t0 + 20)
        m.mark("relay-p4", "Eva", at: t0 + 30)
        m.mark("stored", "Eva", at: t0 + 900)
        m.mark("delivered", "Alice", at: t0 + 1_000)
        m.mark("delivered", "Bob", at: t0 + 1_500)
        m.mark("read", "Alice", at: t0 + 61_000)
        m.receipts = JSONObject([("peer-carol", "delivered")])
        return m
    }

    /// A time of day with seconds in English, UTC (the details' form for a step on the message's day).
    private func ts(_ at: Int64) -> String { Formats.timeSeconds("en", at, tz: utc) }

    private func content(_ m: ChatMessage, _ host: DesignHost, hidden: Bool = false, forwardVerified: Bool = false) -> MsgDetailsContent {
        MsgDetailsModel.content(m, roomLabel: "Tým", peerName: { $0 == "peer-carol" ? "Carol" : nil }, forwardVerified: forwardVerified,
                                hidden: hidden, t: host.peopleText, lang: "en", now: t0 + 120_000, tz: utc)
    }

    func testEveryRecipientsStatesWithTheirTimes() {
        let host = RendererTestSupport.host()
        let c = content(mine(), host)
        let t = host.peopleText
        XCTAssertEqual(c.receipts.map(\.label), ["Eva", "Alice", "Bob", "Carol"])
        XCTAssertEqual(c.receipts[0].value, t("msginfo.state.stored") + " " + ts(t0 + 900))
        XCTAssertEqual(c.receipts[1].value, t("msginfo.state.delivered") + " " + ts(t0 + 1_000) + " · " + t("msginfo.state.read") + " " + ts(t0 + 61_000))
        XCTAssertEqual(c.receipts[2].value, t("msginfo.state.delivered") + " " + ts(t0 + 1_500))
        XCTAssertTrue(ts(t0 + 61_000).contains("54:21"))
        // An older message's receipt without a timeline: the state alone, under the peer's name.
        XCTAssertEqual(c.receipts[3].value, t("msginfo.state.delivered"))
        // Not mine: no receipts part.
        var theirs = mine()
        theirs.mine = false
        XCTAssertTrue(content(theirs, host).receipts.isEmpty)
    }

    func testTheTimelineInTheDesignsWords() {
        let host = RendererTestSupport.host()
        let t = host.peopleText
        let c = content(mine(), host)
        XCTAssertEqual(c.timeline.map(\.state), ["created", "encrypted", "sent", "relay-p4", "stored", "delivered", "delivered", "read"])
        XCTAssertEqual(c.timeline.map(\.icon), ["pencil-line", "lock", "send-horizontal", "shield-check", "server", "check", "check", "check-check"])
        XCTAssertEqual(c.timeline[2].label, t("msginfo.state.sent") + " · " + t("msginfo.meta.p2p"))
        // How a message for an away member was sealed (6.12 § 7.4): the design's words, or the app's English.
        XCTAssertEqual(c.timeline[3].label, MsgDetailsModel.word(t, "msginfo.state.", "relay-p4") + " · Eva")
        XCTAssertNotEqual(MsgDetailsModel.word(t, "msginfo.state.", "relay-room"), "relay-room")
        XCTAssertEqual(c.timeline[0].time, ts(t0))
        // A message from before 6.2 gets its "created" step; a step on another day shows the day.
        var old = ChatMessage()
        old.id = "o1"; old.createdAt = t0; old.text = "x"
        old.mark("received", "", at: t0 + 86_400_000)
        let oc = content(old, host)
        XCTAssertEqual(oc.timeline.first?.state, "created")
        XCTAssertEqual(oc.timeline.last?.time, Formats.shortFull("en", t0 + 86_400_000, tz: utc))
    }

    func testTheRowsAndTheKinds() {
        let host = RendererTestSupport.host()
        let t = host.peopleText
        var m = mine()
        m.vanishSeconds = 60
        m.replyToId = "m1"; m.replyToSender = "Alice"
        m.forwardedFrom = "Bob"
        m.expiresAt = t0 + 3_600_000
        let c = content(m, host, forwardVerified: true)
        XCTAssertEqual(c.rows.map(\.label), [t("msginfo.when"), t("msginfo.sender"), t("msginfo.recipients"), t("msginfo.size"), t("msginfo.verified"), t("msginfo.expires")])
        XCTAssertEqual(c.rows[0].value, Formats.full("en", t0, tz: utc))
        XCTAssertEqual(c.rows[1].value, t("users.me") + " (Mike)")
        XCTAssertEqual(c.rows[2].value, "Alice, Bob")
        XCTAssertEqual(c.rows[3].value, t("msginfo.sizeText") + " " + MsgDetailsModel.size(Int64("Jen pro tebe.".utf8.count)))
        XCTAssertEqual(c.rows[4].value, "✓")
        XCTAssertEqual(c.kinds, [t("msginfo.kind.text"), t("msginfo.kind.vanish") + " · 60 s", t("msginfo.kind.private") + " · Alice, Bob",
                                 t("msginfo.kind.forwarded") + " · Bob ✓", t("msginfo.kind.reply") + " · Alice"])
        // To everyone, a changed identity, a file, a position.
        var f = ChatMessage()
        f.id = "f1"; f.createdAt = t0; f.senderName = "Bob"; f.changed = true
        f.fileName = "plan.pdf"; f.fileMime = "application/pdf"; f.fileSize = 182_331; f.filePath = "in-1"; f.fileProgress = -1
        f.loc = JSONObject([("lat", .double(50.08)), ("lon", .double(14.42))])
        let fc = content(f, host)
        XCTAssertEqual(fc.rows[2].value, t("msginfo.everyone") + " · Tým")
        XCTAssertEqual(fc.rows[4].value, "⚠ " + t("msginfo.changed"))
        XCTAssertEqual(fc.kinds, [t("msginfo.kind.file"), t("msginfo.kind.location")])
        XCTAssertEqual(fc.attachment?.label, "plan.pdf")
        XCTAssertEqual(fc.attachment?.value, MsgDetailsModel.size(182_331) + " · application/pdf")
        XCTAssertTrue(fc.attachmentReady)
        XCTAssertTrue(fc.canHide)
        // A position message (📍 …) is not "text".
        var pos = ChatMessage()
        pos.text = "📍 50.08804, 14.42076 (±12 m) https://www.openstreetmap.org/"
        XCTAssertEqual(MsgDetailsModel.kindsOf(pos), ["location"])
        // A system line cannot be hidden.
        XCTAssertFalse(content(ChatMessage.system(roomKey: "team", text: "Alice joined", now: t0), host).canHide)
    }

    func testHidingUntilATimeOrTheNextSignInAndDeleting() {
        let room = PeopleFakeRoom()
        room.messages = [mine()]
        let hides = DetailsHides()
        hides.now = { self.t0 }
        var audit = [String]()
        hides.audit = { action, _, _, _ in audit.append(action) }
        hides.hide(room, room.messages[0], choice: 1)
        XCTAssertEqual(room.hideCalls.last?.1, t0 + 3_600_000)
        XCTAssertEqual(room.hideCalls.last?.3, "1h")
        XCTAssertTrue(hides.hidden(room.messages[0], now: t0 + 1000))
        XCTAssertFalse(hides.hidden(room.messages[0], now: t0 + 3_600_001))
        let host = RendererTestSupport.host()
        let c = content(room.messages[0], host, hidden: true)
        XCTAssertTrue(c.hidden)
        XCTAssertEqual(c.rows.last?.label, host.peopleText("msginfo.hidden"))
        // Until the next sign-in: the hide names this unlock; a new unlock ends it.
        hides.hide(room, room.messages[0], choice: 4)
        XCTAssertEqual(room.messages[0].hiddenUntil, ChatMessage.untilSignIn)
        XCTAssertEqual(room.messages[0].hiddenFor, hides.unlock)
        XCTAssertTrue(hides.hidden(room.messages[0], now: t0))
        XCTAssertEqual(content(room.messages[0], host, hidden: true).rows.last?.value, host.peopleText("msginfo.hide.until-signin"))
        hides.lockDidUnlock()
        XCTAssertFalse(hides.hidden(room.messages[0], now: t0))
        hides.unhide(room, room.messages[0])
        XCTAssertEqual(room.messages[0].hiddenUntil, 0)
        hides.delete(room, room.messages[0])
        XCTAssertTrue(room.messages.isEmpty)
        XCTAssertEqual(audit, ["hide", "hide", "unhide", "delete"])
        XCTAssertEqual(DetailsHides.names, ["15m", "1h", "8h", "1d", "until-signin"])
    }

    func testTheViewDrawsTheDetailsAndFollowsTheMessage() {
        let w = PeopleWorld.make()
        w.room.messages = [mine()]
        let view = MsgDetailsView(room: w.room, messageId: "m8", hides: DetailsHides(), now: { self.t0 }, timeZone: utc)
            .environment(w.host)
        let vc = RendererTestSupport.layOut(view, size: RendererTestSupport.iPhone)
        let image = RendererTestSupport.draw(vc.view)
        XCTAssertGreaterThan(image.size.height, 100)
        // msg.info opens it for a message of the room; not for a system line.
        PeopleParts.install(services: w.host.services)
        w.room.messages.append(ChatMessage.system(roomKey: "team", text: "Alice joined", now: t0))
        XCTAssertNotNil(PeopleParts.find("m8"))
        XCTAssertNil(PeopleParts.find("nothing"))
    }
}
