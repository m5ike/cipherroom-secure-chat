// The UIKit side of the app (SwiftUI's @UIApplicationDelegateAdaptor): launch,
// APNs registration, silent pushes and PushKit — what the Android app gets in
// M5.onCreate, push/FcmService and telecom/CallRing.

import PushKit
import UIKit

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    let model = AppModel()
    private var pushKit: PushKitBridge?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // The Platform code installs its handlers first (background tasks must be registered
        // before launch ends; a VoIP push that started the app is delivered right after).
        Bootstrap.install(into: model)
        // PushKit: only with a handler that reports every VoIP push to CallKit.
        if model.voip != nil { pushKit = PushKitBridge(model: model) }
        // APNs: a token for silent pushes needs no permission (alerts ask for it — Platform/Notifications).
        application.registerForRemoteNotifications()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        model.didRegister(apnsToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        model.didFailToRegister(error)
    }

    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable: Any]) async -> UIBackgroundFetchResult {
        guard let push = model.push else { return .noData }
        return await push.didReceiveRemoteNotification(userInfo)
    }
}

/// PushKit's registry for VoIP pushes, on the main queue, handing everything to AppModel.voip.
@MainActor
final class PushKitBridge: NSObject, @preconcurrency PKPushRegistryDelegate {
    private let registry = PKPushRegistry(queue: .main)
    private unowned let model: AppModel

    init(model: AppModel) {
        self.model = model
        super.init()
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
    }

    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        model.didUpdate(voipToken: pushCredentials.token)
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        model.didUpdate(voipToken: nil)
    }

    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload,
                      for type: PKPushType, completion: @escaping () -> Void) {
        guard type == .voIP, let voip = model.voip else { return completion() }
        voip.didReceiveVoIPPush(payload.dictionaryPayload, completion: completion)
    }
}
