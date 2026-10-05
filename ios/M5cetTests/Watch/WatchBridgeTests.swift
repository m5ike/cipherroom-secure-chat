// The bridge: content only while unlocked and turned on; a lock (also the real AppLock, through
// LockParticipant), "off", a sign-out and the wipe leave the watch an empty snapshot of a new generation at
// once; requests are routed to the rooms (reply → RoomModel.sendText, read → markRead, open → switchTo), once
// per id, refused when locked / off / stale / unknown, and answered on the channel they came by.

import XCTest
@testable import M5cet

@MainActor
final class WatchBridgeTests: XCTestCase {
    private func make(env: FakeWatchEnv = FakeWatchEnv()) -> (WatchBridge, FakeWatchTransport, FakeWatchEnv, CoreModels) {
        let core = WatchTest.previewCore()
        let t = FakeWatchTransport()
        let b = WatchTest.bridge(core: core, env: env, transport: t)
        return (b, t, env, core)
    }

    private func team(_ core: CoreModels) -> PreviewRoom { core.rooms.room("team") as! PreviewRoom }
    private func id(of name: String, _ s: WatchSnapshot?) -> String { s?.rooms.first { $0.name == name }?.id ?? "" }

    // MARK: when there is content

    func testOnlyWhileUnlockedAndTurnedOn() throws {
        let env = FakeWatchEnv()
        env.mirrorEnabled = false
        let (b, t, _, _) = make(env: env)
        XCTAssertIdentical(t.handler, b)
        b.publishNow()
        XCTAssertEqual(t.context?.state, .off)
        XCTAssertEqual(t.context?.rooms, [])
        env.mirrorEnabled = true
        env.unlocked = false
        b.publishNow()
        XCTAssertEqual(t.context?.state, .locked)
        XCTAssertEqual(t.context?.reason, "lock")
        XCTAssertEqual(t.context?.rooms, [])
        XCTAssertFalse(t.allJSON.contains("Ahoj"), "nothing of a room reached the watch")
        XCTAssertFalse(t.allJSON.contains("Tým"))
        env.unlocked = true
        b.publishNow()
        let s = try XCTUnwrap(t.context)
        XCTAssertEqual(s.state, .ok)
        XCTAssertEqual(s.rooms.count, 3)
        XCTAssertTrue(t.contextJSON.contains("Ahoj, jak to jde?"))
        XCTAssertNotNil(s.strings["watch.locked"], "the locked screen's words come with every snapshot")
    }

    func testNothingIsSentWithoutAWatch() {
        let (b, t, _, _) = make()
        t.canDeliver = false
        b.publishNow()
        b.refresh()
        XCTAssertTrue(t.contexts.isEmpty)
        XCTAssertNil(b.told)
        t.canDeliver = true
        b.transportChanged()
        XCTAssertEqual(t.context?.state, .ok, "paired and installed: it gets the state at once")
    }

    func testAnUnchangedSnapshotIsNotSentAgainButRefreshed() {
        let (b, t, _, _) = make()
        let clock = WatchTestClock()
        b.clock = { clock.now }
        b.publishNow()
        b.publishNow()
        XCTAssertEqual(t.contexts.count, 1, "same content: nothing new")
        clock.now += 1000
        team(b.core()).sendText("Nová zpráva z telefonu")
        b.publishNow()
        XCTAssertEqual(t.contexts.count, 2)
        XCTAssertGreaterThan(t.context?.seq ?? 0, 1)
        clock.now += WatchWire.refreshMs
        b.publishNow()
        XCTAssertEqual(t.contexts.count, 3, "the lifetime is renewed")
        XCTAssertEqual(t.context?.exp, clock.now + WatchWire.lifetimeMs)
    }

    func testAnOpenWatchAppGetsItAsAMessageToo() {
        let (b, t, _, _) = make()
        t.reachable = true
        b.publishNow()
        XCTAssertEqual(t.messages.count, 1)
        XCTAssertEqual(t.messages.last, t.contexts.last)
    }

    // MARK: leaving content

