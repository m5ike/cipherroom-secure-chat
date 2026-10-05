// The notification extension's path through the shared code, with the app's
// real formats: the SYS tier written by Platform/Security's Vault and read back
// by SysTierReader (sys.key unwrapped with the "sys" key, records opened), the
// device's encryption key from its keychain item, a control message sealed and
// signed as the server does it (and the server's own recording), the lock
// mirror's rules, the handoff to the app and the opaque thread ids.

import CryptoKit
import Foundation
import M5Crypto
import M5Net
import XCTest
@testable import M5cet

@MainActor
final class ExtensionPathTests: XCTestCase {
    /// A SecurityCenter of throwaway parts whose SYS tier holds an enrolled device's records.
    private func enrolled(_ fx: Fixture, server: TestControlServer, deviceId: String = "ios_ext0001") throws -> SysTierReader {
        let store = VaultNetStateStore(vault: fx.vault)
        store.saveNow("config", DeviceState(server: "https://chat.example.com", deviceId: deviceId, serverKey: server.spki, serverKid: server.kid).json)
        var mirror = NotifyMirror()
        mirror.appName = "Our Chat"
        store.saveNow(NotifyMirror.record, try NetJSON.parse(mirror.data))
        _ = try fx.center.agreement() // the encryption key exists from the enrolment on
        let memory = fx.sharedStore
        return SysTierReader(shared: fx.center.paths.shared) { name in try? memory.read(name) }
    }

    func testTheExtensionOpensWhatTheAppKeeps() throws {
        let fx = try Fixture()
        let server = TestControlServer()
        let reader = try enrolled(fx, server: server)
        let ctx = try reader.context()
        XCTAssertEqual(ctx.deviceId, "ios_ext0001")
        XCTAssertEqual(ctx.serverKey, server.spki)
        XCTAssertEqual(ctx.prefs.appName, "Our Chat")
        // A notify message sealed for this device's key, signed by the server.
        let enc = try fx.center.agreement().spki
        let w = server.wire(id: "n1", kind: "notify", payload: ["kind": "message", "privacy": "sender", "vars": ["sender": "Bob"],
                                                               "tpl": ["title": "{app}", "body": "{sender} wrote"]],
                            device: enc, deviceId: ctx.deviceId)
        let opened = try PushOpener.open(w, deviceId: ctx.deviceId, serverKey: ctx.serverKey, now: 1, agree: ctx.agree)
        XCTAssertEqual(opened.kind, "notify")
        let plan = PushContent.control(kind: opened.kind, payload: opened.payload, locked: false, prefs: ctx.prefs, previewsAlways: false, now: 1,
                                       texts: PushContent.defaultTexts("en"))
        XCTAssertEqual(plan.title, "Our Chat")
        XCTAssertEqual(plan.body, "Bob wrote")
        XCTAssertEqual(plan.sender, "Bob")
        // The same message while the app is locked.
        let locked = PushContent.control(kind: opened.kind, payload: opened.payload, locked: true, prefs: ctx.prefs, previewsAlways: false, now: 1,
                                         texts: PushContent.defaultTexts("en"))
        XCTAssertEqual([locked.title, locked.body], ["Our Chat", "New message"])
        XCTAssertNil(locked.sender)
    }

