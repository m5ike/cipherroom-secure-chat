// Port of android/app/src/test/java/cz/m5cet/app/ui/bubble/BubblesTest.java (6.2 bubbles):
// the map preview's tile math and policy, what a message is, hides, the audit entry,
// and that every word the bubbles look up is in the design's strings.

import M5Core
import M5Proto
import XCTest
@testable import M5cet

@MainActor
final class BubblesTests: XCTestCase {
    // MARK: tiles

    func testProjectsLikeTheSlippyMap() {
        var p = MapTileMath.project(0, 0, 0)
        XCTAssertEqual(p.x, 128, accuracy: 1e-9)
        XCTAssertEqual(p.y, 128, accuracy: 1e-9)
        p = MapTileMath.project(0, 0, 1)
        XCTAssertEqual(p.x, 256, accuracy: 1e-9)
        XCTAssertEqual(p.y, 256, accuracy: 1e-9)
        // The corners of the square world.
        XCTAssertEqual(MapTileMath.project(MapTileMath.maxLat, -180, 3).y, 0, accuracy: 1e-3)
        XCTAssertEqual(MapTileMath.project(-MapTileMath.maxLat, 180, 3).x, MapTileMath.world(3), accuracy: 1e-9)
        XCTAssertEqual(MapTileMath.project(-MapTileMath.maxLat, 180, 3).y, MapTileMath.world(3), accuracy: 1e-3)
    }

    func testFindsTheTileOfAPlace() {
        // Prague, Old Town Square — OpenStreetMap's own numbering (z 16: 35393 / 22201).
        let t = MapTileMath.tileOf(50.0875, 14.4213, 16)
        let n = Double(1 << 16)
        let latRad = 50.0875 * Double.pi / 180
        XCTAssertEqual(t.x, Int(floor((14.4213 + 180) / 360 * n)))
        XCTAssertEqual(t.y, Int(floor((1 - log(tan(latRad) + 1 / cos(latRad)) / Double.pi) / 2 * n)))
        XCTAssertEqual(t.x, 35393)
        XCTAssertEqual(t.y, 22201)
        // Beyond the poles: the last row.
        XCTAssertEqual(MapTileMath.tileOf(89, 0, 4).y, 0)
        XCTAssertEqual(MapTileMath.tileOf(-89, 0, 4).y, 15)
    }

    func testTheViewIsCentredExactlyOnThePoint() throws {
        let lat = 50.0875, lon = 14.4213, w = 280.0, h = 160.0
        let z = 16
        let tiles = MapTileMath.tiles(lat, lon, z, w, h)
        let p = MapTileMath.project(lat, lon, z)
        let home = MapTileMath.tileOf(lat, lon, z)
        let hit = try XCTUnwrap(tiles.first { $0.x == home.x && $0.y == home.y })
        // The point's pixel inside its tile, moved by the tile's offset, is the middle of the view.
        XCTAssertEqual(hit.left + (p.x - Double(home.x) * 256), w / 2, accuracy: 1e-6)
        XCTAssertEqual(hit.top + (p.y - Double(home.y) * 256), h / 2, accuracy: 1e-6)
        // The tiles cover the whole view, without gaps, in rows.
        var minL = Double.greatestFiniteMagnitude, minT = Double.greatestFiniteMagnitude, maxR = -Double.greatestFiniteMagnitude, maxB = -Double.greatestFiniteMagnitude
        var seen = Set<String>()
        for t in tiles {
            minL = min(minL, t.left); minT = min(minT, t.top)
            maxR = max(maxR, t.left + 256); maxB = max(maxB, t.top + 256)
            XCTAssertTrue(seen.insert(t.description).inserted)
            XCTAssertEqual(t.z, z)
        }
        XCTAssertTrue(minL <= 0 && minT <= 0 && maxR >= w && maxB >= h)
        XCTAssertTrue(tiles.count >= 2 && tiles.count <= 6)
    }

    func testATileCornerNeedsFourTiles() {
        // (0, 0) at z 1 is where four tiles meet: a small view takes one of each.
        let tiles = MapTileMath.tiles(0, 0, 1, 100, 100)
        XCTAssertEqual(tiles.count, 4)
        XCTAssertEqual(tiles[0].description, "1/0/0")
        XCTAssertEqual(tiles[0].left, -206, accuracy: 1e-9)
        XCTAssertEqual(tiles[0].top, -206, accuracy: 1e-9)
        XCTAssertEqual(tiles[3].description, "1/1/1")
        XCTAssertEqual(tiles[3].left, 50, accuracy: 1e-9)
    }

