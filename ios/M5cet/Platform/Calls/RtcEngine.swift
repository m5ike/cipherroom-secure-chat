// One WebRTC factory for the app (the audio device, the video codecs — the
// hardware H.264 coder and VP8 / VP9 / AV1 of WebRTC's defaults) and the ICE
// servers from /api/turn (IceConfigCache). Port of
// android/app/src/main/java/cz/m5cet/app/rtc/Rtc.java.
//
// Audio is manual (RTCAudioSession.useManualAudio): WebRTC's audio unit runs
// only while CallKit has activated the audio session for a call
// (CallAudioSession.didActivate) — iOS requires that of a CallKit app, and it
// keeps the microphone off outside calls.

import Foundation
@preconcurrency import WebRTC

@MainActor
final class RtcEngine {
    static let shared = RtcEngine()

    let ice: IceConfigCache
    /// "Hide my IP address" (CallSettings.hideIp): relay-only where the server offers TURN.
    var relayOnly = false
    /// Frame encryption of the media (off: see MediaFrameProtection).
    var frameProtection: (any MediaFrameProtection)?

    private var factoryStorage: RTCPeerConnectionFactory?

    init(ice: IceConfigCache = IceConfigCache()) {
        self.ice = ice
    }

    /// The shared factory (made on first use).
    var factory: RTCPeerConnectionFactory {
        if let factoryStorage { return factoryStorage }
        RTCInitializeSSL()
        CallAudioSession.shared.prepare()
        let f = RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(),
                                         decoderFactory: RTCDefaultVideoDecoderFactory())
        factoryStorage = f
        CallLog.info("WebRTC ready")
        return f
    }

    /// The configuration of a new peer connection, with fresh ICE servers.
    func configuration() async -> RTCConfiguration {
        let servers = await ice.current()
        return Self.configuration(servers: servers, relayOnly: IceConfig.relayOnly(requested: relayOnly, servers: servers))
    }

    /// Android's Rtc.config(): unified plan, continual gathering, max-bundle, RTCP mux, implicit
    /// rollback (perfect negotiation: the polite side rolls its own offer back on a collision).
    static func configuration(servers: [IceServerSpec], relayOnly: Bool) -> RTCConfiguration {
        let c = RTCConfiguration()
        c.iceServers = servers.map { RTCIceServer(urlStrings: $0.urls, username: $0.username, credential: $0.credential) }
        c.sdpSemantics = .unifiedPlan
        c.continualGatheringPolicy = .gatherContinually
        c.bundlePolicy = .maxBundle
        c.rtcpMuxPolicy = .require
        c.enableImplicitRollback = true
        c.iceTransportPolicy = relayOnly ? .relay : .all
        // ECDSA certificates (WebRTC's default; said here so it never changes under us).
        c.keyType = .ECDSA
        return c
    }

    /// A room's hub socket joined: an ICE answer without TURN is not reused (6.12).
    func hubConnected() { ice.hubConnected() }
}