    func testNothingOpensWithoutTheRightKeys() throws {
        let fx = try Fixture()
        let server = TestControlServer()
        let reader = try enrolled(fx, server: server)
        // No keychain: nothing at all.
        let blind = SysTierReader(shared: fx.center.paths.shared) { _ in nil }
        XCTAssertThrowsError(try blind.context())
        // Another device's App Group: nothing.
        let shared = fx.sharedStore
        XCTAssertThrowsError(try SysTierReader(shared: TempDir().url) { name in try? shared.read(name) }.context())
        // The app-only group's items are not what the extension reads (the "sys" key is in the shared group).
        let appOnly = fx.store
        XCTAssertThrowsError(try SysTierReader(shared: fx.center.paths.shared) { name in try? appOnly.read(name) }.context())
        // A record swapped for another's does not open (AAD "SYS|<name>").
        let dir = fx.center.paths.shared.appendingPathComponent("sys")
        try FileManager.default.removeItem(at: dir.appendingPathComponent("notify-prefs.bin"))
        try FileManager.default.copyItem(at: dir.appendingPathComponent("config.bin"), to: dir.appendingPathComponent("notify-prefs.bin"))
        let key = try reader.sysKey()
        XCTAssertThrowsError(try reader.record("notify-prefs", key: key))
        XCTAssertNotNil(try reader.record("config", key: key))
        // The user tier is never in the App Group.
        XCTAssertFalse(FileManager.default.fileExists(atPath: fx.center.paths.shared.appendingPathComponent("user").path))
    }

    func testTheServersOwnSealedCommandOpens() throws {
        let s = PushFixtures.ios
        let wire = try XCTUnwrap(s.obj("checkin")?.arr("commands")?.first)
        var w: [String: String] = [:]
        for (k, v) in wire.objectValue ?? [:] { w[k] = v.stringValue }
        let agree = KeyringEciesOpener(agreement: FixtureKeys.pair).agree
        let o = try PushOpener.open(w, deviceId: PushFixtures.deviceId, serverKey: PushFixtures.serverKey, now: PushFixtures.checkinTime, agree: agree)
        XCTAssertEqual(o.kind, "lock")
        XCTAssertEqual(o.payload["reason"] as? String, "lost")
        XCTAssertEqual(o.id, s.str("commandId"))
        XCTAssertGreaterThan(o.exp, PushFixtures.checkinTime)
        // As APNs carries it (under "m5").
        XCTAssertEqual(PushOpener.wire(from: ["aps": ["alert": ["title": "M5cet", "body": "Security notice"]], "m5": wire.foundation])?["i"], o.id)
        // A week later it has expired; another device or a changed byte does not open.
        XCTAssertThrowsError(try PushOpener.open(w, deviceId: PushFixtures.deviceId, serverKey: PushFixtures.serverKey, now: o.exp + 1, agree: agree)) {
            XCTAssertEqual($0 as? PushOpener.Failure, .expired)
        }
        XCTAssertThrowsError(try PushOpener.open(w, deviceId: "ios_other", serverKey: PushFixtures.serverKey, now: 1, agree: agree)) {
            XCTAssertEqual($0 as? PushOpener.Failure, .notSigned)
        }
        var changed = w
        changed["ct"] = String(w["ct"]!.dropLast(4)) + "AAAA"
        XCTAssertThrowsError(try PushOpener.open(changed, deviceId: PushFixtures.deviceId, serverKey: PushFixtures.serverKey, now: 1, agree: agree))
        XCTAssertThrowsError(try PushOpener.open(w, deviceId: "", serverKey: PushFixtures.serverKey, now: 1, agree: agree)) {
            XCTAssertEqual($0 as? PushOpener.Failure, .notEnrolled)
        }
    }