    func testWrapsAcrossTheDateLineAndStopsAtThePoles() {
        let xs = Set(MapTileMath.tiles(0, 179.99, 2, 280, 160).map(\.x))
        XCTAssertTrue(xs.contains(3) && xs.contains(0)) // the east edge and, past it, the west one
        for t in MapTileMath.tiles(85, 0, 2, 280, 400) { XCTAssertTrue(t.y >= 0 && t.y < 4) }
    }

    func testMetresPerPixel() {
        XCTAssertEqual(MapTileMath.metersPerPixel(0, 0), 156543.03, accuracy: 0.01)
        XCTAssertEqual(MapTileMath.metersPerPixel(50, 16), 156543.03392 / 65536 * cos(50 * Double.pi / 180), accuracy: 1e-6)
    }

    // MARK: policy

    private func map(_ pairs: [(String, JSON)]) -> JSONObject { JSONObject([("map", .object(JSONObject(pairs)))]) }

    func testReadsTheOperatorsPolicyLikeTheServer() {
        let d = ChatMapPolicy.parse(map([]))
        XCTAssertTrue(d.enabled)
        XCTAssertEqual(d.zoom, 16)
        XCTAssertEqual(d.width, 280)
        XCTAssertEqual(d.height, 160)
        XCTAssertEqual(d.pinColor, 0xFFE1_1D48)
        XCTAssertEqual(d.accent, 0)
        XCTAssertTrue(d.label && d.showCoords)
        XCTAssertFalse(d.grayscale)
        let p = ChatMapPolicy.parse(map([("enabled", true), ("zoom", 40), ("width", 90), ("height", 9999), ("pinColor", "#00FF00"), ("accent", "#123456"),
                                         ("grayscale", true), ("label", false), ("attribution", "<b>© Tiles</b>\u{07}"), ("subdomains", "abc!")]))
        XCTAssertEqual(p.zoom, 19)
        XCTAssertEqual(p.width, 160)
        XCTAssertEqual(p.height, 480)
        XCTAssertEqual(p.pinColor, 0xFF00_FF00)
        XCTAssertEqual(p.accent, 0xFF12_3456)
        XCTAssertTrue(p.grayscale)
        XCTAssertFalse(p.label)
        XCTAssertEqual(p.attribution, "b© Tiles/b")
        XCTAssertEqual(p.subdomains, "")
        XCTAssertEqual(ChatMapPolicy.parse(map([("pinColor", "red")])).pinColor, 0xFFE1_1D48)
        // A server from before 6.2 has no map (and no tiles to give).
        XCTAssertFalse(ChatMapPolicy.parse(JSONObject([("composer", .object(JSONObject()))])).enabled)
        XCTAssertFalse(ChatMapPolicy.parse(map([("enabled", false)])).enabled)
    }

    // MARK: kinds

    private func msg(_ text: String) -> ChatMessage {
        var m = ChatMessage()
        m.id = "msg-1"
        m.roomKey = "k"
        m.text = text
        return m
    }

    func testAPositionMessageFromTheWebOrTheApp() throws {
        let web = msg("📍 50.08804, 14.42076 (±12 m) https://www.openstreetmap.org/?mlat=50.088040&mlon=14.420760#map=15/50.088040/14.420760")
        XCTAssertTrue(BubbleKinds.isPositionMessage(web))
        let p = try XCTUnwrap(BubbleKinds.position(web))
        XCTAssertEqual(p.chatDouble("lat"), 50.08804, accuracy: 1e-9)
        XCTAssertEqual(p.chatDouble("lon"), 14.42076, accuracy: 1e-9)
        XCTAssertEqual(p.optInt64("acc"), 12)
        XCTAssertFalse(BubbleKinds.headerPosition(web))
        XCTAssertEqual(BubbleKinds.of(web), ["location"])

        let live = msg("📍 live -33.86785, 151.20732 https://www.openstreetmap.org/")
        XCTAssertEqual(try XCTUnwrap(BubbleKinds.position(live)).chatDouble("lat"), -33.86785, accuracy: 1e-9)
        XCTAssertFalse(try XCTUnwrap(BubbleKinds.position(live)).has("acc"))

        // The app's own carries loc too — that wins (more precise, with its time).
        var app = msg("📍 50.08804, 14.42076 (±12 m) https://…")
        app.loc = JSONObject([("lat", .double(50.0880412)), ("lon", .double(14.4207633)), ("acc", 9), ("at", 1)])
        XCTAssertEqual(try XCTUnwrap(BubbleKinds.position(app)).chatDouble("lat"), 50.0880412, accuracy: 1e-9)

        // Only the header's position: text of its own, loc beside it.
        var header = msg("Jsem na místě")
        header.loc = JSONObject([("lat", .double(50.1)), ("lon", .double(14.4)), ("acc", 30)])
        XCTAssertTrue(BubbleKinds.headerPosition(header))
        XCTAssertFalse(BubbleKinds.isPositionMessage(header))
        XCTAssertEqual(BubbleKinds.of(header), ["text", "location"])

        XCTAssertNil(BubbleKinds.position(msg("I am at 📍 home")))
        XCTAssertNil(BubbleKinds.position(msg("📍 95.1, 14.2")))
        var sealed = msg("📍 50.1, 14.2")
        sealed.sealed = JSONObject()
        XCTAssertNil(BubbleKinds.position(sealed))
    }

