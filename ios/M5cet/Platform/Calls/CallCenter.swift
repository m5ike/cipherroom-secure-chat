// The rooms' calls as CallKit sees them: one CallKit call per room (however
// many people are in it), the native call screen, the lock screen, Recents.
// Android has no counterpart that runs calls — its ring is a notification
// (telecom/CallRing) and its ConnectionService refuses every call; on iOS the
// microphone in the background and the call screen need CallKit, so the
// room's call goes through it:
//
//   ring       CallTrack says someone else started a call I am not in (the room
//              is connected, not on screen) — or a VoIP push says so while the
//              app is away (reportVoIP; every push is reported, synchronously).
//   answer     CallKit's Answer → the room's audio goes on (once the room is
//              connected and the app unlocked — Android's CallRing join).
//   decline    CallKit's End while ringing → CallTrack's declined.
//   missed     the ring ends unanswered (60 s, or the call ended) → .unanswered.
//   outgoing   the app's call button → CXStartCallAction → the room's audio.
//   hang up    CallKit's End or the app's → the room's audio off.
//   mute/hold  → the room's track (hold: my microphone and the others' sound off).
//
// CallKit refusing a request (the simulator, a region where it may not be
// used) does not stop a call: it then runs without CallKit ("direct", the app
// activates the audio session itself). Everything CallKit touches goes through
// CallProviding / CallControlling, so CallCenterTests drive this with fakes.

import AVFoundation
import Foundation
import Observation

enum CallEndReason: Equatable, Sendable {
    case failed, remoteEnded, unanswered, answeredElsewhere, declinedElsewhere
}

/// What CallKit shows of a call.
struct CallDisplay: Equatable, Sendable {
    /// The opaque handle (CallNaming.handle) — never the room.
    var handle: String
    var name: String
    var video: Bool
}

/// A transaction the app asks CallKit for (CXCallController).
enum CallRequest: Equatable, Sendable {
    case start(UUID, CallDisplay)
    case answer(UUID)
    case end(UUID)
    case mute(UUID, Bool)
    case hold(UUID, Bool)
}

/// CXProviderConfiguration as the settings make it.
struct CallProviderSettings: Equatable, Sendable {
    /// Calls in the Phone app's Recents (Settings › Calls, Android's call log switch).
    var recents: Bool
    /// The 40-pt template image CallKit shows on its buttons (the app's mark).
    var iconTemplate: Data?
}

/// CXProvider, as the call center uses it.
@MainActor
protocol CallProviding: AnyObject {
    /// Must call CXProvider.reportNewIncomingCall before returning (PushKit's rule); `done` later.
    func reportIncoming(_ uuid: UUID, _ display: CallDisplay, done: @escaping @MainActor (Bool) -> Void)
    func reportUpdate(_ uuid: UUID, _ display: CallDisplay)
    func reportOutgoing(_ uuid: UUID, startedConnectingAt date: Date)
    func reportOutgoing(_ uuid: UUID, connectedAt date: Date)
    func reportEnded(_ uuid: UUID, at date: Date, reason: CallEndReason)
    func configure(_ settings: CallProviderSettings)
}

/// CXCallController, as the call center uses it.
@MainActor
protocol CallControlling: AnyObject {
    func request(_ request: CallRequest, done: @escaping @MainActor (Bool) -> Void)
}

@MainActor
@Observable
final class CallCenter: RoomCallEvents {
    enum Phase: Equatable, Sendable {
        /// Incoming, not answered.
        case ringing
        /// My call: asked CallKit to start it.
        case dialing
        /// Answered; waiting for the room (connect, unlock) to join.
        case answering
        case active
    }

    struct Call: Equatable, Sendable {
        let uuid: UUID
        let roomKey: String
        var incoming: Bool
        var video: Bool
        var phase: Phase
        var who = ""
        /// Someone was in the room's call since this CallKit call began (a remote hang-up can be told).
        var sawOthers = false
        /// The room's audio was started for it (a later "off" is a hang-up).
        var started = false
        var connectedReported = false
        var muted = false
        /// From a VoIP push (the room was not connected).
        var fromPush = false
        /// When the call started (ms; a push says it, a ring is now).
        var at: Int64 = 0
        /// CallKit refused it: the app runs it alone.
        var direct = false
    }

