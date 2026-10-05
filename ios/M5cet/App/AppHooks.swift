// The extension points of the app shell: what the Platform code of wave 2 implements
// and installs in Bootstrap.swift. The shell calls them from the UIKit delegate and
// PushKit; until something is installed it does the safe minimum (no VoIP
// registration, background fetches report .noData).

import Foundation
import UIKit

/// APNs: the device token and silent (content-available) pushes — Platform/Push
/// (Android: push/Push, push/FcmService, push/Control).
@MainActor
protocol RemotePushHandling: AnyObject {
    /// iOS gave the app its APNs token; the server gets it at enroll / check-in (/api/ios).
    func didRegister(apnsToken: Data)
    /// No token (no network, the simulator without the push entitlement…).
    func didFailToRegister(_ error: any Error)
    /// A silent push (a signed control message, a relay wake-up). Return within ~30 s.
    func didReceiveRemoteNotification(_ userInfo: [AnyHashable: Any]) async -> UIBackgroundFetchResult
}

/// PushKit VoIP pushes — Platform/Calls (Android: telecom/CallRing, rtc/Rtc, ui/CallService).
@MainActor
protocol VoIPPushHandling: AnyObject {
    /// The PushKit token (nil when iOS withdrew it).
    func didUpdate(voipToken: Data?)
    /// iOS terminates an app that does not report a call to CallKit for every VoIP push:
    /// call `CXProvider.reportNewIncomingCall` synchronously here, then `completion`.
    func didReceiveVoIPPush(_ payload: [AnyHashable: Any], completion: @escaping () -> Void)
}

extension Data {
    /// The hex form APNs tokens are sent to servers in.
    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}
