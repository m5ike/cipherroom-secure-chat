// The snapshot from the sample core (PreviewCore: a room with every kind of message): the limits, the privacy
// levels as the notifications apply them, placeholders instead of whatever the phone keeps behind a step or
// never sends (seals, hold-to-read, vanishing, hidden, held, files, positions), and the size budget.

import M5Core
import M5Proto
import XCTest
@testable import M5cet

@MainActor
final class WatchSnapshotBuilderTests: XCTestCase {
    private func snapshot(level: Int, core: CoreModels = WatchTest.previewCore()) -> (WatchSnapshot, String) {
        let env = FakeWatchEnv()
        env.privacyLevel = level
        let b = WatchTest.bridge(core: core, env: env)
        let s = b.build(now: WatchTest.now)
        let json = String(decoding: try! WatchEnvelope.snapshot(s).encoded(), as: UTF8.self)
        XCTAssertNoThrow(try WatchEnvelope.decode(Data(json.utf8)), "what the phone makes passes its own checks")
        return (s, json)
    }

    func testTheSampleRoomsAtTheContentLevel() throws {
        let (s, json) = snapshot(level: WatchPrivacy.content)
        XCTAssertEqual(s.state, .ok)
        XCTAssertEqual(s.exp, WatchTest.now + WatchWire.lifetimeMs)
        XCTAssertEqual(s.rooms.count, 3, "team, family and the saved project-x")
        XCTAssertEqual(Set(s.rooms.map(\.name)), ["Tým", "Rodina", "project-x"])
        XCTAssertFalse(json.contains("\"team\""), "a room's key never goes, only an opaque id")
        let team = try XCTUnwrap(s.rooms.first { $0.name == "Tým" })
        let saved = try XCTUnwrap(s.rooms.first { $0.name == "project-x" })
        XCTAssertNil(saved.messages, "a saved room has no session: no messages")
        XCTAssertFalse(saved.reply)
        XCTAssertEqual(saved.status, "saved")
        XCTAssertTrue(team.reply)
        let byId = Dictionary(uniqueKeysWithValues: (team.messages ?? []).map { ($0.id, $0) })
        // m1 text; m2 mine; m3 a file; m4 a position; m5 sealed (opened on the phone!); m6 hold to read; m7 vanishing.
        XCTAssertEqual(byId["m1"]?.kind, WatchKind.text)
        XCTAssertEqual(byId["m1"]?.text, "Ahoj, jak to jde?")
        XCTAssertEqual(byId["m1"]?.sender, "Alice")
        XCTAssertEqual(byId["m2"]?.mine, true)
        XCTAssertEqual(byId["m2"]?.sender, "", "my own has no sender")
        XCTAssertEqual(byId["m2"]?.status, "read")
        XCTAssertEqual(byId["m3"]?.kind, WatchKind.file)
        XCTAssertEqual(byId["m3"]?.text, "")
        XCTAssertEqual(byId["m4"]?.kind, WatchKind.location)
        XCTAssertEqual(byId["m4"]?.text, "", "no coordinates")
        XCTAssertEqual(byId["m5"]?.kind, WatchKind.sealed)
        XCTAssertEqual(byId["m5"]?.text, "")
        XCTAssertEqual(byId["m6"]?.kind, WatchKind.tap)
        XCTAssertEqual(byId["m6"]?.text, "")
        XCTAssertEqual(byId["m7"]?.kind, WatchKind.vanish)
        XCTAssertEqual(byId["m7"]?.text, "")
        XCTAssertEqual(byId["m9"]?.text, "Super, jdu na to 👍")
        XCTAssertEqual(team.preview, "Alice: Super, jdu na to 👍")
        // Never anywhere in the payload: positions, the sealed text and its code, file names, the vault id.
        for secret in ["50.088", "14.420", "openstreetmap", "Tajný kód", "K7Q2", "plan.pdf", "in-sample", "sample-passphrase", "BKey"] {
            XCTAssertFalse(json.contains(secret), "\(secret) left the phone")
        }
        // The system line stays at this level; the strings are the watch's.
        XCTAssertTrue(team.messages?.contains { $0.kind == WatchKind.sys && $0.text == "Alice joined" } ?? false)
        XCTAssertEqual(Set(s.strings.keys), Set(WatchWire.english.keys))
        XCTAssertEqual(s.quick, ["OK", "Yes", "No", "On my way", "I'll write later"])
    }

    func testNeutralShowsNoNameSenderOrText() throws {
        let (s, json) = snapshot(level: WatchPrivacy.neutral)
        XCTAssertEqual(s.rooms.map(\.name).sorted(), ["Conversation 1", "Conversation 2", "Conversation 3"])
        for m in s.rooms.flatMap({ $0.messages ?? [] }) {
            XCTAssertEqual(m.kind, WatchKind.neutral)
            XCTAssertEqual(m.text, "")
            XCTAssertEqual(m.sender, "")
        }
        XCTAssertFalse(s.rooms.flatMap { $0.messages ?? [] }.contains { $0.id.hasPrefix("sys-") }, "system lines name people")
        for word in ["Tým", "Rodina", "project-x", "Alice", "Bob", "Ahoj", "Super"] {
            XCTAssertFalse(json.contains(word), "\(word) at the neutral level")
        }
        let family = try XCTUnwrap(s.rooms.first { $0.unread == 7 })
        XCTAssertEqual(family.preview, "New message", "unread: the neutral words")
        XCTAssertTrue(s.rooms.filter { $0.unread == 0 }.allSatisfy { $0.preview.isEmpty })
    }

