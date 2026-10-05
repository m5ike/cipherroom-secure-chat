// The rooms' calls through CallKit (with a fake provider and controller):
// ring → answer / decline / missed / remote hang-up, outgoing → connected →
// hang up, mute and hold, CallKit refusing (direct), the privacy of what is
// shown, and VoIP pushes — each reported to CallKit before the handler returns.
//
// The rooms here are real RoomRtc objects: a member's audio going live is the
// room's "audio-status" message (peerAudioStatus), exactly what CallTrack sees.

import XCTest
@testable import M5cet

@MainActor
final class CallRig {
    let provider = FakeProvider()
    let controller = FakeController()
    let directory = FakeDirectory()
    let env = FakeEnvironment()
    let vault = FakeVault()
    let history: AppCallHistory
    let engine = testEngine()
    let center: CallCenter
    var clock: Int64 = 1_760_000_000_000
    var rooms: [String: RoomRtc] = [:]
    var links: [String: RecordingLink] = [:]
    var missed: [(String, String)] = []

    init() {
        history = AppCallHistory(vault: vault)
        center = CallCenter(provider: provider, controller: controller, environment: env)
        controller.center = center
        center.directory = directory
        center.history = history
        center.rooms = { [unowned self] in self.rooms[$0] }
        center.now = { [unowned self] in self.clock }
        center.timing = .init(ring: .milliseconds(400), pushWait: .milliseconds(200), join: .seconds(3),
                              joinQuiet: .milliseconds(300), poll: .milliseconds(20))
        center.onMissed = { [unowned self] key, who, _, _ in self.missed.append((key, who)) }
        directory.labels = ["team": "Team", "family": "Family"]
        history.now = { [unowned self] in self.clock }
    }

    /// The room connects (the room session attaches it).
    @discardableResult
    func room(_ key: String = "team") -> RoomRtc {
        if let r = rooms[key] { return r }
        let r = RoomRtc(roomKey: key, label: directory.labels[key] ?? key, engine: engine)
        let link = RecordingLink()
        r.link = link
        r.events = center
        r.history = history
        r.now = { [unowned self] in self.clock }
        rooms[key] = r
        links[key] = link
        return r
    }

    /// A member of the room whose audio goes live / off (its audio-status message).
    func member(_ name: String, in key: String = "team", _ status: CallAudioState) {
        let r = room(key)
        let id = "peer-" + name.lowercased()
        if r.peer(id) == nil { r.addPeer(id: id, name: name, initiator: true) }
        r.peerAudioStatus(status.rawValue, from: id)
    }

    /// Time passes beyond CallTrack's grace and the room changes again (any change re-reads the call).
    func afterGrace(_ key: String = "team") {
        clock += CallTrack.graceMs + 1
        let r = room(key)
        if let p = r.peers.first { r.renamePeer(id: p.id, name: p.name + " ") }
    }

    var onlyCall: CallCenter.Call? { center.calls.values.first }
}

private final class Opener: VoIPPayloadOpening {
    var invite: VoIPCallInvite?
    func openCallInvite(_ payload: [AnyHashable: Any]) -> VoIPCallInvite? { invite }
}

@MainActor
final class CallCenterTests: XCTestCase {
    // MARK: incoming