    func testTheKindsTheAuditJournalKnows() {
        var m = msg("hello")
        m.fileName = "clip.mp4"
        m.fileMime = "video/mp4"
        m.tap = true
        m.vanishSeconds = 30
        m.to.append("Jana")
        m.forwardedFrom = "Petr"
        m.replyToId = "msg-0"
        m.sourceAudio = "call-1"
        m.fn = JSONObject([("keyword", "w")])
        XCTAssertEqual(BubbleKinds.of(m), ["text", "video", "tap", "vanish", "fn", "private", "forwarded", "reply", "transcript"])
        var img = msg("")
        img.fileName = "a.png"
        img.fileImage = true
        XCTAssertEqual(BubbleKinds.of(img), ["image"])
        var voice = msg("")
        voice.fileName = "v.m4a"
        voice.fileMime = "audio/mp4"
        XCTAssertEqual(BubbleKinds.of(voice), ["audio"])
        var doc = msg("")
        doc.fileName = "a.pdf"
        doc.fileMime = "application/pdf"
        XCTAssertEqual(BubbleKinds.of(doc), ["file"])
        var seal = msg("ciphertext")
        seal.sealed = JSONObject()
        XCTAssertEqual(BubbleKinds.of(seal), ["text", "sealed"])
    }

    // MARK: audit

    func testTheAuditEntryNeverCarriesTheMessage() {
        var m = msg("tajné heslo je 1234")
        m.fileName = "smlouva.pdf"
        m.fileMime = "application/pdf"
        m.fileDataUrl = "data:application/pdf;base64,JVBERi0="
        m.mine = true
        let hide = ChatMessageAudit.entry("hide", m, room: "r3.abc", until: 1_700_000_000_000, at: 1_699_999_000_000)
        XCTAssertEqual(hide.optString("action"), "hide")
        XCTAssertEqual(hide.optString("messageId"), "msg-1")
        XCTAssertEqual(hide.optString("room"), "r3.abc")
        XCTAssertEqual(hide.int64("until"), 1_700_000_000_000)
        XCTAssertEqual(hide.int64("at"), 1_699_999_000_000)
        XCTAssertEqual(hide.bool("mine"), true)
        XCTAssertEqual(JSON.array(hide.array("kinds") ?? []).stringify(), "[\"text\",\"file\"]")
        let all = hide.stringify()
        XCTAssertFalse(all.contains("tajné") || all.contains("smlouva") || all.contains("base64"))
        XCTAssertEqual(ChatMessageAudit.entry("hide", m, room: "r3.abc", until: ChatMessage.untilSignIn, at: 1).int64("until"), 0) // until the next sign-in
        XCTAssertFalse(ChatMessageAudit.entry("delete", m, room: "r3.abc", until: 0, at: 1).has("until"))
        XCTAssertEqual(Set(ChatMessageAudit.entry("unhide", m, room: "r", until: 0, at: 1).keys), ["action", "messageId", "room", "kinds", "mine", "at"])
    }

    // MARK: hides

    func testTimedHidesEndWithTheirTime() throws {
        var m = msg("x")
        let now: Int64 = 1_000_000
        XCTAssertFalse(BubbleHides.hidden(m, now))
        m.hiddenUntil = now + 60_000
        XCTAssertTrue(BubbleHides.hidden(m, now))
        XCTAssertFalse(BubbleHides.endIfOver(&m, now))
        XCTAssertTrue(BubbleHides.hidden(m, now + 59_999))
        XCTAssertTrue(BubbleHides.endIfOver(&m, now + 60_000))
        XCTAssertEqual(m.hiddenUntil, 0)
        let last = try XCTUnwrap(m.timeline.last)
        XCTAssertEqual(last.state, "unhidden")
        XCTAssertEqual(last.meta, "time")
        XCTAssertEqual(last.at, now + 60_000)
    }