    func testSenderAndRoomLevels() throws {
        let (sender, senderJSON) = snapshot(level: WatchPrivacy.sender)
        XCTAssertTrue(sender.rooms.allSatisfy { $0.name.hasPrefix("Conversation ") }, "no room names below 'room'")
        let senders = Set(sender.rooms.flatMap { $0.messages ?? [] }.map(\.sender))
        XCTAssertTrue(senders.contains("Alice"))
        XCTAssertFalse(senderJSON.contains("Ahoj"), "no text below 'content'")
        let (room, roomJSON) = snapshot(level: WatchPrivacy.room)
        XCTAssertEqual(Set(room.rooms.map(\.name)), ["Tým", "Rodina", "project-x"])
        XCTAssertFalse(roomJSON.contains("Ahoj"))
        XCTAssertFalse(roomJSON.contains("Super, jdu"))
        XCTAssertTrue(room.rooms.flatMap { $0.messages ?? [] }.allSatisfy { $0.kind == WatchKind.neutral && $0.text.isEmpty })
    }

    func testTheDesignsTextsAreUsed() throws {
        let env = FakeWatchEnv()
        env.privacyLevel = WatchPrivacy.neutral
        env.lang = "cs"
        env.texts = ["conversations.neutral": "Konverzace {n}", "notify.message": "Nová zpráva", "watch.quick.1": "Jasně", "watch.quick.2": "",
                     "notify.reply": "Odpovědět\u{202E}"]
        let b = WatchTest.bridge(core: WatchTest.previewCore(), env: env)
        let s = b.build(now: WatchTest.now)
        XCTAssertEqual(s.lang, "cs")
        XCTAssertTrue(s.rooms.allSatisfy { $0.name.hasPrefix("Konverzace ") })
        XCTAssertEqual(s.strings["notify.message"], "Nová zpráva")
        XCTAssertEqual(s.strings["notify.reply"], "Odpovědět", "cleaned for the wire")
        XCTAssertEqual(s.strings["watch.locked"], "Locked on iPhone", "a key the design lacks: English")
        XCTAssertEqual(s.quick.first, "Jasně")
        XCTAssertEqual(s.quick.count, 4, "an empty quick reply is left out")
    }

    func testHiddenHeldAndExpiredMessages() throws {
        let core = WatchTest.previewCore()
        let team = try XCTUnwrap(core.rooms.room("team") as? PreviewRoom)
        team.hide("m1", until: ChatMessage.untilSignIn, unlock: nil, why: nil)
        team.hide("m9", until: WatchTest.now + 60_000, unlock: nil, why: nil)
        team.touch("m2") { $0.changed = true }
        let past = WatchTest.now - 1
        team.touch("m3") { $0.expiresAt = past }
        team.touch("m6") { $0.deleted = true }
        let (s, json) = snapshot(level: WatchPrivacy.content, core: core)
        let byId = Dictionary(uniqueKeysWithValues: (s.rooms.first { $0.name == "Tým" }?.messages ?? []).map { ($0.id, $0) })
        XCTAssertEqual(byId["m1"]?.kind, WatchKind.hidden)
        XCTAssertEqual(byId["m9"]?.kind, WatchKind.hidden)
        XCTAssertEqual(byId["m2"]?.kind, WatchKind.held)
        XCTAssertNil(byId["m3"], "expired")
        XCTAssertNil(byId["m6"], "deleted here")
        XCTAssertFalse(json.contains("Ahoj, jak"))
        XCTAssertFalse(json.contains("Super, jdu"))
        XCTAssertFalse(json.contains("Dobře, díky"))
    }