    func testSomeonesCallRingsAndIsAnswered() async throws {
        let rig = CallRig()
        rig.member("Alice", .live)
        let (uuid, shown) = try XCTUnwrap(rig.provider.incoming.first)
        XCTAssertEqual(rig.provider.incoming.count, 1)
        XCTAssertEqual(shown.name, "Alice · Team", "the person and the room at the full privacy level")
        XCTAssertTrue(shown.handle.hasPrefix("m5cet-"))
        XCTAssertFalse(shown.handle.contains("team"), "never the room")
        XCTAssertEqual(rig.center.calls[uuid]?.phase, .ringing)

        XCTAssertTrue(rig.center.performAnswer(uuid))
        let room = rig.room()
        XCTAssertTrue(room.inCall)
        XCTAssertEqual(rig.center.calls[uuid]?.phase, .active)
        XCTAssertEqual(rig.directory.opened, ["team"])
        XCTAssertEqual(rig.links["team"]?.statuses.last, .live, "the others hear me")

        rig.clock += 42_000
        XCTAssertTrue(rig.center.performEnd(uuid))
        XCTAssertFalse(room.inCall)
        XCTAssertNil(rig.center.calls[uuid])
        let kept = rig.history.load()
        XCTAssertEqual(kept.map(\.callKind), [.incoming])
        XCTAssertEqual(kept.first?.seconds, 42)
        XCTAssertEqual(kept.first?.people, ["Alice"])
        XCTAssertTrue(rig.provider.ended.isEmpty, "CallKit ended it itself: nothing to report")
    }

    func testDeclinedWhileRingingIsADeclinedCall() throws {
        let rig = CallRig()
        rig.member("Alice", .live)
        let uuid = try XCTUnwrap(rig.provider.incoming.first?.0)
        XCTAssertTrue(rig.center.performEnd(uuid))
        XCTAssertFalse(rig.room().inCall)
        rig.member("Alice", .off)
        rig.afterGrace()
        XCTAssertEqual(rig.history.load().map(\.callKind), [.declined])
        XCTAssertTrue(rig.missed.isEmpty)
    }

    func testARingNobodyAnswersIsMissed() async throws {
        let rig = CallRig()
        rig.member("Alice", .live)
        let uuid = try XCTUnwrap(rig.provider.incoming.first?.0)
        let rangOut = await eventually(3) { rig.provider.ended.contains { $0 == (uuid, .unanswered) } }
        XCTAssertTrue(rangOut, "60 s on a phone, 0.4 s here")
        XCTAssertNil(rig.center.calls[uuid])
        rig.member("Alice", .off)
        rig.afterGrace()
        XCTAssertEqual(rig.history.load().map(\.callKind), [.missed])
        XCTAssertEqual(rig.missed.first?.1, "Alice")
        XCTAssertEqual(rig.provider.incoming.count, 1, "no second ring of the same call")
    }

    func testTheCallerHangingUpEndsTheRing() throws {
        let rig = CallRig()
        rig.member("Alice", .live)
        let uuid = try XCTUnwrap(rig.provider.incoming.first?.0)
        rig.member("Alice", .off)
        XCTAssertTrue(rig.provider.ended.contains { $0 == (uuid, .remoteEnded) })
        XCTAssertNil(rig.center.calls[uuid])
    }

    func testJoiningInTheAppAnswersTheRing() async throws {
        let rig = CallRig()
        rig.member("Alice", .live)
        let uuid = try XCTUnwrap(rig.provider.incoming.first?.0)
        rig.room().startAudio() // the room's own call button, not CallKit's
        XCTAssertEqual(rig.controller.requests, [.answer(uuid)])
        XCTAssertEqual(rig.center.calls[uuid]?.phase, .active)
        // The same through CallSystem's button: the ring is answered, not a second call.
        let other = CallRig()
        other.member("Bob", .live)
        let second = try XCTUnwrap(other.provider.incoming.first?.0)
        other.center.startCall(roomKey: "team", video: false)
        XCTAssertEqual(other.controller.requests, [.answer(second)])
        XCTAssertTrue(other.room().inCall)
    }

    func testNoRingForTheRoomOnScreenOrWhenCallsMayNotRingOrCallKitSaysNo() async {
        let onScreen = CallRig()
        onScreen.directory.onScreen = ["team"]
        onScreen.member("Alice", .live)
        XCTAssertTrue(onScreen.provider.incoming.isEmpty, "the room on screen shows its call itself")

        let quiet = CallRig()
        quiet.env.callPrivacy.allowsRing = false
        quiet.member("Alice", .live)
        XCTAssertTrue(quiet.provider.incoming.isEmpty, "the Calls switch / quiet hours")

        let dnd = CallRig()
        dnd.provider.acceptIncoming = false
        dnd.member("Alice", .live)
        XCTAssertEqual(dnd.provider.incoming.count, 1)
        let forgotten = await eventually { dnd.center.calls.isEmpty }
        XCTAssertTrue(forgotten, "CallKit did not show it: no call to keep")
    }

