// M5cet for iPhone and iPad — the entry point (docs/ios-architecture.md § 2, App/).
// The counterpart of the Android app's Application (A/M5.java) and its one activity
// (A/ui/MainActivity.java): the UIKit delegate takes the system's callbacks (push,
// PushKit), the model keeps the app's state, the root view shows the design
// (wave 2: Renderer/ replaces the placeholder).

import SwiftUI

@main
struct M5cetApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(delegate.model)
                // m5cet://enroll?… — the console's QR code (Android: MainActivity.handleIntent).
                .onOpenURL { delegate.model.open($0) }
                // A call-back from the Phone app's Recents (Platform/Calls: asks before dialling).
                // Contacts first (a linked person's call / message), then a call-back from the Phone app's Recents.
                .onContinueUserActivity("INStartCallIntent") { a in
                    if !ContactsService.shared.continueUserActivity(a) { _ = CallSystem.shared.continueUserActivity(a) }
                }
        }
        .onChange(of: scenePhase) { _, phase in
            delegate.model.scenePhaseChanged(phase)
        }
    }
}
