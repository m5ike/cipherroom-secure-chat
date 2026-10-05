// M5cet for Apple Watch — the reduced app (docs/ios-architecture.md): a companion of
// the iPhone app (cz.m5cet.app), fed over WatchConnectivity in wave 2. For now a
// placeholder list that proves the pure M5Kit modules build for watchOS.

import SwiftUI

@main
struct M5cetWatchApp: App {
    var body: some Scene {
        WindowGroup {
            WatchRootView()
        }
    }
}