    func testWhatARingShowsFollowsThePrivacyAndRecents() throws {
        let locked = CallRig()
        locked.env.callPrivacy.locked = true
        locked.member("Alice", .live)
        XCTAssertEqual(locked.provider.incoming.first?.1.name, "M5cet", "locked: the app's name only")

        let person = CallRig()
        person.env.callPrivacy.level = 1
        person.member("Alice", .live)
        XCTAssertEqual(person.provider.incoming.first?.1.name, "Alice")

        let recents = CallRig()
        recents.env.callSettings.recents = true
        recents.member("Alice", .live)
        XCTAssertEqual(recents.provider.incoming.first?.1.name, "M5cet", "Recents keeps the name: the app's by default")
        XCTAssertEqual(recents.center.providerSettings(iconTemplate: nil).recents, true)

        let video = CallRig()
        video.member("Alice", .live)
        XCTAssertEqual(video.provider.incoming.first?.1.video, false)
    }

    // MARK: outgoing

    func testMyCallConnectsWhenSomeoneComesAndHangsUp() throws {
        let rig = CallRig()
        let room = rig.room()
        rig.center.startCall(roomKey: "team", video: false)
        guard case let .start(uuid, shown)? = rig.controller.requests.first else { return XCTFail("no start") }
        XCTAssertEqual(shown.name, "Team")
        XCTAssertTrue(room.inCall)
        XCTAssertEqual(rig.provider.connecting, [uuid])
        XCTAssertTrue(rig.provider.connected.isEmpty, "nobody else yet")
        rig.member("Bob", .live)
        XCTAssertEqual(rig.provider.connected, [uuid])
        XCTAssertEqual(rig.center.calls[uuid]?.phase, .active)
        XCTAssertTrue(rig.provider.incoming.isEmpty, "my own call does not ring")
        rig.clock += 5_000
        rig.center.endCall(roomKey: "team")
        XCTAssertEqual(rig.controller.requests.last, .end(uuid))
        XCTAssertFalse(room.inCall)
        XCTAssertNil(rig.center.calls[uuid])
        XCTAssertEqual(rig.history.load().map(\.callKind), [.outgoing])
        XCTAssertEqual(rig.history.load().first?.people, ["Bob"])
    }

    func testMuteAndHoldGoToTheRoom() throws {
        let rig = CallRig()
        let room = rig.room()
        rig.center.startCall(roomKey: "team", video: false)
        guard case let .start(uuid, _)? = rig.controller.requests.first else { return XCTFail("no start") }
        rig.center.setMuted(roomKey: "team", true)
        XCTAssertEqual(rig.controller.requests.last, .mute(uuid, true))
        XCTAssertEqual(room.audioState, .muted)
        XCTAssertTrue(rig.center.performMute(uuid, false))
        XCTAssertEqual(room.audioState, .live)
        XCTAssertTrue(rig.center.performHold(uuid, true))
        XCTAssertTrue(room.held)
        XCTAssertEqual(room.audioState, .muted, "on hold the others hear me muted")
        XCTAssertTrue(rig.center.performHold(uuid, false))
        XCTAssertFalse(room.held)
        XCTAssertEqual(room.audioState, .live, "back as it was")
        XCTAssertEqual(rig.links["team"]?.statuses, [.live, .muted, .live, .muted, .live])
    }

    func testTheRoomGoingAwayEndsItsCall() throws {
        let rig = CallRig()
        let room = rig.room()
        rig.center.startCall(roomKey: "team", video: false)
        rig.member("Bob", .live)
        guard case let .start(uuid, _)? = rig.controller.requests.first else { return XCTFail("no start") }
        XCTAssertEqual(rig.center.calls[uuid]?.phase, .active)
        room.disconnect()
        XCTAssertTrue(rig.provider.ended.contains { $0 == (uuid, .remoteEnded) })
        XCTAssertTrue(rig.center.calls.isEmpty)
    }