    func testALockClearsTheWatchAndStartsANewGeneration() throws {
        let (b, t, env, _) = make()
        t.reachable = true
        b.publishNow()
        let before = try XCTUnwrap(t.context)
        b.lockWillForget(receiving: nil) // the key is still here
        let locked = try XCTUnwrap(t.context)
        XCTAssertEqual(locked.state, .locked)
        XCTAssertEqual(locked.reason, "lock")
        XCTAssertEqual(locked.rooms, [])
        XCTAssertEqual(locked.unread, 0)
        XCTAssertEqual(locked.exp, 0)
        XCTAssertNotEqual(locked.epoch, before.epoch)
        XCTAssertNil(b.ids.key(for: id(of: "Tým", before)), "the old room ids are gone")
        XCTAssertEqual(t.messages.last, t.contexts.last, "an open watch app hears it at once")
        let count = t.contexts.count
        env.unlocked = false
        b.lockDidForget()
        b.publishNow()
        XCTAssertEqual(t.contexts.count, count, "said once")
        env.unlocked = true
        b.lockDidUnlock()
        let again = try XCTUnwrap(t.context)
        XCTAssertEqual(again.state, .ok)
        XCTAssertEqual(again.epoch, locked.epoch, "the unlock continues the cleared generation")
        XCTAssertNotEqual(id(of: "Tým", again), id(of: "Tým", before))
    }

    func testTurningItOffAndTheWipe() throws {
        let (b, t, env, _) = make()
        b.publishNow()
        b.setEnabled(false)
        XCTAssertEqual(t.context?.state, .off)
        XCTAssertEqual(t.context?.reason, "off")
        XCTAssertFalse(env.mirrorEnabled)
        b.setEnabled(true)
        XCTAssertEqual(t.context?.state, .ok)
        b.wiped()
        XCTAssertEqual(t.context?.state, .off)
        XCTAssertEqual(t.context?.reason, "wipe", "the watch drops its saved strings too")
        XCTAssertFalse(env.mirrorEnabled, "the switch goes with the data")
    }

    func testASignOutStartsANewGeneration() throws {
        let rooms = FakeRooms()
        rooms.add("team", name: "Tým", messages: ["Ahoj"])
        let account = FakeWatchAccount()
        let core = CoreModels(rooms: rooms, account: account)
        let t = FakeWatchTransport()
        let b = WatchTest.bridge(core: core, transport: t)
        b.publishNow()
        let first = try XCTUnwrap(t.context)
        account.signedIn = false
        b.publishNow()
        let second = try XCTUnwrap(t.context)
        XCTAssertNotEqual(second.epoch, first.epoch)
        XCTAssertNotEqual(id(of: "Tým", second), id(of: "Tým", first))
        let r = WatchTest.ask(b, WatchRequest(kind: .reply, at: 1, epoch: first.epoch, room: id(of: "Tým", first), text: "late"))
        XCTAssertEqual(r?.result?.reason, WatchResult.Reason.stale, "a reply from before the sign-out is refused")
        // Signing in again (another account) is a new generation too.
        account.signedIn = true
        account.username = "another-one"
        b.publishNow()
        XCTAssertEqual(t.contexts.count, 2, "signed out → signed in from nothing: no new generation needed")
        account.username = "third"
        b.publishNow()
        XCTAssertNotEqual(t.context?.epoch, second.epoch)
    }

    func testAFailedContextIsTriedAgain() {
        let (b, t, _, _) = make()
        t.failContext = true
        b.publishNow()
        XCTAssertNil(b.told)
        t.failContext = false
        b.publishNow()
        XCTAssertEqual(t.context?.state, .ok)
    }

    // MARK: the real lock and wipe