    /// Timing (CallRing.RING_MS, the 3-minute join of CallRing.tick).
    struct Timing: Sendable {
        var ring: Duration = .seconds(60)
        /// How long a VoIP-pushed ring waits for the room to show the call.
        var pushWait: Duration = .seconds(30)
        /// How long an answered call waits for the room and the unlock.
        var join: Duration = .seconds(180)
        /// …and, once the room is there, for someone to be in its call.
        var joinQuiet: Duration = .seconds(20)
        var poll: Duration = .milliseconds(500)
        /// PushKit's completion at the latest after this (when CallKit does not answer a report).
        var pushCompletion: Duration = .seconds(3)
    }

    private(set) var calls: [UUID: Call] = [:]

    @ObservationIgnored let provider: any CallProviding
    @ObservationIgnored let controller: any CallControlling
    @ObservationIgnored weak var directory: (any CallRoomDirectory)?
    @ObservationIgnored var environment: any CallEnvironment
    /// The connected rooms' WebRTC side (CallSystem's registry).
    @ObservationIgnored var rooms: (String) -> RoomRtc? = { _ in nil }
    /// The audio session (nil in tests).
    @ObservationIgnored var audio: CallAudioSession?
    @ObservationIgnored var history: AppCallHistory?
    /// This install's salt of the opaque handles.
    @ObservationIgnored var handleSalt = Data(repeating: 0, count: 32)
    @ObservationIgnored var timing = Timing()
    /// A missed call (Platform/Notifications may post "Missed call", within the privacy level).
    @ObservationIgnored var onMissed: ((_ roomKey: String, _ who: String, _ video: Bool, _ at: Int64) -> Void)?
    @ObservationIgnored var now: () -> Int64 = { CallTrack.millis() }

    @ObservationIgnored private var timers: [UUID: Task<Void, Never>] = [:]
    /// Rooms whose call was declined or rang out: no second ring for the same call (ms until).
    @ObservationIgnored private var quiet: [String: (until: Int64, declined: Bool)] = [:]
    /// A pushed call that ended before its room connected: recorded unless the room sees the call after all
    /// (then CallTrack records it — one record per call).
    @ObservationIgnored private var pushRecords: [String: CallTrack.Record] = [:]

    init(provider: any CallProviding, controller: any CallControlling, environment: any CallEnvironment) {
        self.provider = provider
        self.controller = controller
        self.environment = environment
    }

    /// The call of a room, if CallKit has one.
    func call(forRoom roomKey: String) -> Call? { calls.values.first { $0.roomKey == roomKey } }

    /// 6.14 core (call wake): a VoIP push owns this room's call now — it rings, or its record is pending — so the
    /// room's relayed call items of it add no second record (one record per call).
    func pushOwnsCall(roomKey: String) -> Bool { call(forRoom: roomKey)?.fromPush == true || pushRecords[roomKey] != nil }

    /// The room whose call is on (not just ringing) — the call screen shows it.
    var activeRoomKey: String? {
        calls.values.filter { $0.phase != .ringing }.map(\.roomKey).sorted().first
    }

    var ringingRoomKeys: [String] { calls.values.filter { $0.phase == .ringing }.map(\.roomKey).sorted() }

    // MARK: - what CallKit shows

    func display(roomKey: String, who: String, video: Bool) -> CallDisplay {
        let s = environment.callSettings, p = environment.callPrivacy
        let label = directory?.label(ofRoom: roomKey) ?? rooms(roomKey)?.roomLabel ?? ""
        let people = rooms(roomKey)?.liveNames ?? []
        let name = CallNaming.displayName(recents: s.recents, logName: s.logName, privacyLevel: p.level, locked: p.locked,
                                          appName: p.appName, room: label, who: who, people: people)
        return CallDisplay(handle: CallNaming.handle(roomKey: roomKey, salt: handleSalt), name: name, video: video)
    }

