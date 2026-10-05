// M5cet for Apple Watch — the miniaturised companion of the iPhone app (cz.m5cet.app), docs/ios-architecture.md.
// It holds no secret: no keys, no passphrases, no protocol, no server. What it shows comes from M5cet on the
// iPhone over WatchConnectivity (WatchLink → WatchStore), only while the app there is unlocked and the person
// turned Apple Watch on; replies, "mark read" and "open on iPhone" go back the same way. Notifications and
// CallKit calls of the iPhone app reach the watch through the system (iOS mirrors them; the iPhone's neutral
// text applies) — there is no notification or call code here.

import SwiftUI

@main
struct M5cetWatchApp: App {
    @State private var store: WatchStore
    private let link: WatchLink?
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let store = WatchStore()
        _store = State(initialValue: store)
        #if DEBUG
        if let sample = WatchSample.requested {
            // Screenshots without an iPhone: the sample in the asked state, no WatchConnectivity.
            let state = WatchState(rawValue: sample) ?? .ok
            store.apply(WatchSample.snapshot(now: store.clock(), state: state, expired: sample == "away"))
            store.reachable = sample != "away"
            link = nil
            return
        }
        #endif
        let link = WatchLink(store: store)
        link.activate()
        self.link = link
    }

    var body: some Scene {
        WindowGroup {
            WatchRootView()
                .environment(store)
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            store.checkExpiry()
            link?.sync()
        }
    }
}