    func testTheAppLockAndTheWipeReachTheWatch() async throws {
        let f = try Fixture()
        try await f.lock.setUp(pin: "482915")
        let env = FakeWatchEnv()
        let (b, t, _, _) = make(env: env)
        f.center.add(b)
        f.center.wiper.addTeardown("watch") { [weak b] in b?.wiped() }
        b.publishNow()
        XCTAssertEqual(t.context?.state, .ok)
        f.lock.lockNow(remote: false)
        XCTAssertTrue(f.lock.isLocked)
        XCTAssertEqual(t.context?.state, .locked, "the lock's participants told the watch")
        XCTAssertEqual(t.context?.rooms, [])
        eq(await f.lock.unlock(pin: "482915"), .ok)
        XCTAssertEqual(t.context?.state, .ok, "the unlock brings it back")
        f.center.wipe(reason: "attempts", remote: false, attempts: 8)
        XCTAssertEqual(t.context?.state, .off)
        XCTAssertEqual(t.context?.reason, "wipe")
        XCTAssertFalse(env.mirrorEnabled)
    }

    func testTheAppEnvironmentFailsClosed() {
        let model = AppModel()
        let suite = "m5.watch.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let env = AppWatchEnvironment(model: model, defaults: defaults)
        XCTAssertFalse(env.mirrorEnabled, "off by default")
        env.setMirrorEnabled(true)
        XCTAssertTrue(env.mirrorEnabled)
        XCTAssertTrue(defaults.bool(forKey: WatchSetting.defaultsKey))
        env.isUnlocked = { false }
        XCTAssertFalse(env.unlocked)
        env.operatorMaxPrivacy = { "room" }
        XCTAssertLessThanOrEqual(env.privacyLevel, WatchPrivacy.room)
        // The design's own words where it has them, English for the watch's new keys.
        XCTAssertEqual(WatchTexts.t("notify.reply", env), model.design.design.text("notify.reply", lang: model.design.lang))
        XCTAssertEqual(WatchTexts.t("watch.locked", env), env.text("watch.locked") ?? "Locked on iPhone")
        XCTAssertEqual(WatchTexts.t("app", env), model.design.design.appName)
    }

    // MARK: requests

    func testAReplyGoesToTheRoomOnce() throws {
        let (b, t, _, core) = make()
        b.publishNow()
        let s = try XCTUnwrap(t.context)
        let room = id(of: "Tým", s)
        let before = team(core).messages.count
        let req = WatchRequest(kind: .reply, at: 1, epoch: s.epoch, room: room, text: "  Jsem na cestě\u{202E} 🚲  ")
        let answer = try XCTUnwrap(WatchTest.ask(b, req)?.result)
        XCTAssertTrue(answer.ok)
        XCTAssertEqual(answer.id, req.id)
        XCTAssertEqual(team(core).messages.count, before + 1)
        let sent = try XCTUnwrap(team(core).messages.last)
        XCTAssertEqual(sent.text, "Jsem na cestě 🚲", "cleaned as a message")
        XCTAssertTrue(sent.mine)
        XCTAssertEqual(answer.sent, sent.id)
        // The same request again (a message that timed out, re-sent through the queue): the first answer, no copy.
        XCTAssertNil(WatchTest.ask(b, req, channel: .queue), "a queued request is answered by a user info")
        let again = try XCTUnwrap(t.userInfos.last.flatMap { try? WatchEnvelope.decode($0).result })
        XCTAssertEqual(again, answer)
        XCTAssertEqual(team(core).messages.count, before + 1)
    }

    func testRepliesAreRefusedWhenTheyMayNotGo() throws {
        let (b, t, env, _) = make()
        b.publishNow()
        let s = try XCTUnwrap(t.context)
        let room = id(of: "Tým", s)
        func reason(_ r: WatchRequest) -> String? { WatchTest.ask(b, r)?.result?.reason }
        XCTAssertEqual(reason(WatchRequest(kind: .reply, at: 1, epoch: "otherepoch", room: room, text: "x")), WatchResult.Reason.stale)
        XCTAssertEqual(reason(WatchRequest(kind: .reply, at: 1, epoch: s.epoch, room: "rnosuchroom", text: "x")), WatchResult.Reason.unknownRoom)
        XCTAssertEqual(reason(WatchRequest(kind: .reply, at: 1, epoch: s.epoch, room: id(of: "project-x", s), text: "x")), WatchResult.Reason.notOpen)
        XCTAssertEqual(reason(WatchRequest(kind: .reply, at: 1, epoch: s.epoch, room: room, text: "\u{202E}\u{200B} ")), WatchResult.Reason.empty)
        env.unlocked = false
        XCTAssertEqual(reason(WatchRequest(kind: .reply, at: 1, epoch: s.epoch, room: room, text: "x")), WatchResult.Reason.locked)
        env.mirrorEnabled = false
        XCTAssertEqual(reason(WatchRequest(kind: .reply, at: 1, epoch: s.epoch, room: room, text: "x")), WatchResult.Reason.off)
        XCTAssertEqual(team(b.core()).messages.filter { $0.text == "x" }.count, 0, "nothing was sent")
    }