    func testTheLockMirrorsRules() throws {
        let boot = "boot-A"
        XCTAssertTrue(LockMirror(locked: true, boot: boot).isLocked(nowMono: 0, boot: boot))
        XCTAssertFalse(LockMirror(locked: false, boot: boot).isLocked(nowMono: 10_000_000, boot: boot), "in the foreground")
        let bg = LockMirror(locked: false, bg: 1_000, bgMono: 5_000_000, boot: boot, autolock: 60)
        XCTAssertFalse(bg.isLocked(nowMono: 5_059_999, boot: boot))
        XCTAssertTrue(bg.isLocked(nowMono: 5_060_000, boot: boot), "the auto-lock passed (monotonic: setting the clock changes nothing)")
        XCTAssertTrue(bg.isLocked(nowMono: 5_000_001, boot: "boot-B"), "another boot: the app starts locked")
        XCTAssertTrue(LockMirror(locked: false, bg: 1, bgMono: 1, boot: boot, autolock: 0).isLocked(nowMono: 1, boot: boot))
        // What the app writes (SecurityCenter.writeMirror) reads back; nothing readable = locked.
        let fx = try Fixture()
        fx.center.writeMirror()
        let m = try XCTUnwrap(LockMirror(data: Data(contentsOf: fx.center.paths.lockState)))
        XCTAssertEqual(m.boot, "boot-A")
        XCTAssertEqual(m.autolock, 60)
        XCTAssertTrue(LockMirror.appLocked(at: TempDir().url.appendingPathComponent("lock-state.json")))
        XCTAssertNil(LockMirror(data: Data("[]".utf8)))
    }

    func testTheHandoffToTheApp() {
        let dir = TempDir()
        let h = PushHandoff(shared: dir.url)
        h.record(.init(id: "cmd_b", kind: "wipe", shown: true, wire: ["i": "cmd_b"], at: 2))
        h.record(.init(id: "cmd_a", kind: "notify", shown: true, wire: nil, at: 1))
        h.record(.init(id: "../escape", kind: "x", shown: true, wire: nil, at: 1))
        XCTAssertEqual(h.entries().map(\.id), ["cmd_a", "cmd_b"])
        XCTAssertEqual(h.entry("cmd_b")?.wire?["i"], "cmd_b")
        h.remove("cmd_a")
        XCTAssertNil(h.entry("cmd_a"))
        h.purge(olderThan: 1, now: 10)
        XCTAssertTrue(h.entries().isEmpty)
    }

    func testThreadsAreOpaqueAndTheServersRoomJoinsTheRoomsThread() throws {
        let store = MemorySyncStateStore()
        let c = Conversations(store: store)
        let secret = c.secret
        XCTAssertEqual(secret.count, 16)
        XCTAssertEqual(c.secret, secret, "made once")
        XCTAssertEqual(Conversations(store: store).secret, secret, "kept")
        let id = c.id("rodina-tajne-heslo")
        XCTAssertFalse(id.contains("rodina"))
        XCTAssertEqual(c.room(of: id, among: ["prace", "rodina-tajne-heslo"]), "rodina-tajne-heslo")
        XCTAssertNil(c.room(of: id, among: ["prace"]), "only a room the app is in")
        // Before the app knows the server's id: a thread of its own; after: the room's.
        let before = c.thread(forServerRoom: "srv-1")
        XCTAssertTrue(before.hasPrefix("srv-"))
        c.noteServerRoom(roomKey: "rodina-tajne-heslo", serverId: "srv-1")
        XCTAssertEqual(c.thread(forServerRoom: "srv-1"), id)
        // What the extension reads: the same mapping from the records.
        let threads = store.loadNow("threads")?.obj("t")?.objectValue ?? [:]
        XCTAssertEqual(threads[ThreadIds.serverRoom(secret: secret, serverRoomId: "srv-1")]?.stringValue, id)
        XCTAssertEqual(ThreadIds.secret(fromRecord: store.loadNow(ThreadIds.record)?.foundation), secret)
    }

    func testTheLockDeletesTheDonations() {
        let c = Conversations(store: MemorySyncStateStore())
        var deleted: [[String]?] = []
        c.deleteDonations = { deleted.append($0) }
        c.donatedNamed()
        XCTAssertTrue(c.hasNamedDonations)
        c.locked()
        XCTAssertEqual(deleted.count, 1)
        XCTAssertNil(deleted[0])
        XCTAssertFalse(c.hasNamedDonations)
        c.roomsGone(["a"])
        XCTAssertEqual(deleted.last??.first, c.id("a"))
        c.isLocked = { true }
        XCTAssertFalse(c.namesNow, "never while locked")
    }
}