    /// The neutral caller (a push that cannot be opened, a call that may not show anything).
    var neutralDisplay: CallDisplay {
        CallDisplay(handle: CallNaming.handlePrefix + "call", name: environment.callPrivacy.appName, video: false)
    }

    func providerSettings(iconTemplate: Data?) -> CallProviderSettings {
        CallProviderSettings(recents: environment.callSettings.recents, iconTemplate: iconTemplate)
    }

    // MARK: - the rooms (RoomCallEvents)

    func roomCallRings(_ room: RoomRtc, who: String, video: Bool) {
        let key = room.roomKey
        if let uuid = uuid(ofRoom: key) {
            // A VoIP push rang it already: now the room knows who.
            calls[uuid]?.who = who
            calls[uuid]?.sawOthers = true
            calls[uuid]?.video = video
            if calls[uuid]?.phase == .ringing { provider.reportUpdate(uuid, display(roomKey: key, who: who, video: video)) }
            return
        }
        if let q = quiet[key], q.until > now() {
            // The same call rang already and was declined or rang out (a VoIP push before the room connected):
            // no second ring, and CallTrack records it now (declined, or missed when it ends without me).
            pushRecords[key] = nil
            if q.declined { room.decline() }
            return
        }
        guard environment.callPrivacy.allowsRing, !(directory?.isOnScreen(roomKey: key) ?? false) else { return }
        ring(roomKey: key, who: who, video: video, fromPush: false, sawOthers: true, done: nil)
    }

    func roomCallRingOver(_ room: RoomRtc) {
        guard let uuid = uuid(ofRoom: room.roomKey), calls[uuid]?.phase == .ringing, !room.inCall else { return }
        end(uuid, reason: .unanswered)
    }

    func roomCall(_ room: RoomRtc, recorded: [CallTrack.Record]) {
        for r in recorded where r.callKind == .missed {
            onMissed?(room.roomKey, r.people.first ?? "", r.video, r.at)
        }
    }

    func roomCallChanged(_ room: RoomRtc) {
        guard let uuid = uuid(ofRoom: room.roomKey), var c = calls[uuid] else { return }
        if room.othersInCall { c.sawOthers = true }
        calls[uuid] = c
        switch c.phase {
        case .ringing:
            if room.inCall {
                // Joined in the app while it rang: CallKit answers it.
                calls[uuid]?.phase = .answering
                controller.request(.answer(uuid)) { [weak self] ok in if !ok { self?.goDirect(uuid) } }
            } else if c.sawOthers && !room.othersInCall {
                // The caller hung up before I answered.
                end(uuid, reason: .remoteEnded)
            }
        case .dialing, .active:
            if c.started && !room.inCall {
                // The room's call stopped without CallKit (the room left, went offline).
                end(uuid, reason: .remoteEnded)
            } else if c.started && room.othersInCall && !c.connectedReported && !c.incoming {
                calls[uuid]?.connectedReported = true
                calls[uuid]?.phase = .active
                provider.reportOutgoing(uuid, connectedAt: Date())
            }
        case .answering:
            if room.inCall { calls[uuid]?.phase = .active; calls[uuid]?.started = true }
        }
    }

    // MARK: - the app's buttons

    /// The call button of a room (audio or video): answers its ring, adds the camera to a running
    /// call, or starts a call through CallKit.
    func startCall(roomKey: String, video: Bool) {
        if let uuid = uuid(ofRoom: roomKey), let c = calls[uuid] {
            switch c.phase {
            case .ringing:
                calls[uuid]?.video = video
                controller.request(.answer(uuid)) { [weak self] ok in
                    if !ok { _ = self?.performAnswer(uuid); self?.goDirect(uuid) }
                }
            default:
                if video, let room = rooms(roomKey) {
                    calls[uuid]?.video = true
                    audio?.video = true // a video call uses the speaker
                    Task { await room.startVideo() }
                }
            }
            return
        }
        let uuid = UUID()
        calls[uuid] = Call(uuid: uuid, roomKey: roomKey, incoming: false, video: video, phase: .dialing)
        controller.request(.start(uuid, display(roomKey: roomKey, who: "", video: video))) { [weak self] ok in
            guard let self, !ok, self.calls[uuid] != nil else { return }
            // CallKit refused: the call goes on without it.
            self.calls[uuid]?.direct = true
            if !self.performStart(uuid) { self.calls[uuid] = nil }
        }
    }