    func testMediaAndCommandKinds() {
        func kind(_ edit: (inout ChatMessage) -> Void) -> String {
            var m = ChatMessage()
            m.id = "x1"
            edit(&m)
            return WatchSnapshotBuilder.kind(of: m, held: false, now: WatchTest.now)
        }
        XCTAssertEqual(kind { $0.fileName = "a.jpg"; $0.fileMime = "image/jpeg" }, WatchKind.image)
        XCTAssertEqual(kind { $0.fileName = "x"; $0.fileImage = true }, WatchKind.image)
        XCTAssertEqual(kind { $0.fileName = "v.m4a"; $0.fileMime = "audio/mp4" }, WatchKind.audio)
        XCTAssertEqual(kind { $0.fileName = "v.mp4"; $0.fileMime = "video/mp4" }, WatchKind.video)
        XCTAssertEqual(kind { $0.fileName = "a.pdf"; $0.fileMime = "application/pdf" }, WatchKind.file)
        XCTAssertEqual(kind { $0.fn = JSONObject([("keyword", "hlr")]) }, WatchKind.fn)
        XCTAssertEqual(kind { $0.kind = "note" }, WatchKind.note)
        XCTAssertEqual(kind { $0.kind = "sys" }, WatchKind.sys)
        XCTAssertEqual(kind { $0.sealed = JSONObject([("v", 1)]); $0.tap = true }, WatchKind.sealed, "the strictest step first")
        XCTAssertEqual(kind { $0.tap = true; $0.fileName = "a.jpg" }, WatchKind.tap)
        XCTAssertEqual(kind { $0.vanishSeconds = 10; $0.loc = JSONObject([("lat", 1)]) }, WatchKind.vanish)
        var cmd = ChatMessage()
        cmd.fn = JSONObject([("keyword", "hlr")])
        cmd.text = "+420 777"
        XCTAssertEqual(WatchSnapshotBuilder.text(of: cmd, kind: WatchKind.fn, max: 280), "/hlr · +420 777")
        var caption = ChatMessage()
        caption.fileName = "a.jpg"
        caption.text = "Dovolená"
        XCTAssertEqual(WatchSnapshotBuilder.text(of: caption, kind: WatchKind.image, max: 280), "Dovolená", "a caption, never the name")
    }

    func testLimitsAndTheBudget() throws {
        let rooms = FakeRooms()
        let long = String(repeating: "Příliš žluťoučký kůň úpěl ďábelské ódy 🐎 ", count: 12)
        for i in 0..<20 {
            rooms.add("room\(i)", name: "Room \(i)", unread: i, messages: (0..<80).map { "\(i)-\($0) " + long }, at: PreviewCore.t0 + Int64(i) * 1000)
        }
        let core = CoreModels(rooms: rooms, account: PreviewAccount())
        let b = WatchTest.bridge(core: core)
        let s = b.build(now: WatchTest.now)
        let data = try WatchEnvelope.snapshot(s).encoded()
        XCTAssertLessThanOrEqual(data.count, WatchWire.snapshotBudget, "shrunk to the budget")
        XCTAssertNoThrow(try WatchEnvelope.decode(data))
        XCTAssertLessThanOrEqual(s.rooms.count, WatchWire.maxRooms)
        XCTAssertLessThanOrEqual(s.rooms.filter { $0.messages != nil }.count, WatchWire.maxRoomsWithMessages)
        // The newest messages of the first rooms (the list's order) are the ones kept.
        let first = try XCTUnwrap(s.rooms.first)
        XCTAssertEqual(first.name, "Room 0")
        let kept = try XCTUnwrap(first.messages)
        XCTAssertFalse(kept.isEmpty)
        XCTAssertEqual(kept.last?.id, "room0-m79", "the newest stays")
        XCTAssertTrue(kept.allSatisfy { $0.text.count <= WatchWire.maxText })
        // Small rooms: every limit at its full value.
        let small = FakeRooms()
        for i in 0..<15 { small.add("s\(i)", name: "S\(i)", messages: (0..<40).map { "m\($0)" }) }
        let full = WatchTest.bridge(core: CoreModels(rooms: small, account: PreviewAccount())).build(now: WatchTest.now)
        XCTAssertEqual(full.rooms.count, WatchWire.maxRooms)
        XCTAssertEqual(full.rooms.filter { $0.messages != nil }.count, WatchWire.maxRoomsWithMessages)
        XCTAssertEqual(full.rooms.first?.messages?.count, WatchWire.maxMessages)
        XCTAssertEqual(full.rooms.first?.messages?.last?.text, "m39")
    }

    func testRoomIdsAreOpaqueAndStableUntilAClear() {
        let ids = WatchRoomIds()
        let a = ids.entry(for: "team"), b = ids.entry(for: "family")
        XCTAssertEqual(ids.entry(for: "team").id, a.id)
        XCTAssertNotEqual(a.id, b.id)
        XCTAssertEqual([a.n, b.n], [1, 2])
        XCTAssertFalse(a.id.contains("team"))
        XCTAssertEqual(ids.key(for: a.id), "team")
        XCTAssertNil(WatchRoomIds().key(for: a.id), "a new generation knows none")
    }

    func testPrivacyLevels() {
        XCTAssertEqual(WatchPrivacy.local(chosen: "", operatorMax: "content"), WatchPrivacy.content, "the app's own default shows content")
        XCTAssertEqual(WatchPrivacy.local(chosen: "sender", operatorMax: "content"), WatchPrivacy.sender)
        XCTAssertEqual(WatchPrivacy.local(chosen: "", operatorMax: "room"), WatchPrivacy.room, "the operator's maximum")
        XCTAssertEqual(WatchPrivacy.local(chosen: "content", operatorMax: "neutral"), WatchPrivacy.neutral)
        XCTAssertEqual(WatchPrivacy.local(chosen: "content", operatorMax: "nonsense"), WatchPrivacy.neutral, "an unknown maximum is neutral")
        XCTAssertEqual(WatchPrivacy.local(chosen: "nonsense", operatorMax: "content"), WatchPrivacy.neutral)
    }
}