    func testTheOthersLeavingDoesNotEndMyCall() throws {
        // Parity with Android and the web: a room's call is on while my audio is on.
        let rig = CallRig()
        rig.room()
        rig.center.startCall(roomKey: "team", video: false)
        rig.member("Bob", .live)
        XCTAssertEqual(rig.provider.connected.count, 1)
        rig.member("Bob", .off)
        XCTAssertTrue(rig.room().inCall)
        XCTAssertTrue(rig.provider.ended.isEmpty)
    }

    func testCallKitRefusingRunsTheCallWithoutIt() async throws {
        let rig = CallRig()
        rig.controller.accept = false
        let room = rig.room()
        rig.center.startCall(roomKey: "team", video: false)
        let started = await eventually { room.inCall }
        XCTAssertTrue(started, "the call goes on without CallKit")
        XCTAssertEqual(rig.onlyCall?.direct, true)
        XCTAssertTrue(rig.provider.connecting.isEmpty, "nothing reported to a CallKit that refused")
        rig.center.setMuted(roomKey: "team", true)
        XCTAssertEqual(room.audioState, .muted, "mute without CallKit")
        rig.center.endCall(roomKey: "team")
        XCTAssertFalse(room.inCall)
        XCTAssertTrue(rig.center.calls.isEmpty)
    }

    func testAResetStopsEverything() throws {
        let rig = CallRig()
        rig.member("Alice", .live)
        rig.member("Bob", in: "family", .live)
        XCTAssertEqual(rig.provider.incoming.count, 2, "a second room rings too (call waiting)")
        let uuid = try XCTUnwrap(rig.center.call(forRoom: "team")?.uuid)
        _ = rig.center.performAnswer(uuid)
        rig.center.providerDidReset()
        XCTAssertTrue(rig.center.calls.isEmpty)
        XCTAssertFalse(rig.room().inCall)
    }

    // MARK: VoIP pushes

    func testAPushThatCannotBeOpenedIsStillACallEndedAtOnce() async {
        let rig = CallRig()
        let handler = VoIPPushHandler(center: rig.center)
        var completed = false
        handler.didReceiveVoIPPush(["m5": ["i": "x"]]) { completed = true }
        XCTAssertEqual(rig.provider.incoming.count, 1, "reported before the handler returned")
        XCTAssertEqual(rig.provider.incoming.first?.1.name, "M5cet", "a neutral caller")
        XCTAssertFalse(completed, "PushKit's completion once CallKit took it")
        let done = await eventually { completed }
        XCTAssertTrue(done)
        XCTAssertEqual(rig.provider.ended.first?.1, .failed)
        XCTAssertEqual(rig.provider.ended.first?.0, rig.provider.incoming.first?.0)
    }

    func testAPushRingsConnectsTheRoomAndTheRoomTakesOver() async throws {
        let rig = CallRig()
        let opener = Opener()
        opener.invite = VoIPCallInvite(kind: .ring, id: "c1", roomKey: "team", who: "Alice", video: true, at: rig.clock - 100)
        let handler = VoIPPushHandler(center: rig.center)
        handler.opener = opener
        var completed = false
        handler.didReceiveVoIPPush([:]) { completed = true }
        let (uuid, shown) = try XCTUnwrap(rig.provider.incoming.first)
        XCTAssertEqual(shown.name, "Alice · Team")
        XCTAssertTrue(shown.video)
        XCTAssertEqual(rig.directory.connected, ["team"], "the room connects to see the call")
        _ = await eventually { completed }
        // The room is there and shows the call: no second ring, a better name.
        rig.member("Alice", .live)
        XCTAssertEqual(rig.provider.incoming.count, 1)
        XCTAssertTrue(rig.provider.events.contains { if case .update(uuid, _) = $0 { return true } else { return false } })
        XCTAssertTrue(rig.center.performAnswer(uuid))
        XCTAssertTrue(rig.room().inCall)
    }