    func testMarkReadAndOpen() throws {
        let rooms = FakeRooms()
        let session = try XCTUnwrap(rooms.add("family", name: "Rodina", unread: 3, messages: ["a", "b", "c"]))
        let core = CoreModels(rooms: rooms, account: PreviewAccount())
        let t = FakeWatchTransport()
        let b = WatchTest.bridge(core: core, transport: t)
        b.publishNow()
        let s = try XCTUnwrap(t.context)
        let room = id(of: "Rodina", s)
        let read = WatchTest.ask(b, WatchRequest(kind: .read, at: 1, epoch: s.epoch, room: room, ids: ["family-m0", "family-m2", "not-here"]))
        XCTAssertEqual(read?.result?.ok, true)
        XCTAssertEqual(session.unread, 0, "markRead reached the room")
        let open = WatchTest.ask(b, WatchRequest(kind: .open, at: 1, epoch: s.epoch, room: room))
        XCTAssertEqual(open?.result?.ok, true)
        XCTAssertEqual(rooms.switched, ["family"])
    }

    func testChannelsAndBadPayloads() throws {
        let (b, t, _, _) = make()
        // sync over a message: the snapshot is the reply.
        let synced = try XCTUnwrap(WatchTest.ask(b, WatchRequest(kind: .sync, at: 1)))
        XCTAssertEqual(synced.t, "snapshot")
        XCTAssertEqual(synced.snapshot?.state, .ok)
        XCTAssertEqual(synced.snapshot, t.context)
        // Through the queue: the result goes back as a user info.
        let s = try XCTUnwrap(t.context)
        XCTAssertNil(WatchTest.ask(b, WatchRequest(kind: .open, at: 1, epoch: s.epoch, room: id(of: "Tým", s)), channel: .queue))
        XCTAssertEqual(t.userInfos.count, 1)
        XCTAssertEqual(try WatchEnvelope.decode(t.userInfos[0]).result?.ok, true)
        // Without a reply handler: done, nothing to answer.
        XCTAssertNil(WatchTest.ask(b, WatchRequest(kind: .open, at: 1, epoch: s.epoch, room: id(of: "Tým", s)), channel: .messageNoReply))
        // Garbage: no answer; a known id of an invalid or newer request: refused by name.
        XCTAssertNil(b.received(Data("nonsense".utf8), channel: .message))
        XCTAssertNil(b.received(Data(count: WatchWire.maxRequestBytes + 1), channel: .message))
        let invalid = Data(#"{"v":1,"t":"request","request":{"id":"bad00001","kind":"reply","at":1,"epoch":"","room":"","text":"","ids":[]}}"#.utf8)
        let refused = try XCTUnwrap(b.received(invalid, channel: .message).flatMap { try? WatchEnvelope.decode($0).result })
        XCTAssertEqual(refused, .refused("bad00001", WatchResult.Reason.invalid))
        let newer = Data(#"{"v":2,"t":"request","request":{"id":"new00001","kind":"teleport"}}"#.utf8)
        let old = try XCTUnwrap(b.received(newer, channel: .message).flatMap { try? WatchEnvelope.decode($0).result })
        XCTAssertEqual(old, .refused("new00001", WatchResult.Reason.version))
        // A snapshot sent to the phone is not a request: ignored.
        XCTAssertNil(b.received(try WatchEnvelope.snapshot(s).encoded(), channel: .message))
    }
}