    /// The hang-up button.
    func endCall(roomKey: String) {
        guard let uuid = uuid(ofRoom: roomKey) else {
            rooms(roomKey)?.stop()
            return
        }
        if calls[uuid]?.direct == true { _ = performEnd(uuid); return }
        controller.request(.end(uuid)) { [weak self] ok in if !ok { _ = self?.performEnd(uuid) } }
    }

    /// The mute button (CallKit's screen shows the same).
    func setMuted(roomKey: String, _ muted: Bool) {
        guard let uuid = uuid(ofRoom: roomKey), calls[uuid]?.direct == false else {
            rooms(roomKey)?.mute(muted)
            return
        }
        controller.request(.mute(uuid, muted)) { [weak self] ok in if !ok { _ = self?.performMute(uuid, muted) } }
    }

    // MARK: - CallKit's actions (CXProviderDelegate)

    func performStart(_ uuid: UUID) -> Bool {
        guard let c = calls[uuid], let room = rooms(c.roomKey) else { calls[uuid] = nil; return false }
        audio?.configure(video: c.video)
        provider.reportUpdate(uuid, display(roomKey: c.roomKey, who: "", video: c.video))
        if c.direct { audio?.activateDirectly(video: c.video) } else { provider.reportOutgoing(uuid, startedConnectingAt: Date()) }
        calls[uuid]?.started = true
        // The room's call — connected as soon as someone else is in it (roomCallChanged).
        room.startAudio()
        if c.video { Task { await room.startVideo() } }
        roomCallChanged(room)
        return true
    }

    func performAnswer(_ uuid: UUID) -> Bool {
        guard let c = calls[uuid] else { return false }
        cancelTimer(uuid)
        audio?.configure(video: c.video)
        directory?.open(roomKey: c.roomKey)
        if let room = rooms(c.roomKey), !environment.callPrivacy.locked {
            calls[uuid]?.phase = .active
            calls[uuid]?.started = true
            if !room.inCall {
                room.startAudio()
                if c.video { Task { await room.startVideo() } }
            }
        } else {
            // Android CallRing: the room, and its call, once the app is unlocked — if someone is still in it.
            calls[uuid]?.phase = .answering
            directory?.connect(roomKey: c.roomKey)
            waitToJoin(uuid)
        }
        return true
    }

    func performEnd(_ uuid: UUID) -> Bool {
        guard let c = calls.removeValue(forKey: uuid) else { return true }
        cancelTimer(uuid)
        let room = rooms(c.roomKey)
        if c.phase == .ringing {
            quiet[c.roomKey] = (now() + Self.ms(timing.ring), true)
            if let room { room.decline() } else if c.fromPush { recordLater(c, .declined) }
        } else {
            room?.stop()
        }
        if c.direct { audio?.deactivateDirectly() }
        return true
    }

    func performMute(_ uuid: UUID, _ muted: Bool) -> Bool {
        guard let c = calls[uuid] else { return false }
        calls[uuid]?.muted = muted
        rooms(c.roomKey)?.mute(muted)
        return true
    }

    func performHold(_ uuid: UUID, _ onHold: Bool) -> Bool {
        guard let c = calls[uuid] else { return false }
        rooms(c.roomKey)?.setHold(onHold)
        return true
    }

    /// CallKit reset (its daemon restarted): every call stops.
    func providerDidReset() {
        for (uuid, c) in calls {
            cancelTimer(uuid)
            if c.phase == .ringing { rooms(c.roomKey)?.decline() } else { rooms(c.roomKey)?.stop() }
        }
        calls.removeAll()
    }

