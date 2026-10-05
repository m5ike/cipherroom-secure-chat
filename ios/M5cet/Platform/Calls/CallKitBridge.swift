// CallKit itself: CXProvider (what the app reports, the actions the system
// asks for) and CXCallController (what the app asks for), behind
// CallProviding / CallControlling. The provider's delegate runs on the main
// queue and hands every action to CallCenter.
//
// Configuration: video, two call groups of one call each (a room's call; a
// second room may ring as call waiting), generic handles (CallNaming.handle —
// never a number, never the room), the app's mark as the icon template, and
// Recents (includesCallsInRecents) only when Settings › Calls says so —
// Android's "call log" switch. The provider's name is the app's display name
// (CXProviderConfiguration() reads CFBundleDisplayName).

import AVFoundation
@preconcurrency import CallKit
import UIKit

@MainActor
final class CallKitProvider: NSObject, CallProviding, @preconcurrency CXProviderDelegate {
    private let provider: CXProvider
    weak var center: CallCenter?

    init(settings: CallProviderSettings) {
        provider = CXProvider(configuration: Self.configuration(settings))
        super.init()
        provider.setDelegate(self, queue: .main)
    }

    static func configuration(_ s: CallProviderSettings) -> CXProviderConfiguration {
        let c = CXProviderConfiguration()
        c.supportsVideo = true
        c.maximumCallGroups = 2
        c.maximumCallsPerCallGroup = 1
        c.supportedHandleTypes = [.generic]
        c.includesCallsInRecents = s.recents
        c.iconTemplateImageData = s.iconTemplate
        return c
    }

    static func update(_ d: CallDisplay) -> CXCallUpdate {
        let u = CXCallUpdate()
        u.remoteHandle = CXHandle(type: .generic, value: d.handle)
        u.localizedCallerName = d.name
        u.hasVideo = d.video
        u.supportsHolding = true
        u.supportsGrouping = false
        u.supportsUngrouping = false
        u.supportsDTMF = false
        return u
    }

    // MARK: CallProviding

    func reportIncoming(_ uuid: UUID, _ display: CallDisplay, done: @escaping @MainActor (Bool) -> Void) {
        provider.reportNewIncomingCall(with: uuid, update: Self.update(display)) { error in
            if let error { CallLog.info("incoming call not shown: \(error.localizedDescription)") }
            let ok = error == nil
            DispatchQueue.main.async { MainActor.assumeIsolated { done(ok) } }
        }
    }

    func reportUpdate(_ uuid: UUID, _ display: CallDisplay) {
        provider.reportCall(with: uuid, updated: Self.update(display))
    }

    func reportOutgoing(_ uuid: UUID, startedConnectingAt date: Date) {
        provider.reportOutgoingCall(with: uuid, startedConnectingAt: date)
    }

    func reportOutgoing(_ uuid: UUID, connectedAt date: Date) {
        provider.reportOutgoingCall(with: uuid, connectedAt: date)
    }

    func reportEnded(_ uuid: UUID, at date: Date, reason: CallEndReason) {
        let r: CXCallEndedReason
        switch reason {
        case .failed: r = .failed
        case .remoteEnded: r = .remoteEnded
        case .unanswered: r = .unanswered
        case .answeredElsewhere: r = .answeredElsewhere
        case .declinedElsewhere: r = .declinedElsewhere
        }
        provider.reportCall(with: uuid, endedAt: date, reason: r)
    }

    func configure(_ settings: CallProviderSettings) {
        provider.configuration = Self.configuration(settings)
    }

    // MARK: CXProviderDelegate (main queue)

    func providerDidReset(_ provider: CXProvider) { center?.providerDidReset() }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        center?.performStart(action.callUUID) == true ? action.fulfill() : action.fail()
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        center?.performAnswer(action.callUUID) == true ? action.fulfill() : action.fail()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        _ = center?.performEnd(action.callUUID)
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        center?.performMute(action.callUUID, action.isMuted) == true ? action.fulfill() : action.fail()
    }

    func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
        center?.performHold(action.callUUID, action.isOnHold) == true ? action.fulfill() : action.fail()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        center?.didActivate(audioSession)
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        center?.didDeactivate(audioSession)
    }
}

@MainActor
final class CallKitController: CallControlling {
    private let controller = CXCallController(queue: .main)

    func request(_ request: CallRequest, done: @escaping @MainActor (Bool) -> Void) {
        let action: CXAction
        switch request {
        case let .start(uuid, d):
            let a = CXStartCallAction(call: uuid, handle: CXHandle(type: .generic, value: d.handle))
            a.isVideo = d.video
            action = a
        case let .answer(uuid): action = CXAnswerCallAction(call: uuid)
        case let .end(uuid): action = CXEndCallAction(call: uuid)
        case let .mute(uuid, muted): action = CXSetMutedCallAction(call: uuid, muted: muted)
        case let .hold(uuid, onHold): action = CXSetHeldCallAction(call: uuid, onHold: onHold)
        }
        controller.request(CXTransaction(action: action)) { error in
            if let error { CallLog.info("CallKit refused a request: \(error.localizedDescription)") }
            let ok = error == nil
            DispatchQueue.main.async { MainActor.assumeIsolated { done(ok) } }
        }
    }
}

/// CallKit's icon template: the mark's "M" (docs: a 40-pt square, only its alpha counts).
enum CallIcon {
    static func template(side: CGFloat = 120) -> Data? {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let image = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { ctx in
            // The mark (Resources/Assets.xcassets/Mark.imageset/Mark.svg): M39,70 L39,43 L54,58 L69,43 L69,70 in a 108 box,
            // its 30…78 square scaled to the icon.
            let k = side / 48, o: CGFloat = 30
            let path = UIBezierPath()
            path.move(to: CGPoint(x: (39 - o) * k, y: (70 - o) * k))
            path.addLine(to: CGPoint(x: (39 - o) * k, y: (43 - o) * k))
            path.addLine(to: CGPoint(x: (54 - o) * k, y: (58 - o) * k))
            path.addLine(to: CGPoint(x: (69 - o) * k, y: (43 - o) * k))
            path.addLine(to: CGPoint(x: (69 - o) * k, y: (70 - o) * k))
            path.lineWidth = 7 * k
            path.lineCapStyle = .round
            path.lineJoinStyle = .round
            UIColor.white.setStroke()
            ctx.cgContext.setShouldAntialias(true)
            path.stroke()
        }
        return image.pngData()
    }
}
