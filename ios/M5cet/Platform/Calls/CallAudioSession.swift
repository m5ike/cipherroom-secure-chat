// The call's audio session (Android: Calls.route / unroute and ui/CallService).
//
// WebRTC runs with manual audio: CallKit activates the session for a call
// (provider(_:didActivate:)) and only then does WebRTC's audio unit start —
// `.playAndRecord` with `.voiceChat` (`.videoChat` in a video call), Bluetooth
// hands-free allowed. Without CallKit (CallKit refused the request — the
// simulator, a region where CallKit may not be used) the app activates the
// session itself (activateDirectly).
//
// Routing: Settings › Calls › Speaker (calls.speaker, on by default as on
// Android) or the earpiece; a video call always uses the speaker. Unlike
// Android, a connected headset, Bluetooth device, car or AirPlay output is
// left alone (iOS routes to it; the speaker override would take it away) —
// the call screen offers the system route picker for those.

import AVFoundation
import Observation
@preconcurrency import WebRTC

@MainActor
@Observable
final class CallAudioSession {
    static let shared = CallAudioSession()

    enum Route: Equatable, Sendable {
        case earpiece, speaker
        /// A headset, Bluetooth, car or AirPlay output (its name).
        case external(String)
    }

    /// The audio session is active for a call (by CallKit or directly).
    private(set) var active = false
    /// Where the call's sound goes now.
    private(set) var route: Route = .earpiece
    /// Settings › Calls › Speaker (calls.speaker).
    var speakerWanted = true { didSet { applyRoute() } }
    /// A video call (the speaker, `.videoChat`).
    var video = false { didSet { if video != oldValue { applyRoute() } } }

    @ObservationIgnored private var prepared = false
    @ObservationIgnored private var direct = false
    @ObservationIgnored private var routeObserver: (any NSObjectProtocol)?

    /// Once, before the first peer connection: manual audio, the call configuration WebRTC uses.
    func prepare() {
        guard !prepared else { return }
        prepared = true
        let rtc = RTCAudioSession.sharedInstance()
        rtc.useManualAudio = true
        rtc.isAudioEnabled = false
        let config = RTCAudioSessionConfiguration.webRTC()
        config.category = AVAudioSession.Category.playAndRecord.rawValue
        config.mode = AVAudioSession.Mode.voiceChat.rawValue
        config.categoryOptions = [.allowBluetoothHFP]
        RTCAudioSessionConfiguration.setWebRTC(config)
        routeObserver = NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil,
                                                               queue: .main) { _ in
            MainActor.assumeIsolated { CallAudioSession.shared.readRoute() }
        }
    }

    /// Category and mode for a call — in CallKit's start / answer action, before it activates the session.
    func configure(video: Bool) {
        prepare()
        self.video = video
        let rtc = RTCAudioSession.sharedInstance()
        rtc.lockForConfiguration()
        defer { rtc.unlockForConfiguration() }
        do {
            try rtc.setCategory(.playAndRecord, mode: video ? .videoChat : .voiceChat, options: [.allowBluetoothHFP])
        } catch {
            CallLog.error("audio session category: \(error.localizedDescription)")
        }
    }

    /// CallKit activated the session (provider(_:didActivate:)).
    func didActivate(_ session: AVAudioSession) {
        let rtc = RTCAudioSession.sharedInstance()
        rtc.audioSessionDidActivate(session)
        rtc.isAudioEnabled = true
        active = true
        applyRoute()
    }

    /// CallKit deactivated it (the call ended, or another call took the audio).
    func didDeactivate(_ session: AVAudioSession) {
        let rtc = RTCAudioSession.sharedInstance()
        rtc.isAudioEnabled = false
        rtc.audioSessionDidDeactivate(session)
        active = false
    }

    /// Without CallKit: the app activates the session itself.
    func activateDirectly(video: Bool) {
        configure(video: video)
        let rtc = RTCAudioSession.sharedInstance()
        rtc.lockForConfiguration()
        do { try rtc.setActive(true) } catch { CallLog.error("audio session: \(error.localizedDescription)") }
        rtc.unlockForConfiguration()
        rtc.isAudioEnabled = true
        direct = true
        active = true
        applyRoute()
    }

    /// The call ended without CallKit: the session goes back (other apps' audio resumes).
    func deactivateDirectly() {
        guard direct else { return }
        direct = false
        let rtc = RTCAudioSession.sharedInstance()
        rtc.isAudioEnabled = false
        rtc.lockForConfiguration()
        do { try rtc.setActive(false) } catch { CallLog.error("audio session off: \(error.localizedDescription)") }
        rtc.unlockForConfiguration()
        active = false
    }

    /// Speaker or earpiece now (the speaker button; a video call keeps the speaker).
    func setSpeaker(_ on: Bool) {
        speakerWanted = on
    }

    /// The route as the settings want it; an external output is left as iOS chose it.
    func applyRoute() {
        guard active else { readRoute(); return }
        let rtc = RTCAudioSession.sharedInstance()
        let speaker = video || speakerWanted
        rtc.lockForConfiguration()
        defer { rtc.unlockForConfiguration(); readRoute() }
        do {
            // A headset, Bluetooth device or car stays (the person picks the speaker in the route picker).
            let override: AVAudioSession.PortOverride = Self.external(rtc.session.currentRoute) == nil && speaker ? .speaker : .none
            try rtc.overrideOutputAudioPort(override)
        } catch {
            CallLog.error("audio route: \(error.localizedDescription)")
        }
    }

    private func readRoute() {
        let current = AVAudioSession.sharedInstance().currentRoute
        if let name = Self.external(current) { route = .external(name); return }
        route = current.outputs.contains { $0.portType == .builtInSpeaker } ? .speaker : .earpiece
    }

    /// The name of an output that is not the phone's own (headset, Bluetooth, car, AirPlay, USB…).
    static func external(_ route: AVAudioSessionRouteDescription) -> String? {
        let own: Set<AVAudioSession.Port> = [.builtInSpeaker, .builtInReceiver]
        return route.outputs.first { !own.contains($0.portType) }?.portName
    }
}