    func didActivate(_ session: AVAudioSession) { audio?.didActivate(session) }
    func didDeactivate(_ session: AVAudioSession) { audio?.didDeactivate(session) }

    // MARK: - VoIP pushes

    /// A VoIP push (opened, or nil when it could not be): reported to CallKit before this returns.
    /// `completion` is PushKit's, called once — when CallKit took the report, or after
    /// `timing.pushCompletion` at the latest (CallKit on the simulator never answers an unsigned app).
    func reportVoIP(_ invite: VoIPCallInvite?, completion pushKitDone: @escaping () -> Void) {
        let completion = once(pushKitDone)
        guard let invite else {
            // Apple: every VoIP push is a call. One we cannot open — a neutral call, ended at once.
            reportAndEnd(neutralDisplay, reason: .failed, completion: completion)
            return
        }
        let shown = display(roomKey: invite.roomKey, who: invite.who, video: invite.video)
        if let uuid = uuid(ofRoom: invite.roomKey) {
            // A call CallKit has: reporting it again satisfies PushKit (CallKit answers "already exists").
            provider.reportIncoming(uuid, shown) { _ in completion.run() }
            if invite.kind == .end, calls[uuid]?.phase == .ringing { end(uuid, reason: .remoteEnded) }
            return
        }
        let expired = invite.at > 0 && now() - invite.at > Self.ms(timing.ring)
        let quietRoom = (quiet[invite.roomKey]?.until ?? 0) > now()
        if invite.kind == .end || expired || quietRoom || !environment.callPrivacy.allowsRing {
            reportAndEnd(shown, reason: invite.kind == .end ? .remoteEnded : .unanswered, completion: completion)
            return
        }
        ring(roomKey: invite.roomKey, who: invite.who, video: invite.video, fromPush: true,
             sawOthers: rooms(invite.roomKey)?.othersInCall ?? false, at: invite.at, done: completion)
        directory?.connect(roomKey: invite.roomKey)
    }

    // MARK: - internals

    private func uuid(ofRoom roomKey: String) -> UUID? { calls.first { $0.value.roomKey == roomKey }?.key }

    private func ring(roomKey: String, who: String, video: Bool, fromPush: Bool, sawOthers: Bool, at: Int64 = 0, done: Once?) {
        let uuid = UUID()
        calls[uuid] = Call(uuid: uuid, roomKey: roomKey, incoming: true, video: video, phase: .ringing, who: who,
                           sawOthers: sawOthers, fromPush: fromPush, at: at > 0 ? at : now())
        provider.reportIncoming(uuid, display(roomKey: roomKey, who: who, video: video)) { [weak self] ok in
            if !ok, let self, self.calls[uuid]?.phase == .ringing {
                // Do Not Disturb, a blocked caller, too many calls: no ring (the room still shows the call).
                self.calls[uuid] = nil
                self.cancelTimer(uuid)
            }
            done?.run()
        }
        let ringFor = timing.ring, pushWait = timing.pushWait
        timers[uuid] = Task { @MainActor [weak self] in
            if fromPush {
                try? await Task.sleep(for: pushWait)
                guard !Task.isCancelled, let self else { return }
                if let c = self.calls[uuid], c.phase == .ringing, !c.sawOthers, !(self.rooms(roomKey)?.othersInCall ?? false) {
                    // The room never showed the call: it was over before we got there.
                    self.end(uuid, reason: .remoteEnded)
                    return
                }
                try? await Task.sleep(for: ringFor - pushWait)
            } else {
                try? await Task.sleep(for: ringFor)
            }
            guard !Task.isCancelled, let self, self.calls[uuid]?.phase == .ringing else { return }
            self.end(uuid, reason: .unanswered)
        }
    }

