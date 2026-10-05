// The window's first view: the design's screens (Renderer/DesignShell — Android's
// MainActivity). Each window (iPad: several) has its own host — its screen, back
// stack, $form and overlay — over the app's shared DesignServices (design,
// settings, language, slots, actions, state). Until the host exists the launch
// screen's look stays (LaunchBackground + Mark, as Info.plist's UILaunchScreen).

import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @State private var host: DesignHost?

    var body: some View {
        Group {
            if let host {
                DesignShell(host: host)
            } else {
                ZStack {
                    Color("LaunchBackground").ignoresSafeArea()
                    Image("Mark").accessibilityHidden(true)
                }
            }
        }
        .onAppear { if host == nil { start() } }
    }

    private func start() {
        let h = DesignHost(services: model.design)
        // The system's tone from the first frame (the shell keeps it in step afterwards).
        h.systemDark = UITraitCollection.current.userInterfaceStyle == .dark
        host = h
        // Links (m5cet://) while the window is open; one that came before it waits in pendingLink.
        model.onLink { [weak h] link in h?.handleLink(link) ?? false }
        model.onScenePhase { [weak h] phase in if phase == .active { h?.resumed() } }
        #if DEBUG
        if DebugLaunch.start(h) { return }
        #endif
        h.start()
        if let link = model.pendingLink, h.handleLink(link) { _ = model.takePendingLink() }
    }
}

#Preview {
    RootView().environment(AppModel())
}