    func testAPushWhoseCallIsOverBeforeTheRoomShowsItIsMissed() async throws {
        let rig = CallRig()
        let handler = VoIPPushHandler(center: rig.center)
        let opener = Opener()
        opener.invite = VoIPCallInvite(kind: .ring, id: "c1", roomKey: "team", who: "Alice")
        handler.opener = opener
        handler.didReceiveVoIPPush([:]) {}
        let uuid = try XCTUnwrap(rig.provider.incoming.first?.0)
        let over = await eventually(3) { rig.provider.ended.contains { $0 == (uuid, .remoteEnded) } }
        XCTAssertTrue(over, "the room never showed the call")
        let recorded = await eventually(3) { !rig.history.load().isEmpty }
        XCTAssertTrue(recorded)
        XCTAssertEqual(rig.history.load().map(\.callKind), [.missed], "recorded by the call center (CallTrack never saw it)")
        XCTAssertEqual(rig.missed.count, 1)
    }

    func testADeclinedPushedCallDoesNotRingAgainAndIsRecordedOnce() async throws {
        let rig = CallRig()
        let handler = VoIPPushHandler(center: rig.center)
        let opener = Opener()
        opener.invite = VoIPCallInvite(kind: .ring, id: "c1", roomKey: "team", who: "Alice")
        handler.opener = opener
        handler.didReceiveVoIPPush([:]) {}
        let uuid = try XCTUnwrap(rig.provider.incoming.first?.0)
        XCTAssertTrue(rig.center.performEnd(uuid), "declined on the lock screen")
        // The room connects (it was asked to) and sees the call: no second ring.
        rig.member("Alice", .live)
        XCTAssertEqual(rig.provider.incoming.count, 1)
        rig.member("Alice", .off)
        rig.afterGrace()
        try? await Task.sleep(for: .milliseconds(600)) // past the call center's own record time
        XCTAssertEqual(rig.history.load().map(\.callKind), [.declined], "one record, CallTrack's")
    }

    func testPushesForACallCallKitHasOrThatEndedOrExpired() async throws {
        let rig = CallRig()
        rig.member("Alice", .live)
        let uuid = try XCTUnwrap(rig.provider.incoming.first?.0)
        let handler = VoIPPushHandler(center: rig.center)
        let opener = Opener()
        handler.opener = opener
        opener.invite = VoIPCallInvite(kind: .ring, id: "c1", roomKey: "team", who: "Alice")
        handler.didReceiveVoIPPush([:]) {}
        XCTAssertEqual(rig.provider.incoming.map(\.0), [uuid, uuid], "the same call reported again (PushKit's rule)")
        opener.invite = VoIPCallInvite(kind: .end, id: "c2", roomKey: "team")
        handler.didReceiveVoIPPush([:]) {}
        XCTAssertEqual(rig.provider.incoming.count, 3)
        XCTAssertTrue(rig.provider.ended.contains { $0 == (uuid, .remoteEnded) }, "an end push stops the ring")

        let late = CallRig()
        let h2 = VoIPPushHandler(center: late.center)
        let o2 = Opener()
        o2.invite = VoIPCallInvite(kind: .ring, id: "c3", roomKey: "family", who: "Bob", at: late.clock - 120_000)
        h2.opener = o2
        var completed = false
        h2.didReceiveVoIPPush([:]) { completed = true }
        XCTAssertEqual(late.provider.incoming.count, 1)
        _ = await eventually { completed }
        XCTAssertEqual(late.provider.ended.first?.1, .unanswered, "an expired push: reported and ended")
        XCTAssertTrue(late.center.calls.isEmpty)
        XCTAssertTrue(late.directory.connected.isEmpty)
    }