    func testSignInHidesEndWithTheNextUnlock() {
        var m = msg("x")
        m.hiddenUntil = ChatMessage.untilSignIn
        m.hiddenFor = "unlock-A"
        XCTAssertTrue(BubbleHides.hidden(m, 5, "unlock-A"))
        XCTAssertTrue(BubbleHides.hidden(m, Int64.max - 1, "unlock-A")) // no time limit
        XCTAssertFalse(BubbleHides.hidden(m, 5, "unlock-B")) // unlocked since (or the app started again)
        m.hiddenFor = nil
        XCTAssertFalse(BubbleHides.hidden(m, 5, "unlock-A"))
    }

    func testAnUnlockEndsTheHidesUntilSignIn() {
        var m = msg("x")
        m.hiddenUntil = ChatMessage.untilSignIn
        m.hiddenFor = BubbleHides.unlock
        XCTAssertTrue(BubbleHides.hidden(m, 5))
        let generation = ChatState.shared.hidesGeneration
        BubbleHides.unlocked()
        XCTAssertGreaterThan(ChatState.shared.hidesGeneration, generation)
        XCTAssertFalse(BubbleHides.hidden(m, 5))
        XCTAssertTrue(BubbleHides.endIfOver(&m, 7))
        XCTAssertEqual(m.timeline.last?.meta, "signin")
    }

    func testTheNextTimedHideToEnd() {
        var a = msg("a"), b = msg("b"), c = msg("c")
        a.hiddenUntil = 5000
        b.hiddenUntil = 3000
        c.hiddenUntil = ChatMessage.untilSignIn
        XCTAssertEqual(BubbleHides.nextEnd([a, b, c], 1000), 3000)
        XCTAssertEqual(BubbleHides.nextEnd([a, b, c], 3000), 5000)
        XCTAssertEqual(BubbleHides.nextEnd([c], 0), Int64.max)
        XCTAssertEqual(BubbleHides.durations.count, BubbleHides.names.count)
    }

    /// Every word the bubbles look up is in the design's strings (server/android/design-62-bubbles.ts), in all three languages.
    func testTheDesignHasEveryWord() throws {
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let src = try String(contentsOf: repo.appendingPathComponent("server/android/design-62-bubbles.ts"), encoding: .utf8)
        var keys = [String]()
        for n in BubbleHides.names { keys.append("msginfo.hide." + n); keys.append("msginfo.meta." + n) }
        for s in ["created", "encrypted", "sent", "received", "decrypted", "displayed", "discarded", "queued", "stored", "forwarded", "delivered", "read", "revealed", "opened", "expired", "hidden", "unhidden"] { keys.append("msginfo.state." + s) }
        for meta in ["p2p", "relay", "code", "ttl", "vanish", "time", "signin", "user"] { keys.append("msginfo.meta." + meta) }
        for k in ["text", "file", "image", "audio", "video", "location", "tap", "vanish", "sealed", "fn", "private", "forwarded", "reply", "transcript"] { keys.append("msginfo.kind." + k) }
        keys += ["map.caption", "map.captionMine", "map.open", "file.share", "file.pages", "msg.forwardTo", "msg.showHidden", "msg.hideHidden", "msg.hiddenUntil", "msg.hiddenSignin",
                 "msginfo.when", "msginfo.sender", "msginfo.recipients", "msginfo.everyone", "msginfo.size", "msginfo.sizeText", "msginfo.sizeFile", "msginfo.verified", "msginfo.changed", "msginfo.expires",
                 "msginfo.hidden", "msginfo.kinds", "msginfo.audit", "msginfo.receipts", "msginfo.attachment", "msginfo.hideTitle", "msginfo.unhide", "msginfo.hiddenFlash", "msginfo.delete",
                 "msginfo.deleteYes", "msginfo.cancel", "msginfo.deleteAsk", "msginfo.deleted", "msginfo.auditNote"]
        for k in keys {
            XCTAssertEqual(src.components(separatedBy: "\"" + k + "\":").count - 1, 3, k + " in cs, en and de")
        }
        XCTAssertTrue(src.contains("{name}"))
    }
}
