// The calls of the app in one place: the WebRTC engine, the rooms' WebRTC
// sides, CallKit (CallCenter), PushKit (VoIPPushHandler), the call history.
// App/Bootstrap installs it (model.voip); the room session attaches each
// connected room (attach / detach) and the screens use the buttons below.

import AVFoundation
import Foundation
import Intents
import Observation

@MainActor
@Observable
final class CallSystem {
    static let shared = CallSystem()

    @ObservationIgnored let engine: RtcEngine
    @ObservationIgnored let history: CallHistoryStore
    let center: CallCenter
    @ObservationIgnored let voip: VoIPPushHandler
    @ObservationIgnored private let provider: any CallProviding
    @ObservationIgnored private(set) var environment: any CallEnvironment
    @ObservationIgnored private let iconTemplate: Data?

    /// The connected rooms' WebRTC side, by room key.
    private(set) var rooms: [String: RoomRtc] = [:]
    /// A call-back from Recents waiting for the person's yes (the History asks, as on Android).
    var pendingCallBack: String?

    /// The app's own instance: real CallKit.
    private convenience init() {
        let env = DefaultCallEnvironment()
        let icon = CallIcon.template()
        let provider = CallKitProvider(settings: CallProviderSettings(recents: env.callSettings.recents, iconTemplate: icon))
        self.init(engine: .shared, provider: provider, controller: CallKitController(), environment: env, iconTemplate: icon,
                  audio: .shared)
        provider.center = center
    }

    /// Any providers (tests: fakes).
    init(engine: RtcEngine, provider: any CallProviding, controller: any CallControlling, environment: any CallEnvironment,
         iconTemplate: Data? = nil, audio: CallAudioSession? = nil, history: CallHistoryStore = CallHistoryStore()) {
        self.engine = engine
        self.provider = provider
        self.environment = environment
        self.iconTemplate = iconTemplate
        self.history = history
        center = CallCenter(provider: provider, controller: controller, environment: environment)
        voip = VoIPPushHandler(center: center)
        center.audio = audio
        center.history = history
        center.handleSalt = Self.handleSalt()
        center.rooms = { [weak self] key in self?.rooms[key] }
        history.enabled = { [weak self] in self?.environment.callSettings.history ?? true }
        settingsChanged()
    }

    /// App/Bootstrap: PushKit is registered with this handler (every VoIP push becomes a CallKit call).
    func install(into model: AppModel) {
        model.voip = voip
    }

    // MARK: - wiring by the other areas

    /// The settings and the design (Settings › Calls, notification privacy, the app lock, texts).
    func setEnvironment(_ env: any CallEnvironment) {
        environment = env
        center.environment = env
        settingsChanged()
    }

    /// Settings › Calls changed (speaker, Recents, history, hide my IP).
    func settingsChanged() {
        let s = environment.callSettings
        engine.relayOnly = s.hideIp
        center.audio?.speakerWanted = s.speaker
        provider.configure(center.providerSettings(iconTemplate: iconTemplate))
    }

    /// The rooms (navigation, connect, labels) — the app's room list.
    var directory: (any CallRoomDirectory)? {
        get { center.directory }
        set { center.directory = newValue }
    }

    /// GET /api/turn — the network code.
    var turnSource: (any TurnFetching)? {
        get { engine.ice.source }
        set { engine.ice.source = newValue }
    }

    // MARK: - rooms (the room session)

    /// A room connected (its hub socket is being opened): its WebRTC side.
    func attach(roomKey: String, label: String, link: any RoomRtcLink) -> RoomRtc {
        if let r = rooms[roomKey] { r.link = link; r.roomLabel = label; return r }
        let r = RoomRtc(roomKey: roomKey, label: label, engine: engine)
        r.link = link
        r.events = center
        r.history = history
        rooms[roomKey] = r
        return r
    }

    /// The room is going away (left, locked, wiped): its call is recorded and stops.
    func detach(roomKey: String) {
        guard let r = rooms[roomKey] else { return }
        r.destroy()
        rooms[roomKey] = nil
    }

    func room(_ roomKey: String) -> RoomRtc? { rooms[roomKey] }

    /// The room whose call is on (the call screen).
    var activeCallRoom: RoomRtc? {
        if let key = center.activeRoomKey, let r = rooms[key] { return r }
        return rooms.values.first { $0.inCall }
    }

    // MARK: - the buttons

    /// call.audio / call.video: the microphone (and camera) permission first, then CallKit.
    @discardableResult
    func startCall(roomKey: String, video: Bool) async -> Bool {
        guard await Self.microphoneAllowed() else { return false }
        if video, !(await Self.cameraAllowed()) { return false }
        center.startCall(roomKey: roomKey, video: video)
        return true
    }

    /// call.end
    func endCall(roomKey: String) { center.endCall(roomKey: roomKey) }

    /// call.mute (toggles)
    func toggleMute(roomKey: String) {
        guard let r = rooms[roomKey] else { return }
        center.setMuted(roomKey: roomKey, r.audioState != .muted)
    }

    /// call.speaker (the setting stays the person's; this is the call's own choice)
    func toggleSpeaker() {
        guard let audio = center.audio else { return }
        audio.setSpeaker(!audio.speakerWanted)
    }

    // MARK: - Recents

    /// A call-back from the Phone app's Recents (INStartCallIntent with our handle): the room opens and
    /// the History-style question is asked first (pendingCallBack) — nothing is dialled without a yes.
    @discardableResult
    func continueUserActivity(_ activity: NSUserActivity) -> Bool {
        guard let intent = activity.interaction?.intent as? INStartCallIntent,
              let value = intent.contacts?.first?.personHandle?.value else { return false }
        return callBack(handle: value)
    }

    @discardableResult
    func callBack(handle: String) -> Bool {
        guard let key = CallNaming.room(forHandle: handle, among: directory?.savedRoomKeys() ?? [], salt: center.handleSalt) else {
            return false
        }
        directory?.open(roomKey: key)
        pendingCallBack = key
        return true
    }

    // MARK: - wipe

    /// A wipe: every call stops, the history and the handle salt go.
    func wipe() {
        for key in Array(rooms.keys) { detach(roomKey: key) }
        center.providerDidReset()
        history.wipe()
        engine.ice.reset()
        UserDefaults.standard.removeObject(forKey: Self.saltKey)
        center.handleSalt = Self.handleSalt()
    }

    // MARK: - permissions, salt

    static func microphoneAllowed() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        default: return await AVAudioApplication.requestRecordPermission()
        }
    }

    static func cameraAllowed() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video)
        default: return false
        }
    }

    private static let saltKey = "cz.m5cet.calls.handleSalt"

    /// This install's random salt of the Recents handles (32 bytes, made once).
    private static func handleSalt() -> Data {
        if let d = UserDefaults.standard.data(forKey: saltKey), d.count == 32 { return d }
        var bytes = [UInt8](repeating: 0, count: 32)
        if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
            for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
        }
        let d = Data(bytes)
        UserDefaults.standard.set(d, forKey: saltKey)
        return d
    }
}