    func testAnAnswerWhileLockedJoinsOnceUnlocked() async throws {
        let rig = CallRig()
        rig.env.callPrivacy.locked = true
        let handler = VoIPPushHandler(center: rig.center)
        let opener = Opener()
        opener.invite = VoIPCallInvite(kind: .ring, id: "c1", roomKey: "team", who: "Alice")
        handler.opener = opener
        handler.didReceiveVoIPPush([:]) {}
        let uuid = try XCTUnwrap(rig.provider.incoming.first?.0)
        XCTAssertEqual(rig.provider.incoming.first?.1.name, "M5cet", "locked: neutral")
        XCTAssertTrue(rig.center.performAnswer(uuid))
        XCTAssertEqual(rig.center.calls[uuid]?.phase, .answering)
        rig.member("Alice", .live)
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertFalse(rig.room().inCall, "not while the app is locked")
        rig.env.callPrivacy.locked = false
        let joined = await eventually { rig.room().inCall }
        XCTAssertTrue(joined, "joined once unlocked")
        XCTAssertEqual(rig.center.calls[uuid]?.phase, .active)
    }

    func testAnAnswerNobodyIsLeftForEnds() async throws {
        let rig = CallRig()
        let handler = VoIPPushHandler(center: rig.center)
        let opener = Opener()
        opener.invite = VoIPCallInvite(kind: .ring, id: "c1", roomKey: "team", who: "Alice")
        handler.opener = opener
        handler.didReceiveVoIPPush([:]) {}
        let uuid = try XCTUnwrap(rig.provider.incoming.first?.0)
        XCTAssertTrue(rig.center.performAnswer(uuid))
        rig.room() // connected, but nobody is in the call any more
        let ended = await eventually(3) { rig.provider.ended.contains { $0 == (uuid, .remoteEnded) } }
        XCTAssertTrue(ended)
        XCTAssertFalse(rig.room().inCall)
    }

    func testTheVoIPTokenGoesToWhoeverSendsIt() {
        let rig = CallRig()
        let handler = VoIPPushHandler(center: rig.center)
        var seen: [String?] = []
        handler.onToken { seen.append($0) }
        handler.didUpdate(voipToken: Data([0xAB, 0x01, 0xFF]))
        XCTAssertEqual(handler.tokenHex, "ab01ff")
        handler.didUpdate(voipToken: nil)
        XCTAssertNil(handler.tokenHex)
        XCTAssertEqual(seen, ["ab01ff", nil])
        var late: [String?] = []
        handler.didUpdate(voipToken: Data([1]))
        handler.onToken { late.append($0) }
        XCTAssertEqual(late, ["01"], "a late observer gets the current token")
    }

    // MARK: CallSystem

    func testCallSystemAttachesRoomsAndMapsRecentsBack() throws {
        let provider = FakeProvider()
        let controller = FakeController()
        let env = FakeEnvironment()
        let system = CallSystem(engine: testEngine(), provider: provider, controller: controller, environment: env,
                                history: AppCallHistory(vault: FakeVault()))
        controller.center = system.center
        let directory = FakeDirectory()
        directory.labels = ["team": "Team", "other": "Other"]
        system.directory = directory
        let link = RecordingLink()
        let room = system.attach(roomKey: "team", label: "Team", link: link)
        XCTAssertTrue(system.attach(roomKey: "team", label: "Team", link: link) === room, "one per room")
        system.center.startCall(roomKey: "team", video: false)
        XCTAssertTrue(system.activeCallRoom === room)
        let handle = system.center.display(roomKey: "team", who: "", video: false).handle
        XCTAssertTrue(system.callBack(handle: handle))
        XCTAssertEqual(system.pendingCallBack, "team", "asked before anything is dialled")
        XCTAssertEqual(directory.opened, ["team"])
        XCTAssertFalse(system.callBack(handle: "m5cet-0000000000000000"))
        env.callSettings.recents = true
        system.settingsChanged()
        XCTAssertEqual(provider.events.compactMap { if case let .configured(s) = $0 { return s.recents } else { return nil } }.last, true)
        system.detach(roomKey: "team")
        XCTAssertFalse(room.inCall)
        XCTAssertNil(system.room("team"))
    }
}
