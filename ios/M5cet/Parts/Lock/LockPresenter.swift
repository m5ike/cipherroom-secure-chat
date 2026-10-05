// The lock and privacy windows over every scene of the app (several on iPad).
// The lock screen is its own window above the app (UIWindow level alert + 1), so
// no screen of the app — the Renderer's or the shell's — has to know about the
// lock: while the app is locked the window is up and the app below it gets no
// touches and no VoiceOver focus. The privacy cover (alert + 2) hides the app in
// the app switcher's snapshot and while the screen is recorded or mirrored —
// iOS's substitute for Android's FLAG_SECURE (ScreenPrivacy decides when).

import SwiftUI
import UIKit

/// The privacy cover: the launch screen's look (brand background and mark), nothing of the app.
struct PrivacyCoverView: View {
    var body: some View {
        ZStack {
            Color("LaunchBackground").ignoresSafeArea()
            Image("Mark").resizable().scaledToFit().frame(width: 96, height: 96).accessibilityHidden(true)
        }
        .accessibilityIdentifier("privacy.cover")
    }
}

/// After a wipe that is not quiet: the design's "data erased" notice for a moment (Android: a flash, then
/// the restart), then the empty app.
struct WipedNoticeView: View {
    var texts: LockTexts = .builtIn
    var done: @MainActor () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let look = LockLook.builtIn(dark: scheme == .dark)
        ZStack {
            look.background.ignoresSafeArea()
            VStack(spacing: 20) {
                Image(systemName: "trash.slash").font(.system(size: 44)).foregroundStyle(look.danger)
                Text(texts("lock.wiped")).font(.title3).foregroundStyle(look.onSurface).multilineTextAlignment(.center)
            }
            .padding(32)
        }
        .contentShape(Rectangle())
        .onTapGesture { done() }
        .task {
            try? await Task.sleep(for: .seconds(2.5))
            done()
        }
        .accessibilityIdentifier("lock.wiped")
    }
}

/// Puts the lock / notice windows up and down on every window scene.
@MainActor
final class LockPresenter {
    private weak var center: SecurityCenter?
    private var windows: [ObjectIdentifier: UIWindow] = [:]
    private var showing: [ObjectIdentifier: Kind] = [:]
    private enum Kind: Equatable { case lock, wiped }

    init(center: SecurityCenter) { self.center = center }

    /// What should be up now, on every connected scene.
    func update() {
        guard let center else { return }
        let want: Kind? = center.wipedNotice ? .wiped : (center.lock.isSetUp && center.lock.isLocked ? .lock : nil)
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let live = Set(scenes.map(ObjectIdentifier.init))
        for id in windows.keys where !live.contains(id) { remove(id) }
        for scene in scenes {
            let id = ObjectIdentifier(scene)
            guard let want else { remove(id); continue }
            if showing[id] == want, let w = windows[id] {
                // The app's own window may have taken the key status (a scene that just connected).
                if !w.isKeyWindow { w.makeKey() }
                continue
            }
            remove(id)
            let w = UIWindow(windowScene: scene)
            w.windowLevel = .alert + 1
            w.backgroundColor = .clear
            w.rootViewController = UIHostingController(rootView: view(for: want, center: center))
            w.makeKeyAndVisible()
            windows[id] = w
            showing[id] = want
        }
    }

    private func view(for kind: Kind, center: SecurityCenter) -> AnyView {
        switch kind {
        case .lock:
            AnyView(LockScreenView(model: LockPadModel(lock: center.lock, mode: .unlock,
                                                       shuffle: center.settings.bool(SecuritySetting.shufflePin))))
        case .wiped:
            AnyView(WipedNoticeView { [weak center] in
                center?.wipedNotice = false
                center?.presenter.update()
            })
        }
    }

    private func remove(_ id: ObjectIdentifier) {
        guard let w = windows.removeValue(forKey: id) else { return }
        showing[id] = nil
        let scene = w.windowScene
        w.isHidden = true
        w.rootViewController = nil
        // The app's own window takes the keyboard and VoiceOver back.
        scene?.windows.first { $0.windowLevel == .normal && !$0.isHidden }?.makeKey()
    }

    /// Whether a lock window is up (tests, diagnostics).
    var isShowingLock: Bool { showing.values.contains(.lock) }
}