    /// Ends a call CallKit has (not asked by CallKit): reported, forgotten.
    private func end(_ uuid: UUID, reason: CallEndReason) {
        guard let c = calls.removeValue(forKey: uuid) else { return }
        cancelTimer(uuid)
        provider.reportEnded(uuid, at: Date(), reason: reason)
        if c.phase == .ringing {
            quiet[c.roomKey] = (now() + Self.ms(timing.ring), false)
            // A pushed call the room never showed: CallTrack cannot record it — unless the room sees it after all.
            if c.fromPush && !c.sawOthers { recordLater(c, .missed) }
        }
        if c.direct { audio?.deactivateDirectly() }
    }

    /// A pushed call its room has not seen (yet): recorded after the ring's time, unless the room shows the
    /// call by then (roomCallRings drops it — CallTrack records that call itself).
    private func recordLater(_ c: Call, _ kind: CallTrack.Kind) {
        let key = c.roomKey
        pushRecords[key] = CallTrack.Record(kind: kind, at: c.at, seconds: 0, video: c.video, people: c.who.isEmpty ? [] : [c.who])
        let wait = timing.ring
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: wait)
            guard let self, let r = self.pushRecords.removeValue(forKey: key) else { return }
            self.history?.record(r, roomKey: key, room: self.directory?.label(ofRoom: key) ?? "")
            if r.callKind == .missed { self.onMissed?(key, r.people.first ?? "", r.video, r.at) }
        }
    }

    private func reportAndEnd(_ display: CallDisplay, reason: CallEndReason, completion: Once) {
        let uuid = UUID()
        let provider = self.provider
        let finish = once {
            provider.reportEnded(uuid, at: Date(), reason: reason)
            completion.run()
        }
        provider.reportIncoming(uuid, display) { _ in finish.run() }
    }

    /// A closure run once — touched on the main actor only (PushKit's completion is not Sendable).
    final class Once: @unchecked Sendable {
        private var body: (() -> Void)?
        init(_ body: @escaping () -> Void) { self.body = body }

        @MainActor
        func run() {
            let b = body
            body = nil
            b?()
        }
    }

    /// `body` once: on the first run, or after `timing.pushCompletion` when nothing ran it.
    private func once(_ body: @escaping () -> Void) -> Once {
        let box = Once(body)
        let wait = timing.pushCompletion
        Task { @MainActor in
            try? await Task.sleep(for: wait)
            box.run()
        }
        return box
    }

    /// CallKit refused the answer of an in-app join: the call runs without it.
    private func goDirect(_ uuid: UUID) {
        guard let c = calls[uuid] else { return }
        calls[uuid]?.direct = true
        calls[uuid]?.phase = .active
        calls[uuid]?.started = rooms(c.roomKey)?.inCall ?? false
        audio?.activateDirectly(video: c.video)
    }

    /// Android CallRing.tick: every half second, once the room is connected and the app unlocked — join if
    /// someone is still in the call; give up after the join time, or when nobody comes once the room is there.
    private func waitToJoin(_ uuid: UUID) {
        let t = timing
        timers[uuid] = Task { @MainActor [weak self] in
            let clock = ContinuousClock()
            let deadline = clock.now + t.join
            var roomSince: ContinuousClock.Instant?
            while clock.now < deadline {
                try? await Task.sleep(for: t.poll)
                guard !Task.isCancelled, let self, let c = self.calls[uuid], c.phase == .answering else { return }
                guard let room = self.rooms(c.roomKey), !self.environment.callPrivacy.locked else { continue }
                if room.othersInCall {
                    self.calls[uuid]?.phase = .active
                    self.calls[uuid]?.started = true
                    if !room.inCall { room.startAudio() }
                    self.timers[uuid] = nil
                    return
                }
                if roomSince == nil { roomSince = clock.now }
                if let since = roomSince, clock.now - since > t.joinQuiet { break }
            }
            guard let self, self.calls[uuid]?.phase == .answering else { return }
            self.end(uuid, reason: .remoteEnded)
        }
    }

    static func ms(_ d: Duration) -> Int64 {
        let c = d.components
        return c.seconds * 1000 + c.attoseconds / 1_000_000_000_000_000
    }

    private func cancelTimer(_ uuid: UUID) {
        timers.removeValue(forKey: uuid)?.cancel()
    }
}
